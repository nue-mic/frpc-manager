# frpmgr-server（frpmgrd）

> 一个用浏览器就能管理多条 frp 内网穿透隧道的「FRP 客户端管理器」。
> 一个进程同时跑多个 `frpc`，自带 **Web 管理界面** + 完整 **API**，开机自启、热重载，专为服务器/Docker 设计。

简单说：你不用再手动写一堆 `frpc.toml`、再用 `systemctl` 一个个管理了。装上它，打开网页，点点鼠标就能新增/启动/停止/查看日志/监控你的所有穿透隧道。

> 本项目从 Windows 桌面版 [frpmgr](https://github.com/mia-clark/frp-manager-server) 演化而来，去掉了 Windows GUI，保留了配置模型、热重载和内嵌 frpc 的能力，改造成 Linux/服务器友好的服务。内置 frp `v0.68.1`。

---

## ✨ 它能帮你做什么

- 🖥️ **网页管理界面**：打开 `http://你的IP:端口/` 就是管理后台，新增/编辑/启停隧道、看实时日志、看监控，全在网页上完成。
- 🔀 **一个进程管多条隧道**：多个 `frpc` 实例跑在同一个进程里（不是一堆容器），省资源、好管理。
- ♻️ **热重载不断线**：改配置即时生效，已经连上的代理不掉线。
- 🔌 **完整 REST API + WebSocket**：配置增删改查、启停重载、校验、导入导出、实时事件推送、实时日志，方便二次开发对接。
- 🔐 **令牌鉴权**：单一 API 令牌（Bearer Token）保护后台，支持 CORS 配置。
- 📊 **系统监控**：CPU / 内存 / 磁盘 / 网络 / 连接数，以及每条代理的当前连接数。
- 📖 **在线接口文档**：内置 Scalar 文档，访问 `http://你的IP:端口/api/docs/` 可直接在线调试。

---

## 🚀 一键安装（推荐，macOS / Linux）

复制下面**任意一条**命令到终端回车即可。脚本会自动识别你的系统和 CPU 架构，下载对应版本，安装并注册成开机自启的系统服务。

**使用 curl：**

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/mia-clark/frp-manager-server/main/scripts/install.sh)"
```

**使用 wget：**

```sh
sh -c "$(wget -qO- https://raw.githubusercontent.com/mia-clark/frp-manager-server/main/scripts/install.sh)"
```

安装过程会**交互式**地问你两件事（直接回车用默认值）：

1. **监听端口**：回车=默认 `8080`，输入 `r`=随机端口，或自己输一个端口号。
2. **API 令牌**：自己填一个，或直接回车自动生成一个强随机令牌（**请务必保存好，这是登录后台的唯一凭证**）。

装完后终端会打印访问地址、令牌和常用命令。打开浏览器访问 `http://你的IP:端口/` 即可使用。

### 想要不交互 / 自定义参数？

脚本支持命令行参数任意组合，参数已传入的项就不再询问：

```sh
# 先把脚本下载到本地
curl -fsSL https://raw.githubusercontent.com/mia-clark/frp-manager-server/main/scripts/install.sh -o install.sh

sh install.sh -p 9000                      # 指定端口 9000，只问令牌
sh install.sh -t 我的令牌                   # 指定令牌，只问端口
sh install.sh -p 9000 -t 我的令牌           # 端口+令牌都指定，零交互（仅一次确认）
sh install.sh -p 9000 -t 我的令牌 -y        # 完全静默安装
sh install.sh --port random                # 随机端口
sh install.sh -v v1.2.10 -p 8888           # 指定版本 + 端口
sh install.sh --help                       # 查看全部参数
```

也支持用环境变量（适合自动化/CI）：

```sh
FRPMGR_PORT=9000 FRPMGR_API_TOKEN=xxx ASSUME_YES=1 sh install.sh
```

### 全自动更新

