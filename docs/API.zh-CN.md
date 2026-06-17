# frpcmgrd API 详细参考（中文 · v1）

> 本文件基于 [`internal/api`](../internal/api/) 与 [`internal/manager/instance.go`](../internal/manager/instance.go) 实地核对生成，并使用 dev 守护进程 `./frpcmgrd-dev.exe serve` 真实探测过每条路径。
> 凡是与 [`internal/api/openapi.yaml`](../internal/api/openapi.yaml) 不一致之处，请以本文档为准（OpenAPI 描述了路径但 **没有** 描述请求/响应体的字段，本文档把它补齐）。

---

## 0. 全局约定

| 项目 | 值 |
|---|---|
| 监听地址 | `FRPCMGR_HTTP_ADDR`，可只填端口(如 `18080`，自动归一化为 `:18080`)或 `:端口`/`ip:端口`，默认 `:18080` |
| 数据目录 | `FRPCMGR_DATA_DIR`，默认 `/data` |
| 鉴权 | 除 `/api/v1/health`、`GET /api/v1/ui/branding` 与 `/api/docs/*` 外，所有 `/api/v1/*` 都要求 `Authorization: Bearer <FRPCMGR_API_TOKEN>` |
| Content-Type | 除特别说明（`/raw` / `/import/zip` / `/validate` 等）外，**请求/返回均为 `application/json; charset=utf-8`** |
| 401 时机 | 缺失或错误 Bearer Token；前端拦截器会 `clearAPIToken()` 并跳转 `/login` |
| 路径 ID 限制 | `id` 不允许 `/ \ : ? * < > | " '`，不能以 `.` 开头，长度 ≤ 64 |
| WebSocket 子路径 | `/api/v1/events`、`/api/v1/configs/{id}/logs/tail` —— 需要把 `Authorization` 通过 query `?token=...` 或额外协议头携带；CORS 由 `FRPCMGR_CORS_ORIGINS` 控制 |

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
| `visitor_port_conflict` | 409 | 跨实例同协议族访客本地端口冲突（见 §3.2） |
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
| `daemon` | string | `frpcmgrd` 版本号（例 `"dev"`） |
| `frp` | string | 内嵌的 frp 版本（例 `"0.69.1"`） |
| `build_date` | string | 构建时间，未注入时为 `"unknown"` |

```json
{ "daemon": "dev", "frp": "0.69.1", "build_date": "unknown" }
```

### 1.3 GET `/api/v1/version/check` — 检查最新版本

查询 GitHub 最新 release 并与当前版本对比。后端结果缓存约 1 小时；传 `?force=1` 绕过缓存。
字段为 **snake_case**（与 `/api/v1/system/*` 一致）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `current` | string | 当前 daemon 版本 |
| `frp` | string | 内嵌 frp 版本 |
| `deployment_mode` | string | `docker` / `systemd` / `openrc` / `launchd` / `windows-service` / `manual` |
| `self_update_enabled` | bool | 是否允许 Web 端自更新（`FRPCMGR_SELF_UPDATE_ENABLED`） |
| `has_update` | bool | 是否有更新版本 |
| `can_self_update` | bool | 该部署是否支持一键更新（Docker / 手动运行为 false） |
| `reason` | string | 不可更新或被禁用时的说明，正常为空串 |
| `latest` | string? | 最新版本 tag（仅查询成功时返回） |
| `changelog` | string? | release 正文（Markdown，仅成功时返回） |
| `html_url` | string? | release 页面链接（仅成功时返回） |
| `published_at` | string? | 发布时间（仅成功时返回） |
| `check_error` | string? | 查询失败时的错误信息（仅失败时返回） |

```json
{
  "current": "1.2.30", "frp": "0.69.1", "deployment_mode": "systemd",
  "self_update_enabled": true, "has_update": true, "can_self_update": true,
  "reason": "", "latest": "v1.2.32", "changelog": "## 修复\n- ...",
  "html_url": "https://github.com/mia-clark/frpc-manager/releases/tag/v1.2.32",
  "published_at": "2026-06-06T00:00:00Z"
}
```

