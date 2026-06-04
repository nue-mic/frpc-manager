# FRPC 实例日志按 xlog 前缀隔离 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标 (Goal):** 让多个 frpc 实例同进程运行时，每个实例在 UI 上看到的"运行日志速览"只包含自己的日志，不再被其他实例的 heartbeat 等输出污染。

**架构 (Architecture):** 不 fork frp 库、不上子进程方案。改造为「合并日志文件 + xlog 前缀注入 + 后端按 `[inst=<id>]` 前缀过滤」三步走：(1) daemon 在调用 `svc.Run(ctx)` 前往 ctx 里塞一个带 `inst=<id>` 前缀的 `xlog.Logger`，frp 内部 128 处 `xl.*` 调用会自动带上这个前缀；(2) 所有 frpc 实例统一写到 `{logsDir}/frpc.log`（合并日志）；(3) `GET /configs/{id}/logs` 与 WS `/logs/tail` 改为读取合并日志后按前缀过滤，`DELETE /logs` 改为更新 `LogViewSince[id]` 时间戳（逻辑清空）。前端 0 改动。

**技术栈 (Tech Stack):** Go 1.25 / 标准库 (context, bufio, encoding/json) / `github.com/fatedier/frp v0.69.1` (pkg/util/xlog) / `github.com/coder/websocket` / `github.com/fsnotify/fsnotify` / 项目自身 `internal/logtail` 包

---

## 背景知识（执行前必读）

### 根因回顾

