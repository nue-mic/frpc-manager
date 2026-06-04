package services

import (
	"context"
	"reflect"
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
	if got != want {
		t.Fatalf("expected prefix to equal %q, got %q", want, got)
	}
}

func TestNewInstanceContext_PreservesParentCancel(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	ctx := NewInstanceContext(parent, "abc")
	cancel()
	// xlog.NewContext uses context.WithValue, which propagates the parent's
	// Done channel directly — so cancellation is observable synchronously here.
	select {
	case <-ctx.Done():
		// ok
	default:
		t.Fatal("expected child ctx to be canceled when parent is canceled")
	}
}

func newCtxPrefixesForTest(ctx context.Context) string {
	xl := xlog.FromContextSafe(ctx)
	if xl == nil {
		return ""
	}
	return dumpPrefixesForTest(xl)
}

func dumpPrefixesForTest(xl *xlog.Logger) string {
	v := reflect.ValueOf(xl).Elem().FieldByName("prefixes")
	if !v.IsValid() {
		return ""
	}
	var out string
	for i := 0; i < v.Len(); i++ {
		val := v.Index(i).FieldByName("Value").String()
		out += "[" + val + "]"
	}
	return out
}
