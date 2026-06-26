package manager

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/nue-mic/frpc-manager/internal/eventbus"
	"github.com/nue-mic/frpc-manager/pkg/config"
)

func newImportTestManager(t *testing.T) *Manager {
	t.Helper()
	tmp := t.TempDir()
	logsDir := filepath.Join(tmp, "logs")
	profilesDir := filepath.Join(tmp, "profiles")
	storesDir := filepath.Join(tmp, "stores")
	for _, d := range []string{logsDir, profilesDir, storesDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}
	silent := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	m, err := New(Options{
		LogsDir: logsDir, ProfilesDir: profilesDir, StoresDir: storesDir,
		MetaPath: filepath.Join(tmp, "meta.json"), Logger: silent, Bus: eventbus.New(16),
	})
	if err != nil {
		t.Fatalf("manager.New: %v", err)
	}
	return m
}

func listIDs(m *Manager) []string {
	out := []string{}
	for _, s := range m.List() {
		out = append(out, s.ID)
	}
	return out
}

// ImportMeta 从备份 meta.json 同时还原品牌与实例显示顺序。模拟「另一台机器
// 导入备份」：实例按创建序 c1,c2,c3，但备份记录的顺序是 c3,c1,c2。
func TestImportMeta_RestoresBrandingAndOrder(t *testing.T) {
	m := newImportTestManager(t)
	for _, id := range []string{"c1", "c2", "c3"} {
		if err := m.Create(id, config.NewDefaultClientConfig()); err != nil {
			t.Fatalf("Create %s: %v", id, err)
		}
	}

	blob, err := json.Marshal(Meta{
		Version:  1,
		Sort:     []string{"c3", "c1", "c2"},
		Branding: &Branding{AppName: "老灯塔", AppSubtitle: "面板", HTMLTitle: "老灯塔 · 控制台"},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	br, or, _, _, err := m.ImportMeta(blob)
	if err != nil {
		t.Fatalf("ImportMeta: %v", err)
	}
	if !br || !or {
		t.Fatalf("expected branding+order restored, got branding=%v order=%v", br, or)
	}
	if got := m.GetBranding(); got.AppName != "老灯塔" || got.HTMLTitle != "老灯塔 · 控制台" {
		t.Fatalf("branding not restored: %+v", got)
	}
	if got := listIDs(m); len(got) != 3 || got[0] != "c3" || got[1] != "c1" || got[2] != "c2" {
		t.Fatalf("order not restored: got %v want [c3 c1 c2]", got)
	}
}

// 备份里只有 sort、无 branding：仅还原顺序，brandingRestored=false。
func TestImportMeta_OrderOnly(t *testing.T) {
	m := newImportTestManager(t)
	for _, id := range []string{"a", "b"} {
		if err := m.Create(id, config.NewDefaultClientConfig()); err != nil {
			t.Fatalf("Create %s: %v", id, err)
		}
	}
	blob, _ := json.Marshal(Meta{Version: 1, Sort: []string{"b", "a"}})

	br, or, _, _, err := m.ImportMeta(blob)
	if err != nil {
		t.Fatalf("ImportMeta: %v", err)
	}
	if br {
		t.Fatalf("expected branding NOT restored")
	}
	if !or {
		t.Fatalf("expected order restored")
	}
	if got := listIDs(m); got[0] != "b" || got[1] != "a" {
		t.Fatalf("order not restored: got %v want [b a]", got)
	}
}

// 备份的 sort 里含一个当前已不存在的实例：Reorder 过滤未知 id，其余实例
// 仍按备份顺序排列，不报错、不丢实例。
func TestImportMeta_UnknownIDsFiltered(t *testing.T) {
	m := newImportTestManager(t)
	for _, id := range []string{"a", "b"} {
		if err := m.Create(id, config.NewDefaultClientConfig()); err != nil {
			t.Fatalf("Create %s: %v", id, err)
		}
	}
	// gone 不存在；b 在前 a 在后
	blob, _ := json.Marshal(Meta{Version: 1, Sort: []string{"gone", "b", "a"}})

	if _, or, _, _, err := m.ImportMeta(blob); err != nil || !or {
		t.Fatalf("ImportMeta: or=%v err=%v", or, err)
	}
	if got := listIDs(m); len(got) != 2 || got[0] != "b" || got[1] != "a" {
		t.Fatalf("expected [b a] after filtering unknown id, got %v", got)
	}
}

// 损坏的 meta.json：返回错误、不 panic、不改动现状。
func TestImportMeta_InvalidJSON(t *testing.T) {
	m := newImportTestManager(t)
	br, or, sc, bk, err := m.ImportMeta([]byte("{not json"))
	if err == nil {
		t.Fatalf("expected error on invalid json")
	}
	if br || or || sc || bk {
		t.Fatalf("nothing should be restored on invalid json")
	}
}

// 备份带 system_config 覆盖：四项 UI 覆盖应一并还原，systemConfigRestored=true。
// 同时校验「全 nil 的 system_config」不算还原（systemConfigRestored=false）。
func TestImportMeta_RestoresSystemConfig(t *testing.T) {
	m := newImportTestManager(t)
	lvl, su, docs := "debug", false, false
	cors := []string{"https://panel.example.com"}
	blob, _ := json.Marshal(Meta{
		Version: 1,
		SystemConfig: &SystemConfig{
			LogLevel: &lvl, SelfUpdateEnabled: &su, DocsEnabled: &docs, CORSOrigins: &cors,
		},
	})

	_, _, sc, _, err := m.ImportMeta(blob)
	if err != nil {
		t.Fatalf("ImportMeta: %v", err)
	}
	if !sc {
		t.Fatalf("expected system_config restored")
	}
	got := m.GetSystemConfig()
	if got.LogLevel == nil || *got.LogLevel != "debug" {
		t.Fatalf("log_level not restored: %+v", got.LogLevel)
	}
	if got.SelfUpdateEnabled == nil || *got.SelfUpdateEnabled != false {
		t.Fatalf("self_update_enabled not restored")
	}
	if got.DocsEnabled == nil || *got.DocsEnabled != false {
		t.Fatalf("docs_enabled not restored")
	}
	if got.CORSOrigins == nil || len(*got.CORSOrigins) != 1 || (*got.CORSOrigins)[0] != "https://panel.example.com" {
		t.Fatalf("cors_origins not restored: %+v", got.CORSOrigins)
	}

	// 全 nil 的 system_config 不应被当作「有覆盖」上报。
	m2 := newImportTestManager(t)
	blob2, _ := json.Marshal(Meta{Version: 1, SystemConfig: &SystemConfig{}})
	if _, _, sc2, _, err := m2.ImportMeta(blob2); err != nil || sc2 {
		t.Fatalf("empty system_config should not count as restored: sc=%v err=%v", sc2, err)
	}
}

// updateSystemConfig 在锁内完成读-改-写：并发部分更新不应互相丢字段。
func TestUpdateSystemConfig_AtomicMerge(t *testing.T) {
	m := newImportTestManager(t)
	lvl := "warn"
	if err := m.UpdateSystemConfig(func(c *SystemConfig) { c.LogLevel = &lvl }); err != nil {
		t.Fatalf("update log_level: %v", err)
	}
	docs := false
	if err := m.UpdateSystemConfig(func(c *SystemConfig) { c.DocsEnabled = &docs }); err != nil {
		t.Fatalf("update docs: %v", err)
	}
	// 第二次更新只动 docs，不能把第一次写入的 log_level 抹掉。
	got := m.GetSystemConfig()
	if got.LogLevel == nil || *got.LogLevel != "warn" {
		t.Fatalf("log_level lost after second update: %+v", got.LogLevel)
	}
	if got.DocsEnabled == nil || *got.DocsEnabled != false {
		t.Fatalf("docs_enabled not applied: %+v", got.DocsEnabled)
	}
}
