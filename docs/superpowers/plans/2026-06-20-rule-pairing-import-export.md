# 规则级导入导出 + 代理↔访客自动配对 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在 A 机配好 STCP/XTCP/SUDP 代理后,复制并到 B 机粘贴即自动推导出配对访客(字段填好、加密压缩对齐、端口建议好);并提供规则级 TOML / 可移植信封的查看、复制、导入。

**Architecture:** TOML 与可移植信封的生成/解析全部在后端 Go(复用 `pkg/config` 的 `toMap` / `ClientProxyToV1` / `ClientVisitorToV1` / `ClientProxyFromV1` / `ClientVisitorFromV1` / `config.UnmarshalClientConf`)。新增 3 个 HTTP 端点(`export`/`parse`/`import`),核心逻辑下沉到 `pkg/config`(纯函数,易测)与 `internal/manager`(有测试脚手架 `newImportTestManager`)。前端只做"显示字符串 / 读剪贴板 / 渲染预览表"的薄层。

**Tech Stack:** Go 1.25(`net/http` via chi、`pelletier/go-toml/v2`、`encoding/json`)、内嵌 `fatedier/frp` v0.69.1;React 19 + TypeScript + Vite + Ant Design 6 + `@uiw/react-codemirror`。

---

## 关键事实(实现前必读)

