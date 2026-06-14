#!/bin/sh
# =============================================================================
# nfpm postinstall — 只装 web 壳子，不自动下载二进制。
#   核心二进制由 LuCI 网页（服务 → FRPC Manager → 下载核心）或命令行
#   frpcmgrd-fetch 触发下载。opkg/apk 安装时执行（镜像构建期 $IPKG_INSTROOT 非空跳过）。
# =============================================================================
[ -n "${IPKG_INSTROOT}" ] && exit 0

# 启用 procd（让开机时会评估服务状态）。是否真正运行由 UCI option enabled 决定。
# 升级/重装时再尝试 start：start_service 按 enabled 把关——
#   enabled=1（运行态/默认）→ 升级后自动恢复运行；enabled=0（用户在网页停过）→ 跳过，保持停止。
# 故「升级核心 / 重装 ipk」都能保持用户上次的启停状态。
if [ -x /etc/init.d/frpcmgrd ]; then
	/etc/init.d/frpcmgrd enable >/dev/null 2>&1
	# 首次安装通常尚未下载二进制，仅在二进制就绪时才尝试恢复运行，避免无谓的启动失败日志。
	[ -x /usr/bin/frpcmgrd ] && /etc/init.d/frpcmgrd start >/dev/null 2>&1
fi

# 立即刷新 LuCI 菜单/模块缓存并重载 rpcd，让 FRPC Manager 菜单与 ACL 立即出现
# （opkg 场景；apk 场景由 /etc/uci-defaults/40_luci-frpcmgrd 在下次启动兜底）
rm -f  /tmp/luci-indexcache* 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null
/etc/init.d/rpcd reload >/dev/null 2>&1

_addr="$(uci -q get frpcmgrd.main.http_addr 2>/dev/null)"
[ -n "$_addr" ] || _addr=":18080"

echo ""
echo "==================================================================="
echo " luci-app-frpcmgrd 已安装 ✓（web 壳子）"
echo "-------------------------------------------------------------------"
echo " 打开路由器后台 → 服务(Services) → FRPC Manager："
echo "   ① 下载 / 更新核心二进制"
echo "   ② 配置端口 / 登录令牌"
echo "   ③ 启动服务，再点「打开管理后台」管理隧道"
echo ""
echo " 也可命令行下载核心: frpcmgrd-fetch latest"
echo " frpcmgrd 自带后台: http://<路由器IP>${_addr}"
echo "==================================================================="
echo ""

exit 0
