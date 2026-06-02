#!/bin/sh
# =============================================================================
# frpmgrd 一键安装脚本 (frp-manager-server)
#
#   支持: macOS / 各类 Linux (systemd / OpenRC / 通用回退)
#   下载: 自动选择 curl 或 wget
#   功能: 自动识别系统架构 -> 下载对应二进制 -> 安装 -> 注册系统服务 -> 开机自启
#
# 一行安装 (推荐, 支持交互):
#   sh -c "$(curl -fsSL https://raw.githubusercontent.com/mia-clark/frp-manager-server/main/scripts/install.sh)"
#   sh -c "$(wget -qO- https://raw.githubusercontent.com/mia-clark/frp-manager-server/main/scripts/install.sh)"
#
# 非交互 / 自定义示例:
#   sh install.sh --yes --port 9000 --token mysecret
#   sh install.sh --port random
#   sh install.sh --uninstall
#
# 环境变量 (等价于命令行参数, 便于自动化):
#   FRPMGR_PORT=9000  FRPMGR_API_TOKEN=xxx  FRPMGR_VERSION=v1.2.10  ASSUME_YES=1
# =============================================================================

set -eu

# ----------------------------------------------------------------------------
# 常量配置
# ----------------------------------------------------------------------------
REPO="mia-clark/frp-manager-server"
BIN_NAME="frpmgrd"
INSTALL_DIR="/usr/local/bin"
SERVICE_NAME="frpmgrd"
DEFAULT_PORT="8080"

# 这些值会在 detect_platform / 参数解析阶段被填充
OS=""
ARCH=""
DATA_DIR=""
ENV_FILE=""
DOWNLOADER=""
VERSION="${FRPMGR_VERSION:-}"
PORT="${FRPMGR_PORT:-}"
TOKEN="${FRPMGR_API_TOKEN:-}"
ASSUME_YES="${ASSUME_YES:-0}"
FORCE="0"
ACTION="install"
TMP_DIR=""

# ----------------------------------------------------------------------------
# 输出辅助 (带颜色, 非 TTY 自动降级为纯文本)
# ----------------------------------------------------------------------------
if [ -t 1 ]; then
    C_RED='\033[0;31m'; C_GRN='\033[0;32m'; C_YLW='\033[0;33m'
    C_BLU='\033[0;34m'; C_BOLD='\033[1m'; C_RST='\033[0m'
else
    C_RED=''; C_GRN=''; C_YLW=''; C_BLU=''; C_BOLD=''; C_RST=''
fi
info()  { printf "%b\n" "${C_BLU}[*]${C_RST} $*"; }
ok()    { printf "%b\n" "${C_GRN}[+]${C_RST} $*"; }
warn()  { printf "%b\n" "${C_YLW}[!]${C_RST} $*"; }
err()   { printf "%b\n" "${C_RED}[x]${C_RST} $*" >&2; }
die()   { err "$*"; exit 1; }

cleanup() { [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] && rm -rf "$TMP_DIR"; return 0; }
trap cleanup EXIT INT TERM