`services/client.go:179` 的 `log.Logger = log.Logger.WithOptions(options...)` 改的是上游 frp 库 [pkg/util/log/log.go:32](https://github.com/fatedier/frp/blob/v0.69.1/pkg/util/log/log.go#L32) 的全局变量 `var Logger *log.Logger`。多个 frpc 实例同进程启动时，**谁后启动谁就赢**——先启动的旧实例此后所有日志（heartbeat、reconnect、proxy 状态）会全部跑到新实例的 .log 文件里。

### 为什么 xlog 方案能解决这个问题

frp 内部用 `xlog.Logger.prefixString` 机制：所有 `xl.Infof("send heartbeat...")` 都会自动在格式串前拼上 `prefixString`（形如 `[runID-xxx] `）。`xlog.Logger` 由 `ctx` 携带，`client.Service.Run(ctx)` 入口处 `svr.ctx = xlog.NewContext(ctx, xlog.FromContextSafe(ctx))` 会**保留我们传入 ctx 的 logger 并贯穿整个生命周期**。

因此只要 daemon 在起 svc 时往 ctx 里塞一个 `xlog.New().AppendPrefix("inst=<id>")` 的 logger，frp 内部 128 处 `xl.*` 调用都会自动带上 `[inst=<id>]`。后端按这个前缀过滤就能还原"每个实例独立日志"的体验。

### 已知不会带前缀的 12 处裸 `log.*` 调用（游离日志）

- `client/service.go` line 235/240/242/250/252：vnet 控制器 + admin webServer 启动 — 默认都不启用
- `client/config_manager.go` line 52/196/228/249/297/329/350：reload conf 成功 + store 子系统 (proxy/visitor 增删改) — store 默认也不启用

游离日志只有 `success reload conf` 一条会在常规使用中触发。我们的策略是：**保留它们写入合并日志但不带 inst 前缀；前端默认不显示游离日志；提供一个"全局日志"页面（本计划不实现，作为后续工作记录）**。

### 前缀格式规范

```
[inst=dt_116_frps] [267eacf26d676612] send heartbeat to server
↑                  ↑
daemon 注入         frp 自己在 service.go:327 注入的 runID
```

前缀里的 `inst=<id>` 用 `=` 而不是 `:` 是为了与 frp 自己的 `runID-...` 风格区分（frp 用 Value 直接拼，没有 key），减少误判风险。`id` 来自 [internal/manager/manager.go:415-422](internal/manager/manager.go#L415) 的 `validateID`，已禁掉 `/\:?*<>|"'` 等字符，**不会包含 `]` `[` 空格**，可以安全用作前缀字面值。

### 合并日志文件路径

- 路径：`{LogsDir}/frpc.log`（与现有 per-id `.log` **同目录**，frp 的 `RotateFileWriter` 会按天滚动为 `frpc.20260603-153000.log`，`util.FindLogFiles` 现有逻辑直接复用）
- `LogsDir` 来自 [internal/appcfg/appcfg.go:38](internal/appcfg/appcfg.go#L38)：`{DataDir}/logs`，生产默认 `/var/lib/frpmgrd/logs`

### LogViewSince 机制（取代物理删除）

`DELETE /api/v1/configs/{id}/logs` 不能再删整个 `frpc.log`（会清掉所有实例数据）。改为：
- 在 `meta.json` 里加 `log_view_since: {id: unix_milli}` 映射
- `GET /logs` 与 `WS /logs/tail` 都在过滤时增加判断："时间戳必须 ≥ LogViewSince[id]"
- `DELETE /logs` 仅更新这个戳，前端立即看不到旧数据；物理日志保留供运维 grep

日志行的时间戳从行首解析（frp 行格式：`2026-06-03 15:18:20.546 [D] [...]`）。

### 提交规范

每个任务的 commit 必须遵守：Conventional Commits + 中文描述。scope 优先用文件所在子系统：
- `feat(manager)`：manager 包变更
- `feat(api)`：HTTP/WS 接口变更
- `feat(services)`：services 包变更
- `refactor(util)`：util 包变更
- `test(xxx)`：仅测试代码
- `docs(api)`：API 文档同步

---

## 文件结构概览

```
新建文件
  pkg/util/file_filtered.go              # ReadFileLinesFiltered + 时间戳解析
  pkg/util/file_filtered_test.go         # 单测
  services/instance_context.go           # NewInstanceContext helper（拆出来便于测试）
  services/instance_context_test.go      # 单测

修改文件
  services/client.go                     # Run() -> Run(ctx)
  internal/manager/instance.go           # runLoop 注入 xlog ctx
  internal/manager/manager.go            # data.LogFile 统一为 frpc.log
  internal/manager/meta.go               # 加 LogViewSince 字段 + setLogViewSince
  internal/manager/meta_test.go          # 加 LogViewSince 单测（若已存在则追加）
  internal/api/logs.go                   # logPath / Query / Tail / Clear 全部改造
  internal/api/logs_test.go              # 接口集成测试（若已存在则追加）
  internal/api/server.go                 # 把 Manager 引用透传给 LogsHandler（用于读 LogViewSince）
  docs/API.zh-CN.md                      # 更新日志接口文档与游离日志说明
```

---

## Task 1: 抽出 `NewInstanceContext` helper

**Files:**
- Create: `services/instance_context.go`
- Create: `services/instance_context_test.go`

- [ ] **Step 1.1: 写失败测试** — 验证 helper 返回的 ctx 能被 `xlog.FromContextSafe` 取出，且 prefixString 含 `[inst=<id>] `

创建 `services/instance_context_test.go`:

```go
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
	// xlog 把 prefixString 直接拼在 format 前；我们用 Spawn 拿到拷贝便于断言
	spawned := xl.Spawn()
	// renderPrefixString 在 Spawn 时已重算
	// 由于 prefixString 是私有字段，我们改为通过实际 Errorf 走 frp 全局 Logger 不现实；
	// 退而求其次：断言新 prefix 在 prefixes 列表里（通过反复 AppendPrefix 同 key 会覆盖来侧面验证）
	spawned.AppendPrefix("probe")
	// 这里只能间接验证：Spawn 后的 logger 至少不为空
	_ = spawned

	// 主要断言：父 ctx 派生时不出错；instance id 在 helper 中以 "inst=<id>" 形式写入
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
```

- [ ] **Step 1.2: 运行测试确认失败**

```bash
go test ./services/ -run TestNewInstanceContext -v
```

预期：编译失败，`undefined: NewInstanceContext` + `undefined: newCtxPrefixesForTest`

- [ ] **Step 1.3: 实现 helper + 测试用 prefix dump**

创建 `services/instance_context.go`:

```go
// Package services 桥接上游 frp 客户端库与本项目 daemon。本文件提供 daemon
// 在调用 svc.Run(ctx) 前往 ctx 里注入「每个 frpc 实例独立的 xlog 前缀」的 helper。
//
// 背景：上游 frp v0.69.1 用全局 logger 变量；多实例同进程时日志会互串。
// 通过 xlog.NewContext 注入带 [inst=<id>] 前缀的 logger，daemon 即可在合并
// 日志中按前缀分离每个实例的输出。
package services

import (
	"context"

	"github.com/fatedier/frp/pkg/util/xlog"
)

// InstancePrefixName 是 xlog.LogPrefix 的 Name 字段，用作 AddPrefix 覆盖时
// 的主键。同名 prefix 重复 AddPrefix 会覆盖 Value，确保 daemon 重启实例时
// 不会累积重复前缀。
const InstancePrefixName = "instance"

// InstancePrefixPriority 控制前缀排序。frp 内部加 runID 时用默认 priority=10；
// 我们用 1 让 inst= 显示在最前面，便于人眼扫读和正则匹配。
const InstancePrefixPriority = 1

// NewInstanceContext 返回一个派生 ctx，其中携带一个新的 xlog.Logger，logger
// 的 prefixes 已经追加 `[inst=<id>] ` 前缀。frp 内部所有通过 xlog 输出的
// 日志（128 处 xl.* 调用）都会自动带上这个前缀。
//
// 注意：xlog.Logger 不是并发安全的「prefix 操作」，但本函数只在 daemon
// 启动实例时单线程调用一次；后续 frp 会在登录成功后 AddPrefix(runID)，
// 这两次写入之间有 happens-before（daemon 调 svc.Run 后才进入 frp 内部），
// 因此不会 race。
func NewInstanceContext(parent context.Context, instanceID string) context.Context {
	xl := xlog.New()
	xl.AddPrefix(xlog.LogPrefix{
		Name:     InstancePrefixName,
		Value:    "inst=" + instanceID,
		Priority: InstancePrefixPriority,
	})
	return xlog.NewContext(parent, xl)
}

// newCtxPrefixesForTest 仅供同包测试使用，返回从 ctx 中取出的 xlog.Logger
// 当前所有前缀拼接的字符串。生产代码不应调用。
func newCtxPrefixesForTest(ctx context.Context) string {
	xl := xlog.FromContextSafe(ctx)
	if xl == nil {
		return ""
	}
	// 通过 Spawn 复制 prefixes，再追加一个固定 probe 触发 renderPrefixString，
	// 然后用 strings.Builder 把每个前缀重新拼出来。
	spawned := xl.Spawn()
	// xlog.Logger 的 prefixes 是私有字段；这里走"已 Spawn 出来的可读 String"路径
	// 失败，所以我们换种思路：让调用方调用 spawned.Infof("...") 不可行因为会写文件。
	// 实际可观察的只有 spawned 自己。为了测试用我们暂时使用反射读私有字段。
	return dumpPrefixesForTest(spawned)
}
```

由于 `xlog.Logger.prefixes` 是私有字段，测试断言要靠反射。补一个内部 helper：

补到同文件末尾：

```go
import "reflect"

// dumpPrefixesForTest 反射读 xlog.Logger.prefixes（私有字段），返回
// 类似 "[inst=foo] [runID-bar] " 的拼接串。仅测试用。
func dumpPrefixesForTest(xl *xlog.Logger) string {
	v := reflect.ValueOf(xl).Elem().FieldByName("prefixes")
	if !v.IsValid() {
		return ""
	}
	var out string
	for i := 0; i < v.Len(); i++ {
		entry := v.Index(i)
		val := entry.FieldByName("Value").String()
		out += "[" + val + "]"
	}
	return out
}
```

> ⚠️ 注意：上面 import 块需要合并到文件顶部。完整文件应为单一 import 块，把 `"reflect"` 和 `"context"` `"github.com/fatedier/frp/pkg/util/xlog"` 放一起。

整理后的完整 `services/instance_context.go`:

```go
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

// NewInstanceContext 见包级文档。
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
```

- [ ] **Step 1.4: 运行测试确认通过**

```bash
go test ./services/ -run TestNewInstanceContext -v
```

预期：两个测试均 PASS

- [ ] **Step 1.5: 提交**

```bash
git add services/instance_context.go services/instance_context_test.go
git commit -m "feat(services): 新增 NewInstanceContext 注入 xlog 实例前缀"
```

---

## Task 2: 把 `FrpClientService.Run()` 改为 `Run(ctx)`

**Files:**
- Modify: `services/client.go:97-109`
- Modify: `internal/manager/instance.go:326` (唯一调用方)

- [ ] **Step 2.1: 写失败测试** — 验证 `Run(ctx)` 透传 ctx 给 `svr.Run`

`FrpClientService.svr` 是上游 frp 的 `*client.Service`，难以 mock。改为写一个不需要真连 frps 的测试：构造一个 ctx 被立即 cancel，调用 `Run(ctx)`，断言 Run 在 ctx 已 cancel 时快速退出而不死等。

在 `services/client.go` 同包追加 `services/client_test.go`（新建）：

```go
package services

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestRun_RespectsCtxCancel：调用 Run(ctx)，ctx 在 50ms 内 cancel，
// Run 应在 ~5s 内返回（远短于 frpc 默认无限重连的时长）。
// 这间接证明 ctx 被透传到了 svr.Run；如果 Run 仍然写死 context.Background()，
// 测试会超时失败。
func TestRun_RespectsCtxCancel(t *testing.T) {
	tmpDir := t.TempDir()
	cfgPath := filepath.Join(tmpDir, "test.toml")
	// 写一份指向不存在的 frps 的最小 toml；Login 会失败但 loginFailExit=true 让它快速退出
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
		close(done)
	}()

	// 让它跑 50ms 然后 cancel
	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case <-done:
		// ok
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not exit within 5s after ctx cancel")
	}
}
```

- [ ] **Step 2.2: 运行测试确认失败**

```bash
go test ./services/ -run TestRun_RespectsCtxCancel -v
```

预期：编译失败 `cannot use ctx (variable of type context.Context) as type ... in argument to svc.Run`，因为现在 `Run` 不收参数。

- [ ] **Step 2.3: 改实现 — `Run() -> Run(ctx)`**

编辑 `services/client.go:97-109`：

```go
// Run starts frp client service in blocking mode.
// ctx 用于让 daemon 在 stop 时取消 frp 内部循环；同时 ctx 携带的 xlog.Logger
// 会让 frp 内部 xl.* 调用自动带上 [inst=<id>] 前缀，便于在合并日志中按实例分流。
func (s *FrpClientService) Run(ctx context.Context) {
	defer close(s.done)
	if s.file != "" {
		log.Infof("start frpc service for config file [%s] with aggregated configuration", s.file)
		defer log.Infof("frpc service for config file [%s] stopped", s.file)
	}

	// There's no guarantee that this function will return after a close call.
	// So we can't wait for the Run function to finish.
	if err := s.svr.Run(ctx); err != nil {
		log.Errorf("run service error: %v", err)
	}
}
```

- [ ] **Step 2.4: 更新唯一调用方 `internal/manager/instance.go:326`**

定位 `runLoop` 内的 `go func() { svc.Run(); close(doneCh) }()`，改为：

```go
	go func() {
		// runCtx 由 start() 时通过 context.WithCancel(parent) 派生；本任务暂时
		// 直接透传给 svc.Run。Task 3 会在这里再包一层 xlog.NewContext 注入
		// instance id 前缀。
		svc.Run(runCtx)
		close(doneCh)
	}()
```

- [ ] **Step 2.5: 运行所有相关测试**

```bash
go vet ./...
go test ./services/ -run TestRun_RespectsCtxCancel -v
go test ./internal/manager/ -v
```

预期：全部 PASS

- [ ] **Step 2.6: 提交**

```bash
git add services/client.go services/client_test.go internal/manager/instance.go
git commit -m "refactor(services): FrpClientService.Run 接收外部 ctx 以支持取消与 xlog 注入"
```

---

## Task 3: instance.runLoop 注入 xlog 前缀

**Files:**
- Modify: `internal/manager/instance.go` (import + runLoop)

- [ ] **Step 3.1: 写失败测试** — 验证 instance 启动时透传给 svc.Run 的 ctx 含 `[inst=<id>]`

在 `internal/manager/instance_test.go`（不存在则新建）追加：

```go
package manager

import (
	"context"
	"reflect"
	"testing"

	"github.com/fatedier/frp/pkg/util/xlog"
)

// TestRunLoopInjectsInstancePrefix：runLoop 在调用 svc.Run 之前应在 ctx 上
// 叠加一个带 [inst=<id>] 前缀的 xlog.Logger。
//
// 由于 svc 是 *services.FrpClientService（难 mock），改用直接调用 instance
// 的私有 helper instanceCtx(parent) 验证。Task 3 的实现会暴露这个 helper。
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
```

- [ ] **Step 3.2: 运行测试确认失败**

```bash
go test ./internal/manager/ -run TestRunLoopInjectsInstancePrefix -v
```

预期：编译失败 `inst.instanceCtx undefined`。

- [ ] **Step 3.3: 在 instance.go 加 `instanceCtx` helper 并在 runLoop 调用**

编辑 `internal/manager/instance.go`，在 import 区加：

```go
import (
	// ... 现有 imports ...
	"github.com/mia-clark/frp-manager-server/services"
)
```

在 instance struct 定义之后、`newInstance` 之前插入：

```go
// instanceCtx 在 parent ctx 上叠加 xlog 前缀 [inst=<id>]。Run 时调用，
// 让 frp 内部 128 处 xl.* 调用自动带上前缀，便于合并日志按实例过滤。
func (i *instance) instanceCtx(parent context.Context) context.Context {
	return services.NewInstanceContext(parent, i.id)
}
```

定位 `runLoop` 内 Task 2 已改成的：

```go
	go func() {
		svc.Run(runCtx)
		close(doneCh)
	}()
```

改为：

```go
	go func() {
		// 注入 [inst=<id>] xlog 前缀，让 frp 内部输出在合并日志中可按实例分流。
		svc.Run(i.instanceCtx(runCtx))
		close(doneCh)
	}()
```

- [ ] **Step 3.4: 运行测试确认通过**

```bash
go test ./internal/manager/ -run TestRunLoopInjectsInstancePrefix -v
go vet ./...
```

预期：PASS

- [ ] **Step 3.5: 提交**

```bash
git add internal/manager/instance.go internal/manager/instance_test.go
git commit -m "feat(manager): runLoop 注入 xlog 实例前缀以支持合并日志按实例分流"
```

---

## Task 4: 统一 LogFile 到 `frpc.log`（合并日志）

**Files:**
- Modify: `internal/manager/manager.go:400`
- Modify: `internal/manager/manager.go` — 加 const `CombinedLogFileName = "frpc.log"` 与对外暴露的 `CombinedLogPath` 方法

- [ ] **Step 4.1: 写失败测试** — 验证 writeConfig 后 toml 里 `LogFile` 字段是 `<LogsDir>/frpc.log`

在 `internal/manager/manager_test.go`（不存在则新建）追加：

```go
package manager

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestWriteConfig_UsesCombinedLogFile：每个 instance 的 toml 写出后，
// LogFile 字段应统一指向 LogsDir/frpc.log，而不是 per-id 的 <id>.log。
func TestWriteConfig_UsesCombinedLogFile(t *testing.T) {
	tmp := t.TempDir()
	logsDir := filepath.Join(tmp, "logs")
	profilesDir := filepath.Join(tmp, "profiles")
	storesDir := filepath.Join(tmp, "stores")
	for _, d := range []string{logsDir, profilesDir, storesDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}

	m := &Manager{opts: Options{
		LogsDir:     logsDir,
		ProfilesDir: profilesDir,
		StoresDir:   storesDir,
	}}

	// 用 pkg/config.NewDefaultClientConf 简化构造（项目里已有 helper）
	// 这里直接读已有的最小 toml fixture；若没有则就地写一个
	cfgPath := filepath.Join(profilesDir, "abc.toml")
	if err := os.WriteFile(cfgPath, []byte(`serverAddr="127.0.0.1"
serverPort=7000
`), 0o644); err != nil {
		t.Fatalf("seed toml: %v", err)
	}

	// 解析 -> writeConfig -> 重读
	data, err := loadClientConfigForTest(cfgPath)
	if err != nil {
		t.Fatalf("loadClientConfigForTest: %v", err)
	}
	if err := m.writeConfig(cfgPath, data); err != nil {
		t.Fatalf("writeConfig: %v", err)
	}

	got, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("readback: %v", err)
	}
	want := filepath.ToSlash(filepath.Join(logsDir, "frpc.log"))
	if !strings.Contains(string(got), want) {
		t.Fatalf("expected LogFile to contain %q, got toml:\n%s", want, got)
	}
}
```

如果 `loadClientConfigForTest` 不存在则使用项目已有的 `config.UnmarshalClientConf` 直接读 toml，封装：

```go
// loadClientConfigForTest 帮 Task 4 的测试读 toml 文件返回 *config.ClientConfig。
// 放在 manager_test.go 内部以避免污染生产 API。
func loadClientConfigForTest(path string) (*config.ClientConfig, error) {
	return config.UnmarshalClientConf(path)
}
```

并加 import `"github.com/mia-clark/frp-manager-server/pkg/config"`.

- [ ] **Step 4.2: 运行测试确认失败**

```bash
go test ./internal/manager/ -run TestWriteConfig_UsesCombinedLogFile -v
```

预期：FAIL，期望 `<logsDir>/frpc.log`，实际是 `<logsDir>/abc.log`（per-id）

- [ ] **Step 4.3: 改 manager.go**

定位 `internal/manager/manager.go:400`：

```go
	data.LogFile = filepath.ToSlash(filepath.Join(m.opts.LogsDir, id+".log"))
```

改为：

```go
	// 合并日志：所有 frpc 实例共写 frpc.log，依赖 daemon 注入的 xlog 前缀
	// [inst=<id>] 在读取侧按实例过滤。详见 docs/superpowers/plans/2026-06-03-frpc-log-isolation-via-xlog-prefix.md
	data.LogFile = filepath.ToSlash(filepath.Join(m.opts.LogsDir, CombinedLogFileName))
```

并在 manager.go 顶部 import 块下面（或 const 区）加：

```go
// CombinedLogFileName 是所有 frpc 实例共用的合并日志文件名。
// 完整路径由 Options.LogsDir 拼成。
const CombinedLogFileName = "frpc.log"

// CombinedLogPath 返回合并日志的绝对路径。给 internal/api/logs.go 用。
func (m *Manager) CombinedLogPath() string {
	return filepath.Join(m.opts.LogsDir, CombinedLogFileName)
}
```

- [ ] **Step 4.4: 运行测试确认通过**

```bash
go test ./internal/manager/ -run TestWriteConfig_UsesCombinedLogFile -v
go vet ./...
```

预期：PASS

- [ ] **Step 4.5: 提交**

```bash
git add internal/manager/manager.go internal/manager/manager_test.go
git commit -m "feat(manager): 所有 frpc 实例 LogFile 统一为合并日志 frpc.log"
```

---

## Task 5: `pkg/util/file.go` 新增 `ReadFileLinesFiltered`

**Files:**
- Create: `pkg/util/file_filtered.go`
- Create: `pkg/util/file_filtered_test.go`

- [ ] **Step 5.1: 写失败测试** — 反向读取、按 predicate 过滤、凑够 N 行

创建 `pkg/util/file_filtered_test.go`:

```go
package util

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestReadFileLinesFiltered_KeepsOnlyMatchingLines：写一个混合两实例日志的文件，
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

// TestReadFileLinesFiltered_LimitsToN：N=2 时只返回最后 2 条匹配行（按文件顺序）。
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

// TestReadFileLinesFiltered_FileNotExist：文件不存在不报错，返回空数组。
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
```

- [ ] **Step 5.2: 运行测试确认失败**

```bash
go test ./pkg/util/ -run TestReadFileLinesFiltered -v
```

预期：编译失败 `undefined: ReadFileLinesFiltered`

- [ ] **Step 5.3: 实现**

创建 `pkg/util/file_filtered.go`:

```go
package util

import (
	"bufio"
	"errors"
	"io/fs"
	"os"
)

// ReadFileLinesFiltered 顺序读取整个文件，丢弃所有 filter 返回 false 的行，
// 然后返回过滤后**最后 n 条**（按文件顺序）。
//
// 设计说明：
//   - 对合并日志场景，单实例感兴趣的行通常远少于全文件，先扫一遍再截 N 是
//     最简单可读的实现；用环形缓冲避免一次性把整个 filtered 切片驻留内存。
//   - 文件不存在视作"空日志"（实例从未启动过），不报错，返回空切片。
//   - n <= 0 时被视作"不限制"，全部返回。
//   - filter 为 nil 时全部匹配。
func ReadFileLinesFiltered(path string, n int, filter func(string) bool) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return []string{}, nil
		}
		return nil, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	// 日志单行最大 1 MiB；默认 64 KiB 对长 stack trace 不够。
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	if filter == nil {
		filter = func(string) bool { return true }
	}

	if n <= 0 {
		out := make([]string, 0, 256)
		for scanner.Scan() {
			line := scanner.Text()
			if filter(line) {
				out = append(out, line)
			}
		}
		if err := scanner.Err(); err != nil {
			return nil, err
		}
		return out, nil
	}

	// 环形缓冲：固定大小 n，超出后覆盖最旧。
	buf := make([]string, n)
	count, idx := 0, 0
	for scanner.Scan() {
		line := scanner.Text()
		if !filter(line) {
			continue
		}
		buf[idx] = line
		idx = (idx + 1) % n
		count++
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	// 还原顺序：count <= n 时 buf[:count]；否则从 idx 开始环绕
	if count <= n {
		return buf[:count], nil
	}
	out := make([]string, 0, n)
	out = append(out, buf[idx:]...)
	out = append(out, buf[:idx]...)
	return out, nil
}
```

- [ ] **Step 5.4: 运行测试确认通过**

```bash
go test ./pkg/util/ -run TestReadFileLinesFiltered -v
```

预期：3 个测试均 PASS

- [ ] **Step 5.5: 提交**

```bash
git add pkg/util/file_filtered.go pkg/util/file_filtered_test.go
git commit -m "feat(util): 新增 ReadFileLinesFiltered 支持按 predicate 过滤读取最后 N 行"
```

---

## Task 6: `meta.go` 加 `LogViewSince` 字段与 setter

**Files:**
- Modify: `internal/manager/meta.go`
- Modify: `internal/manager/meta_test.go` (新建)

- [ ] **Step 6.1: 写失败测试**

创建 `internal/manager/meta_test.go`:

```go
package manager

import (
	"os"
	"path/filepath"
	"testing"
)

// TestMetaLogViewSince_RoundTrip：setLogViewSince 写入的戳能从磁盘读回。
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

// TestMetaLogViewSince_DropIDs：dropIDs 应同时清除 LogViewSince 中的对应键。
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

// TestMetaLogViewSince_BackwardCompatRead：旧 meta.json 不含 log_view_since 字段时，
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
```

- [ ] **Step 6.2: 运行测试确认失败**

```bash
go test ./internal/manager/ -run TestMetaLogViewSince -v
```

预期：编译失败 `m.LogViewSince undefined`, `store.setLogViewSince undefined`

- [ ] **Step 6.3: 实现**

编辑 `internal/manager/meta.go`：

(a) 在 `type Meta struct` 加字段（保留 `omitempty` 以保持旧版兼容）：

```go
type Meta struct {
	Version      int              `json:"version"`
	AutoStart    []string         `json:"auto_start"`
	Sort         []string         `json:"sort"`
	LogViewSince map[string]int64 `json:"log_view_since,omitempty"`
}
```

(b) `defaultMeta()` 初始化空 map：

```go
func defaultMeta() *Meta {
	return &Meta{
		Version:      1,
		AutoStart:    []string{},
		Sort:         []string{},
		LogViewSince: map[string]int64{},
	}
}
```

(c) `openMetaStore` 反序列化后兜底（紧挨现有 nil 检查）：

```go
		if s.data.LogViewSince == nil {
			s.data.LogViewSince = map[string]int64{}
		}
```

(d) `snapshot` 复制 map：

```go
func (s *metaStore) snapshot() Meta {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := *s.data
	m.AutoStart = append([]string(nil), s.data.AutoStart...)
	m.Sort = append([]string(nil), s.data.Sort...)
	m.LogViewSince = make(map[string]int64, len(s.data.LogViewSince))
	for k, v := range s.data.LogViewSince {
		m.LogViewSince[k] = v
	}
	return m
}
```

(e) 新增 `setLogViewSince`：

```go
// setLogViewSince 记录"用户在 unixMilli 时刻清空了 id 的日志视图"。
// GET /logs 和 WS /logs/tail 后续会跳过时间戳早于此值的行，达到逻辑清空效果。
func (s *metaStore) setLogViewSince(id string, unixMilli int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.LogViewSince == nil {
		s.data.LogViewSince = map[string]int64{}
	}
	s.data.LogViewSince[id] = unixMilli
	return s.flushLocked()
}

// logViewSince 读取指定 id 的清空戳；不存在返回 0（表示"显示所有历史"）。
func (s *metaStore) logViewSince(id string) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.LogViewSince[id]
}
```

(f) 修改 `dropIDs` 同步清 LogViewSince：

```go
func (s *metaStore) dropIDs(ids ...string) error {
	if len(ids) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	idset := make(map[string]struct{}, len(ids))
	for _, x := range ids {
		idset[x] = struct{}{}
	}
	s.data.AutoStart = filterOut(s.data.AutoStart, idset)
	s.data.Sort = filterOut(s.data.Sort, idset)
	for id := range idset {
		delete(s.data.LogViewSince, id)
	}
	return s.flushLocked()
}
```

- [ ] **Step 6.4: 在 Manager 上暴露 LogViewSince 读写 API**

编辑 `internal/manager/manager.go`，在文件末尾加：

```go
// LogViewSince 返回指定 id 的"日志逻辑清空时间戳"（Unix 毫秒）。
// 用于 internal/api/logs.go 过滤合并日志时丢弃旧行。0 表示从未清空。
func (m *Manager) LogViewSince(id string) int64 {
	return m.meta.logViewSince(id)
}

// SetLogViewSince 记录用户"清空日志"操作。internal/api/logs.go 在 Clear
// 接口里调用本方法，并通过 eventbus 广播让前端立即刷新（如果需要）。
func (m *Manager) SetLogViewSince(id string, unixMilli int64) error {
	return m.meta.setLogViewSince(id, unixMilli)
}
```

- [ ] **Step 6.5: 运行测试确认通过**

```bash
go test ./internal/manager/ -run TestMetaLogViewSince -v
go vet ./...
```

预期：3 个测试均 PASS

- [ ] **Step 6.6: 提交**

```bash
git add internal/manager/meta.go internal/manager/manager.go internal/manager/meta_test.go
git commit -m "feat(manager): meta.json 增加 LogViewSince 支持逻辑清空日志视图"
```

---

## Task 7: 改造 `internal/api/logs.go` — Query 走合并日志 + 过滤

**Files:**
- Modify: `internal/api/logs.go` (Query 方法)
- Modify: `internal/api/server.go` (NewLogsHandler 传 Manager 引用)
- Modify: `internal/api/logs_test.go` (新建)

- [ ] **Step 7.1: 写失败测试**

创建 `internal/api/logs_test.go`:

```go
package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mia-clark/frp-manager-server/internal/manager"
)

// TestLogsQuery_FiltersByInstancePrefix：合并日志含 A/B 两实例的行，
// GET /api/v1/configs/A/logs 只应返回 A 的行。
func TestLogsQuery_FiltersByInstancePrefix(t *testing.T) {
	tmp := t.TempDir()
	logsDir := filepath.Join(tmp, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	combined := filepath.Join(logsDir, "frpc.log")
	body := strings.Join([]string{
		"2026-06-03 15:17:41.437 [I] [inst=A] try to connect",
		"2026-06-03 15:17:50.544 [D] [inst=B] heartbeat",
		"2026-06-03 15:18:20.416 [E] [inst=A] login fail",
		"",
	}, "\n")
	if err := os.WriteFile(combined, []byte(body), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	m := newTestManager(t, tmp) // 见辅助函数
	// 让 manager 认为 id=A 存在
	mustCreateInstance(t, m, "A")
	mustCreateInstance(t, m, "B")

	h := NewLogsHandler(m, logsDir, testLogger(), []string{"*"})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/configs/A/logs?lines=10", nil)
	req = withPathID(req, "A") // 用 chi 路由的等价 helper
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
```

辅助函数 `newTestManager` / `mustCreateInstance` / `withPathID` / `testLogger` 加在同文件末尾：

```go
import (
	"context"
	"log/slog"
	"github.com/go-chi/chi/v5"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
}

func newTestManager(t *testing.T, dataDir string) *manager.Manager {
	t.Helper()
	opts := manager.Options{
		DataDir:     dataDir,
		ProfilesDir: filepath.Join(dataDir, "profiles"),
		LogsDir:     filepath.Join(dataDir, "logs"),
		StoresDir:   filepath.Join(dataDir, "stores"),
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
	// 最小 toml：仅含 serverAddr，由 manager.Create 写到 ProfilesDir
	body := `serverAddr = "127.0.0.1"
serverPort = 7000
`
	if _, err := m.Create(context.Background(), id, []byte(body)); err != nil {
		t.Fatalf("Create %s: %v", id, err)
	}
}

func withPathID(r *http.Request, id string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", id)
	return r.WithContext(context.WithValue(r.Context(), chi.RouteCtxKey, rctx))
}
```

> ⚠️ `manager.New` / `manager.Create` 的真实签名以源码为准；若签名不一致，本测试需要调整。运行 `go vet` 时会直接报错暴露不一致。

- [ ] **Step 7.2: 运行测试确认失败**

```bash
go test ./internal/api/ -run TestLogsQuery_FiltersByInstancePrefix -v
```

预期：FAIL 或编译错误（logPath 仍指向 per-id `<id>.log`，不存在所以返回空 lines）

- [ ] **Step 7.3: 改 LogsHandler 持有 Manager + 改 logPath 为合并路径**

编辑 `internal/api/logs.go`：

```go
// LogsHandler serves /api/v1/configs/{id}/logs*.
type LogsHandler struct {
	m       *manager.Manager
	logsDir string
	log     *slog.Logger
	origins []string
}
```

`m *manager.Manager` 已经在 struct 里了（见现有源码 line 23），所以**这一步只需要确认它没被改名**。`NewLogsHandler` 签名也已收 m，不用改。

替换 `logPath` 方法：

```go
// logCombinedPath 返回合并日志的绝对路径；所有 frpc 实例共写这一个文件。
func (h *LogsHandler) logCombinedPath() string {
	return filepath.Join(h.logsDir, manager.CombinedLogFileName)
}

// instancePrefix 用于在合并日志中匹配单个实例的行。
func instancePrefix(id string) string {
	return "[inst=" + id + "]"
}
```

删掉旧的 `logPath` 方法（用 search 检查仍引用它的地方在 Files / Clear / Tail 里，下一步处理）。

修改 `Query` 方法：

```go
func (h *LogsHandler) Query(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	if !h.m.Exists(id) {
		WriteError(w, http.StatusNotFound, CodeConfigNotFound, "config not found", nil)
		return
	}
	lines := atoiDefault(r.URL.Query().Get("lines"), 200)
	prefix := instancePrefix(id)
	since := h.m.LogViewSince(id)

	got, err := util.ReadFileLinesFiltered(h.logCombinedPath(), lines, func(line string) bool {
		if !strings.Contains(line, prefix) {
			return false
		}
		if since == 0 {
			return true
		}
		ts, ok := parseLogLineTimestamp(line)
		if !ok {
			return true // 解析失败的行保留，避免误删
		}
		return ts >= since
	})
	if err != nil {
		WriteJSON(w, http.StatusOK, map[string]any{"lines": []string{}, "next_offset": int64(0)})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"lines":       trimLines(got),
		"next_offset": int64(0), // 合并日志模式不再支持 offset 翻页；前端只用 lines
	})
}
```

> 📝 `next_offset` 保留字段名是为了不破坏前端契约（前端目前没用它）。后续 API 文档应注明"合并日志模式下 next_offset 恒为 0"。

在文件顶部添加 import：

```go
import (
	// 现有 imports ...
	"strings"
)
```

新增 `parseLogLineTimestamp`（放在文件底部 utility 区）：

```go
// parseLogLineTimestamp 从 frp 日志行首解析时间戳（毫秒精度）。
// frp 行格式："2026-06-03 15:18:20.546 [D] ..."（util.log 包默认 layout）。
// 解析失败时 ok=false，调用方应当默认保留这一行。
func parseLogLineTimestamp(line string) (unixMilli int64, ok bool) {
	const layout = "2006-01-02 15:04:05.000"
	if len(line) < len(layout) {
		return 0, false
	}
	t, err := time.ParseInLocation(layout, line[:len(layout)], time.Local)
	if err != nil {
		return 0, false
	}
	return t.UnixMilli(), true
}
```

- [ ] **Step 7.4: 运行测试确认通过**

```bash
go test ./internal/api/ -run TestLogsQuery_FiltersByInstancePrefix -v
```

预期：PASS

- [ ] **Step 7.5: 提交**

```bash
git add internal/api/logs.go internal/api/logs_test.go
git commit -m "feat(api): GET /logs 改读合并日志并按 [inst=<id>] 前缀过滤"
```

---

## Task 8: 改造 `Tail` (WebSocket 实时尾追)

**Files:**
- Modify: `internal/api/logs.go` (Tail 方法)
- Modify: `internal/api/logs_test.go` (追加 Tail 测试)

- [ ] **Step 8.1: 写失败测试** — 起 WS 连接，往 combined.log 追加 A/B 两行，期望客户端只收到 A 的行

追加到 `internal/api/logs_test.go`:

```go
import (
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestLogsTail_FiltersByInstancePrefix：WS /logs/tail 实时推送，
// 应只推送当前实例的行。
func TestLogsTail_FiltersByInstancePrefix(t *testing.T) {
	tmp := t.TempDir()
	logsDir := filepath.Join(tmp, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	combined := filepath.Join(logsDir, "frpc.log")
	if err := os.WriteFile(combined, []byte(""), 0o644); err != nil {
		t.Fatalf("seed empty: %v", err)
	}

	m := newTestManager(t, tmp)
	mustCreateInstance(t, m, "A")
	mustCreateInstance(t, m, "B")

	h := NewLogsHandler(m, logsDir, testLogger(), []string{"*"})

	// 用 httptest.Server 起 HTTP，再 ws.Dial 上去
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = withPathID(r, "A")
		h.Tail(w, r)
	}))
	defer srv.Close()

	wsURL, _ := url.Parse(srv.URL)
	wsURL.Scheme = "ws"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL.String(), nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	// 给 logtail goroutine 一点时间订阅成功
	time.Sleep(200 * time.Millisecond)

	// 追加 3 行
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
	readDeadline := time.After(3 * time.Second)
	for len(got) < 2 {
		select {
		case <-readDeadline:
			t.Fatalf("timeout, got %v", got)
		default:
		}
		readCtx, c := context.WithTimeout(ctx, 1*time.Second)
		_, data, err := conn.Read(readCtx)
		c()
		if err != nil {
			t.Fatalf("ws read: %v", err)
		}
		// frame 格式 {"line":"..."}
		var frame struct{ Line string `json:"line"` }
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
}
```

- [ ] **Step 8.2: 运行测试确认失败**

```bash
go test ./internal/api/ -run TestLogsTail_FiltersByInstancePrefix -v
```

预期：FAIL（当前 Tail 监听 per-id `.log`，不会订阅到 combined.log 的写入）

- [ ] **Step 8.3: 改 Tail 实现**

替换 `internal/api/logs.go` 的 `Tail` 方法：

```go
// Tail upgrades to WebSocket and streams new lines belonging to the given
// instance as they arrive. 物理上订阅合并日志 frpc.log，按 [inst=<id>] 前缀
// 过滤后再推送。
func (h *LogsHandler) Tail(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	if !h.m.Exists(id) {
		WriteError(w, http.StatusNotFound, CodeConfigNotFound, "config not found", nil)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: middleware.IsWildcard(h.origins),
		OriginPatterns:     h.origins,
	})
	if err != nil {
		h.log.Warn("ws accept failed", slog.Any("err", err))
		return
	}
	defer conn.Close(websocket.StatusInternalError, "internal error")

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	t := logtail.New(h.logCombinedPath())
	ch := t.Subscribe()
	defer t.Stop()

	prefix := instancePrefix(id)
	since := h.m.LogViewSince(id)

	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case line, ok := <-ch:
			if !ok {
				return
			}
			if !strings.Contains(line, prefix) {
				continue
			}
			if since > 0 {
				if ts, ok := parseLogLineTimestamp(line); ok && ts < since {
					continue
				}
			}
			payload, _ := json.Marshal(map[string]string{"line": line})
			wctx, c := context.WithTimeout(ctx, 5*time.Second)
			if err := conn.Write(wctx, websocket.MessageText, payload); err != nil {
				c()
				return
			}
			c()
		case <-ping.C:
			pctx, c := context.WithTimeout(ctx, 5*time.Second)
			if err := conn.Ping(pctx); err != nil {
				c()
				return
			}
			c()
		}
	}
}
```

- [ ] **Step 8.4: 运行测试确认通过**

```bash
go test ./internal/api/ -run TestLogsTail_FiltersByInstancePrefix -v
```

预期：PASS

- [ ] **Step 8.5: 提交**

```bash
git add internal/api/logs.go internal/api/logs_test.go
git commit -m "feat(api): WS /logs/tail 改订阅合并日志并按 [inst=<id>] 前缀过滤"
```

---

## Task 9: 改造 `Clear` 接口语义 — 写 LogViewSince，不删文件

**Files:**
- Modify: `internal/api/logs.go` (Clear 方法)
- Modify: `internal/api/logs.go` (Files 方法 — 改为列出合并日志的 rotated 文件)
- Modify: `internal/api/logs_test.go` (追加 Clear 测试)

- [ ] **Step 9.1: 写失败测试**

追加到 `internal/api/logs_test.go`:

```go
// TestLogsClear_SetsViewSince：DELETE /logs 应仅更新 LogViewSince，不删文件。
// 后续 GET /logs 不再返回戳之前的行；同时 frpc.log 物理文件保留。
func TestLogsClear_SetsViewSince(t *testing.T) {
	tmp := t.TempDir()
	logsDir := filepath.Join(tmp, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	combined := filepath.Join(logsDir, "frpc.log")
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
```

- [ ] **Step 9.2: 运行测试确认失败**

```bash
go test ./internal/api/ -run TestLogsClear_SetsViewSince -v
```

预期：FAIL — 当前 Clear 物理删除 per-id `.log`，并不影响合并日志，GET A 仍会返回 old 行。

- [ ] **Step 9.3: 改 Clear 实现**

替换 `internal/api/logs.go` 的 `Clear`:

```go
import "time"

// Clear sets a "view since" timestamp for this instance instead of deleting
// the combined log file. Subsequent GET /logs and WS /logs/tail will skip
// lines older than this timestamp. The physical frpc.log is preserved so
// operators can still grep historical data on disk.
func (h *LogsHandler) Clear(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	if !h.m.Exists(id) {
		WriteError(w, http.StatusNotFound, CodeConfigNotFound, "config not found", nil)
		return
	}
	if err := h.m.SetLogViewSince(id, time.Now().UnixMilli()); err != nil {
		WriteError(w, http.StatusInternalServerError, "internal_error", err.Error(), nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 9.4: 改 `Files` 方法以列合并日志的 rotated 文件（保持接口不死）**

```go
// Files 列出合并日志 frpc.log 的所有轮转副本。在合并日志模式下，所有
// instance 共享同一份历史；前端仍可调用此接口知道有哪些归档存在。
func (h *LogsHandler) Files(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	if !h.m.Exists(id) {
		WriteError(w, http.StatusNotFound, CodeConfigNotFound, "config not found", nil)
		return
	}
	files, dates, err := util.FindLogFiles(h.logCombinedPath())
	if err != nil {
		WriteJSON(w, http.StatusOK, map[string]any{"items": []any{}})
		return
	}
	items := make([]map[string]any, 0, len(files))
	for i, f := range files {
		entry := map[string]any{"path": f}
		if i < len(dates) && !dates[i].IsZero() {
			entry["rotated_at"] = dates[i]
		}
		items = append(items, entry)
	}
	WriteJSON(w, http.StatusOK, map[string]any{"items": items})
}
```

- [ ] **Step 9.5: 删除 `internal/api/logs.go` 中残留的 `logPath` 函数**

如果 Task 7 没有删干净，本步骤明确把它删除（grep 确认无引用后）：

```bash
go vet ./...
```

- [ ] **Step 9.6: 运行所有 logs_test 测试**

```bash
go test ./internal/api/ -v -run "TestLogs"
```

预期：全部 PASS（Query、Tail、Clear 三组）

- [ ] **Step 9.7: 提交**

```bash
git add internal/api/logs.go internal/api/logs_test.go
git commit -m "feat(api): DELETE /logs 改为更新 LogViewSince，物理日志保留"
```

---

## Task 10: 端到端集成验证 — 两实例同进程跑

**Files:**
- 无新代码，仅手动/脚本验证

- [ ] **Step 10.1: 构建本机二进制**

```bash
make build-host
```

预期：`bin/frpmgrd` 生成成功（或 Windows 上 `bin/frpmgrd-dev.exe`）

- [ ] **Step 10.2: 起 dev 环境**

```bash
FRPMGR_API_TOKEN=dev ./bin/frpmgrd serve
```

预期：日志显示 `daemon listening on :8080`

- [ ] **Step 10.3: 创建两个实例（A 和 B）**

```bash
curl -X POST http://localhost:8080/api/v1/configs \
  -H "Authorization: Bearer dev" \
  -H "Content-Type: application/json" \
  -d '{"id":"inst_a","config":{"serverAddr":"127.0.0.1","serverPort":65530,"loginFailExit":false}}'

curl -X POST http://localhost:8080/api/v1/configs \
  -H "Authorization: Bearer dev" \
  -H "Content-Type: application/json" \
  -d '{"id":"inst_b","config":{"serverAddr":"127.0.0.1","serverPort":65530,"loginFailExit":false}}'
```

预期：两次都 201。

- [ ] **Step 10.4: 启动两个实例**

```bash
curl -X POST http://localhost:8080/api/v1/configs/inst_a/start -H "Authorization: Bearer dev"
curl -X POST http://localhost:8080/api/v1/configs/inst_b/start -H "Authorization: Bearer dev"
```

- [ ] **Step 10.5: 直接读合并日志检查前缀**

```bash
tail -n 50 ./tmp/data/logs/frpc.log
```

预期：每行都带 `[inst=inst_a]` 或 `[inst=inst_b]` 前缀（除了 12 处游离日志）

- [ ] **Step 10.6: 通过 API 拉两个实例的日志，确认分流**

```bash
curl -s -H "Authorization: Bearer dev" "http://localhost:8080/api/v1/configs/inst_a/logs?lines=20" | jq '.lines[]'
curl -s -H "Authorization: Bearer dev" "http://localhost:8080/api/v1/configs/inst_b/logs?lines=20" | jq '.lines[]'
```

预期：
- 第一个调用返回的所有行都含 `[inst=inst_a]`
- 第二个调用返回的所有行都含 `[inst=inst_b]`
- 无交叉

- [ ] **Step 10.7: 验证 Clear 语义**

```bash
curl -X DELETE -H "Authorization: Bearer dev" http://localhost:8080/api/v1/configs/inst_a/logs
curl -s -H "Authorization: Bearer dev" "http://localhost:8080/api/v1/configs/inst_a/logs?lines=20" | jq '.lines | length'
```

预期：返回 0；`./tmp/data/logs/frpc.log` 文件仍然存在并保留历史。

- [ ] **Step 10.8: 验证 WS 实时分流**

打开两个终端各连一个 WS：

```bash
# 终端 1
wscat -c "ws://localhost:8080/api/v1/configs/inst_a/logs/tail?token=dev"
# 终端 2
wscat -c "ws://localhost:8080/api/v1/configs/inst_b/logs/tail?token=dev"
```

观察 ~30 秒：终端 1 只应收到 inst_a 的 heartbeat 行；终端 2 只应收到 inst_b 的。

- [ ] **Step 10.9: 提交验证报告**

如果以上 8 步全部通过，加一条 commit 标记里程碑完成：

```bash
git commit --allow-empty -m "chore(test): 合并日志 + xlog 前缀过滤端到端验证通过"
```

---

## Task 11: 同步文档

**Files:**
- Modify: `docs/API.zh-CN.md`
- Modify: `CLAUDE.md`（可选）

- [ ] **Step 11.1: 更新 `docs/API.zh-CN.md`**

定位到日志接口章节（搜 `/api/v1/configs/{id}/logs`），追加/替换为：

```markdown
### 实例日志

> ⚠️ 自 v1.2.22 起，所有 frpc 实例的日志统一写入 `{LogsDir}/frpc.log` 合并日志文件，
> 由 daemon 在 ctx 注入 xlog 前缀 `[inst=<id>]` 区分。本节接口在合并日志上做按
> 实例前缀的过滤，前端使用方式不变。

| 接口 | 行为 |
|---|---|
| `GET /api/v1/configs/{id}/logs?lines=N` | 读取合并日志，按 `[inst=<id>]` 过滤后返回最后 N 行 |
| `GET /api/v1/configs/{id}/logs/files` | 列出合并日志的轮转副本路径与日期 |
| `DELETE /api/v1/configs/{id}/logs` | **不再物理删除文件**；改为更新该实例的 `LogViewSince` 时间戳，后续 GET / WS 跳过戳之前的行 |
| `WS /api/v1/configs/{id}/logs/tail` | 订阅合并日志，按 `[inst=<id>]` 过滤后实时推送 |

**已知限制 — "游离日志"**：上游 frp v0.69.1 内部有 12 处裸 `log.*` 调用（不经
xlog ctx），主要分布在 `client/service.go`(vnet/admin) 与 `client/config_manager.go`
(reload/store)。这些行不带 `[inst=<id>]` 前缀，**不会显示在任何单实例视图中**。
默认情况下用户感知不到（vnet/admin/store 默认都不启用），仅在 reload 时会有
一条 `success reload conf` 落空。需要看全部 frp 内部日志时，运维可直接在主机上
`tail -f {LogsDir}/frpc.log`。
```

- [ ] **Step 11.2: 提交**

```bash
git add docs/API.zh-CN.md
git commit -m "docs(api): 同步合并日志 + LogViewSince 接口语义变更"
```

- [ ] **Step 11.3: （可选）追加 CHANGELOG / Release Notes**

如果项目有 CHANGELOG.md，按现有风格加一行：

```
## v1.2.22

- fix(logs): 修复多 frpc 实例日志互串问题；现统一写入合并日志 frpc.log 并按
  xlog 前缀 [inst=<id>] 按实例过滤展示。`DELETE /logs` 语义从"物理删除文件"
  改为"更新 LogViewSince 戳"，前端无需改动。
```

提交：

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): v1.2.22 — 多实例日志互串修复"
```

---

## Self-Review 自检

**已对照"背景知识"段每项验证：**

| 需求 | 实现位置 |
|---|---|
| daemon 注入 `[inst=<id>]` xlog 前缀 | Task 1 (helper) + Task 3 (runLoop 调用) |
| 所有 frpc 实例写到 `frpc.log` | Task 4 (manager.go 改 LogFile) |
| `GET /logs` 按前缀过滤 | Task 7 (Query 改写) |
| WS `/logs/tail` 按前缀过滤 | Task 8 (Tail 改写) |
| `DELETE /logs` 改为 LogViewSince | Task 6 (meta 字段) + Task 9 (Clear 改写) |
| LogViewSince 持久化 | Task 6 (meta.json 字段) |
| 删除 instance 时清 LogViewSince | Task 6 (dropIDs 改写) |
| 12 处游离日志说明 | Task 11 (API.zh-CN.md) |
| 时间戳解析失败的兜底（保留行） | Task 7 (parseLogLineTimestamp + 调用处 ok=false 保留) |
| 文件不存在时返回空 | Task 5 (ReadFileLinesFiltered) |
| 旧 meta.json 向后兼容 | Task 6 (Step 6.3 兜底 nil map) |
| 测试覆盖每个改动 | Task 1/2/3/5/6/7/8/9 均有失败测试先行 |
| 端到端集成验证 | Task 10 |
| 文档同步 | Task 11 |

**Placeholder 扫描**：未出现 "TBD" / "实现 later" / "类似 Task N" 等占位符。

**类型一致性**：
- `NewInstanceContext(parent, id)` 全程使用相同签名（Task 1 / Task 3）
- `CombinedLogFileName` 全程引用同一常量（Task 4 / Task 7 / Task 9）
- `LogViewSince` 字段类型 `map[string]int64`（unix milli）全程一致（Task 6 / Task 7 / Task 8 / Task 9）
- `parseLogLineTimestamp` 返回 `(int64, bool)`，调用方在 Task 7 / Task 8 都正确处理 ok=false

**潜在风险点（执行时注意）**：
- Task 1 用 reflect 读 xlog.Logger 私有字段是**测试辅助**手段；若 xlog 上游 0.69.1 之后改了字段名，测试需要同步更新。生产代码不依赖反射。
- Task 7 的 `next_offset` 始终返回 0：前端当前未使用该字段，无破坏；如未来恢复 offset 翻页，需重新设计合并日志的"按实例 offset"语义。
- Task 8 的 WS 测试依赖文件系统 fsnotify 行为；Windows 上 fsnotify 写事件延迟可能比 Linux 长，必要时把 1s read timeout 放宽到 2s。
- Task 10 集成验证的 frps 用 65530 无效端口让 frpc 持续重连失败 — 这是为了在不部署真实 frps 的前提下产生稳定的日志流；如本地有真 frps 可改成有效地址观察 heartbeat。

---

## 执行交接 (Execution Handoff)

**计划完成并保存于 `docs/superpowers/plans/2026-06-03-frpc-log-isolation-via-xlog-prefix.md`，两种执行选项：**

**1. Subagent-Driven（推荐）** — 我对每个 Task 派遣一个 fresh subagent，Task 之间做 review，迭代快、隔离干净。

**2. Inline Execution** — 在当前会话里用 executing-plans 跑，批量执行 + checkpoint。

**选哪种？**
