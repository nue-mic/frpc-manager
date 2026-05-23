# frpmgr-server — 部署与使用

`frpmgrd` 是 Linux 优先、Docker 友好的 FRP 客户端守护进程,通过完整的 REST + WebSocket API 管理多个 frpc 实例。原 Windows GUI 版本的 70% 业务能力(配置 CRUD、热重载、状态跟踪、日志查看、导入导出、自毁配置)以 API 形式提供。

## 快速开始 (docker compose)

```bash
cd deploy/
cp .env.example .env
# 至少改一下 FRPMGR_API_TOKEN
openssl rand -hex 32  # 复制结果填进 .env

docker compose up -d --build
docker compose logs -f frpmgrd
```

健康检查:

```bash
curl http://localhost:8080/api/v1/health
# {"status":"ok","uptime_s":3}
```

附 token 调用任意 API:

```bash
TOKEN=$(grep ^FRPMGR_API_TOKEN= .env | cut -d= -f2)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/v1/version
```

## 数据布局

容器卷挂在 `/data`,内部结构:

```
/data/
  ├── profiles/   # *.toml(每个 config 一个文件)
  ├── logs/       # frpc 日志,自动按天轮换
  ├── stores/     # frp visitor 状态(visitor/xtcp 用)
  └── meta.json   # 自启动列表 + 排序
```

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `FRPMGR_API_TOKEN` | ✓ | — | API 鉴权 Bearer Token |
| `FRPMGR_HTTP_ADDR` |   | `:8080` | 监听地址 |
| `FRPMGR_DATA_DIR`  |   | `/data` | 数据根目录 |
| `FRPMGR_CORS_ORIGINS` |   | `*` | 逗号分隔的 CORS 白名单 |
| `FRPMGR_LOG_LEVEL` |   | `info` | trace/debug/info/warn/error |
| `FRPMGR_DOCS_ENABLED` |   | `true` | 是否暴露 `/api/docs` 浏览器 UI(关闭后所有 docs 路由返回 404) |

## 鉴权

- 所有 `/api/v1/*`(除 `/health`)要求 `Authorization: Bearer <token>`
- WebSocket 客户端如果无法设置 header,可用 query 参数:
  `ws://host:8080/api/v1/events?token=<token>`

## 核心端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`    | `/api/v1/configs` | 列表 |
| `POST`   | `/api/v1/configs` | 新建 (JSON) |
| `GET`    | `/api/v1/configs/{id}` | 详情 |
| `PUT`    | `/api/v1/configs/{id}` | 全量替换 (JSON) |
| `PATCH`  | `/api/v1/configs/{id}` | RFC 7396 合并补丁 |
| `DELETE` | `/api/v1/configs/{id}` | 删除 |
| `GET/PUT`| `/api/v1/configs/{id}/raw` | 直接读写 TOML 文本 |
| `POST`   | `/api/v1/configs/{id}/{start,stop,reload}` | 生命周期 |
| `GET`    | `/api/v1/configs/{id}/proxies` | proxy 列表 + 实时状态 |
| `*`      | `/api/v1/configs/{id}/proxies/{name}` | proxy CRUD |
| `GET`    | `/api/v1/configs/{id}/logs?lines=200` | 日志查询 |
| `GET`    | `/api/v1/configs/{id}/logs/tail` | **WebSocket** 实时日志 |
| `GET`    | `/api/v1/events` | **WebSocket** 全局事件流 |
| `POST`   | `/api/v1/import/{file,url,text,zip}` | 多种导入 |
| `GET`    | `/api/v1/configs/{id}/export` | 单文件下载 |
| `GET`    | `/api/v1/export/all` | ZIP 备份 |
| `POST`   | `/api/v1/validate` | 不落盘校验 |
| `POST`   | `/api/v1/nathole/discover` | STUN 探测 |
| `GET`    | `/api/v1/system/info` | **聚合面板**:host + cpu + memory + disk + network + connections + process |
| `GET`    | `/api/v1/system/cpu?window=200ms` | CPU 使用率 / 拓扑 / 每核 / load avg |
| `GET`    | `/api/v1/system/memory` | 虚存 + swap |
| `GET`    | `/api/v1/system/disk?paths=/foo,/bar` | 磁盘用量(默认 `/` + data_dir) |
| `GET`    | `/api/v1/system/network` | 每网卡 cumulative bytes/packets |
| `GET`    | `/api/v1/system/connections` | TCP/UDP 总数 + 按状态分组 + daemon 自己持有的 |
| `GET`    | `/api/v1/system/process` | daemon 自身:RSS / 线程 / goroutine / open files |

完整 schema 见 [`internal/api/openapi.yaml`](../internal/api/openapi.yaml)(已 embed 进二进制),运行时通过 `GET /api/docs/openapi.yaml` 获取。可直接喂给 Swagger Codegen / openapi-typescript 生成前端 client。

## 浏览器版 API 文档

启动后访问 **<http://localhost:8080/api/docs/>** — 内置 [Scalar](https://github.com/scalar/scalar)(MIT,OpenAPI 3.1 原生支持),界面现代化,带"try it out"调试功能。

