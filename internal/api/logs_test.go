package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"

	"github.com/mia-clark/frp-manager-server/internal/manager"
	"github.com/mia-clark/frp-manager-server/pkg/config"
)

// TestLogsQuery_FiltersByInstancePrefix: 合并日志含 A/B 两实例的行，
// GET /api/v1/configs/A/logs 只应返回 A 的行。
func TestLogsQuery_FiltersByInstancePrefix(t *testing.T) {
	tmp := t.TempDir()
	logsDir := filepath.Join(tmp, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	combined := filepath.Join(logsDir, manager.CombinedLogFileName)
	body := strings.Join([]string{
		"2026-06-03 15:17:41.437 [I] [inst=A] try to connect",
		"2026-06-03 15:17:50.544 [D] [inst=B] heartbeat",
		"2026-06-03 15:18:20.416 [E] [inst=A] login fail",
		"",
	}, "\n")
	if err := os.WriteFile(combined, []byte(body), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	m := newTestManager(t, tmp)
	mustCreateInstance(t, m, "A")
	mustCreateInstance(t, m, "B")

	h := NewLogsHandler(m, logsDir, testLogger(), []string{"*"})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/configs/A/logs?lines=10", nil)
	req = withPathID(req, "A")
	rec := httptest.NewRecorder()
	h.Query(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Lines []string `json:"lines"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode resp: %v", err)
	}
	if len(resp.Lines) != 2 {
		t.Fatalf("expected 2 lines for inst=A, got %d: %v", len(resp.Lines), resp.Lines)
	}
	for _, l := range resp.Lines {
		if !strings.Contains(l, "[inst=A]") {
			t.Fatalf("unexpected line: %s", l)
		}
	}
}

// ---- test helpers ----

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
}

func newTestManager(t *testing.T, dataDir string) *manager.Manager {
	t.Helper()
	opts := manager.Options{
		ProfilesDir: filepath.Join(dataDir, "profiles"),
		LogsDir:     filepath.Join(dataDir, "logs"),
		StoresDir:   filepath.Join(dataDir, "stores"),
		MetaPath:    filepath.Join(dataDir, "meta.json"),
		Logger:      testLogger(),
	}
	for _, d := range []string{opts.ProfilesDir, opts.LogsDir, opts.StoresDir} {
		_ = os.MkdirAll(d, 0o755)
	}
	m, err := manager.New(opts)
	if err != nil {
		t.Fatalf("manager.New: %v", err)
	}
	return m
}

func mustCreateInstance(t *testing.T, m *manager.Manager, id string) {
	t.Helper()
	body := []byte(`serverAddr = "127.0.0.1"
serverPort = 7000
`)
	data, err := config.UnmarshalClientConf(body)
	if err != nil {
		t.Fatalf("UnmarshalClientConf: %v", err)
	}
	if err := m.Create(id, data); err != nil {
		t.Fatalf("Create %s: %v", id, err)
	}
}

func withPathID(r *http.Request, id string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}

// TestLogsTail_FiltersByInstancePrefix: WS /logs/tail 实时推送，
// 应只推送当前实例的行。
func TestLogsTail_FiltersByInstancePrefix(t *testing.T) {
	tmp := t.TempDir()
	logsDir := filepath.Join(tmp, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	combined := filepath.Join(logsDir, manager.CombinedLogFileName)
	if err := os.WriteFile(combined, []byte(""), 0o644); err != nil {
		t.Fatalf("seed empty: %v", err)
	}

	m := newTestManager(t, tmp)
	mustCreateInstance(t, m, "A")
	mustCreateInstance(t, m, "B")

	h := NewLogsHandler(m, logsDir, testLogger(), []string{"*"})

	// httptest.Server + ws Dial
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = withPathID(r, "A")
		h.Tail(w, r)
	}))
	defer srv.Close()

	wsURL, _ := url.Parse(srv.URL)
	wsURL.Scheme = "ws"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL.String(), nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}

	// 给 logtail goroutine 一点时间订阅成功（Windows fsnotify 启动较慢）
	time.Sleep(500 * time.Millisecond)

	f, err := os.OpenFile(combined, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open append: %v", err)
	}
	for _, line := range []string{
		"2026-06-03 16:00:00.000 [D] [inst=B] heartbeat-B\n",
		"2026-06-03 16:00:01.000 [I] [inst=A] login success\n",
		"2026-06-03 16:00:02.000 [D] [inst=A] heartbeat-A\n",
	} {
		_, _ = f.WriteString(line)
	}
	_ = f.Close()

	// 期望读到 A 的 2 条
	got := []string{}
	readDeadline := time.After(8 * time.Second)
	for len(got) < 2 {
		select {
		case <-readDeadline:
			t.Fatalf("timeout, got %v", got)
		default:
		}
		readCtx, c := context.WithTimeout(ctx, 3*time.Second)
		_, data, err := conn.Read(readCtx)
		c()
		if err != nil {
			t.Fatalf("ws read: %v", err)
		}
		var frame struct {
			Line string `json:"line"`
		}
		if err := json.Unmarshal(data, &frame); err != nil {
			t.Fatalf("decode frame: %v", err)
		}
		got = append(got, frame.Line)
	}
	for _, l := range got {
		if !strings.Contains(l, "[inst=A]") {
			t.Fatalf("unexpected line in tail: %s", l)
		}
	}

	// 显式关闭连接：触发服务端 CloseRead ctx 取消 → Tail handler 退出 →
	// logtail.Stop() → run() goroutine 退出 → 文件句柄释放。
	// 等待 500ms 让 goroutine 链完成，避免 Windows TempDir cleanup 时文件仍被持有。
	conn.Close(websocket.StatusNormalClosure, "")
	time.Sleep(500 * time.Millisecond)
}

// TestLogsClear_SetsViewSince: DELETE /logs 应仅更新 LogViewSince，不删文件。
// 后续 GET /logs 不再返回戳之前的行；同时 frpc.log 物理文件保留。
func TestLogsClear_SetsViewSince(t *testing.T) {
	tmp := t.TempDir()
	logsDir := filepath.Join(tmp, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	combined := filepath.Join(logsDir, manager.CombinedLogFileName)
	body := strings.Join([]string{
		"2026-06-03 10:00:00.000 [I] [inst=A] old",
		"2026-06-03 12:00:00.000 [I] [inst=B] old-B",
		"",
	}, "\n")
	if err := os.WriteFile(combined, []byte(body), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	m := newTestManager(t, tmp)
	mustCreateInstance(t, m, "A")
	mustCreateInstance(t, m, "B")
	h := NewLogsHandler(m, logsDir, testLogger(), []string{"*"})

	// 1. Clear A
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/configs/A/logs", nil)
	req = withPathID(req, "A")
	rec := httptest.NewRecorder()
	h.Clear(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}

	// 2. 文件仍存在
	if _, err := os.Stat(combined); err != nil {
		t.Fatalf("combined.log should still exist after Clear, got %v", err)
	}

	// 3. GET A 应返回空
	getReq := httptest.NewRequest(http.MethodGet, "/api/v1/configs/A/logs?lines=10", nil)
	getReq = withPathID(getReq, "A")
	getRec := httptest.NewRecorder()
	h.Query(getRec, getReq)
	var resp struct {
		Lines []string `json:"lines"`
	}
	_ = json.Unmarshal(getRec.Body.Bytes(), &resp)
	if len(resp.Lines) != 0 {
		t.Fatalf("expected empty lines after Clear, got %v", resp.Lines)
	}

	// 4. GET B 仍能看到自己的行
	getReq2 := httptest.NewRequest(http.MethodGet, "/api/v1/configs/B/logs?lines=10", nil)
	getReq2 = withPathID(getReq2, "B")
	getRec2 := httptest.NewRecorder()
	h.Query(getRec2, getReq2)
	var resp2 struct {
		Lines []string `json:"lines"`
	}
	_ = json.Unmarshal(getRec2.Body.Bytes(), &resp2)
	if len(resp2.Lines) != 1 {
		t.Fatalf("expected 1 line for B, got %v", resp2.Lines)
	}
}

// TestLogsClear_404OnUnknownID: DELETE 不存在的 instance 应返回 404，
// 不应误把 LogViewSince 写到 meta.json。
func TestLogsClear_404OnUnknownID(t *testing.T) {
	tmp := t.TempDir()
	logsDir := filepath.Join(tmp, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	m := newTestManager(t, tmp)
	h := NewLogsHandler(m, logsDir, testLogger(), []string{"*"})

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/configs/nonexistent/logs", nil)
	req = withPathID(req, "nonexistent")
	rec := httptest.NewRecorder()
	h.Clear(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d body=%s", rec.Code, rec.Body.String())
	}
}

// TestLogsQuery_RespectsViewSince: 设置 LogViewSince 后，
// Query 只返回时间戳 >= since 的行。
func TestLogsQuery_RespectsViewSince(t *testing.T) {
	tmp := t.TempDir()
	logsDir := filepath.Join(tmp, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	combined := filepath.Join(logsDir, manager.CombinedLogFileName)
	body := strings.Join([]string{
		"2026-06-03 10:00:00.000 [I] [inst=A] line-1-old",
		"2026-06-03 12:00:00.000 [I] [inst=A] line-2-old",
		"2026-06-03 14:00:00.000 [I] [inst=A] line-3-new",
		"",
	}, "\n")
	if err := os.WriteFile(combined, []byte(body), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	m := newTestManager(t, tmp)
	mustCreateInstance(t, m, "A")
	h := NewLogsHandler(m, logsDir, testLogger(), []string{"*"})

	// Set view-since to 13:00:00 — only line-3 (14:00) should survive
	cutoff, err := time.ParseInLocation("2006-01-02 15:04:05.000",
		"2026-06-03 13:00:00.000", time.Local)
	if err != nil {
		t.Fatalf("parse cutoff: %v", err)
	}
	if err := m.SetLogViewSince("A", cutoff.UnixMilli()); err != nil {
		t.Fatalf("SetLogViewSince: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/configs/A/logs?lines=10", nil)
	req = withPathID(req, "A")
	rec := httptest.NewRecorder()
	h.Query(rec, req)

	var resp struct {
		Lines []string `json:"lines"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Lines) != 1 {
		t.Fatalf("expected 1 line after view-since, got %d: %v", len(resp.Lines), resp.Lines)
	}
	if !strings.Contains(resp.Lines[0], "line-3-new") {
		t.Fatalf("expected line-3-new, got %q", resp.Lines[0])
	}
}