# ----------------------------------------------------------------------------
# 参数解析
# ----------------------------------------------------------------------------
usage() {
    cat <<EOF
${C_BOLD}frpmgrd 一键安装脚本${C_RST}

用法: sh install.sh [选项]

选项:
  -p, --port <端口>     指定监听端口; 传 "random" 表示随机端口; 省略则交互/默认 ${DEFAULT_PORT}
  -t, --token <令牌>    指定 API 令牌; 省略则交互输入, 留空则生成强随机令牌
  -v, --version <版本>  指定版本 (如 v1.2.10); 省略则安装最新版
  -y, --yes             非交互模式, 端口用默认值、令牌自动随机生成
  -u, --update          全自动更新到最新版 (保留现有端口/令牌/数据, 仅换二进制并重启)
  -f, --force           配合 --update: 即使已是最新版也强制重装
      --uninstall       卸载 (停止服务 + 删除二进制/服务文件)
  -h, --help            显示帮助

参数可任意组合, 已传入的参数不再交互询问。示例:
  sh install.sh                                 # 全交互: 逐项询问端口/令牌
  sh install.sh -p 9000                         # 指定端口, 仅询问令牌
  sh install.sh -t my-secret-token              # 指定令牌, 仅询问端口
  sh install.sh -p 9000 -t my-secret-token      # 端口+令牌都指定, 零交互
  sh install.sh -p 9000 -t my-secret -y         # 完全静默安装
  sh install.sh --port random                   # 随机端口
  sh install.sh -v v1.2.10 -p 8888              # 指定版本+端口
  sh install.sh --update                        # 全自动更新到最新版
  sh install.sh --update -v v1.2.11             # 更新到指定版本
  sh install.sh --update --force                # 强制重装当前最新版
  sh install.sh --uninstall                     # 卸载

环境变量等价形式 (适合 CI/自动化):
  FRPMGR_PORT=9000 FRPMGR_API_TOKEN=xxx ASSUME_YES=1 sh install.sh
EOF
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            -p|--port)     PORT="${2:-}"; shift 2 ;;
            -t|--token)    TOKEN="${2:-}"; shift 2 ;;
            -v|--version)  VERSION="${2:-}"; shift 2 ;;
            -y|--yes)      ASSUME_YES=1; shift ;;
            -u|--update)   ACTION="update"; shift ;;
            -f|--force)    FORCE=1; shift ;;
            --uninstall)   ACTION="uninstall"; shift ;;
            -h|--help)     usage; exit 0 ;;
            *)             die "未知参数: $1 (使用 --help 查看用法)" ;;
        esac
    done
}

# ----------------------------------------------------------------------------
# 平台探测: OS + ARCH, 并据此决定数据目录
# ----------------------------------------------------------------------------
detect_platform() {
    uname_s="$(uname -s 2>/dev/null || echo unknown)"
    uname_m="$(uname -m 2>/dev/null || echo unknown)"

    case "$uname_s" in
        Linux)   OS="linux" ;;
        Darwin)  OS="darwin" ;;
        *)       die "不支持的操作系统: $uname_s (仅支持 Linux / macOS)" ;;
    esac

    case "$uname_m" in
        x86_64|amd64)            ARCH="amd64" ;;
        aarch64|arm64)           ARCH="arm64" ;;
        armv7l|armv7|armhf|arm)  ARCH="armv7" ;;
        *)                       die "不支持的 CPU 架构: $uname_m" ;;
    esac

    # macOS 没有 armv7 发布产物
    if [ "$OS" = "darwin" ] && [ "$ARCH" = "armv7" ]; then
        die "macOS 不提供 armv7 版本"
    fi

    if [ "$OS" = "darwin" ]; then
        DATA_DIR="/usr/local/var/${SERVICE_NAME}"
    else
        DATA_DIR="/var/lib/${SERVICE_NAME}"
    fi
    ENV_FILE="/etc/${SERVICE_NAME}/${SERVICE_NAME}.env"

    info "检测到平台: ${C_BOLD}${OS}/${ARCH}${C_RST}"
}

# ----------------------------------------------------------------------------
# 选择下载器: 优先 curl, 否则 wget
# ----------------------------------------------------------------------------
detect_downloader() {
    if command -v curl >/dev/null 2>&1; then
        DOWNLOADER="curl"
    elif command -v wget >/dev/null 2>&1; then
        DOWNLOADER="wget"
    else
        die "未找到 curl 或 wget, 请先安装其中之一"
    fi
    info "使用下载工具: ${C_BOLD}${DOWNLOADER}${C_RST}"
}

# 下载到标准输出. 用法: fetch_stdout <url>
fetch_stdout() {
    if [ "$DOWNLOADER" = "curl" ]; then
        curl -fsSL "$1"
    else
        wget -qO- "$1"
    fi
}

# 下载到文件. 用法: fetch_file <url> <dest>
fetch_file() {
    if [ "$DOWNLOADER" = "curl" ]; then
        curl -fSL --progress-bar "$1" -o "$2"
    else
        wget -q --show-progress -O "$2" "$1"
    fi
}

# ----------------------------------------------------------------------------
# 权限: 非 root 时通过 sudo 执行
# ----------------------------------------------------------------------------
SUDO=""
ensure_root() {
    if [ "$(id -u)" -ne 0 ]; then
        if command -v sudo >/dev/null 2>&1; then
            SUDO="sudo"
            info "部分操作需要管理员权限, 将通过 sudo 执行"
        else
            die "需要 root 权限, 但未找到 sudo. 请使用 root 用户运行"
        fi
    fi
}
# 以特权执行命令
priv() { $SUDO "$@"; }

