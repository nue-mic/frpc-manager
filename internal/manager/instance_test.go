package manager

import (
	"context"
	"reflect"
	"testing"

	"github.com/fatedier/frp/pkg/util/xlog"
)

// TestRunLoopInjectsInstancePrefix: runLoop 在调用 svc.Run 之前应在 ctx 上
// 叠加一个带 [inst=<id>] 前缀的 xlog.Logger。
//
// svc 是 *services.FrpClientService（难 mock），改用直接调用 instance 的私有
// helper instanceCtx(parent) 验证。Task 3 的实现会暴露这个 helper。
func TestRunLoopInjectsInstancePrefix(t *testing.T) {
	inst := &instance{id: "dt_116_frps"}
	ctx := inst.instanceCtx(context.Background())

	xl := xlog.FromContextSafe(ctx)
	if xl == nil {
		t.Fatal("expected xlog logger in ctx")
	}
	v := reflect.ValueOf(xl).Elem().FieldByName("prefixes")
	if !v.IsValid() || v.Len() == 0 {
		t.Fatal("expected at least one prefix")
	}
	found := false
	for i := 0; i < v.Len(); i++ {
		if v.Index(i).FieldByName("Value").String() == "inst=dt_116_frps" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected prefix Value=inst=dt_116_frps")
	}
}
