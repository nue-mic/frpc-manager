package util

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestReadFileLinesFiltered_KeepsOnlyMatchingLines: 写一个混合两实例日志的文件，
// 过滤器只接受 "[inst=A]" 行，预期返回的行都含该前缀。
func TestReadFileLinesFiltered_KeepsOnlyMatchingLines(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "frpc.log")
	body := strings.Join([]string{
		"2026-06-03 15:17:41.437 [I] [inst=A] [client/service.go:308] try to connect",
		"2026-06-03 15:17:50.544 [D] [inst=B] [run-xyz] heartbeat A",
		"2026-06-03 15:17:51.608 [D] [inst=A] [run-abc] heartbeat",
		"2026-06-03 15:18:00.822 [I] [inst=B] [client/service.go:308] try to connect",
		"2026-06-03 15:18:20.416 [E] [inst=A] login fail",
		"",
	}, "\n")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	lines, err := ReadFileLinesFiltered(path, 10, func(s string) bool {
		return strings.Contains(s, "[inst=A]")
	})
	if err != nil {
		t.Fatalf("ReadFileLinesFiltered: %v", err)
	}
	if got := len(lines); got != 3 {
		t.Fatalf("expected 3 matching lines, got %d: %v", got, lines)
	}
	for _, l := range lines {
		if !strings.Contains(l, "[inst=A]") {
			t.Fatalf("unexpected line slipped through filter: %q", l)
		}
	}
}

// TestReadFileLinesFiltered_LimitsToN: N=2 时只返回最后 2 条匹配行（按文件顺序）。
func TestReadFileLinesFiltered_LimitsToN(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "frpc.log")
	var sb strings.Builder
	for i := 0; i < 10; i++ {
		sb.WriteString("[inst=A] line ")
		sb.WriteString(string(rune('0' + i)))
		sb.WriteByte('\n')
	}
	if err := os.WriteFile(path, []byte(sb.String()), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	lines, err := ReadFileLinesFiltered(path, 2, func(s string) bool {
		return strings.Contains(s, "[inst=A]")
	})
	if err != nil {
		t.Fatalf("ReadFileLinesFiltered: %v", err)
	}
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines, got %d: %v", len(lines), lines)
	}
	if !strings.Contains(lines[0], "line 8") || !strings.Contains(lines[1], "line 9") {
		t.Fatalf("expected last two matching lines (8, 9), got: %v", lines)
	}
}

// TestReadFileLinesFiltered_FileNotExist: 文件不存在不报错，返回空数组。
// 这一行为对齐 internal/api/logs.go 现有 Query 的"日志文件不存在时返回空"。
func TestReadFileLinesFiltered_FileNotExist(t *testing.T) {
	lines, err := ReadFileLinesFiltered("/nonexistent/path/frpc.log", 10, func(string) bool { return true })
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if len(lines) != 0 {
		t.Fatalf("expected empty, got %v", lines)
	}
}
