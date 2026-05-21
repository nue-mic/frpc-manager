// frp 0.68 客户端配置参考片段集
//
// 数据源：上游 fatedier/frp@v0.68.1 的 conf/frpc_full_example.toml + pkg/config/v1
// 所有片段都是合法 TOML，可直接粘贴到「高级 TOML 配置」编辑器或 frpc.toml 文件。
// 中文注释由本项目维护，与 frpmgr WebUI 的可视化字段一一对应。

export interface Snippet {
  key: string;
  title: string;
  hint: string;
  toml: string;
}

export interface SnippetGroup {
  key: string;
  label: string;
  items: Snippet[];
}

export const TOML_SNIPPETS: SnippetGroup[] = [
  {
    key: 'base',
    label: '基础与全局',
    items: [
      {
        key: 'minimal',
        title: '最小可用配置',
        hint: '一个 frpc.toml 至少需要这些字段就能连上 frps 并暴露一条 TCP 隧道。',
        toml: `# ===========================================================
# frpc 最小可用配置 · 把本机 SSH (22) 暴露成公网 6022
# -----------------------------------------------------------
# 1. 服务端地址 / 端口 — 与 frps 配置一致
# 2. 认证 token — 与 frps 端 [auth].token 必须一致
# 3. 一条 [[proxies]] — 类型 tcp，把 local 端口映射到 remote 端口
# ===========================================================

serverAddr = "frps.example.com"
serverPort = 7000

[auth]
method = "token"
token  = "your-shared-secret"

[[proxies]]
name       = "ssh"
type       = "tcp"
localIP    = "127.0.0.1"
localPort  = 22
remotePort = 6022
`,
      },
      {
        key: 'global',
        title: '全局参数（serverAddr / user / metadatas）',
        hint: '客户端身份、命名前缀、UDP 包大小、includes 等顶层配置。',
        toml: `# ===========================================================
# 客户端全局参数
# ===========================================================

# 服务端地址与端口（IPv6 写法：serverAddr = "::")
serverAddr = "frps.example.com"
serverPort = 7000

# user 非空时，所有代理名会被改写为 {user}.{proxy}
#   例如 user = "office"，name = "ssh" → 实际注册为 "office.ssh"
# 方便多人共用同一 frps 时区分归属
user = "office"

# 可选的唯一标识符，用于 frps 端做客户端追踪
# clientID = "office-node-1"

# 内网 NAT 穿透时用的 STUN 服务器（xtcp 用）
natHoleStunServer = "stun.easyvoip.com:3478"

# 首次登录失败的行为：true=立刻退出 / false=无限重试
# frp 上游默认 true；frpmgr 默认 false 更友好
loginFailExit = false

# UDP 单包字节数，必须与 frps 一致（影响 udp / sudp 代理）
udpPacketSize = 1500

# 用 start 白名单只启动部分代理（默认全部启动）
# start = ["ssh", "web01"]

# 透传给 frps / 服务端插件的元信息
[metadatas]
env       = "prod"
owner     = "alice"

# 引入其它 toml/ini 片段（支持 glob，相对路径）
# includes = ["./confd/*.toml"]

# 实验性 feature gate（如 VirtualNet 虚拟内网）
# [featureGates]
# VirtualNet = true
`,
      },
      {
        key: 'frpmgr',
        title: 'frpmgr 扩展（[frpmgr]）',
        hint: '本项目自有的扩展块：实例备注名、是否随服务启动、自动删除策略。',
        toml: `# ===========================================================
# [frpmgr] — 本项目的元数据扩展（标准 frpc 不识别会被忽略）
# 用 frpmgr 启动时这些字段才会生效
# ===========================================================

[frpmgr]
# 实例显示名（左侧配置列表展示）
name        = "杭州办公网"
# true=随 frpmgrd 服务启动；false=只有手动点启动才跑
manualStart = false

# 自动删除：在某个时间点或运行多久后，自动停掉并删除这个实例（应急临时配置）
[frpmgr.autoDelete]
# "absolute" 绝对时间 / "relative" 相对时间 / "" 关闭
deleteMethod = ""
# absolute 模式：在这个 UTC 时间点删除
# afterDate = "2026-12-31T00:00:00Z"
# relative 模式：相对创建时间多少秒后删除
# deleteAfter = 86400
`,
      },
    ],
  },
  {
    key: 'auth',
    label: '认证',
    items: [
      {
        key: 'token',
        title: 'Token 认证（最常见）',
        hint: '双方共享一个静态 token；最简单也最常用。',
        toml: `# ===========================================================
# [auth] · Token 模式
# 必须与 frps 端 [auth].token 完全一致
# ===========================================================

[auth]
method = "token"
token  = "vX8mKq3JwLz9NpRt5Yy2Hc7Bf4Gg1Db6"

# 可选：把 token 从外部文件加载（避免明文写入 toml）
# 与 auth.token 互斥
# [auth.tokenSource]
# type = "file"
# [auth.tokenSource.file]
# path = "/etc/frp/token"

# 额外鉴权范围（要求 frps 在心跳 / 新工作连接里也校验 token）
# 取值：HeartBeats / NewWorkConns
# additionalScopes = ["HeartBeats", "NewWorkConns"]
`,
      },
      {
        key: 'oidc',
        title: 'OIDC 认证',
        hint: '与 Keycloak / Auth0 / Okta 等 OIDC Provider 集成。',
        toml: `# ===========================================================
# [auth] · OIDC 模式
# frpc 会先去 OIDC Token Endpoint 拿一个 access token，再用它登录 frps
# ===========================================================

[auth]
method = "oidc"

[auth.oidc]
clientID         = "frp-client"
clientSecret     = "xxxxxxxxxxxxxxxx"
audience         = "frp"
scope            = "frp"
tokenEndpointURL = "https://idp.example.com/auth/realms/myrealm/protocol/openid-connect/token"

# 额外参数（会拼到 token 请求 body 上）
# [auth.oidc.additionalEndpointParams]
# resource = "https://example.com/api"

# OIDC Provider 用自签证书 / 私有 CA 时
# trustedCaFile = "/etc/ssl/idp-ca.crt"
# insecureSkipVerify = false

# OIDC 走代理（仅 OIDC 流量；不影响 frpc → frps 连接）
# proxyURL = "http://proxy.example.com:8080"
`,
      },
    ],
  },
  {
    key: 'log-webserver',
    label: '日志 / 管理端',
    items: [
      {
        key: 'log',
        title: '[log] 日志配置',
        hint: '级别、保留天数、输出位置。frpmgr 启动时会覆盖 log.to 为 /data/logs/{id}.log。',
        toml: `# ===========================================================
# [log]
# ===========================================================

[log]
# trace / debug / info / warn / error
level   = "info"
# 文件名（frpmgr 启动时会自动改写为 /data/logs/{id}.log）
# "console" 表示直接打到 stdout/stderr
to      = "./frpc.log"
# 日志保留天数（超过会按日切割并删除）
maxDays = 7
# to = "console" 时是否禁用 ANSI 颜色码
disablePrintColor = false
`,
      },
      {
        key: 'webServer',
        title: '[webServer] 管理 HTTP 接口',
        hint: 'frpc 自带的管理 API（不是 frpmgrd 的）；可远程触发 reload / status。',
        toml: `# ===========================================================
# [webServer] — frpc 自己的管理 HTTP 接口
# 用 curl http://addr:port/api/reload 可让 frpc 热重载 toml
# 与 frpmgrd HTTP API 不冲突
# ===========================================================

[webServer]
addr        = "127.0.0.1"
port        = 7400
user        = "admin"
password    = "changeme"
# 自定义后台静态资源目录
# assetsDir   = "./static"
# 启用 Go pprof（性能分析）
pprofEnable = false

# 管理端口启用 TLS
# [webServer.tls]
# certFile      = "/etc/frp/admin.crt"
# keyFile       = "/etc/frp/admin.key"
# trustedCaFile = "/etc/frp/admin-ca.crt"
`,
      },
    ],
  },
  {
    key: 'transport',
    label: '传输 / TLS / QUIC',
    items: [
      {
        key: 'transport',
        title: '[transport] 传输层调优',
        hint: '协议、连接池、TCP Mux、心跳。绝大多数场景默认值就够。',
        toml: `# ===========================================================
# [transport] — 客户端到 frps 的传输层
# ===========================================================

[transport]
# tcp / kcp / quic / websocket / wss
protocol = "tcp"

# 连接池：客户端预先建立 N 条空闲连接，减少新代理建立延时
poolCount = 5

# 是否启用 TCP Stream Multiplexing（多路复用），必须与 frps 一致
tcpMux = true
# TCP Mux 内层心跳（仅当 tcpMux=true 时生效）
tcpMuxKeepaliveInterval = 30

# 拨号超时（秒）
dialServerTimeout    = 10
dialServerKeepalive  = 7200

# 客户端出口 IP（多网卡时强制绑定）；仅对 tcp / websocket 生效
# connectServerLocalIP = "192.168.1.10"

# 走代理连接 frps（仅 tcp 协议生效）
# proxyURL = "http://user:pwd@proxy.example.com:8080"
# proxyURL = "socks5://user:pwd@proxy.example.com:1080"

# 应用层心跳（启用 TCP Mux 时默认 -1=关闭，否则 30/90）
# heartbeatInterval = 30
# heartbeatTimeout  = 90
`,
      },
      {
        key: 'tls',
        title: '[transport.tls] TLS 加密',
        hint: 'frp v0.50+ 默认开启 TLS，多数情况只需保持默认。',
        toml: `# ===========================================================
# [transport.tls] · 客户端到服务端的 TLS 加密
# ===========================================================

[transport.tls]
# v0.50+ 默认 true
enable = true

# 是否禁用首字节自定义；v0.50+ 默认 true（保留默认即可）
disableCustomTLSFirstByte = true

# mTLS 客户端证书（双向认证场景）
# certFile      = "/etc/frp/client.crt"
# keyFile       = "/etc/frp/client.key"

# 验证 frps 证书时用的 CA（私有 CA 必填）
# trustedCaFile = "/etc/frp/frps-ca.crt"

# 验证 frps 证书时校验的 SNI；frps 证书 CN/SAN 不是 IP 时必填
# serverName    = "frps.example.com"
`,
      },
      {
        key: 'quic',
        title: '[transport.quic] QUIC 协议',
        hint: '在 protocol="quic" 时生效，常用于绕过 TCP 拥塞限制。',
        toml: `# ===========================================================
# [transport.quic] · 仅当 transport.protocol = "quic" 生效
# ===========================================================

[transport]
protocol = "quic"

[transport.quic]
# QUIC 应用层 keep-alive 周期（秒）
keepalivePeriod    = 10
# 单个 QUIC 连接最大空闲（秒）
maxIdleTimeout     = 30
# 单个 QUIC 连接允许的最大并发流
maxIncomingStreams = 100000
`,
      },
    ],
  },
  {
    key: 'proxy-tcp-udp',
    label: '代理 · TCP / UDP',
    items: [
      {
        key: 'tcp',
        title: 'TCP 代理（基础）',
        hint: '最常见类型：将本地端口暴露到 frps 的某个公网端口。',
        toml: `# ===========================================================
# TCP 代理 · 把本地 SSH 暴露成公网 6022
# ===========================================================

[[proxies]]
name       = "ssh"
type       = "tcp"
localIP    = "127.0.0.1"
localPort  = 22
remotePort = 6022

# 可选：禁用此代理（不删除）
# enabled = false

# 限速（前端可视化里叫"传输带宽"）
# transport.bandwidthLimit     = "1MB"
# transport.bandwidthLimitMode = "client"   # client / server

# 单代理加密 / 压缩（覆盖全局 transport）
# transport.useEncryption  = true
# transport.useCompression = true

# remotePort = 0 让 frps 自动分配端口
`,
      },
      {
        key: 'tcp-range',
        title: 'TCP Range（端口区间）',
        hint: '一次性映射连续多个端口；frpmgr 在保存时会自动展开成多条代理。',
        toml: `# ===========================================================
# Range 模式 — 一次开 8000-8010 共 11 个端口
# ===========================================================

[[proxies]]
name       = "rdp-range"
type       = "tcp"
localIP    = "127.0.0.1"
# 注意：localPort/remotePort 都用字符串表达区间
# 支持逗号 + 连字符，元素数必须对齐
localPort  = "8000-8010"
remotePort = "8000-8010"
`,
      },
      {
        key: 'udp',
        title: 'UDP 代理',
        hint: '映射 UDP 端口；包大小由全局 udpPacketSize 控制。',
        toml: `# ===========================================================
# UDP 代理 · 转发 DNS / 游戏服务端
# ===========================================================

[[proxies]]
name       = "dns"
type       = "udp"
localIP    = "114.114.114.114"
localPort  = 53
remotePort = 6053
`,
      },
    ],
  },
  {
    key: 'proxy-http',
    label: '代理 · HTTP / HTTPS',
    items: [
      {
        key: 'http',
        title: 'HTTP 代理（域名/子域名）',
        hint: '需要 frps 配置 vhostHTTPPort；按域名/路径路由。',
        toml: `# ===========================================================
# HTTP 代理 · 通过域名路由到本地 80 端口
# 前置要求：frps 端必须配置 vhostHTTPPort，否则代理会 start error
# ===========================================================

[[proxies]]
name      = "web-app"
type      = "http"
localIP   = "127.0.0.1"
localPort = 80

# 自定义域名（DNS 需指向 frps 的 vhostHTTPPort）
customDomains = ["app.example.com"]
# 子域名（要求 frps 配置了 subdomainHost）
# subdomain = "myapp"

# 仅路由这些前缀
locations = ["/", "/api"]

# Basic Auth（http 协议层）
httpUser     = "admin"
httpPassword = "secret"

# 按 Basic Auth 用户名路由到此代理（多个代理同域名时区分）
# routeByHTTPUser = "alice"

# 改写 Host 头给上游应用
hostHeaderRewrite = "internal.example.com"

# 注入请求头 / 响应头
[proxies.requestHeaders.set]
x-from-where = "frp"

[proxies.responseHeaders.set]
x-served-by = "frpmgr"
`,
      },
      {
        key: 'https',
        title: 'HTTPS 代理（透传 TLS）',
        hint: 'frps 把 TLS 流量原封不动透传给本地，不解开 SNI 之外的内容。',
        toml: `# ===========================================================
# HTTPS 代理 · TLS 直通到本地 443
# 前置要求：frps 配置 vhostHTTPSPort
# ===========================================================

[[proxies]]
name          = "secure-site"
type          = "https"
localIP       = "127.0.0.1"
localPort     = 443
customDomains = ["secure.example.com"]
# subdomain  = "secure"

# 上游 PROXY Protocol 头 — v1 / v2 / 空
# transport.proxyProtocolVersion = "v2"
`,
      },
    ],
  },
  {
    key: 'proxy-tcpmux',
    label: '代理 · TCPMUX',
    items: [
      {
        key: 'tcpmux',
        title: 'TCPMUX (httpconnect)',
        hint: '让多个 TCP 服务复用同一 frps 端口，通过 HTTP CONNECT 域名分流。',
        toml: `# ===========================================================
# TCPMUX · 多个 TCP 服务共用 frps 单一端口（基于 HTTP CONNECT 协议）
# 前置要求：frps 端配置 tcpmuxHTTPConnectPort
# ===========================================================

[[proxies]]
name        = "tunnel-1"
type        = "tcpmux"
multiplexer = "httpconnect"        # 当前仅支持 httpconnect
localIP     = "127.0.0.1"
localPort   = 22
customDomains = ["t1.example.com"]

# Basic Auth + 按用户路由（可选）
# httpUser        = "alice"
# httpPassword    = "secret"
# routeByHTTPUser = "alice"
`,
      },
    ],
  },
  {
    key: 'proxy-secure',
    label: '代理 · 安全 / P2P (STCP/SUDP/XTCP)',
    items: [
      {
        key: 'stcp-server',
        title: 'STCP 服务端（安全 P2P TCP）',
        hint: '只对持有 secretKey 的 visitor 暴露；流量经 frps 转发。',
        toml: `# ===========================================================
# STCP 服务端（提供方）
# 没有 remotePort — frps 不会暴露公网端口，必须配对一个 visitor
# ===========================================================

[[proxies]]
name       = "speed-test-tcp"
type       = "stcp"
localIP    = "127.0.0.1"
localPort  = 12091
secretKey  = "shared-secret-here"

# 允许的访问者用户列表，"*" 表示所有人
allowUsers = ["alice", "bob"]
`,
      },
      {
        key: 'sudp-server',
        title: 'SUDP 服务端（安全 P2P UDP）',
        hint: '同 STCP，但承载 UDP。',
        toml: `[[proxies]]
name       = "secure-dns"
type       = "sudp"
localIP    = "127.0.0.1"
localPort  = 53
secretKey  = "another-secret"
allowUsers = ["*"]
`,
      },
      {
        key: 'xtcp-server',
        title: 'XTCP 服务端（NAT 打洞）',
        hint: '依赖 STUN；打洞成功后双方直连，省 frps 带宽。',
        toml: `# ===========================================================
# XTCP 服务端 · 与 visitor 之间直接 P2P，无需 frps 转发
# 双方都必须能访问 STUN（natHoleStunServer）
# ===========================================================

[[proxies]]
name       = "p2p-tcp"
type       = "xtcp"
localIP    = "127.0.0.1"
localPort  = 22
secretKey  = "shared-secret"
allowUsers = ["alice"]

# 可选：NAT 穿透微调
[proxies.natTraversal]
# true=只用 STUN 探测到的公网地址（不上报本机网卡内网地址）
# 对慢速 VPN / VPN 内网穿透有帮助
disableAssistedAddrs = false
`,
      },
    ],
  },
  {
    key: 'visitors',
    label: '访客 (Visitors)',
    items: [
      {
        key: 'stcp-visitor',
        title: 'STCP 访客',
        hint: '与 STCP 服务端配对；secretKey/serverName 必须对齐。',
        toml: `# ===========================================================
# STCP 访客（消费方）
# 连接对端的 stcp 代理；流量经 frps 中转
# ===========================================================

[[visitors]]
name       = "speed-test-visitor"
type       = "stcp"

# 对端 frpc 的 user（如果它没配 user 这里也留空）
serverUser = "ln2-node"
# 对端 [[proxies]] 的 name
serverName = "speed-test-tcp"
# 与对端 stcp 的 secretKey 完全一致
secretKey  = "shared-secret-here"

# 本地绑定地址 / 端口；连接 127.0.0.1:12081 就等于连到对端 localPort
bindAddr   = "127.0.0.1"
bindPort   = 12081
`,
      },
      {
        key: 'xtcp-visitor',
        title: 'XTCP 访客（NAT 打洞）',
        hint: '尝试 P2P 直连，失败时可回落到指定 visitor。',
        toml: `# ===========================================================
# XTCP 访客 · 尝试 P2P，失败时可 fallback 到一个 stcp visitor
# ===========================================================

[[visitors]]
name       = "p2p-visitor"
type       = "xtcp"
serverUser = "alice"
serverName = "p2p-tcp"
secretKey  = "shared-secret"
bindAddr   = "127.0.0.1"
bindPort   = 12082

# 高级：保持隧道常开（频繁/快速连接场景）
keepTunnelOpen   = false
maxRetriesAnHour = 8
minRetryInterval = 90

# P2P 数据通道协议：quic（默认） / kcp
# protocol = "quic"

# P2P 失败时回退到另一个 visitor（通常是 stcp_visitor）
# fallbackTo        = "speed-test-visitor"
# fallbackTimeoutMs = 1000

[visitors.natTraversal]
disableAssistedAddrs = false
`,
      },
    ],
  },
  {
    key: 'plugins',
    label: '本地插件',
    items: [
      {
        key: 'http_proxy',
        title: 'http_proxy — HTTP 正向代理',
        hint: '让 frps 端 6080 变成一个标准 HTTP 代理服务器。',
        toml: `[[proxies]]
name       = "internet-proxy"
type       = "tcp"
remotePort = 6080
# 启用 plugin 时 localIP/localPort 会被忽略
[proxies.plugin]
type         = "http_proxy"
httpUser     = "alice"
httpPassword = "secret"
`,
      },
      {
        key: 'socks5',
        title: 'socks5 — SOCKS5 代理',
        hint: '在 frps 端开一个 SOCKS5 代理，供办公出口翻内网。',
        toml: `[[proxies]]
name       = "socks5"
type       = "tcp"
remotePort = 6081
[proxies.plugin]
type     = "socks5"
username = "alice"
password = "secret"
`,
      },
      {
        key: 'static_file',
        title: 'static_file — 静态文件服务',
        hint: '把本地一个目录通过 frps 公开成 HTTP 静态站。',
        toml: `[[proxies]]
name       = "site-mirror"
type       = "tcp"
remotePort = 6082
[proxies.plugin]
type         = "static_file"
localPath    = "/var/www/site"
stripPrefix  = ""               # 访问 http://frps:6082/foo → 文件 /var/www/site/foo
httpUser     = ""               # 留空=不要 Basic Auth
httpPassword = ""
`,
      },
      {
        key: 'unix_socket',
        title: 'unix_domain_socket — 暴露 Docker / 应用 socket',
        hint: '常用于把 /var/run/docker.sock 暴露到远端。',
        toml: `[[proxies]]
name       = "docker-api"
type       = "tcp"
remotePort = 6083
[proxies.plugin]
type     = "unix_domain_socket"
unixPath = "/var/run/docker.sock"
`,
      },
      {
        key: 'http2http',
        title: 'http2http / http2https — HTTP 反向代理',
        hint: '把入站 HTTP 流量改写后转发到本地另一个 HTTP/HTTPS 后端。',
        toml: `# HTTP → HTTP 反代（最常见）
[[proxies]]
name = "site-rewrite"
type = "tcp"
remotePort = 6084
[proxies.plugin]
type              = "http2http"
localAddr         = "127.0.0.1:8080"
hostHeaderRewrite = "internal.app"
[proxies.plugin.requestHeaders.set]
x-from-where = "frp"

# HTTP → HTTPS 反代
[[proxies]]
name = "site-https-back"
type = "http"
customDomains = ["www.example.com"]
[proxies.plugin]
type              = "http2https"
localAddr         = "127.0.0.1:443"
hostHeaderRewrite = "127.0.0.1"
`,
      },
      {
        key: 'https2http',
        title: 'https2http / https2https — TLS 终结 / 透传',
        hint: 'frpc 用自己的证书 TLS 握手，再反代到内部 HTTP/HTTPS 后端。',
        toml: `# HTTPS → HTTP（在 frpc 端做 TLS 终结，可避免内网应用配证书）
[[proxies]]
name = "ingress"
type = "https"
customDomains = ["www.example.com"]
[proxies.plugin]
type              = "https2http"
localAddr         = "127.0.0.1:80"
crtPath           = "/etc/ssl/site.crt"
keyPath           = "/etc/ssl/site.key"
hostHeaderRewrite = "127.0.0.1"

# HTTPS → HTTPS（两端都 TLS，frpc 中转）
[[proxies]]
name = "ingress-tls"
type = "https"
customDomains = ["secure.example.com"]
[proxies.plugin]
type              = "https2https"
localAddr         = "127.0.0.1:8443"
crtPath           = "/etc/ssl/site.crt"
keyPath           = "/etc/ssl/site.key"
hostHeaderRewrite = "127.0.0.1"
`,
      },
      {
        key: 'tls2raw',
        title: 'tls2raw — TLS 解封为明文 TCP',
        hint: '在 frpc 解 TLS，把明文 TCP 喂给本地 raw 服务（如 MQTT/Redis）。',
        toml: `[[proxies]]
name = "tls-mqtt"
type = "tcp"
remotePort = 8883
[proxies.plugin]
type      = "tls2raw"
localAddr = "127.0.0.1:1883"
crtPath   = "/etc/ssl/mqtt.crt"
keyPath   = "/etc/ssl/mqtt.key"
`,
      },
      {
        key: 'virtual_net',
        title: 'virtual_net — 虚拟内网（实验）',
        hint: '需在全局开启 featureGates.VirtualNet = true。',
        toml: `# 在全局打开 feature gate
[featureGates]
VirtualNet = true

[virtualNet]
address = "100.86.1.1/24"

# 服务端 visitor 暴露一段虚拟网络
[[proxies]]
name = "vnet-server"
type = "stcp"
secretKey = "vnet-key"
[proxies.plugin]
type = "virtual_net"

# 对端访问者：bindPort=-1 不绑定本地端口
[[visitors]]
name = "vnet-visitor"
type = "stcp"
serverName = "vnet-server"
secretKey  = "vnet-key"
bindPort   = -1
[visitors.plugin]
type          = "virtual_net"
destinationIP = "100.86.0.1"
`,
      },
    ],
  },
  {
    key: 'advanced',
    label: '负载均衡 / 健康检查 / 元数据',
    items: [
      {
        key: 'loadbalancer',
        title: '负载均衡（loadBalancer）',
        hint: '把多个本地服务挂到同一 group + groupKey，frps 自动分发请求。',
        toml: `# 三个机器都跑同一份 frpc，但每个 frpc 指向本机的不同上游
# 它们共享同一个 group → frps 收到 6080 的连接会随机分给三者之一
[[proxies]]
name       = "web-lb"
type       = "tcp"
localIP    = "127.0.0.1"
localPort  = 8080
remotePort = 6080

[proxies.loadBalancer]
group    = "web_cluster"
groupKey = "cluster-secret"
`,
      },
      {
        key: 'healthcheck',
        title: '健康检查（healthCheck）',
        hint: 'TCP/HTTP 健康探测，失败次数过多会从 frps 摘除。',
        toml: `# TCP 健康探测：每 10s 连一下本地端口，连续 3 次失败就摘掉
[[proxies]]
name = "api"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8080
remotePort = 6080
[proxies.healthCheck]
type            = "tcp"
intervalSeconds = 10
timeoutSeconds  = 3
maxFailed       = 3

# HTTP 健康探测：GET /status 返回 2xx 视为健康
[[proxies]]
name = "web"
type = "http"
localIP = "127.0.0.1"
localPort = 80
customDomains = ["web.example.com"]
[proxies.healthCheck]
type            = "http"
path            = "/status"
intervalSeconds = 10
timeoutSeconds  = 3
maxFailed       = 3
# 自定义探测请求头
httpHeaders = [
  { name = "x-from-where", value = "frp-health" }
]
`,
      },
      {
        key: 'meta-annot',
        title: '元数据 metadatas + annotations',
        hint: 'metadatas 透传给服务端插件用；annotations 在 frps 仪表盘展示。',
        toml: `[[proxies]]
name       = "billing-api"
type       = "tcp"
localIP    = "127.0.0.1"
localPort  = 9000
remotePort = 6090

# metadatas — 传给 frps 服务端插件读
[proxies.metadatas]
team  = "payment"
env   = "prod"

# annotations — 仅在 frps Web 仪表盘标签显示
[proxies.annotations]
owner = "alice@example.com"
"prefix/sla" = "99.99%"
`,
      },
    ],
  },
  {
    key: 'full',
    label: '完整示例',
    items: [
      {
        key: 'full-example',
        title: '完整 frpc.toml（含上述所有片段精简版）',
        hint: '一次性把所有典型块串起来，直接复制可微改即用。',
        toml: `# ===========================================================
# frpc.toml · 完整示范（按需删减）
# 适用 frp v0.68+
# ===========================================================

serverAddr = "frps.example.com"
serverPort = 7000
user       = "office"
natHoleStunServer = "stun.easyvoip.com:3478"
loginFailExit  = false
udpPacketSize  = 1500

[auth]
method = "token"
token  = "your-shared-secret"

[log]
level   = "info"
to      = "./frpc.log"
maxDays = 7

[webServer]
addr     = "127.0.0.1"
port     = 7400
user     = "admin"
password = "changeme"

[transport]
protocol  = "tcp"
poolCount = 5
tcpMux    = true

[transport.tls]
enable = true
# serverName    = "frps.example.com"
# trustedCaFile = "/etc/frp/frps-ca.crt"

[metadatas]
env   = "prod"
owner = "alice"

# ---------- 代理：TCP ----------
[[proxies]]
name       = "ssh"
type       = "tcp"
localIP    = "127.0.0.1"
localPort  = 22
remotePort = 6022

# ---------- 代理：HTTP ----------
[[proxies]]
name      = "web-app"
type      = "http"
localIP   = "127.0.0.1"
localPort = 80
customDomains = ["app.example.com"]
locations     = ["/", "/api"]
hostHeaderRewrite = "internal.app"
[proxies.requestHeaders.set]
x-from-where = "frp"

# ---------- 代理：STCP 服务端 ----------
[[proxies]]
name       = "secure-tcp"
type       = "stcp"
localIP    = "127.0.0.1"
localPort  = 12091
secretKey  = "shared-secret"
allowUsers = ["alice", "bob"]

# ---------- 代理：XTCP 服务端 ----------
[[proxies]]
name       = "p2p-tcp"
type       = "xtcp"
localIP    = "127.0.0.1"
localPort  = 22
secretKey  = "shared-secret"
allowUsers = ["alice"]

# ---------- 代理：插件 socks5 ----------
[[proxies]]
name       = "socks5"
type       = "tcp"
remotePort = 6081
[proxies.plugin]
type     = "socks5"
username = "alice"
password = "secret"

# ---------- 访客：STCP ----------
[[visitors]]
name       = "secure-tcp-visitor"
type       = "stcp"
serverUser = "remote"
serverName = "secure-tcp"
secretKey  = "shared-secret"
bindAddr   = "127.0.0.1"
bindPort   = 12081

# ---------- 访客：XTCP ----------
[[visitors]]
name       = "p2p-visitor"
type       = "xtcp"
serverUser = "remote"
serverName = "p2p-tcp"
secretKey  = "shared-secret"
bindAddr   = "127.0.0.1"
bindPort   = 12082
keepTunnelOpen   = false
maxRetriesAnHour = 8
minRetryInterval = 90

# ---------- frpmgr 扩展 ----------
[frpmgr]
name        = "杭州办公网"
manualStart = false
`,
      },
    ],
  },
];

export function findSnippet(groupKey: string, itemKey: string): Snippet | undefined {
  const g = TOML_SNIPPETS.find((x) => x.key === groupKey);
  return g?.items.find((x) => x.key === itemKey);
}

export function defaultSnippet(): { groupKey: string; itemKey: string } {
  return { groupKey: TOML_SNIPPETS[0].key, itemKey: TOML_SNIPPETS[0].items[0].key };
}
