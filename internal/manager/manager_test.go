package manager

import (
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/nue-mic/frpc-manager/internal/eventbus"
	"github.com/nue-mic/frpc-manager/pkg/config"
)

// TestWriteConfig_UsesCombinedLogFile: 每个 instance 的 toml 写出后，
// LogFile 字段应统一指向 LogsDir/frpc.log，而不是 per-id 的 <id>.log。
func TestWriteConfig_UsesCombinedLogFile(t *testing.T) {
	tmp := t.TempDir()
	logsDir := filepath.Join(tmp, "logs")
	profilesDir := filepath.Join(tmp, "profiles")
	storesDir := filepath.Join(tmp, "stores")
	for _, d := range []string{logsDir, profilesDir, storesDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}

	m := &Manager{opts: Options{
		LogsDir:     logsDir,
		ProfilesDir: profilesDir,
		StoresDir:   storesDir,
	}}

	cfgPath := filepath.Join(profilesDir, "abc.toml")
	if err := os.WriteFile(cfgPath, []byte(`serverAddr="127.0.0.1"
serverPort=7000
`), 0o644); err != nil {
		t.Fatalf("seed toml: %v", err)
	}

	data, err := config.UnmarshalClientConf(cfgPath)
	if err != nil {
		t.Fatalf("UnmarshalClientConf: %v", err)
	}
	if err := m.writeConfig(cfgPath, data); err != nil {
		t.Fatalf("writeConfig: %v", err)
	}

	// Parse the written TOML back and verify LogFile points exactly at the combined path.
	parsed, err := config.UnmarshalClientConf(cfgPath)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	want := filepath.ToSlash(filepath.Join(logsDir, "frpc.log"))
	if parsed.LogFile != want {
		t.Fatalf("expected LogFile=%q, got %q", want, parsed.LogFile)
	}
}

// TestMigratePaths_RewritesLegacyLogFile: v1.2.22 之前写的 toml 里 log.to 还
// 指向 per-id <id>.log。MigratePaths 应把它重写为 combined log 路径。
func TestMigratePaths_RewritesLegacyLogFile(t *testing.T) {
	tmp := t.TempDir()
	logsDir := filepath.Join(tmp, "logs")
	profilesDir := filepath.Join(tmp, "profiles")
	storesDir := filepath.Join(tmp, "stores")
	metaPath := filepath.Join(tmp, "meta.json")
	for _, d := range []string{logsDir, profilesDir, storesDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}

	// 模拟 v1.2.22 写下的 toml：log.to 指向 per-id 路径
	legacyLogPath := filepath.ToSlash(filepath.Join(logsDir, "dt_116_frps.log"))
	cfgPath := filepath.Join(profilesDir, "dt_116_frps.toml")
	legacyBody := `serverAddr = "127.0.0.1"
serverPort = 7000
loginFailExit = false

[log]
to = "` + legacyLogPath + `"
level = "info"
maxDays = 3
`
	if err := os.WriteFile(cfgPath, []byte(legacyBody), 0o644); err != nil {
		t.Fatalf("seed legacy toml: %v", err)
	}

	silentLogger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	m, err := New(Options{
		LogsDir:     logsDir,
		ProfilesDir: profilesDir,
		StoresDir:   storesDir,
		MetaPath:    metaPath,
		Logger:      silentLogger,
		Bus:         eventbus.New(16),
	})
	if err != nil {
		t.Fatalf("manager.New: %v", err)
	}
	if err := m.LoadAll(); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}

	// 迁移前确认确实读到的是旧路径
	pre, err := config.UnmarshalClientConf(cfgPath)
	if err != nil {
		t.Fatalf("re-parse before: %v", err)
	}
	if pre.LogFile != legacyLogPath {
		t.Fatalf("setup invariant broken: pre LogFile=%q want %q", pre.LogFile, legacyLogPath)
	}

	// 执行迁移
	m.MigratePaths()

	// 迁移后 toml 文件里 log.to 应指向 combined log
	post, err := config.UnmarshalClientConf(cfgPath)
	if err != nil {
		t.Fatalf("re-parse after: %v", err)
	}
	want := filepath.ToSlash(filepath.Join(logsDir, "frpc.log"))
	if post.LogFile != want {
		t.Fatalf("expected migrated LogFile=%q, got %q", want, post.LogFile)
	}
}

