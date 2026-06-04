// Package services 桥接上游 frp 客户端库与本项目 daemon。本文件提供 daemon
// 在调用 svc.Run(ctx) 前往 ctx 里注入「每个 frpc 实例独立的 xlog 前缀」的 helper。
package services

import (
	"context"

	"github.com/fatedier/frp/pkg/util/xlog"
)

const (
	instancePrefixName = "instance"
	// instancePrefixPriority makes the [inst=<id>] tag sort before any prefix
	// frp itself adds (frp's defaults use Priority=10). Lower number = earlier.
	instancePrefixPriority = 1
)

// NewInstanceContext 创建一个新的 context，其中注入了以 instanceID 为标识的
// xlog 前缀（格式：[inst=<instanceID>]），用于在同一进程中运行多个 frpc
// 实例时区分各实例的日志输出。
func NewInstanceContext(parent context.Context, instanceID string) context.Context {
	xl := xlog.New()
	xl.AddPrefix(xlog.LogPrefix{
		Name:     instancePrefixName,
		Value:    "inst=" + instanceID,
		Priority: instancePrefixPriority,
	})
	return xlog.NewContext(parent, xl)
}