### 1.4 POST `/api/v1/system/update` — 一键更新并重启

启动一个**脱离进程**下载最新版、替换二进制并重启服务，立即返回 `202`。客户端随后轮询
`/api/v1/version` 直到 `daemon` 变化即视为完成。受 `FRPCMGR_SELF_UPDATE_ENABLED` 开关控制，
且仅对服务化部署可用（Docker / 手动运行会被拒绝）。传 `?force=1` 可在已是最新时强制重装。

| 状态码 | 含义 |
|---|---|
| `202` | 更新已开始，服务即将重启；body 含 `{status, from, to, message}` |
| `403` | 管理员已禁用 Web 端自更新 |
| `400` | 当前部署方式不支持一键更新（Docker / 手动） |
| `409` | 已是最新版本（未带 `force=1`） |
| `502` | 无法获取最新版本（网络受限等） |

```json
{ "status": "updating", "from": "1.2.30", "to": "v1.2.32", "message": "更新已开始，服务即将重启，请稍候…" }
```

---

### 1.5 GET `/api/v1/ui/branding` — 读取 UI 品牌（**无需鉴权**）

返回**生效品牌**：管理员未自定义的字段回退到默认值。字段为 **snake_case**。
本端点公开（无需 token），以便登录页与浏览器 `<title>` 在登录前即可显示自定义值。

```json
{ "app_name": "FRPC", "app_subtitle": "客户端管理面板", "html_title": "FRPC · 内网穿透客户端管理控制台" }
```

> 首屏零闪：daemon 在下发 SPA 的 `index.html` 时已就地把 `<title>` 与
> `window.__FRPC_BRANDING__` 注入为当前品牌，前端首帧即正确，无需等待本接口。
> 本接口主要供设置页回填与运行时同步。

### 1.6 PUT `/api/v1/ui/branding` — 更新 UI 品牌

| 入参（均可选） | 类型 | 说明 |
|---|---|---|
| `app_name` | string | 品牌名（侧边栏 + 登录页主标题），≤ 40 字符 |
| `app_subtitle` | string | 副标题（侧边栏 + 登录页副标题），≤ 60 字符 |
| `html_title` | string | 浏览器标签 `<title>`，≤ 120 字符 |

语义：**省略**的字段保留当前存储值；显式传**空串**则该字段**重置为默认**。值会被
trim 并按字符（rune）限长。返回更新后的**生效品牌**（结构同 1.5）。持久化在
`<DataDir>/meta.json` 的 `branding` 字段，清浏览器缓存 / 重登后仍生效。

```jsonc
// 请求
{ "app_name": "我的隧道", "app_subtitle": "内网穿透面板", "html_title": "我的隧道 · 控制台" }
// 响应 200
{ "app_name": "我的隧道", "app_subtitle": "内网穿透面板", "html_title": "我的隧道 · 控制台" }
```

### 1.7 GET `/api/v1/system/config` — 读取运行时系统配置

把原本只能用 `FRPCMGR_*` 环境变量（装机写死、改了要 SSH + 重启）配置的若干项，
做成 **运行时可调**：env 是启动默认值，UI 的改动作为**覆盖**存进 `meta.json`，
读取时 `生效值 = env 默认 ∪ meta 覆盖`，**全部免重启即时生效**。

返回三块：`effective`（当前生效值）、`env_default`（环境变量原始默认）、
`overridden`（各字段是否被覆盖：`true`=已固定为 UI 值，`false`=跟随 env）。

```jsonc
// 响应 200
{
  "effective":   { "log_level": "debug", "self_update_enabled": true, "docs_enabled": false, "cors_origins": ["*"] },
  "env_default": { "log_level": "info",  "self_update_enabled": true, "docs_enabled": true,  "cors_origins": ["*"] },
  "overridden":  { "log_level": true,    "self_update_enabled": false, "docs_enabled": true, "cors_origins": false }
}
```

### 1.8 PUT `/api/v1/system/config` — 更新运行时系统配置

