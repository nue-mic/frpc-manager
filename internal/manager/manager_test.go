package manager

import (
	"os"
	"path/filepath"
	"strings"
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

	got, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("readback: %v", err)
	}
	want := filepath.ToSlash(filepath.Join(logsDir, "frpc.log"))
	if !strings.Contains(string(got), want) {
		t.Fatalf("expected LogFile to contain %q, got toml:\n%s", want, got)
	}
}
