package manager

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/mia-clark/frp-manager-server/pkg/config"
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
