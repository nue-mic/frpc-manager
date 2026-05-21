---
name: web-api-binding
description: Use this skill whenever you are about to write, modify, or debug ANY frontend code in web/src/ that calls the Go backend API (axios client, fetch, WebSocket). Triggers include adding a new page, wiring a form save handler, rendering a table from `/api/v1/...`, hooking up a WebSocket, or chasing a bug where "saving / loading / displaying doesn't work". This skill enforces reading the Go source of truth BEFORE writing or fixing the frontend binding, so you never guess at field names, casing, request shape, or response shape.
---

# Web ↔ Go API 对接强制对核流程

## 触发条件（命中任一即必须激活）

- 任意 `web/src/**` 下新增/修改一处对 `/api/v1/...` 的调用
- 任意 React 组件读取或渲染后端返回数据中的字段
- 任意 WebSocket 订阅（`/api/v1/events`、`/logs/tail`）
- 任意"保存失败 / 列表为空 / 编辑表单空白 / 字段对不上 / 400 / 409"类 Bug
- 调整 `web/src/api/schema.d.ts` 或 `web/src/api/types.ts`

> **本项目踩过的坑（不可忘）**：
> - `ProxySnapshot` 用 snake_case (`local_ip / local_port / cur_conns`)，但 `ClientConfigV1` 走 camelCase（上游 frp 规则），前端混淆字段名导致列表与编辑表单空白 — 这是"保存规则不好用"的真凶。
> - 上游 frp 保留非常规 camelCase：`natHoleStunServer`（不是 `STUN`）、`dialServerKeepalive`（不是 `KeepAlive`）、`tokenEndpointURL`、`connectServerLocalIP` — 写错 key 不会立刻报错，但下次回读时拿不到。
> - Go `encoding/json` 默认 **大小写不敏感** 匹配字段，所以写错也能写入成功，回读时却找不到 — 这种 Bug 隐蔽性极强。
> - `decodeJSON` 在 [internal/api/helpers.go](../../../internal/api/helpers.go) 使用 `DisallowUnknownFields()`，前端多发一个 key 会直接 400 — 但只对没有自定义 `UnmarshalJSON` 的类型生效。

---

## 强制步骤（不允许跳过）

### Step 1 — 定位后端 handler 与路由

在动手写前端代码前，**必须先**：

1. 打开 [internal/api/server.go](../../../internal/api/server.go) 找到目标路径对应的 handler 方法。
2. 打开该 handler 所在的 `internal/api/<name>.go`（如 `proxies.go` / `configs.go` / `logs.go` / `system.go`），完整读一遍：
   - 请求体结构体（如 `proxyReq` / `createReq`）— 这是**入参契约**
   - `decodeJSON` 是否启用 — 若启用则 **多一个字段就 400**
   - 中间用到的转换函数（`toV1` / `fromV1` / `ClientProxyFromV1` 等）
   - 返回值（`WriteJSON(w, status, v)` 中的 `v`）— 这是**出参契约**
3. 若返回的是 `manager.Snapshot` / `ProxySnapshot` 等结构体，再打开 [internal/manager/instance.go](../../../internal/manager/instance.go) 看 JSON 标签，确认是 camelCase 还是 snake_case。
4. 若入参/出参里出现 `ClientConfigV1` / `TypedProxyConfig`，必须再翻到 [pkg/config/v1.go](../../../pkg/config/v1.go) 与上游 `github.com/fatedier/frp/pkg/config/v1`（`$(go env GOMODCACHE)/github.com/fatedier/frp@v0.68.1/pkg/config/v1/`）核对 JSON 标签。

### Step 2 — 整理"入参 / 出参字段表"

在动手前，**用工具写下来**（哪怕只是 TodoWrite 一行也行）：

```
路径: PUT /api/v1/configs/{id}/proxies/{name}
入参: { proxy?: TypedProxyConfig, visitor?: TypedVisitorConfig }
  TypedProxyConfig 字段 (camelCase, 按 type 分发):
    - 公共: name, type, transport.*, loadBalancer.*, healthCheck.*,
            localIP, localPort (int!), plugin.*
    - tcp:  remotePort
    - http: customDomains[], subdomain, locations[], httpUser, httpPassword,
            hostHeaderRewrite, routeByHTTPUser
    - stcp: secretKey, allowUsers[]
出参: 204 No Content (空 body)
错误: 404 proxy_not_found
```

这一步可以借助：
- `docs/API.zh-CN.md` 已整理的字段表
- `internal/api/openapi.yaml` 的路径定义
- 实地探测 `curl -H "Authorization: Bearer ..." http://localhost:8080/api/v1/...`

### Step 3 — 写前端代码

只有完成 Step 1/2 后才能动 `web/src/`。要求：