# ----------------------------------------------------------------------------
# 交互读取 (从 /dev/tty 读, 这样 curl|sh 管道里也能交互)
#   用法: prompt <提示语> <默认值>  -> 结果写入全局 REPLY
# ----------------------------------------------------------------------------
REPLY=""
prompt() {
    _msg="$1"; _def="${2:-}"
    if [ "$ASSUME_YES" = "1" ] || [ ! -r /dev/tty ]; then
        REPLY="$_def"
        return 0
    fi
    if [ -n "$_def" ]; then
        printf "%b" "${C_YLW}? ${C_RST}${_msg} [${C_BOLD}${_def}${C_RST}]: " > /dev/tty
    else
        printf "%b" "${C_YLW}? ${C_RST}${_msg}: " > /dev/tty
    fi
    IFS= read -r REPLY < /dev/tty || REPLY=""
    [ -z "$REPLY" ] && REPLY="$_def"
}

# ----------------------------------------------------------------------------
# 生成随机令牌 / 随机端口
# ----------------------------------------------------------------------------
gen_token() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 24
    elif [ -r /dev/urandom ]; then
        LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom 2>/dev/null | dd bs=48 count=1 2>/dev/null
    else
        # 退而求其次: 时间戳 + 进程号
        printf "frpmgr%s%s" "$(date +%s)" "$$"
    fi
}

gen_random_port() {
    # 20000-60000 之间的随机端口
    if command -v awk >/dev/null 2>&1; then
        awk "BEGIN{srand($$ + $(date +%s 2>/dev/null || echo 0)); print int(20000 + rand()*40000)}"
    else
        # 用进程号兜底
        echo $(( 20000 + ($$ % 40000) ))
    fi
}

# 校验端口是否为 1-65535 的合法整数
valid_port() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# ----------------------------------------------------------------------------
# 解析最新版本号 (GitHub API), 失败则提示手动指定
# ----------------------------------------------------------------------------
resolve_version() {
    if [ -n "$VERSION" ]; then
        # 统一补上 v 前缀
        case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac
        info "使用指定版本: ${C_BOLD}${VERSION}${C_RST}"
        return 0
    fi
    info "正在查询最新版本..."
    _api="https://api.github.com/repos/${REPO}/releases/latest"
    _tag="$(fetch_stdout "$_api" 2>/dev/null \
        | grep '"tag_name"' \
        | head -n1 \
        | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')" || true
    [ -n "$_tag" ] || die "无法获取最新版本, 请用 --version 手动指定 (如 --version v1.2.10)"
    VERSION="$_tag"
    ok "最新版本: ${C_BOLD}${VERSION}${C_RST}"
}

# ----------------------------------------------------------------------------
# 决定端口与令牌 (交互 / 默认 / 随机)
# ----------------------------------------------------------------------------
resolve_port() {
    if [ "$PORT" = "random" ]; then
        PORT="$(gen_random_port)"
        ok "已生成随机端口: ${C_BOLD}${PORT}${C_RST}"
        return 0
    fi
    if [ -z "$PORT" ]; then
        prompt "请输入监听端口 (回车=默认 ${DEFAULT_PORT}, 输入 r=随机)" "$DEFAULT_PORT"
        PORT="$REPLY"
    fi
    if [ "$PORT" = "r" ] || [ "$PORT" = "random" ]; then
        PORT="$(gen_random_port)"
        ok "已生成随机端口: ${C_BOLD}${PORT}${C_RST}"
    fi
    valid_port "$PORT" || die "端口非法: '$PORT' (应为 1-65535)"
    info "监听端口: ${C_BOLD}${PORT}${C_RST}"
}

# TOKEN_SOURCE 记录令牌来源, 供安装前确认信息展示
TOKEN_SOURCE=""
resolve_token() {
    if [ -n "$TOKEN" ]; then
        TOKEN_SOURCE="命令行/环境变量指定"
    elif [ "$ASSUME_YES" != "1" ]; then
        prompt "请输入 API 令牌 (后台访问凭证, 回车=自动生成强随机令牌)" ""
        TOKEN="$REPLY"
        [ -n "$TOKEN" ] && TOKEN_SOURCE="手动输入"
    fi
    if [ -z "$TOKEN" ]; then
        TOKEN="$(gen_token)"
        TOKEN_SOURCE="自动生成"
        ok "已自动生成强随机 API 令牌"
    else
        info "API 令牌: ${TOKEN_SOURCE}"
    fi
}

