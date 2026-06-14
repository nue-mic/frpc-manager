package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mia-clark/frpc-manager/internal/api"
	"github.com/mia-clark/frpc-manager/internal/appcfg"
	"github.com/mia-clark/frpc-manager/internal/backup"
	"github.com/mia-clark/frpc-manager/internal/eventbus"
	"github.com/mia-clark/frpc-manager/internal/manager"
	"github.com/mia-clark/frpc-manager/pkg/version"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		os.Exit(runServe(os.Args[2:]))
	case "health":
		os.Exit(runHealth(os.Args[2:]))
	case "version", "-v", "--version":
		fmt.Printf("frpcmgrd %s (frp %s, built %s)\n", version.Number, version.FRPVersion, version.BuildDate)
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `frpcmgrd — headless FRP client manager daemon

USAGE
  frpcmgrd <command> [flags]

COMMANDS
  serve     Run the HTTP API server (default for containers)
  health    Probe /api/v1/health and exit non-zero on failure
  version   Print version information
  help      Show this help

ENV
  FRPCMGR_API_TOKEN       Required. Bearer token for API auth.
  FRPCMGR_HTTP_ADDR       Listen address (default ":18080")
  FRPCMGR_DATA_DIR        Data root (default "/data")
  FRPCMGR_CORS_ORIGINS    Comma-separated origins or "*" (default "*")
  FRPCMGR_LOG_LEVEL       trace|debug|info|warn|error (default "info")
  FRPCMGR_DOCS_ENABLED    Expose /api/docs Scalar UI (default "true")`)
}

func runServe(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	_ = fs.Parse(args)

	cfg, err := appcfg.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "config error: %v\n", err)
		return 1
	}
	if err := cfg.EnsureDirs(); err != nil {
		fmt.Fprintf(os.Stderr, "cannot create data dirs: %v\n", err)
		return 1
	}

	// Use a LevelVar so the running level can be changed at runtime via the
	// system-config UI (FRPCMGR_LOG_LEVEL is the boot default).
	levelVar := new(slog.LevelVar)
	levelVar.Set(appcfg.ParseLevel(cfg.LogLevel))
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: levelVar}))
	// Surface any FRPCMGR_HTTP_ADDR normalization warning now that the logger
	// exists (appcfg.Load runs before the logger is built, so it can only stash
	// the text). Non-empty means the value was left as-is for net.Listen to
	// reject — better a visible error than silently binding the default port.
	if cfg.HTTPAddrWarn != "" {
		logger.Warn("listen addr normalize", slog.String("detail", cfg.HTTPAddrWarn))
	}
	logger.Info("starting frpcmgrd",
		slog.String("addr", cfg.HTTPAddr),
		slog.String("data_dir", cfg.DataDir),
		slog.String("version", version.Number),
		slog.String("frp", version.FRPVersion),
	)

	bus := eventbus.New(1024)
	mgr, err := manager.New(manager.Options{
		ProfilesDir: cfg.ProfilesDir,
		LogsDir:     cfg.LogsDir,
		StoresDir:   cfg.StoresDir,
		MetaPath:    cfg.MetaFile,
		Logger:      logger,
		Bus:         bus,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "init manager: %v\n", err)
		return 1
	}
	if err := mgr.LoadAll(); err != nil {
		fmt.Fprintf(os.Stderr, "load configs: %v\n", err)
		return 1
	}
	// 升级迁移：把 v1.2.22 及之前写下的 per-id .log 路径重写为 combined log
	// 路径，否则旧 toml 启动的 frpc 仍按旧路径写日志，UI 读 combined 会空白。
	mgr.MigratePaths()
	mgr.ArmAllAutoDelete()
	mgr.AutoStart()
	defer mgr.Shutdown()

	// Scheduled-backup engine: cron-driven uploads of the config export to the
	// configured storage channels. Started after AutoStart so a backup's payload
	// reflects the running set; stopped before the manager shuts down.
	host, _ := os.Hostname()
	sched := backup.NewScheduler(mgr, mgr, mgr, bus, logger, host)
	sched.Start()
	defer sched.Stop()

	handler := api.NewRouter(api.Deps{Cfg: cfg, Logger: logger, Manager: mgr, LogLevel: levelVar, Backup: sched})
	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-sigCh:
		logger.Info("shutdown signal received", slog.String("signal", sig.String()))
	case err := <-errCh:
		logger.Error("http server crashed", slog.Any("err", err))
		return 1
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownWait)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", slog.Any("err", err))
		return 1
	}
	logger.Info("bye")
	return 0
}

func runHealth(args []string) int {
	fs := flag.NewFlagSet("health", flag.ExitOnError)
	addr := fs.String("addr", "http://127.0.0.1:18080", "daemon base URL")
	_ = fs.Parse(args)

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(*addr + "/api/v1/health")
	if err != nil {
		fmt.Fprintf(os.Stderr, "health check failed: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "unhealthy: status=%d\n", resp.StatusCode)
		return 1
	}
	return 0
}
