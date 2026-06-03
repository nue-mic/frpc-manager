package services

import (
	"context"
	"strings"
	"testing"

	"github.com/fatedier/frp/pkg/util/xlog"
)

func TestNewInstanceContext_AddsInstancePrefix(t *testing.T) {
	parent := context.Background()
	ctx := NewInstanceContext(parent, "dt_116_frps")

	xl := xlog.FromContextSafe(ctx)
	if xl == nil {
		t.Fatal("expected xlog.Logger to be present in ctx")
	}

	// 通过格式化一条日志验证前缀就位
	got := newCtxPrefixesForTest(ctx)
	want := "[inst=dt_116_frps]"
	if !strings.Contains(got, want) {
		t.Fatalf("expected prefix to contain %q, got %q", want, got)
	}
}

func TestNewInstanceContext_PreservesParentCancel(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	ctx := NewInstanceContext(parent, "abc")
	cancel()
	select {
	case <-ctx.Done():
		// ok
	default:
		t.Fatal("expected child ctx to be canceled when parent is canceled")
	}
}
