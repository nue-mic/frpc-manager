# 设计:规则级导入导出 + 代理↔访客自动配对(粘贴即用)

> 状态:待评审 · 日期:2026-06-20 · 范围:`internal/api` + `internal/manager` + `pkg/config` + `web/src`

## 1. 背景与目标

frpc-manager 现在能在**整实例**层面看/改 TOML(`/raw`)、导入导出(`/import/*`、`/export/all`)。但 FRP 里 STCP/XTCP/SUDP 是**代理(proxy)↔ 访客(visitor)成对**工作的:

- A 机配 **代理**:暴露本地服务,带 `secretKey`、`serverName`(= 代理名)。
- B 机配 **访客**:用**相同**的 `secretKey`、`serverName` 连过去,本地 `bindPort` 监听。

手工把代理翻译成配对访客极易出错(密钥/名字/`serverUser` 抄错,尤其**加密/压缩两端对不齐** —— 见 commit `1a94439`)。

**头号目标**:A 机配好代理 → 复制 → **B 机任意处粘贴 → 自动推导出配对访客(字段填好、端口建议好、加密压缩强制对齐)→ 确认即建好**。

**次要目标**(沿用第一轮需求):规则级 TOML 查看/复制(代理 TOML、访客 TOML 各自一键复制)、可移植格式复制、解析 TOML 或可移植格式导入、整实例 + 勾选批量导出。

## 2. 范围与非目标

| 在范围内 | 非目标(YAGNI) |
|---|---|
| 规则级(单条/批量代理·访客)导出为 TOML 片段 / 可移植信封 | 反向自动推导(访客→代理);访客项仅同质导入 |
| 粘贴自动识别 → 确认预览 → 落库 | 跨机自动同步/拉取 |
| 代理→访客自动配对(stcp/xtcp/sudp) | 选择"导入到哪个实例"(固定落当前选中实例,后续可加) |
| 重名逐项处理(覆盖/跳过/重命名) | `allowUsers` 白名单联动强校验(仅提示) |
| 整实例 + 勾选批量两种颗粒度 | INI 片段导出(导入侧仍尽量兼容,导出统一 TOML) |

**核心立场**:**TOML 的生成与解析、可移植信封的组装与解析,全部在后端 Go 完成。前端绝不手搓/手解 TOML。** 理由是本项目第一大坑(上游 frp 不规则 camelCase + Go `json` 大小写不敏感)。格式契约只活在 Go + `openapi.yaml` 一处,前端是"显示字符串 / 读剪贴板 / 渲染预览表"的薄层。

## 3. 可移植信封格式(规定格式 v1)

```json
{
  "frpcManagerExport": "v1",
  "kind": "rules",
  "exportedAt": "2026-06-20T12:00:00Z",
  "source": {
    "configId": "ldt_116_frps",
    "configName": "老灯塔-116-FRPS",
    "user": "jp-bangzu-node",
    "daemon": "1.2.75",
    "frp": "0.69.1"
  },
  "proxies":  [ /* camelCase,与 config.proxies[] 同构,含 frpmgr range/sort */ ],
  "visitors": [ /* camelCase,与 config.visitors[] 同构 */ ]
}
```

- `frpcManagerExport` 是粘贴识别的**魔术锚点**;字符串值即版本号,便于后续演进。
- `proxies`/`visitors` 是后端权威 camelCase 对象,由后端从存储配置直接取出 → 杜绝前端拼错字段名。
- `source.user` 承载代理所属 frp `user`(多节点必需,用于推导访客 `serverUser`)。
- **含 `secretKey`**(配对必须)。**绝不含** `serverAddr` / `auth.token` / admin 凭据(它们在 config 根,本就不在 proxies/visitors 里)。规则级导出天然比整实例导出安全。

## 4. 后端 API(3 个新端点)

均挂在 `internal/api/rulesio.go`,在 `internal/api/server.go` 注册,沿用现有 Bearer 鉴权与 `decodeJSON`(注意请求体字段需在白名单内,否则 `DisallowUnknownFields` 触发 400)。

### 4.1 导出 `POST /api/v1/configs/{id}/proxies/export`

请求:
```json
{ "format": "toml" | "portable",
  "kind":   "all" | "proxy" | "visitor",
  "names":  ["a","b"] }            // 缺省/null = 该 kind 全部
```
响应 200:
```json
{ "format": "toml", "kind": "all",
  "counts": { "proxies": 3, "visitors": 1 },
  "proxiesToml":  "[[proxies]]\n...",    // 仅 format=toml
  "visitorsToml": "[[visitors]]\n...",   // 仅 format=toml
  "portableJson": "{ ...信封... }",       // 仅 format=portable(已格式化的 JSON 字符串)
  "filename": "老灯塔-116-FRPS-rules.toml" }
```
- `proxiesToml`/`visitorsToml` **拆开返回**,满足"代理 TOML、访客 TOML 各自一键复制"。
- 复用 `saveTOML` 的 `toMap` + `toml.Marshal`,只塞入选中的 `Proxies`/`Visitors` 子集。

