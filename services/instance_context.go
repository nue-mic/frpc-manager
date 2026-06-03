// Package services 桥接上游 frp 客户端库与本项目 daemon。本文件提供 daemon
// 在调用 svc.Run(ctx) 前往 ctx 里注入「每个 frpc 实例独立的 xlog 前缀」的 helper。
package services

import (
	"context"
	"reflect"

	"github.com/fatedier/frp/pkg/util/xlog"
)

const (
	InstancePrefixName     = "instance"
	InstancePrefixPriority = 1
)

// NewInstanceContext 创建一个新的 context，其中注入了以 instanceID 为标识的
// xlog 前缀（格式：[inst=<instanceID>]），用于在同一进程中运行多个 frpc
// 实例时区分各实例的日志输出。
func NewInstanceContext(parent context.Context, instanceID string) context.Context {
	xl := xlog.New()
	xl.AddPrefix(xlog.LogPrefix{
		Name:     InstancePrefixName,
		Value:    "inst=" + instanceID,
		Priority: InstancePrefixPriority,
	})
	return xlog.NewContext(parent, xl)
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