1. **字段名逐字 copy-paste 自 Go 源** — 不要靠记忆，不要由"驼峰直觉"猜测。
2. **大小写敏感** — `natHoleStunServer` 不等于 `natHoleSTUNServer`。
3. **入参用 TypeScript 类型** — 若 `web/src/api/types.ts` 没有定义，先补上，避免裸 `any`。
4. **响应字段的可选性** — 后端 `omitempty` 标签的字段在前端类型里必须标 optional (`?:`)，并在使用前 `??` 兜底。
5. **不要混 snake_case 与 camelCase** — 后端不同接口风格不同：
   - `ClientConfigV1` 子树 → camelCase
   - `Snapshot` / `ProxySnapshot` / 系统监控 → snake_case
   - WebSocket `Event` → snake_case (`config_id`)
   - 错误信封 → camelCase 内嵌（`error.code` / `error.message`）

### Step 4 — 验证

写完一处对接后，至少做以下**两项**：

1. **构建** `web/` (`npm run build` 或起 vite dev) 看 TS 类型有没有报错。
2. **实跑** — 启动 `./frpmgrd-dev.exe serve`，让前端真去打一次接口，在浏览器 Network 里确认：
   - 请求 payload 的 key 与后端结构体一致
   - 响应 body 的 key 与前端读取的 key 一致
   - 状态码符合预期（201/204/200 不能混）

> "类型检查通过" ≠ "对接正确"。Go 的大小写不敏感匹配会让错的 key 也成功写入但读不回来，**必须看一次真实请求-响应**。

---

## 反例（不要重蹈覆辙）

```tsx
// ❌ 错误：直接用列表快照回填编辑表单
const loadProxies = async () => {
  const resp = await client.get(`/api/v1/configs/${id}/proxies`);
  setProxies(resp.data.items);  // items 元素是 ProxySnapshot（snake_case，无业务字段）
};
const openProxyDrawer = (proxyItem) => {
  proxyForm.setFieldsValue({
    localIP: proxyItem.localIP,        // ❌ 快照里没有这个 key（是 local_ip）
    remotePort: proxyItem.remotePort,  // ❌ 快照里根本没有 remote_port
    customDomains: proxyItem.customDomains,  // ❌ 同上
  });
};
```

```tsx
// ✅ 正确：列表显示用快照，编辑前抓完整定义
const loadFullConfig = async (configId: string) => {
  const resp = await client.get(`/api/v1/configs/${configId}`);
  return resp.data;  // configEnvelope: { ..., config: ClientConfigV1 }
};
const openProxyDrawer = async (proxyName: string) => {
  const env = await loadFullConfig(activeConfigId);
  const fullProxy = env.config.proxies.find((p) => p.name === proxyName);
  if (!fullProxy) return message.error('未找到该代理');
  proxyForm.setFieldsValue({
    name: fullProxy.name,
    type: fullProxy.type,
    localIP: fullProxy.localIP,
    localPort: fullProxy.localPort,
    remotePort: fullProxy.remotePort,
    customDomains: fullProxy.customDomains?.join(','),
    // ...其他业务字段
  });
};
```

---

## 已知契约速查（基于实地探测，不靠记忆）

| 接口 | 入参顶层 key | 出参顶层 key | 风格 |
|---|---|---|---|
| `POST /api/v1/configs` | `id`, `config` | `id, name, path, state, last_error, started_at, stopped_at, config` | snake_case + camelCase 嵌套 |
| `PUT /api/v1/configs/{id}` | `config` | 同上 | 同上 |
| `GET /api/v1/configs/{id}/proxies` | — | `items[]: {name, type, status, remote_addr, error, local_ip, local_port, cur_conns, disabled}` | **snake_case** |
| `POST/PUT /api/v1/configs/{id}/proxies/[name]` | `proxy` 或 `visitor` | 201 空 / 204 空 | camelCase (TypedProxyConfig) |
| `GET /api/v1/configs/{id}/proxies/{name}` | — | 扁平 `TypedProxyConfig` + `frpmgr` | camelCase |
| `POST /api/v1/configs/{id}/proxies/{name}/toggle` | `{enabled?: boolean}` 或空 | 204 | — |
| `POST /api/v1/validate` | `ClientConfigV1` 或 TOML 文本 | `{valid: bool, errors?: string[]}` | camelCase |
| `POST /api/v1/nathole/discover` | `{stun_server?: string}` | `{stun_server, public_addrs[], local_addr}` | snake_case |
| `GET /api/v1/system/info` | — | snake_case 全套 (`uptime_s, data_dir, cpu, memory, disk, network, connections, process`) | snake_case |
| WS `/api/v1/events` | `{action, types?, config_ids?}` | `Event{seq, type, config_id, ts, data}` | snake_case |

完整字段表与样例：[docs/API.zh-CN.md](../../../docs/API.zh-CN.md)

---

## Self-Check（提交前问自己）

- [ ] 是否打开过对应的 Go handler 文件？
- [ ] 是否对照了 `ProxySnapshot` / `ClientConfigV1` / 上游 frp 的 JSON 标签？
- [ ] 前端使用的每一个字段，是否在 Go 源里都能搜到？
- [ ] 大小写是否逐字一致（特别是 `Stun` / `URL` / `IP` 等不规则缩写）？
- [ ] 后端 `omitempty` 字段在前端是否标了 optional 并做了兜底？
- [ ] 是否实跑了一次真实请求看 Network 面板？
- [ ] `docs/API.zh-CN.md` 是否需要同步更新？

只要有一项 NO，就停下，回到 Step 1。