### 4.2 解析(dry-run)`POST /api/v1/configs/{id}/proxies/parse`

请求:
```json
{ "content": "<粘贴文本>", "format": "auto" | "toml" | "portable" }
```
后端自动识别:JSON 且含 `frpcManagerExport` → portable;含 `[[proxies]]`/`[[visitors]]` → TOML 片段(用 frp `config.LoadConfigure`)。响应 200:
```json
{ "detectedFormat": "portable" | "toml" | "unknown",
  "source": { ...portable 时回显... } | null,
  "items": [
    { "kind": "proxy", "name": "secret-ssh", "type": "stcp",
      "summary": "stcp · localPort 22",
      "raw": { ...camelCase 代理对象... },
      "pairable": true,
      "suggestedVisitor": { ...推导出的访客 camelCase,含建议空闲 bindPort... } | null,
      "conflict": { "kind": "name_exists", "with": "proxy" } | null,
      "error": "" }
  ],
  "globalError": "" }
```
- `conflict` 针对**目标 config `{id}`** 现有规则算重名(advisory;最终以导入结果为准)。
- 对 stcp/xtcp/sudp 代理给出 `suggestedVisitor`(见 §5),其 `bindPort` 后端已挑好空闲值。

### 4.3 导入(提交)`POST /api/v1/configs/{id}/proxies/import`

请求:
```json
{ "items": [
    { "kind": "proxy" | "visitor",
      "action": "create" | "overwrite" | "rename" | "skip",
      "newName": "secret-ssh-2",        // action=rename 必填
      "proxy":  { ...camelCase... },     // kind=proxy
      "visitor": { ...camelCase... } } ] // kind=visitor(含生成的配对访客)
}
```
响应 200:
```json
{ "applied": 3, "skipped": 1, "failed": 0,
  "results": [
    { "kind": "visitor", "name": "secret-ssh", "status": "created|overwritten|renamed|skipped|failed",
      "finalName": "secret-ssh", "error": "" } ] }
```
- **"生成配对访客"对导入端是透明的**:前端把(可能编辑过的)`suggestedVisitor` 当普通 `{kind:"visitor", action:"create", visitor:{...}}` 发送。配对逻辑只在 §4.2 的 `suggestedVisitor` 推导里,导入端保持通用。
- **best-effort**:逐项应用到内存 `ClientConfig` 副本,单项非法(如 visitor `bindPort` 冲突)→ 该项 `failed` 并记原因,其余照常;最终**写一次盘、热重载一次、发一条 `config.changed`**。落库复用 manager 现有 proxy 增/改逻辑。

## 5. 代理 → 访客 自动推导映射

仅 `type ∈ {stcp, sudp, xtcp}` 的代理可配对(`pairable:true`)。

| 访客字段 | 来源 |
|---|---|
| `type` | = 代理 `type` |
| `serverName` | = 代理 `name` |
| `secretKey` | = 代理 `secretKey` |
| `serverUser` | = 信封 `source.user`(空则省略) |
| `transport.useEncryption` | **= 代理 `transport.useEncryption`(强制对齐)** |
| `transport.useCompression` | **= 代理 `transport.useCompression`(强制对齐)** |
| `name` | 默认 = 代理 `name`(预览行内可改;重名走动作) |
| `bindAddr` | 默认 `0.0.0.0`(预览行内可改) |
| `bindPort` | 后端**建议空闲端口**(从 `localPort` 或 10000 起扫,跳过本实例及跨实例已占端口;复用现有访客端口冲突检查) |
| (xtcp)`protocol`/`keepTunnelOpen`/`maxRetriesAnHour`/`minRetryInterval`/`fallbackTo`/`fallbackTimeoutMs` | frp 默认值 |

**加密/压缩两端强制对齐**是本特性的关键卖点 —— 直接根治 commit `1a94439` 那一类"两端配置对不齐"的 bug。

**提示(不强校验)**:若代理 `allowUsers` 非空且不含 `*`,预览给黄条提示"源代理限制了 allowUsers,请确保本机 frpc 的 `user` 在白名单内"。

## 6. 前端

### 6.1 入口(`web/src/pages/Configs.tsx`)
- 「新增代理」旁「∨」下拉新增菜单项 **「规则导入导出…」**。
- 批量栏(勾选 ≥1 行时出现)新增 **「导出选中」**。
- **粘贴监听**:配置页挂载时在 `document` 上加 `paste`,卸载时移除。**智能避让**:`activeElement` 为 `INPUT`/`TEXTAREA`/`[contenteditable]`/`.cm-editor` 内时直接放行不拦截。否则快速嗅探(trim 后以 `{` 开头且含 `"frpcManagerExport"`,或含 `[[proxies]]`/`[[visitors]]`)→ 命中才打开弹窗「导入」页、预填并自动调 `parse`。嗅探只是省一次后端调用的门槛,**权威识别仍在后端**。

### 6.2 弹窗组件 `web/src/components/RulesTransferModal.tsx`(新建,两个 Tab)