| 入参（均可选） | 类型 | 说明 |
|---|---|---|
| `log_level` | string | `trace\|debug\|info\|warn\|error` 之一，非法值 400。即时改运行 logger 等级 |
| `self_update_enabled` | bool | 关闭后「关于」页一键更新被禁用（`/system/update` 拒绝） |
| `docs_enabled` | bool | 关闭后 `/api/docs` 系列返回 404 |
| `cors_origins` | string[] | CORS 白名单；非空，`["*"]` 放行全部。对后续请求 / 新 WS 连接即时生效 |
| `reset` | string[] | 列出要**清除覆盖**、回退 env 默认的字段名（同上四个键） |

语义：**提供**的字段写为覆盖；`reset` 里列出的字段清除覆盖。校验：`log_level`
必须是合法枚举，`cors_origins` 若提供则不能为空数组。返回结构同 1.7（更新后的
生效值）。覆盖持久化在 `<DataDir>/meta.json` 的 `system_config` 字段，跨重启保留、
随备份导出。

```jsonc
// 请求：把日志切到 debug、关掉文档
{ "log_level": "debug", "docs_enabled": false }
// 请求：恢复某几项为 env 默认
{ "reset": ["log_level", "docs_enabled"] }
```

### 1.9 定时备份 `/api/v1/backup/*`

把全量配置打包，按 cron 定时上传到云端存储（S3 兼容 / WebDAV）。**完整设计、存储路径
方案、数据模型、安全说明见 [docs/BACKUP.zh-CN.md](BACKUP.zh-CN.md)**，此处只列端点：

| 方法 路径 | 说明 |
|---|---|
| `GET /backup/channels` | 列存储渠道（密钥脱敏，只回 `*_set` 布尔） |
| `POST /backup/channels` | 新建渠道（`kind`: `s3` / `webdav`） |
| `POST /backup/channels/test` | 测试一份未保存的渠道配置（返回 `{ok,error?}`） |
| `PUT /backup/channels/{id}` | 更新渠道（密钥留空 = 保持不变） |
| `DELETE /backup/channels/{id}` | 删除渠道（被计划引用则 409） |
| `POST /backup/channels/{id}/test` | 测试已存渠道连通性 |
| `GET /backup/channels/{id}/objects` | 浏览渠道上**实际存在的 .zip 备份**（最新在前，供恢复挑选） |
| `GET /backup/channels/{id}/download?key=` | 下载某个备份对象（zip 附件，前端走 blob 带鉴权） |
| `POST /backup/channels/{id}/restore` | 下载某个备份对象并恢复（`{key}`，等同 `/import/zip`） |
| `GET /backup/schedules` | 列计划（含 `running` / `last_run`） |
| `POST /backup/schedules` | 新建计划（`cron` + `channel_id` + `retention`） |
| `PUT /backup/schedules/{id}` | 更新计划 |
| `DELETE /backup/schedules/{id}` | 删除计划 |
| `POST /backup/schedules/{id}/toggle` | 开启 / 关闭（即时重载 cron） |
| `POST /backup/schedules/{id}/run` | 立即手动备份（202；进行中 409） |
| `GET /backup/runs?limit=` | 备份历史（最新在前） |

渠道与计划存于 `meta.json`，**跨重启 / 更新不丢**，并随 `/export/all` 备份迁移（`/import/zip`
还原，回报 `backup_restored`）。密钥 API 读取一律脱敏；**备份产物里的密钥被 redact 置空**（不随备份外流），
跨主机还原后需重填密钥（同主机沿用本机现有密钥）。

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

### 2.12 组网 / 虚拟网络（vnet · 实验性）

> 基于上游 frp 的 **VirtualNet**（Alpha 实验特性，官方"勿用于生产"）：在每个参与节点建一块 TUN 虚拟网卡、分配虚拟 IP，节点间通过 frp 的 stcp 隧道（经 frps 中转，非 p2p）互通 IP 包。**仅 Linux/macOS**；Windows 不支持（配置后实例会拒绝启动并给出明确错误）。建 TUN 需 root / CAP_NET_ADMIN。