# ----------------------------------------------------------------------------
# 安装前确认 (交互模式展示最终参数, 让用户过目; 静默/管道无 tty 则跳过)
# ----------------------------------------------------------------------------
confirm_install() {
    printf "\n%b\n" "${C_BOLD}即将安装, 请确认以下信息:${C_RST}"
    printf "  平台      : %s/%s\n" "$OS" "$ARCH"
    printf "  版本      : %s\n" "$VERSION"
    printf "  监听端口  : %s\n" "$PORT"
    printf "  API 令牌  : %s  (%s)\n" "$TOKEN" "$TOKEN_SOURCE"
    printf "  安装目录  : %s/%s\n" "$INSTALL_DIR" "$BIN_NAME"
    printf "  数据目录  : %s\n" "$DATA_DIR"
    printf "\n"
    if [ "$ASSUME_YES" = "1" ] || [ ! -r /dev/tty ]; then
        return 0
    fi
    prompt "确认继续? [Y/n]" "Y"
    case "$REPLY" in
        n|N|no|NO) die "已取消安装" ;;
    esac
}

# ----------------------------------------------------------------------------
# 下载并安装二进制
# ----------------------------------------------------------------------------
download_and_install() {
    _ver_num="${VERSION#v}"   # 文件名里的版本号不带 v
    _asset="${BIN_NAME}_${_ver_num}_${OS}_${ARCH}.tar.gz"
    _url="https://github.com/${REPO}/releases/download/${VERSION}/${_asset}"

    TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t frpmgr)"
    info "下载: ${_url}"
    fetch_file "$_url" "${TMP_DIR}/${_asset}" || die "下载失败, 请检查网络或版本号"

    info "解压安装包..."
    tar -xzf "${TMP_DIR}/${_asset}" -C "$TMP_DIR" || die "解压失败"
    [ -f "${TMP_DIR}/${BIN_NAME}" ] || die "安装包中未找到二进制 ${BIN_NAME}"

    info "安装到 ${INSTALL_DIR}/${BIN_NAME}"
    priv mkdir -p "$INSTALL_DIR"
    priv install -m 0755 "${TMP_DIR}/${BIN_NAME}" "${INSTALL_DIR}/${BIN_NAME}"
    ok "二进制安装完成: $(${INSTALL_DIR}/${BIN_NAME} version 2>/dev/null || echo "${INSTALL_DIR}/${BIN_NAME}")"
}

# ----------------------------------------------------------------------------
# 写入环境配置文件
# ----------------------------------------------------------------------------
write_env_file() {
    info "写入配置: ${ENV_FILE}"
    priv mkdir -p "$(dirname "$ENV_FILE")"
    priv mkdir -p "$DATA_DIR"
    # 通过临时文件再 install, 避免重定向到特权路径的麻烦
    _tmp_env="${TMP_DIR}/frpmgrd.env"
    cat > "$_tmp_env" <<EOF
# frpmgrd 运行配置 (由 install.sh 生成)
FRPMGR_API_TOKEN=${TOKEN}
FRPMGR_HTTP_ADDR=:${PORT}
FRPMGR_DATA_DIR=${DATA_DIR}
FRPMGR_LOG_LEVEL=info
FRPMGR_CORS_ORIGINS=*
FRPMGR_DOCS_ENABLED=true
EOF
    priv install -m 0600 "$_tmp_env" "$ENV_FILE"
}

# ----------------------------------------------------------------------------
# 注册系统服务: systemd / OpenRC / launchd / 回退
# ----------------------------------------------------------------------------
detect_init_system() {
    if [ "$OS" = "darwin" ]; then
        echo "launchd"; return
    fi
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        echo "systemd"; return
    fi
    if command -v rc-update >/dev/null 2>&1; then
        echo "openrc"; return
    fi
    echo "none"
}

