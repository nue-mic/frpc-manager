package manager

import (
	"os"
	"path/filepath"
	"testing"
)

// TestMetaLogViewSince_RoundTrip: setLogViewSince 写入的戳能从磁盘读回。
func TestMetaLogViewSince_RoundTrip(t *testing.T) {
	tmp := t.TempDir()
	metaPath := filepath.Join(tmp, "meta.json")

	store, err := openMetaStore(metaPath)
	if err != nil {
		t.Fatalf("openMetaStore: %v", err)
	}
	if err := store.setLogViewSince("dt_116_frps", 1717420000000); err != nil {
		t.Fatalf("setLogViewSince: %v", err)
	}

	// 重新打开校验持久化
	store2, err := openMetaStore(metaPath)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	m := store2.snapshot()
	got, ok := m.LogViewSince["dt_116_frps"]
	if !ok {
		t.Fatal("LogViewSince[dt_116_frps] missing after reopen")
	}
	if got != 1717420000000 {
		t.Fatalf("expected 1717420000000, got %d", got)
	}
}

// TestMetaLogViewSince_DropIDs: dropIDs 应同时清除 LogViewSince 中的对应键。
func TestMetaLogViewSince_DropIDs(t *testing.T) {
	tmp := t.TempDir()
	metaPath := filepath.Join(tmp, "meta.json")
	store, err := openMetaStore(metaPath)
	if err != nil {
		t.Fatalf("openMetaStore: %v", err)
	}
	_ = store.setLogViewSince("a", 100)
	_ = store.setLogViewSince("b", 200)

	if err := store.dropIDs("a"); err != nil {
		t.Fatalf("dropIDs: %v", err)
	}
	m := store.snapshot()
	if _, ok := m.LogViewSince["a"]; ok {
		t.Fatal("LogViewSince[a] should be dropped")
	}
	if got := m.LogViewSince["b"]; got != 200 {
		t.Fatalf("LogViewSince[b] should remain 200, got %d", got)
	}
}

// TestMetaLogViewSince_BackwardCompatRead: 旧 meta.json 不含 log_view_since 字段时，
// openMetaStore 不应崩，snapshot 返回非 nil map。
func TestMetaLogViewSince_BackwardCompatRead(t *testing.T) {
	tmp := t.TempDir()
	metaPath := filepath.Join(tmp, "meta.json")
	old := `{"version":1,"auto_start":[],"sort":[]}`
	if err := os.WriteFile(metaPath, []byte(old), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	store, err := openMetaStore(metaPath)
	if err != nil {
		t.Fatalf("openMetaStore: %v", err)
	}
	m := store.snapshot()
	if m.LogViewSince == nil {
		t.Fatal("LogViewSince should be initialized to empty map, not nil")
	}
}