升级到最新版，**端口、API 令牌、所有配置和数据都原样保留**，只替换程序本体并重启服务。会先比对版本，已是最新就直接跳过（除非加 `--force`）：

```sh
# 一行命令直接更新（curl）
sh -c "$(curl -fsSL https://raw.githubusercontent.com/mia-clark/frp-manager-server/main/scripts/install.sh)" -- --update

# wget 版
sh -c "$(wget -qO- https://raw.githubusercontent.com/mia-clark/frp-manager-server/main/scripts/install.sh)" -- --update
```

如果之前已把脚本下载到本地，直接：

```sh
sh install.sh --update                 # 更新到最新版（已是最新则跳过）
sh install.sh --update -v v1.2.11      # 更新/回退到指定版本
sh install.sh --update --force         # 即使已是最新也强制重装
```

> 想做无人值守的定时自动更新？把上面的一行命令丢进 `crontab` 即可，例如每天凌晨 4 点：
> `0 4 * * * sh -c "$(curl -fsSL https://raw.githubusercontent.com/mia-clark/frp-manager-server/main/scripts/install.sh)" -- --update >> /var/log/frpmgrd-update.log 2>&1`

### 卸载

```sh
sh install.sh --uninstall
```

会停止并移除系统服务、删除二进制；是否删除配置和数据目录会单独询问你。

### 安装脚本支持的系统

| 系统 | 服务方式 | 开机自启 |
|---|---|---|
| 主流 Linux（Ubuntu/Debian/CentOS/Rocky 等） | systemd | ✅ |
| Alpine 等 | OpenRC | ✅ |
| macOS | launchd | ✅ |
| 其它（无 systemd/OpenRC） | 打印手动后台运行命令 | 需手动 |