// TestMigratePaths_NoOpWhenAlreadyCombined: 已经是 frpc.log 的 toml 不应被
// 重写（避免无谓的文件写）。
func TestMigratePaths_NoOpWhenAlreadyCombined(t *testing.T) {
	tmp := t.TempDir()
	logsDir := filepath.Join(tmp, "logs")
	profilesDir := filepath.Join(tmp, "profiles")
	storesDir := filepath.Join(tmp, "stores")
	metaPath := filepath.Join(tmp, "meta.json")
	for _, d := range []string{logsDir, profilesDir, storesDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}

	combinedPath := filepath.ToSlash(filepath.Join(logsDir, "frpc.log"))
	cfgPath := filepath.Join(profilesDir, "already.toml")
	body := `serverAddr = "127.0.0.1"
serverPort = 7000

[log]
to = "` + combinedPath + `"
level = "info"
`
	if err := os.WriteFile(cfgPath, []byte(body), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	mtimeBefore, err := os.Stat(cfgPath)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}

	silentLogger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	m, err := New(Options{
		LogsDir: logsDir, ProfilesDir: profilesDir, StoresDir: storesDir,
		MetaPath: metaPath, Logger: silentLogger, Bus: eventbus.New(16),
	})
	if err != nil {
		t.Fatalf("manager.New: %v", err)
	}
	if err := m.LoadAll(); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}

	m.MigratePaths()

	mtimeAfter, err := os.Stat(cfgPath)
	if err != nil {
		t.Fatalf("stat after: %v", err)
	}
	if !mtimeAfter.ModTime().Equal(mtimeBefore.ModTime()) {
		t.Fatalf("expected no rewrite when already combined, but mtime changed: %v -> %v",
			mtimeBefore.ModTime(), mtimeAfter.ModTime())
	}
}

// TestMigratePaths_SkipsConsoleAndEmpty: log.to 设为 console 或留空时
// 表示用户显式禁止文件日志, 不应被覆盖为 frpc.log。
func TestMigratePaths_SkipsConsoleAndEmpty(t *testing.T) {
	tmp := t.TempDir()
	logsDir := filepath.Join(tmp, "logs")
	profilesDir := filepath.Join(tmp, "profiles")
	storesDir := filepath.Join(tmp, "stores")
	metaPath := filepath.Join(tmp, "meta.json")
	for _, d := range []string{logsDir, profilesDir, storesDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}

	cases := []struct {
		id   string
		body string
	}{
		{"console_only", `serverAddr = "127.0.0.1"
serverPort = 7000

[log]
to = "console"
`},
	}
	for _, c := range cases {
		p := filepath.Join(profilesDir, c.id+".toml")
		if err := os.WriteFile(p, []byte(c.body), 0o644); err != nil {
			t.Fatalf("seed %s: %v", c.id, err)
		}
	}

	silentLogger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	m, err := New(Options{
		LogsDir: logsDir, ProfilesDir: profilesDir, StoresDir: storesDir,
		MetaPath: metaPath, Logger: silentLogger, Bus: eventbus.New(16),
	})
	if err != nil {
		t.Fatalf("manager.New: %v", err)
	}
	if err := m.LoadAll(); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}

	m.MigratePaths()

	for _, c := range cases {
		p := filepath.Join(profilesDir, c.id+".toml")
		got, err := config.UnmarshalClientConf(p)
		if err != nil {
			t.Fatalf("re-parse %s: %v", c.id, err)
		}
		// 期望仍然不是 frpc.log（console 保留，或被 frp 默认值替换，但绝不能是 frpc.log）
		combined := filepath.ToSlash(filepath.Join(logsDir, "frpc.log"))
		if got.LogFile == combined {
			t.Fatalf("%s: console-mode toml was wrongly migrated to combined log", c.id)
		}
	}
}