setup_systemd() {
    _unit="/etc/systemd/system/${SERVICE_NAME}.service"
    info "创建 systemd 服务: ${_unit}"
    _tmp_unit="${TMP_DIR}/${SERVICE_NAME}.service"
    cat > "$_tmp_unit" <<EOF
[Unit]
Description=frpmgrd - FRP Manager Server
Documentation=https://github.com/${REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
ExecStart=${INSTALL_DIR}/${BIN_NAME} serve
Restart=on-failure
RestartSec=5
LimitNOFILE=65536
# 安全加固 (数据目录仍可写)
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF
    priv install -m 0644 "$_tmp_unit" "$_unit"
    priv systemctl daemon-reload
    priv systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
    priv systemctl restart "${SERVICE_NAME}"
    ok "systemd 服务已启用并设置为开机自启"
}

setup_openrc() {
    _init="/etc/init.d/${SERVICE_NAME}"
    info "创建 OpenRC 服务: ${_init}"
    _tmp_init="${TMP_DIR}/${SERVICE_NAME}.openrc"
    cat > "$_tmp_init" <<EOF
#!/sbin/openrc-run
name="${SERVICE_NAME}"
description="frpmgrd - FRP Manager Server"
command="${INSTALL_DIR}/${BIN_NAME}"
command_args="serve"
command_background=true
pidfile="/run/${SERVICE_NAME}.pid"
output_log="/var/log/${SERVICE_NAME}.log"
error_log="/var/log/${SERVICE_NAME}.log"

depend() {
    need net
}

start_pre() {
    set -a
    . "${ENV_FILE}"
    set +a
}
EOF
    priv install -m 0755 "$_tmp_init" "$_init"
    priv rc-update add "${SERVICE_NAME}" default >/dev/null 2>&1 || true
    priv rc-service "${SERVICE_NAME}" restart
    ok "OpenRC 服务已启用并设置为开机自启"
}

setup_launchd() {
    _label="com.miaclark.${SERVICE_NAME}"
    _plist="/Library/LaunchDaemons/${_label}.plist"
    info "创建 launchd 服务: ${_plist}"
    priv mkdir -p /var/log
    _tmp_plist="${TMP_DIR}/${_label}.plist"
    cat > "$_tmp_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${_label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${INSTALL_DIR}/${BIN_NAME}</string>
        <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>FRPMGR_API_TOKEN</key>
        <string>${TOKEN}</string>
        <key>FRPMGR_HTTP_ADDR</key>
        <string>:${PORT}</string>
        <key>FRPMGR_DATA_DIR</key>
        <string>${DATA_DIR}</string>
        <key>FRPMGR_LOG_LEVEL</key>
        <string>info</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/log/${SERVICE_NAME}.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/${SERVICE_NAME}.log</string>
</dict>
</plist>
EOF
    priv install -m 0644 "$_tmp_plist" "$_plist"
    priv launchctl unload "$_plist" >/dev/null 2>&1 || true
    priv launchctl load -w "$_plist"
    ok "launchd 服务已加载并设置为开机自启"
}

setup_service() {
    _init="$(detect_init_system)"
    case "$_init" in
        systemd) setup_systemd ;;
        openrc)  setup_openrc ;;
        launchd) setup_launchd ;;
        none)
            warn "未识别到 systemd/OpenRC, 跳过服务注册。"
            warn "可手动后台运行: ${ENV_FILE} 已写入配置, 执行:"
            warn "  set -a; . ${ENV_FILE}; set +a; ${INSTALL_DIR}/${BIN_NAME} serve &"
            ;;
    esac
}

# ----------------------------------------------------------------------------
# 读取已安装二进制的版本号 (如 1.2.10), 未安装则为空
# ----------------------------------------------------------------------------
get_installed_version() {
    if [ -x "${INSTALL_DIR}/${BIN_NAME}" ]; then
        "${INSTALL_DIR}/${BIN_NAME}" version 2>/dev/null | awk '{print $2}'
    fi
}

# ----------------------------------------------------------------------------
# 从现有配置读取监听端口 (用于更新后做健康检查), 取不到则为空
# ----------------------------------------------------------------------------
read_env_port() {
    if [ -f "$ENV_FILE" ]; then
        _addr="$(grep '^FRPMGR_HTTP_ADDR=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2)"
        echo "${_addr#:}"
    elif [ "$OS" = "darwin" ]; then
        _plist="/Library/LaunchDaemons/com.miaclark.${SERVICE_NAME}.plist"
        if [ -f "$_plist" ] && [ -x /usr/libexec/PlistBuddy ]; then
            _addr="$(priv /usr/libexec/PlistBuddy -c \
                "Print :EnvironmentVariables:FRPMGR_HTTP_ADDR" "$_plist" 2>/dev/null)"
            echo "${_addr#:}"
        fi
    fi
}

