# frpc-manager 集成 frp VirtualNet（组网/虚拟网络）设计

> 日期：2026-06-14 ｜ 方案：B（把上游 vnet 原样搬进现有 UI，复用规则抽屉与常规配置 tab）
> 内嵌 frp 版本：v0.69.1 ｜ VirtualNet 上游成熟度：**Alpha（实验性，官方"勿用于生产"）**

## 1. 背景与目标

frp v0.62 引入了 **VirtualNet（vnet）**：在每个参与节点建一块 TUN 虚拟网卡、分配虚拟 IP，节点之间通过 frp 已有的 **stcp 隧道（经 frps 中转）** 互通 IP 包，从而像轻量 VPN 一样按虚拟 IP 互访。

本项目（frpc-manager）目标：把 vnet 的全部配置面 **1:1 暴露**到管理后台，让用户用现有"代理穿透规则"抽屉 + "常规配置"可视化页就能配出 vnet，而不必手写 TOML。定位为**多机虚拟 IP 互访（mesh）**、标注**实验性·仅 Linux/macOS**。

非目标（本期不做）：令牌/扫码加入向导、跨节点中央编排、把整个内网网段当网关暴露（frp 当前只给 /32 主机路由）。

## 2. vnet 工作模型（源码级，权威）

一个节点要参与组网，需要三样东西：

1. **开关**（客户端公共配置）：`featureGates = { VirtualNet = true }`
2. **本机虚拟地址**（客户端公共配置）：`virtualNet.address = "100.86.0.X/24"`（建 TUN 网卡）
3. **角色**（按需，可同时配）：
   - **被访问方 / 服务端**：一条 `stcp` 代理 + `[proxies.plugin] type = "virtual_net"`（无参数），带 `secretKey`
   - **访问方 / 客户端**：一条 `stcp` 访客 + `serverName`（指向对端代理名）+ `secretKey`（与对端一致）+ `bindPort = -1` + `[visitors.plugin] type = "virtual_net" destinationIP = "对端虚拟IP"`

要访问 N 个对端就配 N 条访客（每条一个 `destinationIP`，生成一条 /32 主机路由）。流量经 frps 中转（stcp，非 p2p）。

