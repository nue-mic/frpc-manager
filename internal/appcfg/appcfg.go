package appcfg

import (
	"errors"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the daemon's own runtime configuration, populated from env vars.
type Config struct {
	HTTPAddr string
	// HTTPAddrWarn carries a non-fatal warning produced while normalizing
	// FRPCMGR_HTTP_ADDR (e.g. an unrecognized value left as-is for net.Listen
	// to reject). The daemon bootstrap emits it once the logger exists, since
	// Load() runs before the logger is constructed.
	HTTPAddrWarn string
	APIToken     string
	CORSOrigins  []string
	DataDir      string
	ProfilesDir  string
	LogsDir      string
	StoresDir    string
	MetaFile     string
	LogLevel     string
	DocsEnabled  bool
	// SelfUpdateEnabled gates the web-triggered self-update endpoint
	// (POST /api/v1/system/update). It maps to FRPCMGR_SELF_UPDATE_ENABLED
	// and defaults to true. Operators running immutable deployments can set
	// it to false to disable in-place upgrades from the UI.
	SelfUpdateEnabled bool
	ShutdownWait      time.Duration
}

// Load reads configuration from environment variables. Required fields
// without sensible defaults will return an error.
func Load() (*Config, error) {
	httpAddr, httpAddrWarn := NormalizeListenAddr(getEnv("FRPCMGR_HTTP_ADDR", ":18080"))
	cfg := &Config{
		HTTPAddr:     httpAddr,
		HTTPAddrWarn: httpAddrWarn,
		APIToken:     os.Getenv("FRPCMGR_API_TOKEN"),
		CORSOrigins:  splitCSV(getEnv("FRPCMGR_CORS_ORIGINS", "*")),
		DataDir:      getEnv("FRPCMGR_DATA_DIR", "/data"),
		LogLevel:     strings.ToLower(getEnv("FRPCMGR_LOG_LEVEL", "info")),
		DocsEnabled:  parseBool(getEnv("FRPCMGR_DOCS_ENABLED", "true"), true),

		SelfUpdateEnabled: parseBool(getEnv("FRPCMGR_SELF_UPDATE_ENABLED", "true"), true),
		ShutdownWait:      10 * time.Second,
	}
	cfg.ProfilesDir = cfg.DataDir + "/profiles"
	cfg.LogsDir = cfg.DataDir + "/logs"
	cfg.StoresDir = cfg.DataDir + "/stores"
	cfg.MetaFile = cfg.DataDir + "/meta.json"

	if cfg.APIToken == "" {
		return nil, errors.New("FRPCMGR_API_TOKEN is required")
	}
	return cfg, nil
}

// EnsureDirs creates the data subdirectories if they do not exist.
func (c *Config) EnsureDirs() error {
	for _, d := range []string{c.DataDir, c.ProfilesDir, c.LogsDir, c.StoresDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// defaultListenAddr is the fallback used when FRPCMGR_HTTP_ADDR is empty.
const defaultListenAddr = ":18080"

// NormalizeListenAddr makes FRPCMGR_HTTP_ADDR forgiving: a bare port such as
// "18080" gets the ":" prepended so net.Listen accepts it, while existing
// host:port values (":18080", "0.0.0.0:18080", "[::]:18080") pass through
// unchanged — the change is fully backward compatible.
//
// It favors fail-fast over silent fallback: anything we cannot confidently
// interpret (out-of-range port, "abc", bare IP, unbracketed IPv6) is returned
// as-is with a warning, so net.Listen surfaces a real error in the logs rather
// than silently binding the default port and leaving the operator wondering why
// the UI is unreachable. Only an empty value falls back to the default. Digit
// detection is ASCII-only so full-width digits (e.g. "１８０８０") don't slip into
// the port branch and then fail Atoi.
func NormalizeListenAddr(raw string) (addr string, warn string) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return defaultListenAddr, ""
	}
	// 1) Bare port -> ":" + port, with range check.
	if isAllASCIIDigits(s) {
		if n, err := strconv.Atoi(s); err == nil && n >= 1 && n <= 65535 {
			return ":" + s, ""
		}
		return s, "FRPCMGR_HTTP_ADDR 端口越界(需 1-65535): " + raw + "，原样交给 net.Listen 处理"
	}
	// 2) Has a colon: let SplitHostPort validate the syntax. A pass only means
	//    the form is host:port — the host may still be unbindable (a hostname,
	//    localhost, or a non-local IP can fail at Listen time).
	if _, port, err := net.SplitHostPort(s); err == nil {
		if p, e := strconv.Atoi(port); e == nil && p >= 1 && p <= 65535 {
			return s, ""
		}
		return s, "FRPCMGR_HTTP_ADDR 端口部分非法: " + raw + "，原样交给 net.Listen 处理"
	}
	// 3) Anything else (abc / 18080/tcp / bare IP / unbracketed IPv6).
	return s, "FRPCMGR_HTTP_ADDR 无法识别: " + raw + " (IPv6 单地址须用方括号 [addr]:port)，原样交给 net.Listen 处理"
}

// isAllASCIIDigits reports whether s is non-empty and consists solely of ASCII
// 0-9. Deliberately not unicode.IsDigit, which would accept full-width digits
// and let them fall into the bare-port branch only to fail strconv.Atoi.
func isAllASCIIDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// ParseLevel maps a level name (trace|debug|info|warn|error) to slog.Level.
// Shared by the daemon bootstrap and the runtime log-level switch so both agree.
func ParseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "trace", "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func parseBool(s string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on", "y":
		return true
	case "0", "false", "no", "off", "n":
		return false
	default:
		return def
	}
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