# ----------------------------------------------------------------------------
# 重启已有服务 (不重写服务文件, 仅重启以加载新二进制)
# ----------------------------------------------------------------------------
restart_service() {
    case "$(detect_init_system)" in
        systemd)
            if [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
                priv systemctl restart "${SERVICE_NAME}"
                ok "systemd 服务已重启"
            else
                warn "未发现 systemd 服务单元, 跳过重启 (可重新安装以注册服务)"
            fi
            ;;
        openrc)
            if [ -f "/etc/init.d/${SERVICE_NAME}" ]; then
                priv rc-service "${SERVICE_NAME}" restart
                ok "OpenRC 服务已重启"
            else
                warn "未发现 OpenRC 服务, 跳过重启"
            fi
            ;;
        launchd)
            _plist="/Library/LaunchDaemons/com.miaclark.${SERVICE_NAME}.plist"
            if [ -f "$_plist" ]; then
                priv launchctl unload "$_plist" >/dev/null 2>&1 || true
                priv launchctl load -w "$_plist"
                ok "launchd 服务已重启"
            else
                warn "未发现 launchd 服务, 跳过重启"
            fi
            ;;
        none)
            warn "未识别到服务管理器, 请手动重启进程"
            ;;
    esac
}

# ----------------------------------------------------------------------------
# 健康检查
# ----------------------------------------------------------------------------
health_check() {
    info "等待服务就绪..."
    _i=0
    while [ "$_i" -lt 10 ]; do
        if "${INSTALL_DIR}/${BIN_NAME}" health -addr "http://127.0.0.1:${PORT}" >/dev/null 2>&1; then
            ok "服务健康检查通过 ✓"
            return 0
        fi
        _i=$((_i + 1))
        sleep 1
    done
    warn "健康检查未通过 (服务可能仍在启动)。请稍后手动检查服务状态与日志。"
}

# ----------------------------------------------------------------------------
# 安装总流程
# ----------------------------------------------------------------------------
do_install() {
    printf "%b\n" "${C_BOLD}=== frpmgrd 一键安装 ===${C_RST}"
    detect_platform
    detect_downloader
    ensure_root
    resolve_version
    resolve_port
    resolve_token
    confirm_install
    download_and_install
    write_env_file
    setup_service
    health_check
    print_summary
}

print_summary() {
    _ip="127.0.0.1"
    printf "\n%b\n" "${C_GRN}${C_BOLD}✓ 安装完成!${C_RST}"
    printf "%b\n" "────────────────────────────────────────────"
    printf "  访问地址 : ${C_BOLD}http://%s:%s${C_RST}\n" "$_ip" "$PORT"
    printf "  API 文档 : ${C_BOLD}http://%s:%s/api/docs${C_RST}\n" "$_ip" "$PORT"
    printf "  API 令牌 : ${C_BOLD}%s${C_RST}\n" "$TOKEN"
    printf "  配置文件 : %s\n" "$ENV_FILE"
    printf "  数据目录 : %s\n" "$DATA_DIR"
    printf "%b\n" "────────────────────────────────────────────"
    case "$(detect_init_system)" in
        systemd)
            printf "  状态: %b\n" "${C_BOLD}systemctl status ${SERVICE_NAME}${C_RST}"
            printf "  日志: %b\n" "${C_BOLD}journalctl -u ${SERVICE_NAME} -f${C_RST}"
            printf "  停止: %b\n" "${C_BOLD}systemctl stop ${SERVICE_NAME}${C_RST}"
            ;;
        openrc)
            printf "  状态: %b\n" "${C_BOLD}rc-service ${SERVICE_NAME} status${C_RST}"
            printf "  日志: %b\n" "${C_BOLD}tail -f /var/log/${SERVICE_NAME}.log${C_RST}"
            ;;
        launchd)
            printf "  状态: %b\n" "${C_BOLD}sudo launchctl list | grep ${SERVICE_NAME}${C_RST}"
            printf "  日志: %b\n" "${C_BOLD}tail -f /var/log/${SERVICE_NAME}.log${C_RST}"
            ;;
    esac
    printf "  更新: %b\n" "${C_BOLD}sh install.sh --update${C_RST}"
    printf "  卸载: %b\n" "${C_BOLD}sh install.sh --uninstall${C_RST}"
    printf "%b\n" "────────────────────────────────────────────"
    warn "请妥善保存 API 令牌, 它是访问后台的唯一凭证!"
}