- `config.ClientConfig.Proxies` 是 `[]*config.Proxy`(**代理与访客混在一个切片**,访客以 `Role=="visitor"` 区分,`(*Proxy).IsVisitor()` 判定 type∈{stcp,xtcp,sudp}&&role=visitor)。
- in-memory `config.Proxy`(见 [pkg/config/client.go:232](../../../pkg/config/client.go#L232))字段:`Name/Type/UseEncryption/UseCompression`(在内嵌 `BaseProxyConf`)、`Role/SK/AllowUsers/ServerUser/ServerName/BindAddr/BindPort/Protocol/KeepTunnelOpen/...`。**代理的密钥在 `SK` 字段**。
- 转换函数(见 [pkg/config/conversion.go](../../../pkg/config/conversion.go)):
  - `ClientProxyToV1(p *Proxy) ([]TypedProxyConfig, error)`(range 代理会展开成多条)
  - `ClientVisitorToV1(p *Proxy) TypedVisitorConfig`
  - `ClientProxyFromV1(TypedProxyConfig) *Proxy`、`ClientVisitorFromV1(TypedVisitorConfig) *Proxy`
  - `toMap(in any, tag string) (map[string]any, error)`(**私有,仅同包 `pkg/config` 可调用** → 渲染逻辑必须放在 `pkg/config`)
- `config.TypedProxyConfig` / `TypedVisitorConfig` 有自定义 `MarshalJSON`/`UnmarshalJSON`,产出/接受 **camelCase**(见 [pkg/config/v1.go](../../../pkg/config/v1.go))。
- `config.UnmarshalClientConf([]byte) (*ClientConfig, error)`:自动识别 INI/TOML,解析为 `*ClientConfig`(含 `.Proxies`)。可直接喂"只含 `[[proxies]]`/`[[visitors]]` 的片段"或"整份 frpc.toml"。
- manager(见 [internal/manager/manager.go](../../../internal/manager/manager.go)):
  - `Get(id, includeProxies) (Snapshot, *config.ClientConfig, error)`
  - `Update(id, *config.ClientConfig) error`(写盘 + 运行中则热重载 + 发**一条** `eventbus.TypeConfigChanged`)
  - `VisitorBindConflict(excludeID, excludeName, vType, bindAddr string, bindPort int) *VisitorConflict`
  - `ValidateVisitorBinds(id, *config.ClientConfig) *VisitorConflict`
- API 层(见 [internal/api/configdto.go](../../../internal/api/configdto.go)):`toV1(*ClientConfig) *ClientConfigV1`、`fromV1(*ClientConfigV1) *ClientConfig`。
- `decodeJSON` 启用 `DisallowUnknownFields()`:请求体多一个 key 直接 400 —— 前端发送的键必须与 Go struct tag 完全一致。
- 测试脚手架:`internal/manager` 有 `newImportTestManager(t)`、`visitorCfg(name,type,addr,port)`(见 [internal/manager/visitorconflict_test.go](../../../internal/manager/visitorconflict_test.go));`internal/api` 仅有 `logs_test.go`。**后端逻辑测试集中在 `pkg/config` 与 `internal/manager`**,API 层以手动 curl 集成验证为主。

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `pkg/config/rulesio.go` | 信封类型、`BuildPortableEnvelope`、`RenderRulesTOML`、`ParseRules`、`DerivePairVisitor` | 新建 |
| `pkg/config/rulesio_test.go` | 上述纯函数单测(含 round-trip) | 新建 |
| `internal/manager/rulesimport.go` | `RuleImportItem/Summary` 类型 + `ApplyRuleImport` + `SuggestVisitorBindPort` | 新建 |
| `internal/manager/rulesimport_test.go` | 批量导入 / 端口建议单测 | 新建 |
| `internal/api/rulesio.go` | `Export`/`Parse`/`Import` handler | 新建 |
| `internal/api/server.go` | 注册 3 条路由 | 改 |
| `internal/api/openapi.yaml`、`docs/API.zh-CN.md` | 契约同步 | 改 |
| `web/src/components/RulesTransferModal.tsx` | 导入导出弹窗(两个 Tab) | 新建 |
| `web/src/pages/Configs.tsx` | 下拉项 / 批量栏按钮 / 弹窗挂载 / 粘贴监听 | 改 |

---

## Task 1: 可移植信封类型 + BuildPortableEnvelope

**Files:**
- Create: `pkg/config/rulesio.go`
- Test: `pkg/config/rulesio_test.go`

- [ ] **Step 1: 写失败测试**

`pkg/config/rulesio_test.go`:
```go
package config

import (
	"encoding/json"
	"strings"
	"testing"
)

func stcpProxy(name, sk string, enc bool) *Proxy {
	p := &Proxy{}
	p.Name = name
	p.Type = "stcp"
	p.SK = sk
	p.UseEncryption = enc
	return p
}

func TestBuildPortableEnvelope(t *testing.T) {
	src := PortableSource{ConfigID: "c1", ConfigName: "实例", User: "node-a", Daemon: "1.2.75", Frp: "0.69.1"}
	env, err := BuildPortableEnvelope([]*Proxy{stcpProxy("ssh", "k1", true)}, nil, src)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if env.FrpcManagerExport != "v1" || env.Kind != "rules" {
		t.Fatalf("bad header: %+v", env)
	}
	if env.Source.User != "node-a" {
		t.Fatalf("source.user lost: %+v", env.Source)
	}
	b, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(b)
	// camelCase 锚点 + secretKey 必须在
	for _, want := range []string{`"frpcManagerExport":"v1"`, `"secretKey":"k1"`, `"useEncryption":true`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in %s", want, s)
		}
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `go test ./pkg/config/ -run TestBuildPortableEnvelope -v`
Expected: FAIL(`undefined: BuildPortableEnvelope` / `PortableSource`)

- [ ] **Step 3: 写实现**

`pkg/config/rulesio.go`:
```go
package config

// PortableSource records where an exported rule bundle came from. It carries
// the frp `user` so the importer can derive a visitor's serverUser.
type PortableSource struct {
	ConfigID   string `json:"configId,omitempty"`
	ConfigName string `json:"configName,omitempty"`
	User       string `json:"user,omitempty"`
	Daemon     string `json:"daemon,omitempty"`
	Frp        string `json:"frp,omitempty"`
}

// PortableEnvelope is the "规定格式 v1": a self-describing, version-tagged JSON
// bundle of proxies/visitors used to move rules between frpc-manager systems.
// proxies/visitors are upstream camelCase objects (their Typed* MarshalJSON).
type PortableEnvelope struct {
	FrpcManagerExport string               `json:"frpcManagerExport"`
	Kind              string               `json:"kind"`
	ExportedAt        string               `json:"exportedAt,omitempty"`
	Source            PortableSource       `json:"source"`
	Proxies           []TypedProxyConfig   `json:"proxies,omitempty"`
	Visitors          []TypedVisitorConfig `json:"visitors,omitempty"`
}

// BuildPortableEnvelope converts in-memory proxies/visitors into a v1 envelope.
// proxies are non-visitor *Proxy; visitors are Role=="visitor" *Proxy. Either
// slice may be nil. Range proxies are expanded via ClientProxyToV1.
func BuildPortableEnvelope(proxies, visitors []*Proxy, src PortableSource) (*PortableEnvelope, error) {
	env := &PortableEnvelope{FrpcManagerExport: "v1", Kind: "rules", Source: src}
	for _, p := range proxies {
		conv, err := ClientProxyToV1(p)
		if err != nil {
			return nil, err
		}
		env.Proxies = append(env.Proxies, conv...)
	}
	for _, v := range visitors {
		env.Visitors = append(env.Visitors, ClientVisitorToV1(v))
	}
	return env, nil
}
```

- [ ] **Step 4: 运行确认通过**

Run: `go test ./pkg/config/ -run TestBuildPortableEnvelope -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add pkg/config/rulesio.go pkg/config/rulesio_test.go
git commit -m "feat(config): 可移植规则信封 v1 类型与构建"
```

---

## Task 2: RenderRulesTOML — 代理/访客拆分为两段 TOML

**Files:**
- Modify: `pkg/config/rulesio.go`(追加)
- Test: `pkg/config/rulesio_test.go`(追加)

- [ ] **Step 1: 写失败测试**

追加到 `pkg/config/rulesio_test.go`:
```go
func TestRenderRulesTOML(t *testing.T) {
	proxiesTOML, visitorsTOML, err := RenderRulesTOML(
		[]*Proxy{stcpProxy("ssh", "k1", true)},
		nil,
	)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(proxiesTOML, "[[proxies]]") || !strings.Contains(proxiesTOML, `name = 'ssh'`) {
		t.Fatalf("proxies toml wrong: %s", proxiesTOML)
	}
	if !strings.Contains(proxiesTOML, "secretKey = 'k1'") {
		t.Fatalf("secretKey missing: %s", proxiesTOML)
	}
	if visitorsTOML != "" {
		t.Fatalf("visitors should be empty, got: %s", visitorsTOML)
	}
}
```
> 注:`pelletier/go-toml/v2` 默认用单引号 literal string;若实际输出为双引号,实现通过后按真实输出调正断言。

- [ ] **Step 2: 运行确认失败**

Run: `go test ./pkg/config/ -run TestRenderRulesTOML -v`
Expected: FAIL(`undefined: RenderRulesTOML`)

- [ ] **Step 3: 写实现**

追加到 `pkg/config/rulesio.go`(顶部 import 块加入 `"github.com/pelletier/go-toml/v2"`):
```go
import "github.com/pelletier/go-toml/v2"

type proxiesDoc struct {
	Proxies []TypedProxyConfig `json:"proxies,omitempty"`
}
type visitorsDoc struct {
	Visitors []TypedVisitorConfig `json:"visitors,omitempty"`
}

// RenderRulesTOML renders the given rules as two independent TOML fragments:
// a [[proxies]] block and a [[visitors]] block (either empty when its slice is
// empty). proxies are non-visitor *Proxy; visitors are Role=="visitor" *Proxy.
// It reuses the exact toMap+toml.Marshal path that saveTOML uses, so field
// names/casing match the canonical frpc.toml.
func RenderRulesTOML(proxies, visitors []*Proxy) (proxiesTOML, visitorsTOML string, err error) {
	var pxs []TypedProxyConfig
	for _, p := range proxies {
		conv, e := ClientProxyToV1(p)
		if e != nil {
			return "", "", e
		}
		pxs = append(pxs, conv...)
	}
	if len(pxs) > 0 {
		obj, e := toMap(&proxiesDoc{Proxies: pxs}, "json")
		if e != nil {
			return "", "", e
		}
		b, e := toml.Marshal(obj)
		if e != nil {
			return "", "", e
		}
		proxiesTOML = string(b)
	}
	var vss []TypedVisitorConfig
	for _, v := range visitors {
		vss = append(vss, ClientVisitorToV1(v))
	}
	if len(vss) > 0 {
		obj, e := toMap(&visitorsDoc{Visitors: vss}, "json")
		if e != nil {
			return "", "", e
		}
		b, e := toml.Marshal(obj)
		if e != nil {
			return "", "", e
		}
		visitorsTOML = string(b)
	}
	return proxiesTOML, visitorsTOML, nil
}
```
> `toml` 已在本包别处导入;若 `rulesio.go` 是独立文件需自行 import。`go-toml/v2` 包名即 `toml`。

- [ ] **Step 4: 运行确认通过(必要时按真实输出调正引号断言)**

Run: `go test ./pkg/config/ -run TestRenderRulesTOML -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add pkg/config/rulesio.go pkg/config/rulesio_test.go
git commit -m "feat(config): 规则渲染为代理/访客两段 TOML"
```

---

## Task 3: ParseRules — 自动识别 portable / toml / ini

**Files:**
- Modify: `pkg/config/rulesio.go`(追加)
- Test: `pkg/config/rulesio_test.go`(追加)

- [ ] **Step 1: 写失败测试(覆盖 round-trip 与自动识别)**

追加到 `pkg/config/rulesio_test.go`:
```go
func TestParseRules_PortableRoundTrip(t *testing.T) {
	src := PortableSource{User: "node-a"}
	env, _ := BuildPortableEnvelope([]*Proxy{stcpProxy("ssh", "k1", true)}, nil, src)
	b, _ := json.Marshal(env)

	pr, err := ParseRules(b)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if pr.Format != "portable" {
		t.Fatalf("format = %s", pr.Format)
	}
	if pr.Source == nil || pr.Source.User != "node-a" {
		t.Fatalf("source.user lost: %+v", pr.Source)
	}
	if len(pr.Proxies) != 1 || pr.Proxies[0].Name != "ssh" || pr.Proxies[0].SK != "k1" {
		t.Fatalf("proxy round-trip wrong: %+v", pr.Proxies)
	}
}

func TestParseRules_TOMLFragment(t *testing.T) {
	proxiesTOML, _, _ := RenderRulesTOML([]*Proxy{stcpProxy("ssh", "k1", false)}, nil)
	pr, err := ParseRules([]byte(proxiesTOML))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if pr.Format != "toml" {
		t.Fatalf("format = %s", pr.Format)
	}
	if len(pr.Proxies) != 1 || pr.Proxies[0].Type != "stcp" {
		t.Fatalf("toml parse wrong: %+v", pr.Proxies)
	}
}

func TestParseRules_Unknown(t *testing.T) {
	pr, err := ParseRules([]byte("this is not a config at all !!!"))
	if err == nil && pr.Format != "unknown" {
		t.Fatalf("expected unknown/err, got %+v / %v", pr, err)
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `go test ./pkg/config/ -run TestParseRules -v`
Expected: FAIL(`undefined: ParseRules`)

- [ ] **Step 3: 写实现**

追加到 `pkg/config/rulesio.go`(import 加入 `"encoding/json"` 与 `frpconfig "github.com/fatedier/frp/pkg/config"`;注意本包已 import `"github.com/fatedier/frp/pkg/config"` 为 `config`,在独立文件中用别名 `frpconfig` 避免与包名 `config` 自身冲突——本包名就是 `config`,所以直接用 `UnmarshalClientConf` 即可,无需再 import 自身):
```go
import "encoding/json"

// ParsedRules is the structured result of ParseRules. Proxies is the combined
// list; visitors appear in it with Role=="visitor" (use (*Proxy).IsVisitor()).
type ParsedRules struct {
	Format  string          // "portable" | "toml" | "ini" | "unknown"
	Source  *PortableSource // non-nil for portable; {User} for toml/ini
	Proxies []*Proxy
}

// ParseRules auto-detects and parses a pasted rule bundle. Order: portable JSON
// (must carry frpcManagerExport) → TOML/INI via UnmarshalClientConf. A parse
// failure returns (&ParsedRules{Format:"unknown"}, err) so callers can surface
// the message without treating it as a 500.
func ParseRules(content []byte) (*ParsedRules, error) {
	// 1) portable JSON
	var probe struct {
		FrpcManagerExport string `json:"frpcManagerExport"`
	}
	if json.Unmarshal(content, &probe) == nil && probe.FrpcManagerExport != "" {
		var env PortableEnvelope
		if err := json.Unmarshal(content, &env); err != nil {
			return &ParsedRules{Format: "unknown"}, err
		}
		out := &ParsedRules{Format: "portable", Source: &env.Source}
		for _, tp := range env.Proxies {
			out.Proxies = append(out.Proxies, ClientProxyFromV1(tp))
		}
		for _, tv := range env.Visitors {
			out.Proxies = append(out.Proxies, ClientVisitorFromV1(tv))
		}
		return out, nil
	}
	// 2) TOML / INI fragment or full frpc config
	conf, err := UnmarshalClientConf(content)
	if err != nil {
		return &ParsedRules{Format: "unknown"}, err
	}
	format := "toml"
	if conf.LegacyFormat {
		format = "ini"
	}
	return &ParsedRules{
		Format:  format,
		Source:  &PortableSource{User: conf.User},
		Proxies: conf.Proxies,
	}, nil
}
```

- [ ] **Step 4: 运行确认通过**

Run: `go test ./pkg/config/ -run TestParseRules -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add pkg/config/rulesio.go pkg/config/rulesio_test.go
git commit -m "feat(config): 规则解析自动识别 portable/toml/ini"
```

---

## Task 4: DerivePairVisitor — 代理推导配对访客

**Files:**
- Modify: `pkg/config/rulesio.go`(追加)
- Test: `pkg/config/rulesio_test.go`(追加)

- [ ] **Step 1: 写失败测试**

追加到 `pkg/config/rulesio_test.go`:
```go
func TestDerivePairVisitor(t *testing.T) {
	p := stcpProxy("secret-ssh", "k1", true)
	p.UseCompression = true
	v := DerivePairVisitor(p, "node-a", "0.0.0.0", 16001)
	if !v.IsVisitor() {
		t.Fatalf("derived must be visitor")
	}
	if v.Type != "stcp" || v.ServerName != "secret-ssh" || v.SK != "k1" || v.ServerUser != "node-a" {
		t.Fatalf("mapping wrong: %+v", v)
	}
	if v.BindAddr != "0.0.0.0" || v.BindPort != 16001 {
		t.Fatalf("bind wrong: %+v", v)
	}
	// 加密/压缩强制对齐(根治两端对不齐)
	if !v.UseEncryption || !v.UseCompression {
		t.Fatalf("enc/comp must mirror proxy: %+v", v)
	}
}

func TestDerivePairVisitor_XTCPDefaultProtocol(t *testing.T) {
	p := stcpProxy("x", "k", false)
	p.Type = "xtcp"
	v := DerivePairVisitor(p, "", "0.0.0.0", 7000)
	if v.Type != "xtcp" || v.Protocol != "quic" {
		t.Fatalf("xtcp default protocol wrong: %+v", v)
	}
	if v.ServerUser != "" {
		t.Fatalf("empty source user must stay empty: %+v", v)
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `go test ./pkg/config/ -run TestDerivePairVisitor -v`
Expected: FAIL(`undefined: DerivePairVisitor`)

- [ ] **Step 3: 写实现**

追加到 `pkg/config/rulesio.go`(import 加入 `"github.com/mia-clark/frpc-manager/pkg/consts"`):
```go
import "github.com/mia-clark/frpc-manager/pkg/consts"

// Pairable reports whether p is an stcp/xtcp/sudp PROXY (not visitor) and can
// therefore be turned into a configured visitor on another system.
func Pairable(p *Proxy) bool {
	if p.IsVisitor() {
		return false
	}
	switch p.Type {
	case consts.ProxyTypeSTCP, consts.ProxyTypeXTCP, consts.ProxyTypeSUDP:
		return true
	}
	return false
}

// DerivePairVisitor builds the matching visitor for a pairable proxy. It mirrors
// the proxy's secretKey, encryption and compression (the latter two MUST match
// on both ends or frp tunnels silently fail), maps serverName=proxy.name and
// serverUser=the source frp user. bindAddr/bindPort are caller-chosen.
func DerivePairVisitor(p *Proxy, serverUser, bindAddr string, bindPort int) *Proxy {
	v := &Proxy{}
	v.Name = p.Name
	v.Type = p.Type
	v.UseEncryption = p.UseEncryption
	v.UseCompression = p.UseCompression
	v.Role = "visitor"
	v.SK = p.SK
	v.ServerName = p.Name
	v.ServerUser = serverUser
	v.BindAddr = bindAddr
	v.BindPort = bindPort
	if p.Type == consts.ProxyTypeXTCP {
		v.Protocol = "quic"
	}
	return v
}
```
> 确认 `pkg/consts` 中常量名:已知 `consts.ProxyTypeSTCP/ProxyTypeXTCP/ProxyTypeSUDP`(见 `(*Proxy).IsVisitor()` 用法)。

- [ ] **Step 4: 运行确认通过**

Run: `go test ./pkg/config/ -run TestDerivePairVisitor -v`
Expected: PASS

- [ ] **Step 5: 全包测试 + 提交**

```bash
go test ./pkg/config/ -v
git add pkg/config/rulesio.go pkg/config/rulesio_test.go
git commit -m "feat(config): 代理推导配对访客(加密压缩强制对齐)"
```

---

## Task 5: SuggestVisitorBindPort — 建议空闲访客端口

**Files:**
- Create: `internal/manager/rulesimport.go`
- Test: `internal/manager/rulesimport_test.go`

- [ ] **Step 1: 写失败测试**

`internal/manager/rulesimport_test.go`:
```go
package manager

import "testing"

func TestSuggestVisitorBindPort(t *testing.T) {
	m := newImportTestManager(t)
	if err := m.Create("c1", visitorCfg("a", "stcp", "0.0.0.0", 10000)); err != nil {
		t.Fatalf("create: %v", err)
	}
	used := map[int]bool{}
	// 10000 被占用 → 应跳过
	got := m.SuggestVisitorBindPort("stcp", "0.0.0.0", 10000, used)
	if got == 10000 {
		t.Fatalf("must skip occupied 10000, got %d", got)
	}
	if !used[got] {
		t.Fatalf("suggested port must be marked used: %d", got)
	}
	// 再要一个 → 不能与上次相同
	got2 := m.SuggestVisitorBindPort("stcp", "0.0.0.0", 10000, used)
	if got2 == got {
		t.Fatalf("second suggestion duplicated: %d", got2)
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `go test ./internal/manager/ -run TestSuggestVisitorBindPort -v`
Expected: FAIL(`undefined: SuggestVisitorBindPort`)

- [ ] **Step 3: 写实现**

`internal/manager/rulesimport.go`:
```go
package manager

// SuggestVisitorBindPort returns the first port >= start that collides with no
// existing visitor (same protocol family + bindAddr) AND is not already in the
// caller-provided `used` set (so batched suggestions don't duplicate). The
// chosen port is added to `used`. Falls back to `start` if nothing is free in
// a sane range.
func (m *Manager) SuggestVisitorBindPort(vType, bindAddr string, start int, used map[int]bool) int {
	if start <= 0 {
		start = 10000
	}
	if used == nil {
		used = map[int]bool{}
	}
	for port := start; port <= 65535; port++ {
		if used[port] {
			continue
		}
		if m.VisitorBindConflict("", "", vType, bindAddr, port) != nil {
			continue
		}
		used[port] = true
		return port
	}
	used[start] = true
	return start
}
```

- [ ] **Step 4: 运行确认通过**

Run: `go test ./internal/manager/ -run TestSuggestVisitorBindPort -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add internal/manager/rulesimport.go internal/manager/rulesimport_test.go
git commit -m "feat(manager): 建议空闲访客绑定端口"
```

---

## Task 6: ApplyRuleImport — 批量导入(create/overwrite/rename/skip)

**Files:**
- Modify: `internal/manager/rulesimport.go`(追加)
- Test: `internal/manager/rulesimport_test.go`(追加)

- [ ] **Step 1: 写失败测试**

追加到 `internal/manager/rulesimport_test.go`(import 加入 `"github.com/mia-clark/frpc-manager/pkg/config"`):
```go
import "github.com/mia-clark/frpc-manager/pkg/config"

func proxyRule(name string) *config.Proxy {
	p := &config.Proxy{}
	p.Name = name
	p.Type = "tcp"
	p.LocalIP = "127.0.0.1"
	p.LocalPort = "22"
	p.RemotePort = "6000"
	return p
}

// tcpProxyCfg builds a config containing a single tcp proxy named `name`.
func tcpProxyCfg(name string) *config.ClientConfig {
	c := config.NewDefaultClientConfig()
	c.Proxies = append(c.Proxies, proxyRule(name))
	return c
}

func TestApplyRuleImport_CreateAndRename(t *testing.T) {
	m := newImportTestManager(t)
	if err := m.Create("c1", tcpProxyCfg("ssh")); err != nil { // 已存在名为 ssh 的 tcp 代理
		t.Fatalf("create: %v", err)
	}
	sum, err := m.ApplyRuleImport("c1", []RuleImportItem{
		{Action: "create", Proxy: proxyRule("web")},          // 新建
		{Action: "rename", NewName: "ssh2", Proxy: proxyRule("ssh")}, // 重名改名
		{Action: "skip", Proxy: proxyRule("ignored")},        // 跳过
	})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if sum.Applied != 2 || sum.Skipped != 1 {
		t.Fatalf("summary wrong: %+v", sum)
	}
	_, data, _ := m.Get("c1", false)
	names := map[string]bool{}
	for _, p := range data.Proxies {
		names[p.Name] = true
	}
	if !names["web"] || !names["ssh2"] || names["ignored"] {
		t.Fatalf("applied names wrong: %v", names)
	}
}

func TestApplyRuleImport_Overwrite(t *testing.T) {
	m := newImportTestManager(t)
	_ = m.Create("c1", tcpProxyCfg("ssh"))
	repl := proxyRule("ssh")
	repl.RemotePort = "9999"
	sum, err := m.ApplyRuleImport("c1", []RuleImportItem{{Action: "overwrite", Proxy: repl}})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if sum.Applied != 1 {
		t.Fatalf("summary: %+v", sum)
	}
	_, data, _ := m.Get("c1", false)
	for _, p := range data.Proxies {
		if p.Name == "ssh" && p.RemotePort != "9999" {
			t.Fatalf("overwrite did not apply: %+v", p)
		}
	}
}
```
> 前置(已坐实):`newImportTestManager(t)` 在 [importmeta_test.go:14](../../../internal/manager/importmeta_test.go#L14)、`visitorCfg(name,type,addr,port)` 在 [visitorconflict_test.go:10](../../../internal/manager/visitorconflict_test.go#L10) 已存在;`proxyCfg` **不存在**,故本测试文件自带 `tcpProxyCfg`/`proxyRule` 两个本地帮助函数(上方已给)。

- [ ] **Step 2: 运行确认失败**

Run: `go test ./internal/manager/ -run TestApplyRuleImport -v`
Expected: FAIL(`undefined: RuleImportItem` / `ApplyRuleImport`)

- [ ] **Step 3: 写实现**

追加到 `internal/manager/rulesimport.go`(顶部 import 加入 `"github.com/mia-clark/frpc-manager/pkg/config"`):
```go
import "github.com/mia-clark/frpc-manager/pkg/config"

// RuleImportItem is one resolved import action. Proxy is an in-memory *Proxy
// already converted from the wire payload (visitor items have Role=="visitor").
type RuleImportItem struct {
	Action  string // "create" | "overwrite" | "rename" | "skip"
	NewName string // required when Action=="rename"
	Proxy   *config.Proxy
}

type RuleImportResult struct {
	Name      string `json:"name"`
	FinalName string `json:"finalName"`
	Status    string `json:"status"` // created|overwritten|renamed|skipped|failed
	Error     string `json:"error,omitempty"`
}

type RuleImportSummary struct {
	Applied int                `json:"applied"`
	Skipped int                `json:"skipped"`
	Failed  int                `json:"failed"`
	Results []RuleImportResult `json:"results"`
}

// ApplyRuleImport applies a batch of import items to config id in one shot:
// it mutates a cloned proxy slice, performs per-item conflict handling, then
// does a single Update (one write + one hot-reload + one config.changed event).
// best-effort: a single bad item is recorded as "failed"/"skipped" and the rest
// proceed. The whole call only errors on a fatal Update failure.
func (m *Manager) ApplyRuleImport(id string, items []RuleImportItem) (RuleImportSummary, error) {
	var sum RuleImportSummary
	_, data, err := m.Get(id, false)
	if err != nil {
		return sum, err
	}
	// clone current proxies so a write failure can't leave live state mutated
	next := make([]*config.Proxy, 0, len(data.Proxies)+len(items))
	idxByName := map[string]int{}
	for _, p := range data.Proxies {
		np := *p
		next = append(next, &np)
		idxByName[np.Name] = len(next) - 1
	}
	usedBinds := map[string]bool{} // proto|addr|port within this batch

	bindKey := func(p *config.Proxy) string {
		return visitorProto(p.Type) + "|" + normBindAddr(p.BindAddr) + "|" + itoa(p.BindPort)
	}
	addVisitorOK := func(p *config.Proxy) (bool, string) {
		if !p.IsVisitor() {
			return true, ""
		}
		if c := m.VisitorBindConflict(id, "", p.Type, p.BindAddr, p.BindPort); c != nil {
			return false, "本地端口冲突:已被实例「" + c.ConfigName + "」访客「" + c.Name + "」占用"
		}
		if usedBinds[bindKey(p)] {
			return false, "本地端口与本批次另一访客重复"
		}
		usedBinds[bindKey(p)] = true
		return true, ""
	}

	for _, it := range items {
		if it.Proxy == nil {
			sum.Failed++
			sum.Results = append(sum.Results, RuleImportResult{Status: "failed", Error: "空规则"})
			continue
		}
		name := it.Proxy.Name
		switch it.Action {
		case "skip":
			sum.Skipped++
			sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "skipped"})
		case "create":
			if _, exists := idxByName[name]; exists {
				sum.Failed++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "failed", Error: "同名已存在"})
				continue
			}
			if ok, msg := addVisitorOK(it.Proxy); !ok {
				sum.Failed++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "failed", Error: msg})
				continue
			}
			next = append(next, it.Proxy)
			idxByName[name] = len(next) - 1
			sum.Applied++
			sum.Results = append(sum.Results, RuleImportResult{Name: name, FinalName: name, Status: "created"})
		case "overwrite":
			if ok, msg := addVisitorOK(it.Proxy); !ok {
				sum.Failed++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "failed", Error: msg})
				continue
			}
			if i, exists := idxByName[name]; exists {
				next[i] = it.Proxy
				sum.Applied++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, FinalName: name, Status: "overwritten"})
			} else {
				next = append(next, it.Proxy)
				idxByName[name] = len(next) - 1
				sum.Applied++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, FinalName: name, Status: "created"})
			}
		case "rename":
			nn := it.NewName
			if nn == "" || nn == name {
				sum.Failed++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "failed", Error: "重命名需要新名称"})
				continue
			}
			if _, exists := idxByName[nn]; exists {
				sum.Failed++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "failed", Error: "新名称已存在"})
				continue
			}
			it.Proxy.Name = nn
			if ok, msg := addVisitorOK(it.Proxy); !ok {
				sum.Failed++
				sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "failed", Error: msg})
				continue
			}
			next = append(next, it.Proxy)
			idxByName[nn] = len(next) - 1
			sum.Applied++
			sum.Results = append(sum.Results, RuleImportResult{Name: name, FinalName: nn, Status: "renamed"})
		default:
			sum.Failed++
			sum.Results = append(sum.Results, RuleImportResult{Name: name, Status: "failed", Error: "未知动作:" + it.Action})
		}
	}

	if sum.Applied == 0 {
		return sum, nil // 没有任何变更,不触发写盘
	}
	updated := withProxiesData(data, next)
	if err := m.Update(id, updated); err != nil {
		return sum, err
	}
	return sum, nil
}

func itoa(n int) string { return strconv.Itoa(n) }

// withProxiesData returns a shallow copy of data with Proxies replaced.
func withProxiesData(src *config.ClientConfig, proxies []*config.Proxy) *config.ClientConfig {
	cp := *src
	cp.Proxies = proxies
	return &cp
}
```
> 依赖确认:`visitorProto(type)` 与 `normBindAddr(addr)` 已是 manager 包内私有函数(见 `VisitorBindConflict`/`visitorScan` 用法,grep 命中 `normBindAddr`)。import 加入 `"strconv"`。`next` 已是克隆切片,故 `withProxiesData` 直接替换即可,无需再次克隆(与 proxies.go 的 `withProxies` 语义一致——克隆已在循环里做了)。

- [ ] **Step 4: 运行确认通过**

Run: `go test ./internal/manager/ -run TestApplyRuleImport -v`
Expected: PASS

- [ ] **Step 5: 全包测试 + vet + 提交**

```bash
go test ./internal/manager/ ./pkg/config/ -v
go vet ./...
git add internal/manager/rulesimport.go internal/manager/rulesimport_test.go
git commit -m "feat(manager): 规则批量导入(create/overwrite/rename/skip,best-effort)"
```

---

## Task 7: API 端点 export / parse / import + 路由注册

**Files:**
- Create: `internal/api/rulesio.go`
- Modify: `internal/api/server.go`(注册路由 + 构造 handler)

- [ ] **Step 1: 写 handler 实现**

`internal/api/rulesio.go`:
```go
package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/mia-clark/frpc-manager/internal/manager"
	"github.com/mia-clark/frpc-manager/pkg/config"
	"github.com/mia-clark/frpc-manager/pkg/version"
)

// RulesIOHandler serves rule-level export/parse/import under
// /api/v1/configs/{id}/proxies/{export,parse,import}.
type RulesIOHandler struct {
	m   *manager.Manager
	log *slog.Logger
}

func NewRulesIOHandler(m *manager.Manager, log *slog.Logger) *RulesIOHandler {
	return &RulesIOHandler{m: m, log: log}
}

// splitRules partitions a config's combined proxy slice into (proxies, visitors)
// optionally filtered to names (matching primary name or range alias). kind is
// "all"|"proxy"|"visitor". A nil/empty names selects everything of that kind.
func splitRules(data *config.ClientConfig, kind string, names []string) (proxies, visitors []*config.Proxy) {
	var want map[string]struct{}
	if len(names) > 0 {
		want = make(map[string]struct{}, len(names))
		for _, n := range names {
			want[n] = struct{}{}
		}
	}
	matches := func(p *config.Proxy) bool {
		if want == nil {
			return true
		}
		if _, ok := want[p.Name]; ok {
			return true
		}
		for _, a := range p.GetAlias() {
			if _, ok := want[a]; ok {
				return true
			}
		}
		return false
	}
	for _, p := range data.Proxies {
		if !matches(p) {
			continue
		}
		if p.IsVisitor() {
			if kind == "all" || kind == "visitor" {
				visitors = append(visitors, p)
			}
		} else {
			if kind == "all" || kind == "proxy" {
				proxies = append(proxies, p)
			}
		}
	}
	return
}

type rulesExportReq struct {
	Format string   `json:"format"` // toml | portable
	Kind   string   `json:"kind"`   // all | proxy | visitor
	Names  []string `json:"names"`
}

// Export renders selected rules as split TOML or a portable envelope.
func (h *RulesIOHandler) Export(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	var req rulesExportReq
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Kind == "" {
		req.Kind = "all"
	}
	snap, data, err := h.m.Get(id, false)
	if writeManagerError(w, err) {
		return
	}
	proxies, visitors := splitRules(data, req.Kind, req.Names)
	counts := map[string]int{"proxies": len(proxies), "visitors": len(visitors)}

	switch req.Format {
	case "portable":
		env, err := config.BuildPortableEnvelope(proxies, visitors, config.PortableSource{
			ConfigID: id, ConfigName: snap.Name, User: data.User,
			Daemon: version.Number, Frp: version.FRPVersion,
		})
		if err != nil {
			WriteError(w, http.StatusInternalServerError, CodeInternal, "build envelope: "+err.Error(), nil)
			return
		}
		b, _ := json.MarshalIndent(env, "", "  ")
		WriteJSON(w, http.StatusOK, map[string]any{
			"format": "portable", "kind": req.Kind, "counts": counts,
			"portableJson": string(b),
			"filename":     filenameFor(snap.Name) + "-rules.json",
		})
	default: // toml
		pt, vt, err := config.RenderRulesTOML(proxies, visitors)
		if err != nil {
			WriteError(w, http.StatusInternalServerError, CodeInternal, "render toml: "+err.Error(), nil)
			return
		}
		WriteJSON(w, http.StatusOK, map[string]any{
			"format": "toml", "kind": req.Kind, "counts": counts,
			"proxiesToml": pt, "visitorsToml": vt,
			"filename": filenameFor(snap.Name) + "-rules.toml",
		})
	}
}

type rulesParseReq struct {
	Content string `json:"content"`
	Format  string `json:"format"` // accepted but ignored; always auto-detect
}

// Parse dry-runs a paste: detects format, lists items, derives pair visitors
// for stcp/xtcp/sudp proxies, and flags name conflicts against this config.
func (h *RulesIOHandler) Parse(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	var req rulesParseReq
	if !decodeJSON(w, r, &req) {
		return
	}
	_, data, err := h.m.Get(id, false)
	if writeManagerError(w, err) {
		return
	}
	existProxy, existVisitor := map[string]bool{}, map[string]bool{}
	for _, p := range data.Proxies {
		if p.IsVisitor() {
			existVisitor[p.Name] = true
		} else {
			existProxy[p.Name] = true
		}
	}

	parsed, perr := config.ParseRules([]byte(req.Content))
	if perr != nil {
		WriteJSON(w, http.StatusOK, map[string]any{
			"detectedFormat": "unknown", "items": []any{}, "globalError": perr.Error(),
		})
		return
	}

	sourceUser := ""
	if parsed.Source != nil {
		sourceUser = parsed.Source.User
	}
	used := map[int]bool{}
	items := make([]map[string]any, 0, len(parsed.Proxies))
	for _, p := range parsed.Proxies {
		item := map[string]any{
			"name":    p.Name,
			"type":    p.Type,
			"summary": ruleSummary(p),
		}
		if p.IsVisitor() {
			item["kind"] = "visitor"
			item["raw"] = mustMarshal(config.ClientVisitorToV1(p))
			item["conflict"] = conflictTag(existVisitor[p.Name])
		} else {
			item["kind"] = "proxy"
			conv, e := config.ClientProxyToV1(p)
			if e != nil || len(conv) == 0 {
				item["error"] = "无法转换该代理"
			} else {
				item["raw"] = mustMarshal(conv[0])
			}
			item["conflict"] = conflictTag(existProxy[p.Name])
			if config.Pairable(p) {
				item["pairable"] = true
				port := h.m.SuggestVisitorBindPort(p.Type, "0.0.0.0", 10000, used)
				sv := config.DerivePairVisitor(p, sourceUser, "0.0.0.0", port)
				item["suggestedVisitor"] = mustMarshal(config.ClientVisitorToV1(sv))
			}
		}
		items = append(items, item)
	}

	resp := map[string]any{"detectedFormat": parsed.Format, "items": items}
	if parsed.Source != nil {
		resp["source"] = parsed.Source
	}
	WriteJSON(w, http.StatusOK, resp)
}

type rulesImportItem struct {
	Kind    string                     `json:"kind"`
	Action  string                     `json:"action"`
	NewName string                     `json:"newName,omitempty"`
	Proxy   *config.TypedProxyConfig   `json:"proxy,omitempty"`
	Visitor *config.TypedVisitorConfig `json:"visitor,omitempty"`
}

type rulesImportReq struct {
	Items []rulesImportItem `json:"items"`
}

// Import commits a resolved batch (one write + one reload + one event).
func (h *RulesIOHandler) Import(w http.ResponseWriter, r *http.Request) {
	id := pathID(r)
	var req rulesImportReq
	if !decodeJSON(w, r, &req) {
		return
	}
	resolved := make([]manager.RuleImportItem, 0, len(req.Items))
	for _, it := range req.Items {
		var p *config.Proxy
		switch {
		case it.Visitor != nil:
			p = config.ClientVisitorFromV1(*it.Visitor)
		case it.Proxy != nil:
			p = config.ClientProxyFromV1(*it.Proxy)
		default:
			continue // empty item -> skip silently
		}
		resolved = append(resolved, manager.RuleImportItem{
			Action: it.Action, NewName: it.NewName, Proxy: p,
		})
	}
	sum, err := h.m.ApplyRuleImport(id, resolved)
	if writeManagerError(w, err) {
		return
	}
	WriteJSON(w, http.StatusOK, sum)
}

// --- small helpers ---

func ruleSummary(p *config.Proxy) string {
	if p.IsVisitor() {
		return p.Type + " · bind " + p.BindAddr + ":" + itoaSafe(p.BindPort)
	}
	if p.LocalPort != "" {
		return p.Type + " · localPort " + p.LocalPort
	}
	return p.Type
}

func conflictTag(exists bool) any {
	if exists {
		return "name_exists"
	}
	return nil
}

func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("null")
	}
	return b
}
```
> 依赖确认与对齐(执行时核对真实符号名,不符则就近替换):
> - `snap.Name`(已坐实):`manager.Snapshot` 有 `Name string` 字段([instance.go:89](../../../internal/manager/instance.go#L89))。
> - `data.User`(已坐实):`ClientConfig` 内嵌 `ClientCommon.User`([client.go:100](../../../pkg/config/client.go#L100))。
> - `version.Number` / `version.FRPVersion`(已坐实):见 [pkg/version/version.go](../../../pkg/version/version.go)(daemon 版本是 `Number`,不是 `Version`)。
> - `filenameFor(...)`:若 api 包已有同义 helper(导出整 config 时用过)则复用;否则在本文件加 `func filenameFor(s string) string { if s=="" {return "config"}; return s }`(并按需做非法字符替换)。
> - `itoaSafe(int) string`:在本文件加 `func itoaSafe(n int) string { return strconv.Itoa(n) }`(import `"strconv"`),或直接用 `fmt.Sprintf`。
> - `WriteJSON`/`WriteError`/`CodeInternal`/`pathID`/`decodeJSON`/`writeManagerError` 均为 api 包现有符号。

- [ ] **Step 2: 注册路由**

修改 `internal/api/server.go`:在 `proxies := NewProxiesHandler(...)` 附近新增构造:
```go
rulesio := NewRulesIOHandler(d.Manager, d.Logger)
```
在认证子树内、`proxies.Move` 那一组路由之后新增(放在 `/proxies/{name}` **之前**,避免被 `{name}` 通配吞掉):
```go
r.Post("/api/v1/configs/{id}/proxies/export", rulesio.Export)
r.Post("/api/v1/configs/{id}/proxies/parse", rulesio.Parse)
r.Post("/api/v1/configs/{id}/proxies/import", rulesio.Import)
```
> 注意 chi 路由顺序:`/proxies/{name}` 是通配,必须保证上面三条静态子路径在它之前注册(当前 `reorder`/`batch-delete`/`move` 已在 `{name}` 之前,照此插入同组)。

- [ ] **Step 3: 编译 + vet**

Run: `go build ./... && go vet ./...`
Expected: 通过(若 `version.*` 符号名不符,按真实名修正或临时用 "")

- [ ] **Step 4: 手动集成验证(dev 后端)**

启动:`make run`(token=dev,:18080)。先建一个含 stcp 代理的 config(用现有 UI 或 curl),然后:
```bash
# 导出 portable
curl -s -H 'Authorization: Bearer dev' -H 'Content-Type: application/json' \
  -d '{"format":"portable","kind":"all"}' \
  http://127.0.0.1:18080/api/v1/configs/<id>/proxies/export | head -c 600
# 把上面的 portableJson 内容喂给另一个 config 的 parse
curl -s -H 'Authorization: Bearer dev' -H 'Content-Type: application/json' \
  -d '{"content":"<粘贴 portableJson 字符串(转义)>"}' \
  http://127.0.0.1:18080/api/v1/configs/<other-id>/proxies/parse
```
Expected:export 返回 `portableJson` 含 `frpcManagerExport`;parse 对 stcp 代理返回 `pairable:true` 且带 `suggestedVisitor`。

- [ ] **Step 5: 提交**

```bash
git add internal/api/rulesio.go internal/api/server.go
git commit -m "feat(api): 规则级 export/parse/import 端点"
```

---

## Task 8: 契约同步(openapi.yaml + docs/API.zh-CN.md + gen:api)

**Files:**
- Modify: `internal/api/openapi.yaml`、`docs/API.zh-CN.md`
- Generate: `web/src/api/schema.d.ts`

- [ ] **Step 1: openapi.yaml 加 3 个 path**

在 `paths:` 下新增 `/api/v1/configs/{id}/proxies/export`、`.../parse`、`.../import`(POST),requestBody/response 按 Task 7 的 struct 字段如实描述;在 `components/schemas` 加 `PortableEnvelope`、`RuleImportSummary`。字段名/大小写必须与 Go tag 完全一致(`frpcManagerExport`、`portableJson`、`suggestedVisitor`、`detectedFormat` 等)。

- [ ] **Step 2: docs/API.zh-CN.md 加章节**

在 §3 代理章节后追加「§3.x 规则导入导出」:列出三端点的请求/响应字段表、可移植信封 v1 结构、代理→访客映射表、`bindAddr` 默认 `0.0.0.0`、加密压缩强制对齐、best-effort 语义。

- [ ] **Step 3: 重生成前端 schema**

Run: `cd web && npm run gen:api`
Expected:`web/src/api/schema.d.ts` 更新且无报错。

- [ ] **Step 4: 提交**

```bash
git add internal/api/openapi.yaml docs/API.zh-CN.md web/src/api/schema.d.ts
git commit -m "docs(api): 同步规则导入导出端点契约"
```

---

## Task 9: 前端弹窗组件(导出 Tab)

**Files:**
- Create: `web/src/components/RulesTransferModal.tsx`

- [ ] **Step 1: 写组件骨架 + 导出 Tab**

`web/src/components/RulesTransferModal.tsx`(完整代码;导入 Tab 在 Task 10 追加):
```tsx
import { useState, useCallback } from 'react';
import { Modal, Tabs, Radio, Space, Button, App, Typography, Alert } from 'antd';
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import client from '../api/client';

const { Text } = Typography;
const roExt = [StreamLanguage.define(toml), EditorView.editable.of(false)];

export interface RulesTransferModalProps {
  open: boolean;
  configId: string;
  configName: string;
  /** 勾选的规则名(批量导出用),空数组表示无勾选 */
  selectedNames: string[];
  /** 初始 Tab:'export' | 'import' */
  initialTab?: 'export' | 'import';
  /** 粘贴触发时预填到导入框的文本 */
  initialContent?: string;
  onClose: () => void;
  /** 导入成功后回调(刷新表格) */
  onImported?: () => void;
}

type ExportFormat = 'toml' | 'portable';
type ExportKind = 'all' | 'proxy' | 'visitor';
type ExportScope = 'all' | 'selected';

const copyText = async (s: string, msg: { success: (m: string) => void; error: (m: string) => void }) => {
  try {
    await navigator.clipboard.writeText(s);
    msg.success('已复制到剪贴板');
  } catch {
    msg.error('复制失败,浏览器可能不允许访问剪贴板');
  }
};

const download = (s: string, filename: string) => {
  const blob = new Blob([s], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const RulesTransferModal: React.FC<RulesTransferModalProps> = (props) => {
  const { open, configId, configName, selectedNames, initialTab, onClose, onImported, initialContent } = props;
  const { message } = App.useApp();
  const [tab, setTab] = useState<'export' | 'import'>(initialTab || 'export');

  // ---- 导出状态 ----
  const [format, setFormat] = useState<ExportFormat>('toml');
  const [kind, setKind] = useState<ExportKind>('all');
  const [scope, setScope] = useState<ExportScope>(selectedNames.length > 0 ? 'selected' : 'all');
  const [proxiesToml, setProxiesToml] = useState('');
  const [visitorsToml, setVisitorsToml] = useState('');
  const [portableJson, setPortableJson] = useState('');
  const [filename, setFilename] = useState('rules.toml');
  const [loadingExport, setLoadingExport] = useState(false);

  const runExport = useCallback(async () => {
    setLoadingExport(true);
    try {
      const body = {
        format,
        kind,
        names: scope === 'selected' ? selectedNames : null,
      };
      const { data } = await client.post(`/api/v1/configs/${configId}/proxies/export`, body);
      setFilename(data.filename || 'rules.toml');
      if (format === 'portable') {
        setPortableJson(data.portableJson || '');
        setProxiesToml('');
        setVisitorsToml('');
      } else {
        setProxiesToml(data.proxiesToml || '');
        setVisitorsToml(data.visitorsToml || '');
        setPortableJson('');
      }
    } catch (e: any) {
      message.error('导出失败:' + (e?.response?.data?.error?.message || e?.message || ''));
    } finally {
      setLoadingExport(false);
    }
  }, [format, kind, scope, selectedNames, configId, message]);

  const editorBox = (value: string, label: string, fname: string) => (
    <div style={{ marginBottom: 14 }}>
      <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 6 }}>
        <Text strong>{label}</Text>
        <Space>
          <Button size="small" icon={<CopyOutlined />} disabled={!value} onClick={() => copyText(value, message)}>
            复制
          </Button>
          <Button size="small" icon={<DownloadOutlined />} disabled={!value} onClick={() => download(value, fname)}>
            下载
          </Button>
        </Space>
      </Space>
      <div style={{ border: '1px solid #1f2933', borderRadius: 8, overflow: 'hidden', background: '#0b0f14' }}>
        <CodeMirror value={value} theme={oneDark} extensions={roExt} readOnly
          height="220px" maxHeight="40vh"
          basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: false }} />
      </div>
    </div>
  );

  const exportTab = (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Alert type="warning" showIcon banner
        message="导出内容包含 STCP/XTCP/SUDP 的 secretKey(配对所需),请勿公开分享。不含服务器地址与鉴权 token。" />
      <Space wrap>
        <Radio.Group value={scope} onChange={(e) => setScope(e.target.value)} optionType="button" size="small">
          <Radio.Button value="all">全部</Radio.Button>
          <Radio.Button value="selected" disabled={selectedNames.length === 0}>
            已选 {selectedNames.length} 项
          </Radio.Button>
        </Radio.Group>
        <Radio.Group value={kind} onChange={(e) => setKind(e.target.value)} optionType="button" size="small">
          <Radio.Button value="all">代理+访客</Radio.Button>
          <Radio.Button value="proxy">仅代理</Radio.Button>
          <Radio.Button value="visitor">仅访客</Radio.Button>
        </Radio.Group>
        <Radio.Group value={format} onChange={(e) => setFormat(e.target.value)} optionType="button" size="small">
          <Radio.Button value="toml">TOML</Radio.Button>
          <Radio.Button value="portable">可移植信封</Radio.Button>
        </Radio.Group>
        <Button type="primary" size="small" loading={loadingExport} onClick={runExport}>生成</Button>
      </Space>
      {format === 'toml'
        ? (<>
            {editorBox(proxiesToml, '代理 TOML', filename.replace('.toml', '-proxies.toml'))}
            {editorBox(visitorsToml, '访客 TOML', filename.replace('.toml', '-visitors.toml'))}
          </>)
        : editorBox(portableJson, '可移植信封 (JSON)', filename)}
    </Space>
  );

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={760} destroyOnClose
      title={`规则导入导出 · ${configName}`}>
      <Tabs activeKey={tab} onChange={(k) => setTab(k as 'export' | 'import')}
        items={[
          { key: 'export', label: '导出', children: exportTab },
          { key: 'import', label: '导入', children: <div data-import-placeholder /> },
        ]} />
    </Modal>
  );
};

export default RulesTransferModal;
```
> `initialContent`/`onImported` 在 Task 10 接入导入 Tab。

- [ ] **Step 2: 类型检查**

Run: `cd web && npx tsc -b`
Expected:无错误(未用变量 `initialContent`/`onImported` 暂时通过 eslint 可加 `void initialContent;` 或在 Task 10 用掉;若 tsc 报未用,先在组件体加 `void initialContent; void onImported;` 占位)。

- [ ] **Step 3: 提交**

```bash
git add web/src/components/RulesTransferModal.tsx
git commit -m "feat(web): 规则导出弹窗(代理/访客两段 TOML + 可移植信封)"
```

---

## Task 10: 前端弹窗组件(导入 Tab + 预览表)

**Files:**
- Modify: `web/src/components/RulesTransferModal.tsx`

- [ ] **Step 1: 接入导入 Tab**

在组件内补充导入状态、解析/导入逻辑与预览表。要点(完整实现):
- 引入额外 antd:`Input`(`{ TextArea }`)、`Table`、`Select`、`Tag`、`Tooltip`。
- 状态:
```tsx
const [content, setContent] = useState(initialContent || '');
const [parsing, setParsing] = useState(false);
const [rows, setRows] = useState<ParsedRow[]>([]);
const [detected, setDetected] = useState('');
const [globalErr, setGlobalErr] = useState('');
const [importing, setImporting] = useState(false);
```
- 类型:
```tsx
type RowAction = 'pair' | 'as_proxy' | 'as_visitor' | 'overwrite' | 'rename' | 'skip';
interface ParsedRow {
  key: string;
  kind: 'proxy' | 'visitor';
  name: string;
  type: string;
  summary: string;
  raw: any;                 // camelCase Typed* (proxy 或 visitor)
  pairable?: boolean;
  suggestedVisitor?: any;   // camelCase visitor
  conflict?: string | null;
  action: RowAction;
  bindAddr: string;         // 配对访客可编辑
  bindPort?: number;
  newName?: string;
  editName: string;         // 配对访客 / 重命名后的名字
}
```
- 解析:
```tsx
const runParse = useCallback(async (text: string) => {
  const c = (text ?? content).trim();
  if (!c) { message.warning('请先粘贴或输入要导入的内容'); return; }
  setParsing(true);
  try {
    const { data } = await client.post(`/api/v1/configs/${configId}/proxies/parse`, { content: c });
    setDetected(data.detectedFormat || '');
    setGlobalErr(data.globalError || '');
    const items = (data.items || []) as any[];
    setRows(items.map((it, i): ParsedRow => {
      const pairable = it.kind === 'proxy' && it.pairable;
      const sv = it.suggestedVisitor;
      const defaultAction: RowAction = pairable
        ? 'pair'
        : it.conflict ? 'skip' : (it.kind === 'visitor' ? 'as_visitor' : 'as_proxy');
      return {
        key: `${it.kind}-${it.name}-${i}`,
        kind: it.kind, name: it.name, type: it.type, summary: it.summary,
        raw: it.raw, pairable, suggestedVisitor: sv, conflict: it.conflict,
        action: defaultAction,
        bindAddr: sv?.bindAddr || '0.0.0.0',
        bindPort: sv?.bindPort,
        editName: pairable ? (sv?.name || it.name) : it.name,
      };
    }));
  } catch (e: any) {
    message.error('解析失败:' + (e?.response?.data?.error?.message || e?.message || ''));
  } finally {
    setParsing(false);
  }
}, [content, configId, message]);
```
- 组装并导入(把每行映射为后端 `items[]`):
```tsx
const runImport = useCallback(async () => {
  const items = rows
    .filter((r) => r.action !== 'skip')
    .map((r) => {
      if (r.action === 'pair') {
        const v = { ...r.suggestedVisitor, name: r.editName, bindAddr: r.bindAddr, bindPort: r.bindPort };
        return { kind: 'visitor', action: 'create', visitor: v };
      }
      const action = r.action === 'rename' ? 'rename'
        : r.action === 'overwrite' ? 'overwrite' : 'create';
      const payload: any = { kind: r.kind, action };
      if (action === 'rename') payload.newName = r.editName;
      if (r.kind === 'visitor') payload.visitor = r.raw; else payload.proxy = r.raw;
      return payload;
    });
  if (items.length === 0) { message.warning('没有要导入的项'); return; }
  setImporting(true);
  try {
    const { data } = await client.post(`/api/v1/configs/${configId}/proxies/import`, { items });
    message.success(`导入完成:新增/更新 ${data.applied}，跳过 ${data.skipped}，失败 ${data.failed}`);
    if (data.failed > 0) {
      const fails = (data.results || []).filter((x: any) => x.status === 'failed');
      Modal.warning({ title: '部分项导入失败', content: fails.map((f: any) => `${f.name}: ${f.error}`).join('\n') });
    }
    onImported?.();
    onClose();
  } catch (e: any) {
    message.error('导入失败:' + (e?.response?.data?.error?.message || e?.message || ''));
  } finally {
    setImporting(false);
  }
}, [rows, configId, message, onImported, onClose]);
```
- 预览表列:类型 Tag(代理/访客)、名称、type、摘要、冲突 Tag(`name_exists`→红 Tag「同名已存在」)、动作 `Select`(选项随 kind/pairable/conflict 变化)、可编辑名字与端口(action=pair 或 rename 时显示)。动作选项规则:
  - `pairable` 代理:`生成配对访客(pair)`、`原样导入为代理(as_proxy)`、`跳过(skip)`,叠加冲突时再给 `覆盖(overwrite)`、`重命名(rename)`(冲突针对"原样导入为代理")。
  - 普通代理:`as_proxy` / `skip`(+冲突 `overwrite`/`rename`)。
  - 访客:`as_visitor` / `skip`(+冲突 `overwrite`/`rename`)。
- 导入 Tab JSX:`TextArea`(value=content,onChange,placeholder「粘贴 TOML 片段或可移植信封 JSON」)+ 「解析」按钮 + detected/globalErr 提示 + 预览 `Table` + 底部「确认导入」按钮(`disabled={rows.length===0}`)。
- 用 `useEffect` 监听 `initialContent` 变化:当弹窗以粘贴方式打开且 `initialContent` 非空时,`setContent(initialContent)` 并自动 `runParse(initialContent)`。
- 把 Tabs 里 import 的 `children` 从占位替换为真正的 `importTab`,删除之前的 `void initialContent; void onImported;` 占位。

- [ ] **Step 2: 类型检查**

Run: `cd web && npx tsc -b`
Expected:无错误。

- [ ] **Step 3: 提交**

```bash
git add web/src/components/RulesTransferModal.tsx
git commit -m "feat(web): 规则导入预览表 + 代理粘贴自动配对访客"
```

---

## Task 11: Configs 页面接线(下拉项 + 批量栏按钮 + 弹窗挂载)

**Files:**
- Modify: `web/src/pages/Configs.tsx`

- [ ] **Step 1: 引入组件与状态**

在 import 区加:
```tsx
import RulesTransferModal from '../components/RulesTransferModal';
```
在组件状态区(与其它 modal 状态并列)加:
```tsx
const [rulesModalOpen, setRulesModalOpen] = useState(false);
const [rulesModalTab, setRulesModalTab] = useState<'export' | 'import'>('export');
const [rulesPasteContent, setRulesPasteContent] = useState('');
```

- [ ] **Step 2: 下拉菜单加「规则导入导出…」**

在「新增代理」旁的 Dropdown `menu.items` 数组(当前含 `add-visitor`)追加:
```tsx
{ type: 'divider' },
{
  key: 'rules-io',
  icon: <SwapOutlined />,
  label: '规则导入导出…',
  onClick: () => { setRulesModalTab('export'); setRulesPasteContent(''); setRulesModalOpen(true); },
},
```
> `SwapOutlined` 从 `@ant-design/icons` 引入(若未引入)。

- [ ] **Step 3: 批量栏加「导出选中」**

在勾选 ≥1 行时显示的批量操作栏(含「批量删除」处)追加按钮:
```tsx
<Button size="small" icon={<ExportOutlined />}
  onClick={() => { setRulesModalTab('export'); setRulesPasteContent(''); setRulesModalOpen(true); }}>
  导出选中
</Button>
```
> `ExportOutlined` 按需引入。导出弹窗读取 `selectedProxyKeys` 作为 `selectedNames`(见 Step 4)。

- [ ] **Step 4: 挂载弹窗**

在组件 return 的 JSX 末尾(与其它 Modal/Drawer 并列)加:
```tsx
{activeConfigId && (
  <RulesTransferModal
    open={rulesModalOpen}
    configId={activeConfigId}
    configName={configs.find((c) => c.id === activeConfigId)?.name || activeConfigId}
    selectedNames={selectedProxyKeys as string[]}
    initialTab={rulesModalTab}
    initialContent={rulesPasteContent}
    onClose={() => setRulesModalOpen(false)}
    onImported={() => loadProxies(activeConfigId)}
  />
)}
```
> 对齐真实符号:`activeConfigId`、`configs`(实例列表)、`selectedProxyKeys`(已勾选行 key=规则名)、`loadProxies(id)`(刷新代理表)均为 Configs.tsx 现有变量/函数(见首轮探查)。若 `configs` 元素字段不是 `id`/`name`,按真实字段对齐。

- [ ] **Step 5: 类型检查 + 提交**

Run: `cd web && npx tsc -b`
Expected:无错误。
```bash
git add web/src/pages/Configs.tsx
git commit -m "feat(web): 配置页接入规则导入导出弹窗(下拉项+批量导出)"
```

---

## Task 12: 配置页粘贴自动识别(智能避让)

**Files:**
- Modify: `web/src/pages/Configs.tsx`

- [ ] **Step 1: 加粘贴监听 useEffect**

在 Configs 组件内加(放在其它 useEffect 附近):
```tsx
useEffect(() => {
  const onPaste = (e: ClipboardEvent) => {
    if (!activeConfigId) return;
    // 智能避让:输入框 / 文本域 / 可编辑区 / CodeMirror 聚焦时不拦截
    const el = document.activeElement as HTMLElement | null;
    if (el) {
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable || el.closest('.cm-editor')) {
        return;
      }
    }
    const text = e.clipboardData?.getData('text') || '';
    const t = text.trim();
    if (!t) return;
    // 快速嗅探:可移植信封 或 TOML 片段
    const looksPortable = t.startsWith('{') && t.includes('"frpcManagerExport"');
    const looksToml = t.includes('[[proxies]]') || t.includes('[[visitors]]');
    if (!looksPortable && !looksToml) return;
    e.preventDefault();
    setRulesPasteContent(t);
    setRulesModalTab('import');
    setRulesModalOpen(true);
  };
  document.addEventListener('paste', onPaste);
  return () => document.removeEventListener('paste', onPaste);
}, [activeConfigId]);
```
> 依赖 Task 11 引入的 `setRulesPasteContent/setRulesModalTab/setRulesModalOpen` 与现有 `activeConfigId`。`RulesTransferModal` 内部的 `useEffect` 会在 `initialContent` 变化时自动 `runParse`。

- [ ] **Step 2: 类型检查 + 手动验证**

Run: `cd web && npx tsc -b`(无错)。
手动:`make run` + `cd web && npm run dev`,在配置页(非输入态)Ctrl+V 一段从另一个实例导出的可移植信封 → 弹窗自动打开「导入」并显示预览;焦点在某输入框时粘贴 → 不弹窗(正常输入)。

- [ ] **Step 3: 提交**

```bash
git add web/src/pages/Configs.tsx
git commit -m "feat(web): 配置页粘贴自动识别规则并弹确认(智能避让)"
```

---

## Task 13: 全量验证 + 收尾

- [ ] **Step 1: 后端全量测试 + vet**

Run: `make test && go vet ./...`
Expected:全绿。

- [ ] **Step 2: 前端构建**

Run: `cd web && npm run build`
Expected:`tsc -b && vite build` 成功。

- [ ] **Step 3: 端到端手动验证(两实例)**

`make build-host && FRPCMGR_API_TOKEN=dev ./bin/frpcmgrd serve`(或 `make run`)。
1. 实例 A 配 stcp 代理(带 secretKey)→ 选中 → 下拉「规则导入导出」→ 导出「可移植信封」→ 复制。
2. 切到实例 B → 在代理表空白处 Ctrl+V → 自动弹「导入」预览 → 该代理行默认动作=「生成配对访客」,serverName/secretKey/serverUser 已填、bindPort 已建议 → 确认导入。
3. 校验 B 的访客:`useEncryption/useCompression` 与 A 代理一致;`GET /configs/B/proxies` 出现新访客。
4. 重名场景:再导入一次 → 预览出现 `name_exists`,可选覆盖/重命名/跳过。

- [ ] **Step 4: 仅当以上全部通过,创建特性分支并整理提交历史(不直接落 main)**

```bash
git checkout -b feat/rule-pairing-import-export
# 若前面任务已在 main 上逐个 commit,改为:从分叉点起 cherry-pick 或直接将分支指向当前 HEAD
git log --oneline -15
```
> 按仓库约定:**所有逻辑验证通过后**才整理并推送;是否 push 由用户确认。

---

## Self-Review(已核对)

- **Spec 覆盖**:可移植信封(T1)、TOML 拆分(T2)、解析自动识别(T3)、代理→访客推导含加密压缩对齐(T4)、空闲端口(T5)、批量导入冲突处理(T6)、3 端点(T7)、契约同步(T8)、导出 UI(T9)、导入预览+粘贴配对(T10)、页面接线+批量+整实例颗粒度(T11)、粘贴监听智能避让(T12)、整体验证(T13)。逐条对应 spec 决策 1–7。
- **类型一致性**:`RuleImportItem{Action,NewName,Proxy}` 在 T6 定义、T7 使用一致;`PortableEnvelope/PortableSource` T1 定义、T7 使用一致;`ParsedRules{Format,Source,Proxies}` T3 定义、T7 使用一致;`DerivePairVisitor(p,serverUser,bindAddr,bindPort)` 签名 T4/T7 一致;前端 export 响应键 `proxiesToml/visitorsToml/portableJson/filename` T7/T9 一致;parse 响应键 `detectedFormat/items/source/globalError` 与 item 键 `kind/name/type/summary/raw/pairable/suggestedVisitor/conflict` T7/T10 一致;import 请求键 `items[].{kind,action,newName,proxy,visitor}` T7/T10 一致。
- **占位**:无 TBD;少数"执行时核对真实符号名"的点(`snap.Name`/`version.*`/`filenameFor`/`proxyCfg` 测试帮助函数名)已显式标注核对方式与兜底(临时 ""/本地补函数),不影响可执行性。
