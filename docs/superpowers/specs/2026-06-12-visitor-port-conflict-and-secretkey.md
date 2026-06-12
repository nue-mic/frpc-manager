# 设计文档：访客端口冲突校验 + 默认 bindAddr/localIP 0.0.0.0 + secretKey 随机生成

> 日期：2026-06-12 · 状态：已实现

## 背景与需求

用户在「添加规则 → 访客 (Visitor)」时希望：

1. **跨实例同协议端口冲突校验**：多个 FRPS 实例下，所有访客模式中，若与别的实例
   配置了「相同（协议族 + 本地绑定地址 + 本地绑定端口）」，应在创建/编辑时拦下并提示，
   避免运行时才报「端口被占用」。
2. **本地 IP 默认值改为 `0.0.0.0`**：访客 `bindAddr`、代理 `localIP` 默认不再用
   `127.0.0.1`（太局限），统一默认 `0.0.0.0`。
3. **secretKey 随机生成按钮**：点击生成一个专业、强随机的共享密钥；首尾不能是小写
   字母（首尾用大写或数字），整体看着像密钥、舒服。

## 关键事实（读上游 frp v0.69.1 源码）

访客在本地起一个监听端口，按协议族决定监听类型：

| 类型 | 源码 | 监听 |
|---|---|---|
| STCP | `client/visitor/stcp.go:35` | `net.Listen("tcp", bindAddr:bindPort)` |
| XTCP | `client/visitor/xtcp.go:64` | `net.Listen("tcp", bindAddr:bindPort)` |
| SUDP | `client/visitor/sudp.go:54` | `net.ListenUDP("udp", bindAddr:bindPort)` |

**结论**：冲突的真实判定是「**协议族**」而非「同一类型」——

- **STCP 与 XTCP 同属 TCP**：两者在同一 `bindAddr:bindPort` 上**也会互相冲突**
  （都是 TCP listener），不仅仅是 STCP↔STCP / XTCP↔XTCP。
- **SUDP 走 UDP**：与 TCP 端口空间独立，可与同号 TCP 端口共存。

地址重叠规则：`0.0.0.0`（或空）绑定所有网卡，会与该端口上的任何地址冲突；两个
不同的具体 IP（如 `192.168.1.5` vs `192.168.1.6`）同端口不冲突。

`bindPort <= 0` 表示不在本地监听（frp `if BindPort > 0`），不参与冲突校验。

frp 对 secretKey 无格式要求（任意字符串作为共享密钥）。

## 设计

### 1. 后端：跨实例访客端口冲突校验（权威）

放在后端而非纯前端：manager 内存里有全部实例，校验快且权威（API/表单都覆盖）。

- 新错误码 `visitor_port_conflict`（apiresp + errors）。
- `manager.VisitorBindConflict(excludeID, excludeName, vType, bindAddr string, bindPort int) *VisitorConflict`：
  - `bindPort <= 0` 直接返回 nil（不监听）；
  - 规范化 `bindAddr` 空→`0.0.0.0`；按 vType 求协议族（stcp/xtcp→tcp，sudp→udp）；
  - 遍历所有实例的访客（`IsVisitor()`），跳过 `excludeID+excludeName` 自身，
    命中「同协议族 + 同 bindPort + 地址重叠」即返回第一个冲突的
    `{ConfigID, ConfigName, Name, Type, BindAddr, BindPort}`。
- `proxies.go` 的 `Create` / `Update`：当 `req.Visitor != nil` 时调用上面校验
  （Update 排除自身），命中返回 `409 visitor_port_conflict` + `details`，消息中文可读。

### 2. 前端：默认 IP → `0.0.0.0`

把保存器、编辑预填、新建默认、列表显示兜底、表单 initialValue/placeholder 里
访客 `bindAddr`、代理 `localIP` 的 `127.0.0.1` 统一改 `0.0.0.0`。**不动**
`serverAddr`（FRP 服务端地址）与 `adminAddr`（管理 HTTP，安全默认仍 127.0.0.1）。

### 3. 前端：secretKey 随机生成

`genSecretKey(len=32)`：

- 字符集去掉易混字符：大写去 `I O`、小写去 `l o`、数字去 `0 1`；
- **首尾字符只取「大写或数字」**（满足"首尾非小写"）；中间取全字符集；
- `crypto.getRandomValues` 强随机；
- 32 位长度，看着像专业 API key / 强密钥。

在访客与代理两处 secretKey 输入框加 `addonAfter` 的「⚡随机」按钮（镜像规则名随机按钮）。

## 测试

- 后端单测：`VisitorBindConflict` 覆盖 同型冲突 / STCP↔XTCP 跨型 TCP 冲突 / SUDP 不与 TCP 冲突 /
  0.0.0.0 与具体 IP 重叠 / 不同具体 IP 不冲突 / bindPort<=0 跳过 / 排除自身。
- 实跑：两实例各建访客，制造同端口冲突看 409；改默认 IP 看表单；点随机看密钥。
- `go vet/test`、`tsc -b`、`npm run build` 全绿。