# ----------------------------------------------------------------------------
# 全自动更新流程 (保留现有端口/令牌/数据, 仅替换二进制并重启服务)
# ----------------------------------------------------------------------------
do_update() {
    printf "%b\n" "${C_BOLD}=== frpmgrd 全自动更新 ===${C_RST}"
    detect_platform
    detect_downloader
    ensure_root

    if [ ! -x "${INSTALL_DIR}/${BIN_NAME}" ]; then
        die "未检测到已安装的 ${BIN_NAME} (${INSTALL_DIR}/${BIN_NAME})。请先执行安装, 而非更新。"
    fi

    _cur="$(get_installed_version)"
    info "当前已安装版本: ${C_BOLD}${_cur:-未知}${C_RST}"

    resolve_version                 # 解析目标版本 (默认最新, 或 -v 指定)
    _target="${VERSION#v}"

    if [ -n "$_cur" ] && [ "$_cur" = "$_target" ] && [ "$FORCE" != "1" ]; then
        ok "已是最新版本 (${_cur}), 无需更新。"
        info "如需强制重装请加 --force"
        return 0
    fi

    info "准备更新: ${C_BOLD}${_cur:-?}${C_RST} -> ${C_BOLD}${_target}${C_RST}"
    download_and_install            # 下载并覆盖二进制 (不动配置)
    restart_service                 # 重启以加载新二进制

    # 尽力做一次健康检查 (端口取自现有配置)
    PORT="$(read_env_port)"
    if [ -n "$PORT" ]; then
        health_check
    else
        warn "未能读取到现有端口, 跳过健康检查 (服务应已重启)"
    fi

    printf "\n%b\n" "${C_GRN}${C_BOLD}✓ 更新完成!${C_RST} 版本: ${_target}"
    [ -n "$PORT" ] && printf "  访问地址 : http://127.0.0.1:%s\n" "$PORT"
    info "现有端口、API 令牌与数据均未改动。"
}

# ----------------------------------------------------------------------------
# 卸载流程
# ----------------------------------------------------------------------------
do_uninstall() {
    printf "%b\n" "${C_BOLD}=== frpmgrd 卸载 ===${C_RST}"
    detect_platform
    ensure_root

    _init="$(detect_init_system)"
    case "$_init" in
        systemd)
            priv systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
            priv systemctl disable "${SERVICE_NAME}" >/dev/null 2>&1 || true
            priv rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
            priv systemctl daemon-reload || true
            ok "已移除 systemd 服务"
            ;;
        openrc)
            priv rc-service "${SERVICE_NAME}" stop >/dev/null 2>&1 || true
            priv rc-update del "${SERVICE_NAME}" default >/dev/null 2>&1 || true
            priv rm -f "/etc/init.d/${SERVICE_NAME}"
            ok "已移除 OpenRC 服务"
            ;;
        launchd)
            _plist="/Library/LaunchDaemons/com.miaclark.${SERVICE_NAME}.plist"
            priv launchctl unload "$_plist" >/dev/null 2>&1 || true
            priv rm -f "$_plist"
            ok "已移除 launchd 服务"
            ;;
    esac

    priv rm -f "${INSTALL_DIR}/${BIN_NAME}"
    ok "已删除二进制 ${INSTALL_DIR}/${BIN_NAME}"

    prompt "是否同时删除配置文件与数据目录 (${DATA_DIR})? [y/N]" "N"
    case "$REPLY" in
        y|Y|yes|YES)
            priv rm -rf "$(dirname "$ENV_FILE")" "$DATA_DIR"
            ok "已删除配置与数据"
            ;;
        *)
            info "保留配置文件 ${ENV_FILE} 与数据目录 ${DATA_DIR}"
            ;;
    esac
    ok "卸载完成"
}

# ----------------------------------------------------------------------------
# 入口
# ----------------------------------------------------------------------------
main() {
    parse_args "$@"
    case "$ACTION" in
        install)   do_install ;;
        update)    do_update ;;
        uninstall) do_uninstall ;;
    esac
}

main "$@"