公共配置（`ClientConfigV1` 顶层，camelCase）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `featureGates.VirtualNet` | bool | 必须为 `true` 才启用 vnet（守护进程加载时会 `featuregate.SetFromMap` 应用到 frp；这是进程级全局开关，任一实例开启即对该 daemon 全局生效） |
| `virtualNet.address` | string | 本机在虚拟网络中的 CIDR 地址，如 `100.86.0.2/24`；**同一虚拟网内各节点不能重复** |

组网三步（均落在已有的代理/访客字段，见 §3）：

1. 公共配置：`featureGates.VirtualNet = true` + `virtualNet.address = "100.86.0.2/24"`。
2. **被访问端**（每节点一条）：`type:"stcp"` + `secretKey` + `plugin:{type:"virtual_net"}`。
3. **访问端**（每个要访问的对端各一条）：`type:"stcp"` + `serverName`（对端代理名）+ `secretKey`（与对端一致）+ `bindPort:-1` + `plugin:{type:"virtual_net", destinationIP:"对端虚拟IP"}`。每个 `destinationIP` 生成一条 /32 主机路由。

> Docker 跑 vnet：需 `cap_add:[NET_ADMIN]` + `devices:[/dev/net/tun]` + 以 root 运行，见 [`deploy/docker-compose.vnet.yml`](../deploy/docker-compose.vnet.yml)。OpenWrt：procd 默认 root，需内核含 `kmod-tun`（`/dev/net/tun`）。

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
>
> 🔒 **访客本地端口冲突校验**：访客在本地起监听，STCP/XTCP 走 **TCP**、SUDP 走 **UDP**。
> 若**任一实例**（含当前 config 内其它访客）已有**同协议族** + 同 `bindPort` + 地址重叠
> （同 IP，或任一为 `0.0.0.0` 通配；空 `bindAddr` 按 frp 默认 `127.0.0.1` 处理）的访客，
> 返回 `409 visitor_port_conflict`，`error.details` 含 `config_id` / `config_name` /
> `name` / `type` / `bind_addr` / `bind_port`。注意 STCP 与 XTCP 同属 TCP，**会互相冲突**；
> SUDP 与 TCP 端口独立。`bindPort <= 0`（不监听）不校验。
>
> 覆盖范围：本端点（增/改单条）、`PUT /configs/{id}`（整 config）、`PUT /configs/{id}/raw`
> （原始 TOML 编辑器）均校验。**导入路径**（`/import/*`）刻意**不**做冲突校验，以保证
> 备份还原的完整度——导入的冲突访客会在 frpc 启动监听时报端口占用，需手动调整。

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

> **⚠️ STCP/XTCP/SUDP 两端必须一致**：frp 中代理端 (`proxy`) 与访客端 (`visitor`) 各自按**自身**的 `transport.useEncryption` / `transport.useCompression` 包装数据，**互不协商**。一端开、另一端不开 = 隧道能建立（打洞成功）但数据为乱码、**无法访问**。务必让成对的 proxy 与 visitor 两个开关取值完全相同。XTCP 走 `quic` 时 P2P 链路本身已是 TLS 加密，`useEncryption` 多为冗余，建议两端都保持关闭。

**Plugin 透传**：`plugin: { type: "http2https", localAddr: "...", ... }`，可选类型 `http_proxy / socks5 / static_file / unix_domain_socket / http2http / http2https / https2http / https2https / tls2raw / virtual_net`。

> **组网 (vnet) 服务端**：`type: "stcp"` + `secretKey` + `plugin: { type: "virtual_net" }`（无其它参数）把本节点暴露进虚拟网络，供对端访客访问。需先在公共配置开启 `featureGates.VirtualNet` 并设置 `virtualNet.address`（见 §2.12）。仅 Linux/macOS。

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
| `plugin` | object |  | visitor 插件。组网 (vnet) 访客用 `plugin: { type: "virtual_net", destinationIP: "100.86.0.1" }`，并把 `bindPort` 设为 `-1`（只接收重定向）。`destinationIP` 为对端节点的虚拟 IP（单个 IP，非网段）。见 §2.12 |

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

### 3.7 POST `/api/v1/configs/{id}/proxies/reorder` — 持久化代理/访客显示顺序

请求体（`order` 为**完整**的名称有序列表，代理与访客混编、按显示顺序排列）：