- HTML 页:`GET /api/docs/` — Scalar reference UI,从 jsdelivr CDN 加载 JS bundle
- 原始 spec:`GET /api/docs/openapi.yaml`(也支持 `.json` 别名)
- **默认免鉴权** — 与多数开源 daemon 的 Swagger/ReDoc 端点惯例一致
- **关闭方式**:`FRPMGR_DOCS_ENABLED=false`(docs 三个路由全部返回 404,其他 API 不受影响)
- **离线场景**:如果容器无外网,把 Scalar 的 standalone bundle 下载到本地并修改 [`internal/api/docs.go`](../internal/api/docs.go) 中的 `<script src>` 即可

## 事件 schema

WebSocket `/api/v1/events` 每个 frame 是一个 JSON Event:

```json
{
  "seq": 17,
  "type": "instance.state",
  "config_id": "demo",
  "ts": "2026-05-20T08:48:55Z",
  "data": { "state": "started", "prev_state": "starting" }
}
```

事件类型:

- `instance.state` — 实例状态变更 (started/stopped/starting/stopping)
- `instance.error` — 运行时错误
- `proxy.status` — 单个 proxy 状态变更
- `config.changed` — 配置被修改
- `config.deleted` — 配置被删除
- `log.line` — 日志行(仅 `/logs/tail` 端点)

订阅端可在连接后发送:

```json
{"action":"filter","types":["instance.state","proxy.status"],"config_ids":["demo"]}
```

进行二次过滤;或 `{"action":"unfilter"}` 取消。

## 创建配置示例

```bash
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST http://localhost:8080/api/v1/configs -d '{
    "id": "demo",
    "config": {
      "serverAddr": "frps.example.com",
      "serverPort": 7000,
      "auth": {"method":"token","token":"abcd1234"},
      "log":  {"level":"info","maxDays":3},
      "proxies": [
        {"type":"tcp","name":"ssh","localIP":"127.0.0.1","localPort":22,"remotePort":2222}
      ],
      "frpmgr": {"name":"Demo Tunnel","manualStart":true}
    }
  }'
```

`config` 字段就是 frp 官方 `ClientCommonConfig` 的 JSON 形态,外加一个 `frpmgr` 扩展块:

```json
"frpmgr": {
  "name": "human readable label",
  "manualStart": true,        // true = 仅手动启动；false / 缺省 = daemon 启动时自动 Start
  "autoDelete": {
    "method": "relative",   // or "absolute"
    "afterDays": 7,
    "afterDate": "2026-12-31T23:59:59Z"
  }
}
```

> daemon 重启行为：所有 `manualStart != true` 的实例都会在 `frpmgrd serve` 启动时被自动拉起；想要某实例随 daemon 启停"持久关闭"，把 `manualStart` 置为 `true` 后保存即可。启动顺序遵循 `meta.json` 的 `sort` 列表。


## 流量与连接数指标(重要)

frp v0.68 客户端**不在客户端做字节级流量记账** — `WorkingStatus` 只暴露 `Phase/Err/RemoteAddr`,没有 `TodayTrafficIn/Out` 之类字段。流量统计在 **frps 服务端**那边。所以本 daemon 能给的是分级近似:

| 想要的指标 | 能拿到吗 | 来自哪里 |
|---|---|---|
| 容器整体收发字节(累计) | ✅ 准确 | `GET /system/network` (`/proc/net/dev`) |
| 容器整体 TCP/UDP 连接数 + 按状态分组 | ✅ 准确 | `GET /system/connections` |
| daemon 进程自己持有的 socket 数 | ✅ 准确 | `system/connections.owned_*` |
| **per-proxy 当前活跃连接数 (`cur_conns`)** | ✅ 准确(Linux),自动按 LocalPort 匹配 `/proc/net/tcp`,每 2 秒刷新 + WS 推 `proxy.connections` 事件 | `GET /configs/{id}/proxies` 里的 `cur_conns` 字段 |
| **per-proxy 字节流量** | ❌ **frp 客户端不记账** | 需要在 **frps 端**开 dashboard,查它的 `/api/proxy/<type>` 拿 `today_traffic_in/out` |
| 速率(bytes/s) | 客户端自己算:取两次 `/system/network` 样本差值除以时间 | — |

**结论**:如果你做监控面板,容器整体收发字节 + 每个 proxy 的当前连接数已经足够覆盖 90% 场景。如果非要 per-proxy 字节统计,在 frps 端开 dashboard 并由前端额外去拉它。

## 网络模式

- **推荐 `network_mode: host`** — frpc 出站 + xtcp + STUN 都能正常工作。
- 桥接模式可用,但 xtcp 类代理可能受限,需要明确暴露 frpc 用到的本地端口。

## 升级

1. `git pull && docker compose build`
2. `docker compose up -d`(`restart: unless-stopped` 会自动重新拉起)
3. 升级期间 `/data` 持久化,配置不丢

## 本地开发

```bash
# 直接跑(主机模式,不上 Docker)
make run

# 跑单测
make test

# 交叉编译 Linux 二进制
make build
```

## 故障排查

- **401 unauthorized**: 检查 `FRPMGR_API_TOKEN` 是否对齐
- **404 在 WS 时**: 路径必须是 `/api/v1/events`,token 走 `?token=` 或 Authorization header
- **start 立即返回成功但 proxy.status 不上来**: 看 `/api/v1/configs/{id}/logs/tail`,通常是 frps 端连不上 / token 错
- **容器健康检查失败**: `docker compose exec frpmgrd frpmgrd health`
