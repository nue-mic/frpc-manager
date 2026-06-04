# frpmgrd API 详细参考（中文 · v1）

> 本文件基于 [`internal/api`](../internal/api/) 与 [`internal/manager/instance.go`](../internal/manager/instance.go) 实地核对生成，并使用 dev 守护进程 `./frpmgrd-dev.exe serve` 真实探测过每条路径。
> 凡是与 [`internal/api/openapi.yaml`](../internal/api/openapi.yaml) 不一致之处，请以本文档为准（OpenAPI 描述了路径但 **没有** 描述请求/响应体的字段，本文档把它补齐）。

---

## 0. 全局约定

| 项目 | 值 |
|---|---|
| 监听地址 | `FRPMGR_HTTP_ADDR`，默认 `:8080` |
| 数据目录 | `FRPMGR_DATA_DIR`，默认 `/data` |
| 鉴权 | 除 `/api/v1/health` 与 `/api/docs/*` 外，所有 `/api/v1/*` 都要求 `Authorization: Bearer <FRPMGR_API_TOKEN>` |
| Content-Type | 除特别说明（`/raw` / `/import/zip` / `/validate` 等）外，**请求/返回均为 `application/json; charset=utf-8`** |
| 401 时机 | 缺失或错误 Bearer Token；前端拦截器会 `clearAPIToken()` 并跳转 `/login` |
| 路径 ID 限制 | `id` 不允许 `/ \ : ? * < > | " '`，不能以 `.` 开头，长度 ≤ 64 |
| WebSocket 子路径 | `/api/v1/events`、`/api/v1/configs/{id}/logs/tail` —— 需要把 `Authorization` 通过 query `?token=...` 或额外协议头携带；CORS 由 `FRPMGR_CORS_ORIGINS` 控制 |

### 错误响应统一信封

所有非 2xx 业务错误统一返回：

```json
{
  "error": {
    "code": "bad_request",
    "message": "id and config are required",
    "details": { "...可选": "..." }
  }
}
```

| `code` | 典型 HTTP | 说明 |
|---|---|---|
| `bad_request` | 400 | 请求体 / 参数不合法 |
| `unauthorized` | 401 | Token 缺失或无效 |
| `forbidden` | 403 | 鉴权通过但禁止访问 |
| `not_found` | 404 | 通用未找到 |
| `conflict` | 409 | 资源冲突 |
| `validation_failed` | 400 | 业务校验失败 |
| `internal_error` | 500 | 服务端异常 |
| `config_not_found` | 404 | 实例 ID 不存在 |
| `config_already_exists` | 409 | 实例 ID 已存在 |
| `invalid_state` | 400 | 状态不允许该操作（例如未运行不能 reload） |
| `proxy_not_found` | 404 | 代理名不存在 |
| `proxy_already_exists` | 409 | 同名代理已存在 |
| `upstream_failure` | 502 | 远程拉取 / STUN 等外部失败 |

来源：[`apiresp/apiresp.go`](../internal/api/apiresp/apiresp.go)。

---

## 1. 探活与版本

### 1.1 GET `/api/v1/health`  （无需鉴权）

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | string | 固定 `"ok"` |
| `uptime_s` | int64 | 守护进程已运行秒数 |

```json
{ "status": "ok", "uptime_s": 12 }
```

### 1.2 GET `/api/v1/version`

| 字段 | 类型 | 说明 |
|---|---|---|
| `daemon` | string | `frpmgrd` 版本号（例 `"dev"`） |
| `frp` | string | 内嵌的 frp 版本（例 `"0.69.1"`） |
| `build_date` | string | 构建时间，未注入时为 `"unknown"` |

```json
{ "daemon": "dev", "frp": "0.69.1", "build_date": "unknown" }
```

---

## 2. 实例配置（Configs）

### 2.1 GET `/api/v1/configs` — 列出全部实例

无请求体。

返回：

```json
{
  "items": [
    {
      "id": "diag1",
      "name": "diag1",
      "path": "tmp\\diag\\profiles\\diag1.toml",
      "state": "stopped",
      "last_error": "",
      "started_at": "2026-05-21T10:00:00+08:00",
      "stopped_at": "2026-05-21T10:01:00+08:00"
    }
  ]
}
```

