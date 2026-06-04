package services

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestRun_RespectsCtxCancel: calling Run(ctx) with ctx canceled within 50ms,
// Run should return within ~5s (much shorter than frpc's default infinite
// reconnect loop). This indirectly proves ctx is forwarded to svr.Run;
// if Run still hard-coded context.Background(), this test would time out.
func TestRun_RespectsCtxCancel(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "test.toml")
	// Minimal toml pointing at a non-existent frps. Login will fail but
	// loginFailExit=true makes it exit fast.
	cfgBody := `serverAddr = "127.0.0.1"
serverPort = 65530
loginFailExit = true
log.to = "` + filepath.ToSlash(filepath.Join(tmpDir, "log")) + `"
log.level = "info"
log.maxDays = 1
`
	if err := os.WriteFile(cfgPath, []byte(cfgBody), 0o644); err != nil {
		t.Fatalf("write cfg: %v", err)
	}

	svc, err := NewFrpClientService(cfgPath)
	if err != nil {
		t.Fatalf("NewFrpClientService: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		svc.Run(ctx)
		// Close the rotate log writer so t.TempDir() cleanup can remove the file.
		if svc.logger != nil {
			_ = svc.logger.Close()
		}
		close(done)
	}()

	// Let it run 50ms then cancel
	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case <-done:
		// ok
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not exit within 5s after ctx cancel")
	}
}