> CPU 架构自动识别：`amd64` / `arm64` / `armv7`（树莓派等）。Windows 用户请用下面的 Docker 方式，或到 [Releases](https://github.com/mia-clark/frp-manager-server/releases) 下载 Windows 版手动运行。

---

## 📦 其它安装方式

### 方式一：Docker（推荐用于服务器）

```bash
docker run -d --name frpmgrd --network host \
  -e FRPMGR_API_TOKEN="$(openssl rand -hex 32)" \
  -v $(pwd)/data:/data \
  ghcr.io/mia-clark/frp-manager-server:latest
```

镜像在每次推送到 `main` 和每个发布标签时自动构建（支持 amd64 + arm64）。

### 方式二：docker compose（免拉源码）

在任意空目录里：

```bash
curl -O https://raw.githubusercontent.com/mia-clark/frp-manager-server/main/deploy/docker-compose.standalone.yml
curl -O https://raw.githubusercontent.com/mia-clark/frp-manager-server/main/deploy/.env.example
mv .env.example .env
# 编辑 .env，至少把 FRPMGR_API_TOKEN 设成一个真实令牌
docker compose -f docker-compose.standalone.yml up -d
```

### 方式三：手动下载二进制

到 [Releases](https://github.com/mia-clark/frp-manager-server/releases) 下载对应平台的压缩包（Linux amd64/arm64/armv7、macOS amd64/arm64、Windows amd64/arm64），解压后：

```bash
FRPMGR_API_TOKEN=$(openssl rand -hex 32) ./frpmgrd serve
```

---

## 🧭 安装后怎么用

| 用途 | 地址 / 命令 |
|---|---|
| **Web 管理界面** | `http://你的IP:端口/` |
| **在线 API 文档** | `http://你的IP:端口/api/docs/` |
| **健康检查** | `curl http://你的IP:端口/api/v1/health` |
| **调用 API**（需带令牌） | `curl -H "Authorization: Bearer 你的令牌" http://你的IP:端口/api/v1/version` |

> 第一次打开 Web 界面，需要填入安装时设置/生成的 **API 令牌** 才能登录。忘了令牌？看配置文件（见下）。

### 服务管理常用命令

**systemd（多数 Linux）：**

```bash
systemctl status frpmgrd      # 查看状态
journalctl -u frpmgrd -f      # 看实时日志
systemctl restart frpmgrd     # 重启
systemctl stop frpmgrd        # 停止
```

**macOS（launchd）：**

```bash
sudo launchctl list | grep frpmgrd   # 查看状态
tail -f /var/log/frpmgrd.log         # 看日志
```

---

## ⚙️ 配置说明

一键安装后，配置写在环境变量文件里（systemd 服务读取它）：

- **Linux**：`/etc/frpmgrd/frpmgrd.env`（数据目录 `/var/lib/frpmgrd`）
- **macOS**：配置写在 launchd plist 里（数据目录 `/usr/local/var/frpmgrd`）

改完配置后 `systemctl restart frpmgrd` 生效。可用的环境变量：

| 变量 | 必填 | 默认 | 说明 |
|---|---|:---:|---|
| `FRPMGR_API_TOKEN` | ✓ | — | API 鉴权令牌（登录后台的凭证） |
| `FRPMGR_HTTP_ADDR` |   | `:8080` | 监听地址，格式 `:端口` |
| `FRPMGR_DATA_DIR`  |   | `/data` | 数据根目录 |
| `FRPMGR_CORS_ORIGINS` |   | `*` | 逗号分隔的 CORS 白名单 |
| `FRPMGR_LOG_LEVEL` |   | `info` | `trace`/`debug`/`info`/`warn`/`error` |
| `FRPMGR_DOCS_ENABLED` |   | `true` | 是否开放 `/api/docs` 在线文档 |

### 数据目录结构

```
数据目录/
  ├── profiles/   # 每条隧道一个 .toml 配置文件
  ├── logs/       # frpc 日志，自动按天轮换
  ├── stores/     # frp visitor 状态（xtcp/visitor 用）
  └── meta.json   # 自启动列表 + 排序
```

> 升级、重装时只要保留数据目录，配置就不会丢。

---

## ❓ 常见问题

- **打开网页提示 401 / 未授权？** 令牌填错了。核对 `/etc/frpmgrd/frpmgrd.env` 里的 `FRPMGR_API_TOKEN`。
- **服务起不来 / 端口被占用？** 换个端口：改 `FRPMGR_HTTP_ADDR=:新端口` 后重启服务；或重装时用 `-p` 指定。
- **隧道显示已启动但连不上 frps？** 多半是 frps 地址/端口/令牌不对。在 Web 界面看该隧道的实时日志排查。
- **公网访问不了后台？** 检查服务器防火墙/安全组是否放行了你设置的端口。
- **想换成开机不自启？** `systemctl disable frpmgrd`（macOS：卸载对应 launchd plist）。

更详细的部署与 API 说明见 **[`docs/README-server.md`](docs/README-server.md)**。

---

## 🛠️ 开发与构建（给开发者）

```bash
make run            # 本地直接运行（主机模式）
make test           # 跑单元测试
make build          # 交叉编译 Linux 静态二进制 -> bin/frpmgrd
make build-host     # 编译当前平台二进制（本地开发用）
make docker         # 用 deploy/Dockerfile 构建镜像
```

### 目录结构

```
cmd/frpmgrd/        # 守护进程入口
internal/api/       # HTTP + WebSocket 接口、中间件（含内嵌 Web 界面）
internal/manager/   # 实例注册表 + 生命周期管理
internal/eventbus/  # 进程内事件发布订阅（用于 WS 推送）
internal/logtail/   # 日志实时 tail
internal/appcfg/    # 环境变量解析
pkg/config/         # FRP 配置模型（INI/TOML、V1 转换）
web/                # 前端源码（编译产物 embed 进二进制）
deploy/             # Dockerfile、docker-compose、.env.example
docs/               # 部署文档 + OpenAPI 设计
scripts/install.sh  # 一键安装脚本
```

---

## 📄 许可证

与上游一致，见 [`LICENSE`](LICENSE)。