```json
{ "order": ["ssh", "web", "db-visitor"] }
```

后端在内存态的合并代理数组上按该顺序稳定重排（一次 `Update` → 一次热重载）。**不在列表里的名称保持原相对顺序排到末尾**，因此过期/残缺的 `order` 不会丢代理。访客的新位置会写回 `mgr.sort`，跨重启持久化。返回 `204`；配置不存在 `404 / config_not_found`。

### 3.8 POST `/api/v1/configs/{id}/proxies/batch-delete` — 批量删除

请求体：

```json
{ "names": ["ssh", "web"] }
```

一次请求原子删除多条（一次 `Update` → 一次热重载，而非 N 次各自重载）。返回 `200`：

```json
{ "deleted": 2 }
```

`names` 为空 `400`；配置不存在 `404 / config_not_found`；配置存在但无任何匹配 `404 / proxy_not_found`。按 `name` 或 range 别名匹配。

### 3.9 POST `/api/v1/configs/{id}/proxies/move` — 批量迁移到其他实例

把选中代理/访客从当前配置原子搬移到 `target_id` 指向的另一个配置：

```json
{ "target_id": "frps-tokyo", "names": ["ssh", "web"] }
```

**原子顺序：先写目标（追加）、后写来源（移除）**，故中途失败只会留下重复、绝不丢失代理。返回 `200`：

```json
{ "moved": 2 }
```

| 错误 | 状态 | 触发 |
|---|---|---|
| `bad_request` | 400 | 缺 `target_id`/`names`，或 `target_id` 等于来源 |
| `config_not_found` | 404 | 来源或目标配置不存在 |
| `proxy_not_found` | 404 | 配置存在，但来源里没有任一匹配名称 |
| `proxy_already_exists` | 409 | 目标已存在同名规则，`error.details.names` 列出冲突名（整体中止，不部分迁移） |
| `internal` | 500 | 半完成：已写入目标但从来源移除失败，`error.details` 含 `target_id`/`moved`（目标有重复、来源未删，需手动核对） |

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

若包内含 `meta.json`（由 §5.7 导出的备份自带），会在导入配置后一并恢复：
- **品牌**（app_name / app_subtitle / html_title）；
- **实例显示顺序**（`sort`）—— 按备份里的顺序重排，备份里没列到的实例排到末尾，因此换机器/重装后实例顺序与原机一致；
- **系统运行时覆盖**（`system_config`：日志级别 / Web 自更新 / 文档 / CORS，见 §1.7-1.8）—— 自更新/文档/CORS 即时生效，日志级别在下次重启后生效（仅当备份里确有覆盖时才还原）。

`log_view_since` / `auto_start` 不会被改动。

返回（`branding_restored` / `order_restored` / `system_config_restored` 表示是否从备份还原了品牌 / 顺序 / 系统覆盖）：

```json
{ "imported": ["diag1", "diag2"], "branding_restored": true, "order_restored": true, "system_config_restored": true }
```

### 5.6 GET `/api/v1/configs/{id}/export` — 下载单实例 TOML

返回 `application/toml`，`Content-Disposition: attachment; filename="{id}.toml"`。

### 5.7 GET `/api/v1/export/all` — 下载全部实例为 ZIP

返回 `application/zip`，`Content-Disposition: attachment; filename="frpmgr-export-YYYYmmdd-HHMMSS.zip"`，内部含 `profiles/*.toml/*.ini/*.conf` **以及 `meta.json`**（携带品牌/排序），因此备份是自包含的：换机器或重装后用 §5.5 导入即可一并还原品牌。

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

> ⚠️ 自 v1.2.22 起，所有 frpc 实例的日志统一写入 `{FRPCMGR_DATA_DIR}/logs/frpc.log` 合并日志文件，
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
`tail -f {FRPCMGR_DATA_DIR}/logs/frpc.log`。

**LogViewSince 持久化位置**：`{FRPCMGR_DATA_DIR}/meta.json` 中的 `log_view_since`
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

## 11. 真实抓包样例（探测自 `frpcmgrd-dev.exe` v0.69.1）

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
