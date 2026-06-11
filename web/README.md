# frpmgr WebUI

基于 **Vite + React 19 + TypeScript + Ant Design v6** 的 frp-manager 控制台。
最终产物会被 `web/web.go` 通过 `go:embed dist` 嵌入到 `frpcmgrd` 二进制中，与守护进程一起分发。

## 功能矩阵

| 分组 | 路由 | 说明 |
| ---- | ---- | ---- |
| 总览 | `/dashboard` | 实例总览 + 主机资源圆盘 + 趋势曲线 + 实时事件流回放 |
|      | `/events`    | 全局事件中心：类型过滤、关键字检索、导出 NDJSON |
| 运行 | `/configs`   | frpc 实例 / 客户端配置 / 代理规则 / 原始 TOML 编辑 |
|      | `/logs`      | 实时日志流 |
| 主机 | `/system`    | CPU / 内存 / 网络 / 连接四图，磁盘 + 接口表 |
| 工具 | `/tools/validate` | 远端配置语法校验（接 `POST /api/v1/validate`）|
|      | `/tools/nat` | STUN 探测 NAT 类型（接 `POST /api/v1/nathole/discover`）|
|      | `/import-export` | 备份导入导出 |
| 系统 | `/settings`  | 主题切换 / Token 重置 / 应用版本 |

代理支持的 8 种 frp 类型：`tcp` `udp` `http` `https` `tcpmux` `stcp` `sudp` `xtcp`，以及 9 种内置插件
（`http_proxy` `socks5` `static_file` `unix_domain_socket` `http2http` `http2https` `https2http` `https2https` `tls2raw`）。

## 实时事件流

- 入口：`useEventStream()` / `useEventSubscription()` 位于 [src/events/EventStreamContext.tsx](src/events/EventStreamContext.tsx)
- 通道：WebSocket → `/api/v1/events?token=<bearer>&since=<lastSeq>`
- 后端鉴权：兼容 `Authorization: Bearer` Header 与 `?token=` URL Query（参见 `internal/api/middleware/auth.go`）
- 重连：指数退避 500ms → 15s 上限；token 变更（其它标签页登录）会立即触发重连

## 主题

- 三档模式：浅色 / 深色 / 跟随系统，保存在 `localStorage["frpmgr_theme_mode"]`
- 入口：[src/theme/ThemeContext.tsx](src/theme/ThemeContext.tsx)、[src/theme/tokens.ts](src/theme/tokens.ts)
- 顶栏右上角 `ThemeSwitcher` 可即时切换

## 开发

```bash
cd web
npm install --legacy-peer-deps
npm run dev          # http://localhost:5173，开发期 Vite 代理转发到本地 frpcmgrd
npm run gen:api      # 根据 ../internal/api/openapi.yaml 重新生成 src/api/schema.d.ts
```

> 第一次安装需要 `--legacy-peer-deps`，因为 `openapi-typescript` 与项目其它包存在 peer 依赖冲突，
> 项目实际可用，不影响构建。

## 构建并嵌入到 Go 二进制

```bash
cd web
npm run build        # 产出 dist/，被 web/web.go 的 //go:embed dist 吸收
cd ..
go build -o frpcmgrd ./cmd/frpcmgrd
./frpcmgrd serve --addr :18080 --data-dir ./data
# 浏览器访问 http://localhost:18080 即可看到嵌入的控制台
```

## 目录速览

```
web/
├── src/
│   ├── api/                # 类型 + axios client（带 Bearer 注入 / 401 拦截）
│   ├── components/         # 全局布局
│   ├── events/             # WebSocket EventStreamProvider / Hook
│   ├── pages/              # 各路由页面（按页拆分）
│   ├── theme/              # AntD Token + 浅/深主题 + Switcher
│   └── main.tsx            # Providers 装配：QueryClient → Theme → EventStream → App
└── web.go                  # //go:embed dist
```

## 与桌面版（frpmgr 1.26.1 Win 版）能力对照

| 桌面版功能 | WebUI 实现 |
| ---------- | ---------- |
| 多 frpc 实例管理 | `/configs` 左栏卡片列表 + 右栏标签页 |
| 启动 / 停止 / 重载 | 卡片操作按钮，状态来自 `/api/v1/configs/:id/status` 与事件流 |
| 服务端 (frps) 配置 | `/configs` 客户端 Tab 中可视化编辑或 `toml` Tab 原始编辑 |
| 代理规则全套类型 | `/configs` 代理 Tab，支持 8 种类型 + 插件 |
| 配置导入导出 | `/import-export` |
| 实时日志 | `/logs` + 实例 Tab 中的迷你日志 |
| NAT 探测 | `/tools/nat`（桌面版"自助 NAT 测试"等价） |
| 设置 / 关于 | `/settings` |