`Snapshot` 字段（[`instance.go`](../internal/manager/instance.go#L81)）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 文件名去扩展名得到的稳定 ID |
| `name` | string | `frpmgr.name`（用户备注名），空时回填为 `id` |
| `path` | string | 配置文件磁盘绝对路径 |
| `state` | string | `started` / `stopped` / `starting` / `stopping` / `unknown` |
| `last_error` | string | 最近一次错误，`omitempty` |
| `started_at` | RFC3339 | 启动时间，未启动则不出现 |
| `stopped_at` | RFC3339 | 停止时间，从未启动过则不出现 |
| `proxies` | array | **仅 status 路径才会返回**，见 §2.10 |

### 2.2 POST `/api/v1/configs` — 新建实例

请求体：

```json
{
  "id": "diag1",
  "config": {
    "serverAddr": "127.0.0.1",
    "serverPort": 7000,
    "auth": { "method": "token", "token": "abc" },
    "frpmgr": { "name": "diag1", "manualStart": false }
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | √ | 实例 ID，必须满足路径 ID 规则 |
| `config` | object | √ | `ClientConfigV1`，结构见 §6 |

返回 `201 Created`，body 为 `configEnvelope`（=Snapshot + `config`）。  
冲突时返回 `409 / config_already_exists`。  
`id` 或 `config` 缺失返回 `400 / bad_request`。

### 2.3 GET `/api/v1/configs/{id}` — 读取单个实例

无请求体。返回 `200`：

```json
{
  "id": "diag1",
  "name": "diag1",
  "path": "...",
  "state": "stopped",
  "config": { "...ClientConfigV1...": "见 §6" }
}
```

不存在返回 `404 / config_not_found`。

### 2.4 PUT `/api/v1/configs/{id}` — 整体替换实例配置

请求体：

```json
{ "config": { "...ClientConfigV1...": "..." } }
```

返回 `200` + `configEnvelope`。  
`config` 缺失返回 `400 / bad_request`；不存在返回 `404 / config_not_found`。

> ⚠️ 即使实例正在运行，本接口 **不会** 自动重载，需要随后调用 `POST /configs/{id}/reload`。

### 2.5 PATCH `/api/v1/configs/{id}` — 合并补丁（RFC 7396）

请求体：直接传一个**部分 `ClientConfigV1`**，会与当前配置做对象合并（`null` 表示删除该键）。

```json
{ "log": { "level": "debug" } }
```

返回 `200` + `configEnvelope`。

### 2.6 DELETE `/api/v1/configs/{id}` — 删除实例

无请求体。停止运行 → 删除磁盘文件 → 清理 meta.json。返回 `204 No Content`。

### 2.7 POST `/api/v1/configs/{id}/duplicate` — 克隆实例

请求体：

```json
{ "new_id": "diag1_copy" }
```

返回 `201` + 新实例的 `configEnvelope`。`new_id` 必须满足路径 ID 规则，否则 `400`。

### 2.8 POST `/api/v1/configs/reorder` — 持久化展示顺序

请求体：

```json
{ "order": ["diag1", "diag2", "diag3"] }
```

未知 ID 会被静默丢弃。返回 `204`。

### 2.9 GET `/api/v1/configs/{id}/raw` — 取原始 TOML

返回 `Content-Type: application/toml`，body 为字节流。

### 2.10 PUT `/api/v1/configs/{id}/raw` — 写入原始 TOML/INI

请求头：`Content-Type: application/toml` 或 `text/plain`。  
请求体：≤ 4 MiB 的 TOML/INI 文本。  
返回 `200` + `configEnvelope`（已被守护进程重新解析）。

解析失败 → `400 / bad_request`，`message` 中包含 `parse: ...`。

### 2.11 GET `/api/v1/configs/{id}/status` — 取运行状态（含每代理快照）

返回 `Snapshot`（同 §2.1 的元素），并 **额外包含** `proxies` 数组（见 §3.1）。

---

## 3. 代理 / 访问者（Proxies / Visitors）

### 3.1 GET `/api/v1/configs/{id}/proxies` — 列代理（运行时快照）

返回：

```json
{
  "items": [
    {
      "name": "ssh",
      "type": "tcp",
      "status": "",
      "remote_addr": "",
      "error": "",
      "local_ip": "127.0.0.1",
      "local_port": "22",
      "cur_conns": 0
    }
  ]
}
```

`ProxySnapshot` 字段（[`instance.go:99`](../internal/manager/instance.go#L99)）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 代理名（range 代理会拆为多条 `name_0` / `name_1`） |
| `type` | string | `tcp/udp/http/https/tcpmux/stcp/sudp/xtcp` |
| `status` | string | 仅运行时有值：`new/start/running/check failed/closed/error` |
| `remote_addr` | string | 服务端分配的公网地址，运行时才有 |
| `error` | string | 最近错误，`omitempty` |
| `local_ip` | string | 本地 IP |
| `local_port` | string | 本地端口（字符串，允许 range 表达式 `8000-8010,9000`） |
| `cur_conns` | int | 当前活跃连接数（Linux 走 `/proc/net/tcp`，Windows 暂为 0） |

⚠️ **本快照不含 `remote_port / custom_domains / secret_key / subdomain / locations / multiplexer / plugin / disabled` 等业务字段。要看完整字段，请改调用 §3.3。**

### 3.2 POST `/api/v1/configs/{id}/proxies` — 新增一条代理或访客

> ⚠️ 后端 [`proxies.go:Create`](../internal/api/proxies.go) 接收 envelope `{proxy?, visitor?}`，**二选一恰好一项非空**，否则 `400 bad_request`。

#### 3.2.1 代理（`proxy` 通道）

```json
{ "proxy": { "name": "ssh", "type": "tcp", "localIP": "127.0.0.1", "localPort": 22, "remotePort": 6000 } }
```

`proxy` 内层为 `v1.TypedProxyConfig`，按 `type` 字段分发到 8 个具体类型之一：

| `type` | 类型 | 关键字段 |
|---|---|---|
| `tcp` | `TCPProxyConfig` | `localIP / localPort / remotePort` |
| `udp` | `UDPProxyConfig` | `localIP / localPort / remotePort` |
| `http` | `HTTPProxyConfig` | `customDomains[] / subdomain / locations[] / httpUser / httpPassword / hostHeaderRewrite / routeByHTTPUser` |
| `https` | `HTTPSProxyConfig` | `customDomains[] / subdomain` |
| `tcpmux` | `TCPMuxProxyConfig` | `multiplexer ("httpconnect") / customDomains[] / routeByHTTPUser / httpUser / httpPassword` |
| `stcp` | `STCPProxyConfig` | `secretKey / allowUsers[]` |
| `sudp` | `SUDPProxyConfig` | `secretKey / allowUsers[]` |
| `xtcp` | `XTCPProxyConfig` | `secretKey / allowUsers[] / natTraversal.disableAssistedAddrs` |

公共字段：`name / type / transport.{useEncryption, useCompression, bandwidthLimit, ...} / loadBalancer.{group, groupKey} / healthCheck.{type, timeoutSeconds, ...} / metadatas / annotations / enabled (bool 指针，false=禁用) / plugin.{type, ...}`。

**Plugin 透传**：`plugin: { type: "http2https", localAddr: "...", ... }`，可选类型 `http_proxy / socks5 / static_file / unix_domain_socket / http2http / http2https / https2http / https2https / tls2raw`。

#### 3.2.2 访客（`visitor` 通道）— 仅 `stcp / sudp / xtcp`

```json
{
  "visitor": {
    "name": "speed-test-visitor",
    "type": "stcp",
    "serverUser": "ln2-node",
    "serverName": "speed-test-tcp",
    "secretKey": "123456",
    "bindAddr": "127.0.0.1",
    "bindPort": 12081
  }
}
```

`visitor` 内层为 `v1.TypedVisitorConfig`，字段（[`visitor.go`](https://pkg.go.dev/github.com/fatedier/frp@v0.69.1/pkg/config/v1)）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | √ | 唯一名称 |
| `type` | string | √ | `stcp` / `sudp` / `xtcp` |
| `enabled` | bool 指针 |  | `nil`/`true`=启用，`false`=禁用（toggle 接口同样适用） |
| `secretKey` | string | √ | 与对端服务端代理一致的密钥 |
| `serverName` | string | √ | 对端 STCP/SUDP/XTCP 代理的 `name` |
| `serverUser` | string |  | 对端 frpc 的 `user` 前缀，未配置则为空 |
| `bindAddr` | string |  | 本地绑定地址，默认 `127.0.0.1` |
| `bindPort` | int | √ | 本地监听端口；若 `< 0` 表示不绑定，只接受来自其他 visitor 的重定向（SUDP 不支持） |
| `transport.useEncryption` | bool |  | 加密传输 |
| `transport.useCompression` | bool |  | 压缩传输 |
| `plugin` | object |  | visitor 插件（少用） |

**`xtcp` 额外字段**（`XTCPVisitorConfig`）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `protocol` | string | `"quic"` | P2P 协议：`quic` / `kcp` |
| `keepTunnelOpen` | bool | `false` | 保持隧道常开 |
| `maxRetriesAnHour` | int | `8` | 每小时最大重试次数 |
| `minRetryInterval` | int (秒) | `90` | 重试最小间隔 |
| `fallbackTo` | string |  | P2P 失败时切换到的访客名 |
| `fallbackTimeoutMs` | int | `1000` | 回退超时（毫秒） |
| `natTraversal.disableAssistedAddrs` | bool | `false` | 禁用辅助地址探测 |

#### 返回
- `201 Created`，**空 body**。
- 同名冲突：`409 / proxy_already_exists`。
- 同时给 `proxy` 与 `visitor`（或都不给）：`400 / bad_request: "exactly one of proxy/visitor required"`。

#### 与前端集成的注意点

- 前端通过 `_kind: 'proxy' | 'visitor'` 在合并视图里区分两种资源。
- 列表快照 `ProxySnapshot` **不区分**两者，visitor 行的 `local_ip` / `local_port` 为空（因为 visitor 没有这俩字段，只有 `bindAddr` / `bindPort`）。
- 编辑表单回填要靠 `GET /configs/{id}` 抓 `config.proxies[]` 或 `config.visitors[]`，再按 name 匹配。

### 3.3 GET `/api/v1/configs/{id}/proxies/{name}` — 取单条代理完整定义

**⚠️ 已知 Bug**（[`pkg/config/v1.go:24`](../pkg/config/v1.go#L24)）：当前返回形如：

```json
{
  "type": "tcp",
  "ProxyConfigurer": {
    "name": "ssh", "type": "tcp", "localIP": "127.0.0.1", "localPort": 22, "remotePort": 6000,
    "transport": { "bandwidthLimit": "" },
    "loadBalancer": { "group": "" },
    "healthCheck": { "type": "", "intervalSeconds": 0 },
    "plugin": null
  },
  "frpmgr": { "range": { "local": "", "remote": "" } }
}
```

`ProxyConfigurer` 是 Go 内嵌接口字段反射出来的名字，**不是合法的扁平 v1 形状**。原因：项目自己的 `config.TypedProxyConfig` 包装了 `v1.TypedProxyConfig`（后者有 `MarshalJSON`），但加了 `Mgr` 字段后破坏了上游 `MarshalJSON` 的提升。

**修复建议**：给 `config.TypedProxyConfig` 自己写一份 `MarshalJSON`，将 `c.ProxyConfigurer` 字段平铺后再附加 `frpmgr` 字段。

调用方目前**不应**依赖该接口；编辑表单请改用 §2.3 拿到 `config.proxies[]` 再用 `name` 过滤。

### 3.4 PUT `/api/v1/configs/{id}/proxies/{name}` — 替换一条代理

请求体同 §3.2。  
- 替换成功：`204 No Content`，**空 body**。
- 找不到：`404 / proxy_not_found`。
- ⚠️ 路径 `{name}` 用于定位 **旧名**；如果新 `proxy.name` 与 `{name}` 不一致，结果是 **改名 + 替换内容**。

### 3.5 DELETE `/api/v1/configs/{id}/proxies/{name}` — 删除一条代理或访问者

返回 `204`；找不到 `404 / proxy_not_found`。

### 3.6 POST `/api/v1/configs/{id}/proxies/{name}/toggle` — 启/禁单条代理

请求体（可选）：

```json
{ "enabled": false }
```

省略 body 表示 **取反**当前 `Disabled` 标志。返回 `204`。  
⚠️ 当前 §3.1 的快照 **不暴露** `Disabled`，前端只能根据后续行为推断；前端 `<Switch>` 状态目前并不准确。

---

## 4. 生命周期

| 路径 | 方法 | 说明 | 返回 |
|---|---|---|---|
| `/api/v1/configs/{id}/start` | POST | 启动实例（已运行返回 `400/invalid_state: "already running"`） | `200` + `Snapshot` |
| `/api/v1/configs/{id}/stop` | POST | 停止实例（已停止视为成功，无副作用） | `200` + `Snapshot` |
| `/api/v1/configs/{id}/reload` | POST | 热重载，需先把磁盘文件改动（PUT 整 config 或 PUT raw 之后调用） | `200` + `Snapshot`；未运行返回 `400 / invalid_state` |

无请求体。

---

## 5. 校验、导入导出、NAT 探测

### 5.1 POST `/api/v1/validate` — 校验配置但不持久化

| 请求 Content-Type | 请求体 | 行为 |
|---|---|---|
| `application/json` | 一个 `ClientConfigV1` 对象 | 走 JSON→TOML→`UnmarshalClientConf` 双重解析 |
| 其他（如 `application/toml` / `text/plain`） | TOML 或老式 INI 文本 | 直接走 `UnmarshalClientConf` |

返回固定为 `200`：

```json
{ "valid": true }
```

或：

```json
{ "valid": false, "errors": ["unmarshal ProxyConfig error: ..."] }
```

### 5.2 POST `/api/v1/import/file` — 上传单文件导入

`multipart/form-data`：

| 字段 | 必填 | 说明 |
|---|---|---|
| `file` | √ | 单个 `.toml` / `.ini` / `.conf` 文件，≤ 4 MiB |
| `id` | × | 不填则用文件名去后缀作为 ID |

返回 `200` + `configEnvelope`。

### 5.3 POST `/api/v1/import/url` — 从 URL 拉取

```json
{ "url": "http://...", "id": "optional_id" }
```

`url` 必填；下载 ≤ 4 MiB，15s 超时；返回 `200` + `configEnvelope`，远程失败返回 `502 / upstream_failure`。

### 5.4 POST `/api/v1/import/text` — 直接粘贴

```json
{ "id": "office_linux", "text": "[common]\nserver_addr = ...", "format": "toml" }
```

`id` 与 `text` 必填，`format` 仅作元信息（实际靠内容自动判别 TOML/INI）。

### 5.5 POST `/api/v1/import/zip` — 上传 ZIP 备份

`multipart/form-data` 的 `file` 字段，≤ 32 MiB，内含 `*.toml/*.ini/*.conf`。重名会覆盖。

返回：

```json
{ "imported": ["diag1", "diag2"] }
```

### 5.6 GET `/api/v1/configs/{id}/export` — 下载单实例 TOML

返回 `application/toml`，`Content-Disposition: attachment; filename="{id}.toml"`。

### 5.7 GET `/api/v1/export/all` — 下载全部实例为 ZIP

返回 `application/zip`，`Content-Disposition: attachment; filename="frpmgr-export-YYYYmmdd-HHMMSS.zip"`，内部 `profiles/*.toml/*.ini/*.conf`。

### 5.8 POST `/api/v1/nathole/discover` — STUN 探测 NAT

请求体可省略：

```json
{ "stun_server": "stun.easyvoip.com:3478" }
```

返回：

```json
{
  "stun_server": "stun.easyvoip.com:3478",
  "public_addrs": ["1.2.3.4:60123"],
  "local_addr":  "192.168.1.10:54321"
}
```

STUN 失败：`502 / upstream_failure`。

---

## 6. `ClientConfigV1` 数据结构

完整字段以 `github.com/fatedier/frp/pkg/config/v1.ClientCommonConfig` 为准，下面列出 **后端会接受并保存** 的主干字段（camelCase）：

```jsonc
{
  // 顶级 - 上游 frp 字段
  "user": "office",                                  // 代理名前缀
  "clientID": "...",                                 // 客户端 ID
  "serverAddr": "127.0.0.1",
  "serverPort": 7000,
  "natHoleStunServer": "stun.example.com:3478",      // 注意是 "Stun"（小 s）
  "dnsServer": "",
  "loginFailExit": true,
  "start": ["ssh", "web"],                           // 仅在白名单中的代理会启动

  "auth": {
    "method": "token",                               // "" | "token" | "oidc"
    "token": "abc",
    "additionalScopes": ["HeartBeats", "NewWorkConns"],
    "oidc": {
      "clientID": "", "clientSecret": "",
      "audience": "", "scope": "",
      "tokenEndpointURL": "https://..."
    }
  },

  "log": { "to": "/data/logs/x.log", "level": "info", "maxDays": 3 },

  "webServer": {
    "addr": "127.0.0.1", "port": 7400,
    "user": "admin", "password": "...",
    "assetsDir": "", "pprofEnable": false,
    "tls": { "certFile": "", "keyFile": "", "trustedCaFile": "", "serverName": "" }
  },

  "transport": {
    "protocol": "tcp",                               // tcp/kcp/quic/websocket/wss
    "dialServerTimeout": 10, "dialServerKeepalive": 7200,
    "connectServerLocalIP": "",
    "proxyURL": "",
    "poolCount": 1,
    "tcpMux": true, "tcpMuxKeepaliveInterval": 30,
    "quic": { "keepalivePeriod": 0, "maxIdleTimeout": 0, "maxIncomingStreams": 0 },
    "heartbeatInterval": -1, "heartbeatTimeout": -1,
    "tls": {
      "enable": true, "disableCustomTLSFirstByte": true,
      "certFile": "", "keyFile": "", "trustedCaFile": "", "serverName": ""
    }
  },

  "udpPacketSize": 1500,
  "metadatas": { "env": "prod" },
  "includes": [],                                    // 包含其他配置文件
  "store": {},                                       // 内置存储

  "proxies":  [ /* TypedProxyConfig，见 §3.2 */ ],
  "visitors": [ /* TypedVisitorConfig */ ],

  // frpmgr 扩展（本项目独有）
  "frpmgr": {
    "name": "我的实例",
    "manualStart": false,                            // false(默认)=daemon 启动时自动 Start；true=仅手动启动
    "autoDelete": {
      "afterDate": "2026-12-31T00:00:00Z",          // 到期自删
      "deleteMethod": "relative",                    // "absolute" | "relative"
      "deleteAfter": 0
    }
  }
}
```

> 大小写陷阱：
> - 上游 frp **保留** 一些不规则 camelCase：`natHoleStunServer`（不是 `natHoleSTUNServer`）、`dialServerKeepalive`（不是 `dialServerKeepAlive`）、`tokenEndpointURL`、`connectServerLocalIP`。
> - Go 的 `encoding/json` 默认会做 **大小写不敏感匹配**，所以前端若误写也能反序列化成功，但回读时会拿不到（key 不对）。

---

## 7. 系统监控 `/api/v1/system/*`

### 7.1 GET `/api/v1/system/info` — 汇总快照

返回（best-effort，任一字段失败仅省略不报错）：

| 顶层字段 | 类型 | 说明 |
|---|---|---|
| `uptime_s` | int64 | 守护进程已运行秒 |
| `data_dir` | string | 数据目录 |
| `host` | object | `hostname / os / platform / platform_version / kernel_version / kernel_arch / virtualization / uptime_seconds / boot_time` |
| `cpu` | object | `logical_count / physical_count / model_name / mhz_per_core / usage_percent / per_core[] / load_avg_1/5/15` |
| `memory` | object | `total / available / used / used_percent / free / swap_total / swap_used`（字节） |
| `disk` | array | 元素 `path / fstype / total / used / free / used_percent` |
| `network` | array | 元素 `name / bytes_sent / bytes_recv / packets_sent / packets_recv` |
| `connections` | object | `tcp_total / udp_total / tcp_by_status{ESTABLISHED:...} / owned_tcp_conns / owned_udp_conns` |
| `process` | object | `pid / cpu_percent / rss_bytes / vms_bytes / num_threads / num_goroutines / open_files / start_time` |

### 7.2 子接口

| 路径 | 方法 | 说明 | 备注 |
|---|---|---|---|
| `/api/v1/system/cpu` | GET | 返回上面 `cpu` 块 | query `window=200ms`（≤5s） |
| `/api/v1/system/memory` | GET | 返回上面 `memory` 块 |  |
| `/api/v1/system/disk` | GET | 返回 `{items: [...]}` | query `paths=/a,/b`（CSV） |
| `/api/v1/system/network` | GET | 返回 `{items: [...]}` |  |
| `/api/v1/system/connections` | GET | 返回上面 `connections` 块 |  |
| `/api/v1/system/process` | GET | 返回上面 `process` 块 |  |

---

## 8. 日志

### 8.0 合并日志模型（v1.2.22+）

> ⚠️ 自 v1.2.22 起，所有 frpc 实例的日志统一写入 `{FRPMGR_DATA_DIR}/logs/frpc.log` 合并日志文件，
> 由 daemon 在 ctx 注入 xlog 前缀 `[inst=<id>]` 区分。本节接口在合并日志上做按
> 实例前缀的过滤，前端使用方式不变。

| 接口 | 行为 |
|---|---|
| `GET .../logs?lines=N` | 读合并日志，按 `[inst=<id>]` 过滤后返回最后 N 行 |
| `GET .../logs/files` | 列出合并日志的轮转副本路径与日期 |
| `DELETE .../logs` | **不再物理删除文件**；改为更新该实例的 `log_view_since` 时间戳，后续 GET / WS 跳过戳之前的行 |
| `WS .../logs/tail` | 订阅合并日志，按 `[inst=<id>]` 过滤后实时推送 |

**已知限制 — "游离日志"**：上游 frp v0.69.1 内部有 12 处裸 `log.*` 调用（不经
xlog ctx），主要分布在 `client/service.go`（vnet/admin）与 `client/config_manager.go`
（reload/store）。这些行不带 `[inst=<id>]` 前缀，**不会显示在任何单实例视图中**。
默认情况下用户感知不到（vnet/admin/store 默认都不启用），仅在 reload 时会有
一条 `success reload conf` 落空。运维需要看全部 frp 内部日志时，可直接在主机上
`tail -f {FRPMGR_DATA_DIR}/logs/frpc.log`。

**LogViewSince 持久化位置**：`{FRPMGR_DATA_DIR}/meta.json` 中的 `log_view_since`
字段（`map[string]int64`，键为 instance id，值为 Unix 毫秒）。删除 instance 时
该键自动清理。

### 8.1 GET `/api/v1/configs/{id}/logs?lines=200&offset=0` — 离线查询

请求侧不变；服务端从合并日志按 `[inst=<id>]` 过滤后返回。`next_offset` 始终为 0（合并日志模式下不支持 offset 翻页，前端只用 `lines`）。

| Query | 默认 | 说明 |
|---|---|---|
| `lines` | 200 | 返回最多多少行 |
| `offset` | 0 | 兼容字段，**合并日志模式下被忽略**；保留仅为前端旧版本兼容，不再用于分页 |

返回：

```json
{ "lines": ["[I] 2026-...", "..."], "next_offset": 0 }
```

`next_offset` 始终为 `0`（合并日志模式下不支持 offset 翻页）。文件不存在时返回 `200` + 空数组（不报错）。

### 8.2 GET `/api/v1/configs/{id}/logs/files` — 列出滚转日志

列出的是 **合并日志**（`frpc.log`）的轮转副本，**不是按实例分离的**。所有 instance 在同一份历史里。

```json
{
  "items": [
    { "path": "/data/logs/frpc.log" },
    { "path": "/data/logs/frpc.log.2026-05-20", "rotated_at": "2026-05-20T00:00:00Z" }
  ]
}
```

### 8.3 DELETE `/api/v1/configs/{id}/logs` — 重置视图水位

**语义变更（v1.2.22）：** 不再物理删除日志文件。更新该 instance 的 `log_view_since` 时间戳到当前时刻；后续 `GET /logs` 与 `WS /logs/tail` 仅返回时间戳 ≥ 此值的行。物理文件 `frpc.log` 保留，运维仍可直接读盘。

返回 `204`。

### 8.4 WebSocket `/api/v1/configs/{id}/logs/tail` — 实时流

实时推送的行经过 `[inst=<id>]` 前缀过滤；`log_view_since` 也参与过滤，即仅推送时间戳 ≥ 水位的行。

- 协议：`Upgrade: websocket`
- 鉴权：浏览器无法自定义 ws 头，故支持 `?token=<bearer>` 查询参数（前端 `Logs.tsx` 已采用此方式）
- 每帧：`{"line": "..."}`
- 服务端每 30s 发一次 ping 保活；任一方关闭连接即结束

---

## 9. WebSocket 事件流 `/api/v1/events`

- 升级为 WebSocket。
- 初始过滤（可选 query）：`types=instance.state,proxy.status&config_ids=a,b&since=12345`。
- 客户端帧（JSON）：
  - `{"action":"filter","types":["..."],"config_ids":["..."]}` 更新订阅
  - `{"action":"unfilter"}` 收所有
- 服务端帧（每帧一个 `Event` 对象）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `seq` | uint64 | 单调自增序号；ring buffer 中可回放 |
| `type` | string | `instance.state` / `instance.error` / `proxy.status` / `proxy.connections` / `config.changed` / `config.deleted` / `log.line` |
| `config_id` | string | 关联的实例 ID |
| `ts` | RFC3339 | 发生时间 |
| `data` | object | 各 `type` 对应的载荷，结构示意见前端 [`events/types.ts`](../web/src/events/types.ts) |

ping 间隔 30s。

---

## 10. 已发现的接口缺陷（关于"保存规则不好用"）

按影响排序：

### 10.1 列表与编辑表单字段名不匹配（前端）

- 后端 `GET /api/v1/configs/{id}/proxies` 返回的是 **运行时快照**，字段为 snake_case 且 **不含** 业务参数（如 `remote_port / custom_domains / secret_key / multiplexer / disabled` 等）。
- 前端 [`web/src/pages/Configs.tsx:730-783`](../web/src/pages/Configs.tsx#L730) 用 `record.localIP / record.localPort / record.remotePort / record.customDomains` 渲染表格 —— 全部 `undefined`。
- 前端 [`web/src/pages/Configs.tsx:513-544`](../web/src/pages/Configs.tsx#L513) `openProxyDrawer(proxyItem)` 从同一份快照回填编辑表单 —— 看到的是 **几乎全空** 的表单，用户以为"保存不好用"。

**修复方向 A（推荐）**：编辑前改调用 `GET /api/v1/configs/{id}` 取 `config.proxies[].find(name)`（拿到完整 camelCase 定义）。

**修复方向 B**：把 `instance.go` 的 `ProxySnapshot` 扩成 "snapshot + 完整定义"；同时改成 camelCase 与列表 JSON 对齐。

### 10.2 单代理 GET 返回乱形（后端）

`GET /api/v1/configs/{id}/proxies/{name}` 当前输出 `{ "type": "...", "ProxyConfigurer": {...} }` —— 见 §3.3。

**修复**：在 [`pkg/config/v1.go`](../pkg/config/v1.go) 给 `TypedProxyConfig` / `TypedVisitorConfig` 加上自定义 `MarshalJSON`，先用上游 `MarshalJSON` 序列化 `ProxyConfigurer`，再把 `frpmgr` 字段合并进去：

```go
func (c *TypedProxyConfig) MarshalJSON() ([]byte, error) {
    inner, err := c.TypedProxyConfig.MarshalJSON()
    if err != nil { return nil, err }
    if (c.Mgr == ProxyMgr{}) {
        return inner, nil
    }
    var m map[string]any
    if err := json.Unmarshal(inner, &m); err != nil { return nil, err }
    m["frpmgr"] = c.Mgr
    return json.Marshal(m)
}
```

### 10.3 切换状态后 UI 无法回显（次要）

`POST /proxies/{name}/toggle` 工作正常，但 `ProxySnapshot.Disabled` 没有暴露字段 —— 前端 `<Switch checked={record.status !== 'disabled'}>` 永远显示 ON。

**修复**：给 `ProxySnapshot` 增加 `"disabled": bool`，并把 `instance.go:proxySnapshots` 中填充该字段。前端再把 `<Switch>` 改成读 `record.disabled`。

### 10.4 命名风格不统一（建议）

- `Snapshot` / `ProxySnapshot` 走 snake_case；
- `ClientConfigV1` 与 proxy 单体走 camelCase（上游 frp 强约束）；
- `Event` 走 snake_case；

建议把 `Snapshot/ProxySnapshot/Event` 也切到 camelCase（仅在 API 层做一次转换），或者反过来；当前混搭最容易让前端踩坑。

---

## 11. 真实抓包样例（探测自 `frpmgrd-dev.exe` v0.69.1）

```text
POST /api/v1/configs                        201
PUT  /api/v1/configs/diag1                  200
POST /api/v1/configs/diag1/proxies          201  # tcp
POST /api/v1/configs/diag1/proxies          201  # http
POST /api/v1/configs/diag1/proxies          201  # stcp
POST /api/v1/configs/diag1/proxies          201  # tcpmux
PUT  /api/v1/configs/diag1/proxies/ssh      204  # 更新 remotePort
GET  /api/v1/configs/diag1/proxies          200  -> 上文 §3.1 形状
GET  /api/v1/configs/diag1/proxies/ssh      200  -> 上文 §3.3 形状（含 Bug）
```

> 结论：**后端保存路径完全正常**（TCP / UDP / HTTP / HTTPS / TCPMUX / STCP / SUDP / XTCP 全部 201/204）。  
> 用户感知到的"保存规则不好用"主要来自 §10.1（前端字段名错配 + 编辑表单空），其次是 §10.2（单代理 GET 形状坏）与 §10.3（toggle 不可见）。