### 硬约束（已读源码确认）
- **平台**：TUN 仅实现 Linux / macOS；Windows 落入 `pkg/vnet/tun_unsupported.go` 直接返回 "not supported"，配了 vnet 会让实例 `Init` 报错并被 `stop()`，**启动失败**。
- **权限**：建网卡 + 加路由需 root / CAP_NET_ADMIN（Linux 走 netlink，macOS 走 `ifconfig`/`route`）。裸机 systemd/OpenRC/launchd/NSSM(LocalSystem)/OpenWrt procd 默认 root，天然满足；**Docker 默认降权到 UID 65532 且无 NET_ADMIN/`/dev/net/tun`，跑不起来**。
- **Alpha 不稳定**：已知 bug [#4756](https://github.com/fatedier/frp/issues/4756)（大包 `too many segments` 崩溃）、[#4774](https://github.com/fatedier/frp/issues/4774)（visitor 静默 ping 不通）。
- **多实例**：feature gate 是进程级全局单例（任一实例开启即全进程生效）；每个带 `virtualNet.address` 的实例各建一块 TUN，地址段必须互不重叠。

## 3. 集成的两个"命门"（不修则 UI 全是假象）

1. **feature gate 从未被应用**：本项目 `services/client.go` 直连 `client.NewService`，不像上游 `cmd/frpc/sub/root.go:134-135` 那样调 `featuregate.SetFromMap`。结果只要配了 `virtualNet.address`，`validation.ValidateAllClientConfig` 会因 `featuregate.Enabled(VirtualNet)==false` 报 `VirtualNet feature is not enabled` → **实例起不来**。
2. **vnet 字段在结构化保存里被静默丢弃**：API 的 `ClientConfigV1`(camelCase，内嵌上游 v1，能正常 decode) → `fromV1` 降级到 legacy `pkg/config.ClientConfig` → `saveTOML`。而 legacy 模型 + `conversion.go` **没有** `VirtualNet`/`FeatureGates` 字段、也不处理 **访客 plugin**。实测往返：`virtualNet.address`、`featureGates`、访客 `plugin` 全部丢失，**返回 200 不报错**（CLAUDE.md 第 6 条点名的隐蔽坑）。

> 关键细节：`v1.TypedClientPluginOptions.MarshalJSON` 只序列化内层 `ClientPluginOptions`（nil → `null`）。所以服务端 virtual_net 代理在 `clientProxyBaseToV1` 必须把 `ClientPluginOptions` 设为 `&v1.VirtualNetPluginOptions{Type: "virtual_net"}`，否则 GET 回读 `plugin:null` 丢类型。

## 4. 字段契约（前后端对接，权威命名）

> 全部 camelCase，沿用上游。`decodeJSON` 的 `DisallowUnknownFields` 已认识这些 key（内嵌上游 struct），不会 400。**严禁写错大小写**（`destinationIP` 不是 `destinationIp`）。

| 位置 | JSON 路径 | 类型 | 说明 |
|---|---|---|---|
| 公共配置 | `config.featureGates.VirtualNet` | bool | 开关 |
| 公共配置 | `config.virtualNet.address` | string | 本机虚拟地址，CIDR，如 `100.86.0.2/24` |
| 代理(服务端) | `proxies[].type` | `"stcp"` | |
| 代理(服务端) | `proxies[].secretKey` | string | |
| 代理(服务端) | `proxies[].plugin.type` | `"virtual_net"` | 无其它参数 |
| 访客(客户端) | `visitors[].type` | `"stcp"` | |
| 访客(客户端) | `visitors[].serverName` | string | 对端代理名 |
| 访客(客户端) | `visitors[].secretKey` | string | 与对端一致 |
| 访客(客户端) | `visitors[].bindPort` | int | `-1`（只接收重定向，不绑定本地端口） |
| 访客(客户端) | `visitors[].plugin.type` | `"virtual_net"` | |
| 访客(客户端) | `visitors[].plugin.destinationIP` | string | 对端虚拟 IP（单个，非 CIDR） |

## 5. 后端改动（file-by-file）

1. **`pkg/consts/config.go`**：新增 `PluginVirtualNet = "virtual_net"`，并加入 `PluginTypes`。
2. **`pkg/config/client.go` `ClientCommon`**：新增 `VirtualNetAddress string` `ini:"-"` 与 `FeatureGates map[string]bool` `ini:"-"`（不污染 legacy INI）。
3. **`pkg/config/client.go` `Proxy`**：新增 `DestinationIP string` `ini:"-"`（承载访客 virtual_net 插件参数；访客插件类型复用 `BaseProxyConf.Plugin string`）。
4. **`pkg/config/conversion.go`**：
   - `ClientCommonToV1`：`r.VirtualNet = v1.VirtualNetConfig{Address: c.VirtualNetAddress}`；`r.FeatureGates = c.FeatureGates`。
   - `ClientCommonFromV1`：反向 `r.VirtualNetAddress = c.VirtualNet.Address`；`r.FeatureGates = c.FeatureGates`。
   - `clientProxyBaseToV1` 的 `switch c.Plugin`：加 `case consts.PluginVirtualNet: r.Plugin.ClientPluginOptions = &v1.VirtualNetPluginOptions{Type: c.Plugin}`。（FromV1 已有 `out.Plugin = c.Plugin.Type`，无参数无需额外 case。）
   - `clientVisitorBaseToV1`：当 `p.Plugin == consts.PluginVirtualNet` 时设 `r.Plugin = v1.TypedVisitorPluginOptions{Type: "virtual_net", VisitorPluginOptions: &v1.VirtualNetVisitorPluginOptions{Type: "virtual_net", DestinationIP: p.DestinationIP}}`。
   - `clientVisitorBaseFromV1`：读 `c.Plugin`：若 `Type == "virtual_net"` 则 `out.Plugin = "virtual_net"`，并从 `*v1.VirtualNetVisitorPluginOptions` 取 `out.DestinationIP`。
5. **`services/client.go`**（`NewFrpClientService` 与 `Reload`）与 **`services/frp.go`**（`VerifyClientConfig`）：在每次 `LoadClientConfigResult`/`LoadClientConfig` 之后、校验之前，调用 `featuregate.SetFromMap(common.FeatureGates)`（封一个小 helper）。
6. **Windows 守卫**：在 `services` 层（实例创建/校验路径），当 `runtime.GOOS == "windows" && common.VirtualNet.Address != ""` 时返回明确中文错误，避免难懂的 runtime 失败。

## 6. 前端改动（`web/src/pages/Configs.tsx`）

1. **常规配置（visual）tab**：新增「虚拟网络 (VNet)」分组（带 🧪实验性·仅 Linux/macOS 提示）= 开关（写 `config.featureGates.VirtualNet`）+ 地址输入（写 `config.virtualNet.address`，占位 `100.86.0.2/24`）。读写挂在 `GET/PUT /configs/{id}` 的 `config` 上。
2. **代理抽屉**：插件下拉加 `virtual_net`；选中后隐藏 localIP/localPort（插件接管），只保留 `secretKey`。
3. **访客抽屉**：补「插件」选择（当前访客无插件 UI）；选 `virtual_net` 时显示 `destinationIP` 输入，并把 bindPort 默认置 `-1`。`handleSaveProxy` 的 visitor 信封要透传 `plugin`，`openProxyDrawer` 回填要读 `plugin.type`/`plugin.destinationIP`。
4. 平台提示：检测到非 Linux/macOS（可由后端 `/system` 信息或保存报错驱动）时灰显/提示。

## 7. 配套（部署）

- **Docker**：新增 `deploy/docker-compose.vnet.yml`（或在现有 compose 加注释示例）：`cap_add: [NET_ADMIN]` + `devices: ["/dev/net/tun:/dev/net/tun"]` + vnet 模式以 root 运行（`entrypoint.sh` 增加"检测到 vnet 需求则不降权"分支，或 compose 直接 `user: "0:0"`）。不改默认镜像行为。
- **OpenWrt**：纳入支持。procd 默认 root；需文档说明依赖 `kmod-tun` 与 `/dev/net/tun`；在 192.168.1.188 测试机实测 TUN 可建。LuCI 若有相关展示需同步。
- **文档**：`docs/API.zh-CN.md` 增补 vnet 字段；`openapi.yaml` 若新增约束则同步并 `npm run gen:api`；README/openwrt 文档补 vnet 前置条件（平台/权限/Alpha 风险/地址段不重叠）。

## 8. 测试与验收

- `go test ./...`、`go vet ./...`、前端 `tsc -b`/`npm run build` 全绿。
- **新增 Go 往返单测**（核心，防 #1 坑）：构造含 `virtualNet.address` + `featureGates.VirtualNet` + 服务端 virtual_net 代理 + 访客 virtual_net(`destinationIP`,`bindPort=-1`) 的 `ClientConfigV1` → `fromV1`→`toV1` 断言字段全在；并 `saveTOML` 落盘→frp `LoadClientConfigResult` 回读断言不丢。
- **真实往返**：`PUT /configs/{id}` 存 vnet 配置后 `GET` 回读三类字段都在。
- **手动**（条件具备时）：两节点配置实测虚拟 IP 互 ping / ssh。

## 9. 实现任务顺序（plan）

1. 后端：consts → ClientCommon/Proxy 字段 → conversion 双向 → 往返单测（TDD：先写测试）。
2. 后端：services/frp feature gate 应用 + Windows 守卫 + 单测。
3. 前端：常规配置 VNet 分组 → 代理插件选项 → 访客插件 + destinationIP。
4. 配套：Docker compose 覆盖 + OpenWrt 文档/实测项 + openapi/docs/gen:api。
5. 全量验证（test/vet/tsc）→ 真实往返 → 提交 → push main（CI 自动 bump+tag+goreleaser+docker 发版）。

## 10. 风险与缓解

- **Alpha 不稳定**：UI 全程标"实验性"；文档写明已知 bug 与"勿用于生产"。
- **静默丢字段**：以"真实 GET 回读"为验收硬标准，并加往返单测固化。
- **全局 feature gate**：一处开启全进程生效，文档说明；多实例地址段不重叠（后续可加 CIDR 重叠校验，本期文档约束）。
- **发布不可逆**：push main 会触发自动发版；仅在本地 test/vet/tsc 全绿后才推送，失败则停手并报告。