**导出 Tab**:范围(○全部 ○已选 N 项)、类型(全部/仅代理/仅访客)、格式(◉TOML ○可移植信封)。
- TOML:**代理 TOML / 访客 TOML 两块**只读 CodeMirror,各带 `[复制] [下载]`。
- 信封:合并为一块 bundle,一个 `[复制] [下载]`。
- 复用 [About.tsx `copyText`](../../../web/src/pages/About.tsx) 与 [TomlReference.tsx](../../../web/src/pages/TomlReference.tsx) 的只读 CodeMirror。

**导入 Tab**:textarea(粘贴触发时预填)+ `[粘贴] [解析]` → **预览表**(antd Table):
- 列:类型 / 名称 / type / 摘要 / 冲突徽标 / **动作**(Select)。
- 可配对代理:动作 = `生成配对访客`(默认)/ `原样导入为代理` / `跳过`;选「生成配对访客」时行内露出可编辑的 `name`/`bindAddr`/`bindPort`。
- 访客项:`导入为访客` / `跳过`;tcp/udp/http 代理:`导入为代理` / `跳过`。
- 重名项叠加 `覆盖`/`重命名(输入)`。
- 顶部黄条:含 `secretKey` 勿公开;`allowUsers` 限制提示。
- `[确认导入]` → 组装 items 调 `import` → 汇总 toast(已建/跳过/失败 + 失败原因)→ 表格刷新(走现有事件驱动)。

## 7. 数据流

- **导出**:选范围/格式 → `POST .../export` → 后端按存储配置渲染 → 字符串回填 CodeMirror + 复制/下载。
- **导入**:粘贴(避让通过)或手动 → `POST .../parse` → 预览表(后端给冲突 + 配对建议)→ 用户逐项定动作/改端口 → `POST .../import` → 单次写盘 + 热重载 + 一条事件 → 表格刷新。

## 8. 错误处理

- 解析无法识别 → `detectedFormat:"unknown"` + 提示;TOML 语法错 → 透传 frp loader 报错到 `globalError`;部分项非法 → 逐项 `error`,可只导入合法项。
- 导入 best-effort,回每项 `status` + `error`;visitor `bindPort` 冲突在导入时被后端拦下并报告,不影响其他项。
- 导出空选择 → 前端禁用按钮;config 不存在 → 404。

## 9. 安全

- 导出/信封含 `secretKey`(配对必须),UI 红字警告"含密钥勿公开分享"。
- 不含 serverAddr / token / admin 凭据。
- 三端点走现有 Bearer 鉴权。

## 10. 契约同步与测试

- 同步 [internal/api/openapi.yaml](../../../internal/api/openapi.yaml) 与 [docs/API.zh-CN.md](../../../docs/API.zh-CN.md);跑 `npm run gen:api` 重生成前端 schema。
- **Go 测试**:推导映射正确性(加密/压缩被复制、`serverName`/`secretKey`/`serverUser` 正确)、portable/TOML round-trip(导出→解析相等)、重名冲突检测、混合 create/overwrite/rename 批量导入、建议端口避开已占端口。`make test` + `go vet`。
- **前端**:`tsc -b`;按 `web-api-binding` 规范核对一次真实 Network 请求/响应字段。

## 11. 文件清单(预估)

**后端**
- `pkg/config/rulesio.go`(新):`RenderRulesTOML(subset)`、`BuildPortableEnvelope(subset, source)`、`ParseRules(content, format)`、`DeriveVisitorFromProxy(proxy, sourceUser, suggestPort)`。复用 `toMap`/`saveTOML` 内核与 frp `LoadConfigure`。
- `internal/api/rulesio.go`(新):`Export` / `Parse` / `Import` handler;`server.go` 注册路由。
- `internal/manager/manager.go`:新增 `BulkImportRules(id, items)`(应用→写一次→重载一次→发一条事件),复用现有 proxy 增/改 helper 与访客端口冲突检查。
- `internal/api/openapi.yaml`、`docs/API.zh-CN.md` 同步。

**前端**
- `web/src/components/RulesTransferModal.tsx`(新)。
- `web/src/pages/Configs.tsx`:下拉项、批量栏按钮、粘贴监听、弹窗挂载与状态。
- `web/src/api/*`:必要的封装/类型;`npm run gen:api`。

## 12. 决策记录(已锁定)

1. TOML 生成与解析全在后端,前端不手搓。
2. 颗粒度:整实例 + 勾选批量都支持。
3. 第二格式:可移植 JSON 信封(魔术键 `frpcManagerExport`)。
4. 重名:逐项选 覆盖/跳过/重命名。
5. 粘贴监听:仅配置页 + 智能避让(输入框/编辑器聚焦不拦截)。
6. 头号用例:代理→访客自动配对;导入默认动作 = 生成配对访客 + 保留备选。
7. 配对访客默认 `bindAddr=0.0.0.0`;`bindPort` 后端建议空闲端口;加密/压缩两端强制对齐。
