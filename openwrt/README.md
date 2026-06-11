# frpcmgrd · OpenWrt 打包（单个 all ipk）

把无头 FRP 客户端管理器 `frpcmgrd` 打成 OpenWrt 的**一个** ipk 包：`Architecture: all`，**一个包到处装**，不分 CPU 架构。装上即由 **procd** 守护，配置走 **UCI**（`/etc/config/frpcmgrd`），可改端口/登录令牌、开机自启、一键启停、彻底装卸。

> 本目录自包含：ipk 生成逻辑、随包脚本、服务/配置文件全在这里。发布时由 CI（[.github/workflows/release.yml](../.github/workflows/release.yml) 的 `openwrt-ipk` job）调 [build-ipk.sh](build-ipk.sh) 生成单个 `frpcmgrd_<版本>-1_all.ipk` 并传到对应 GitHub Release 的 assets。

---

## 一个 all 包怎么做到「到处装」

`frpcmgrd` 是按 CPU 编译的 Go 二进制，本来需要每个架构一个包。本方案用**「壳子包 + 安装时自取二进制」**把它收敛成一个 `all` 包：

```
all ipk（仅 ~8KB，不含二进制）
├── /etc/init.d/frpcmgrd        procd 服务脚本
├── /etc/config/frpcmgrd        UCI 配置（端口/令牌/…）
├── /usr/sbin/frpcmgrd-fetch    二进制拉取器（核心）
└── /usr/lib/frpcmgrd/VERSION   随包版本号

opkg install 时 → postinst 调 frpcmgrd-fetch →
  ① uname -m + 字节序 识别本机 CPU → 映射到 goreleaser 资产架构
  ② 从 GitHub Release 拉 frpcmgrd_<版本>_linux_<架构>.tar.gz（内置 10 路国内镜像加速 + 直连兜底）
  ③ 解出二进制装到 /usr/bin/frpcmgrd
  ④ enable + start
```

**好处**：一个包覆盖所有架构；彻底甩掉 opkg 架构串映射（不再有 `mips_24kc`/`aarch64_cortex-a53`、不用 `--force-architecture`）；连 mips64le 也能装（只要 Release 有对应 tar.gz）。

**唯一代价**：安装时需要能联网拉二进制（路由器本就联网，且走内置国内镜像）。装时无网也不致命——壳子照样装上，联网后手动跑一次 `frpcmgrd-fetch` 即可。

`frpcmgrd-fetch` 支持的 CPU（`uname -m` → 拉取的二进制）：x86_64、aarch64、armv7/armv6、i386、mips/mipsel（按字节序）、mips64/mips64le、riscv64、loongarch64。

---

## ⚠️ 适配范围（体积约束没变）

二进制解压后约 20–26MB（内嵌 frp + 前端）。OpenWrt 可写空间有限：

| 设备 | 能否装 |
|---|---|
| 8/16MB NOR flash 家用路由（无外置存储） | ❌ 装不下（`frpcmgrd-fetch` 会预检空间并报错引导 extroot） |
| 任意设备 + USB/SD 做 [extroot](https://openwrt.org/docs/guide-user/additional-software/extroot_configuration) | ✅ |
| 128MB+ NAND 机型（MT7621/798x、小米/Redmi 等） | ✅ |
| x86 软路由 | ✅ 推荐 |

`frpcmgrd-fetch` 下载前会 `df` 预检 `/usr/bin` 所在分区（需约 28MB），不足则中止并提示配置 extroot。

---

## 安装

```sh
# 上传 frpcmgrd_<版本>-1_all.ipk 到路由器后：
opkg install frpcmgrd_<版本>-1_all.ipk
```

无需挑架构——任何设备装同一个 `all` 包即可。装完会自动识别 CPU、拉二进制、启动，并打印访问地址与自动生成的 API 令牌。

> **OpenWrt 25.12+（默认 apk）**：本包是 ipk，面向 opkg（OpenWrt ≤24.10）。25.12 改用 apk(APKv3)，不能直接 `apk add` 此 ipk。见文末「OpenWrt 25.12 / apk」。

---

## 配置（端口 / 登录令牌）

配置在 UCI `/etc/config/frpcmgrd` 的 `main` 节，改完 commit + restart 生效：

```sh
uci set frpcmgrd.main.http_addr=':9000'
uci set frpcmgrd.main.token='你的强随机令牌'
uci commit frpcmgrd
/etc/init.d/frpcmgrd restart
```

| UCI 选项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `1` | 0=禁用，不启动 |
| `http_addr` | `:8080` | 监听地址 `:端口` 或 `ip:端口` |
| `token` | 空 | 登录令牌；**留空则首次启动自动生成强随机令牌** |
| `data_dir` | `/usr/lib/frpcmgrd` | 数据根目录，**必须持久化路径**（勿用 /tmp、/var） |
| `log_level` | `info` | trace/debug/info/warn/error |
| `docs_enabled` | `1` | 是否开放 `/api/docs` |
| `cors_origins` | `*` | CORS 白名单 |
| `self_update` | `0` | Web 端自更新，OpenWrt 默认关（用 `frpcmgrd-fetch` 升级） |
| `version` | （注释） | 指定 `frpcmgrd-fetch` 拉取的版本，留空=随包版本 |
| `download_proxy` | （注释） | 指定单一下载镜像，跳过内置列表 |
| `no_proxy` | `0` | 1=跳过镜像直连 GitHub |

> 查看自动生成的令牌：`uci get frpcmgrd.main.token`

---

## 服务管理 / 升级 / 卸载

```sh
/etc/init.d/frpcmgrd start|stop|restart|enable|disable
logread -e frpcmgrd -f            # 实时日志

# 升级二进制（保留配置/数据）：
frpcmgrd-fetch 1.2.40             # 拉指定版本；不带参数=拉随包 VERSION 记录的版本
# 或重装新版 all ipk（postinst 会自动拉新版二进制）：
opkg install frpcmgrd_<新版本>-1_all.ipk

# 卸载（停服 + 删壳子；自取的 /usr/bin/frpcmgrd 与 /usr/lib/frpcmgrd 由 postrm 清理）
opkg remove frpcmgrd
# 连配置也清掉：
opkg remove frpcmgrd && rm -f /etc/config/frpcmgrd
# 数据目录需手动删（默认 /usr/lib/frpcmgrd 已随 postrm 删除，自定义路径请自行清理）
```

> **不要用 Web 端「一键自更新」**（默认已关）：它会覆盖二进制，与包语义冲突。OpenWrt 上用 `frpcmgrd-fetch` 或重装 ipk 升级。

---

## 本地 / CI 构建

依赖 `nfpm`：`go install github.com/goreleaser/nfpm/v2/cmd/nfpm@latest`

```sh
VERSION=1.2.34 ./openwrt/build-ipk.sh --out dist-ipk
# 或
./openwrt/build-ipk.sh --version 1.2.34
```

参数：`--version`（必填，须与 GitHub Release 一致，决定 `frpcmgrd-fetch` 默认拉哪个版本）、`--release`（默认 1）、`--out`（默认 dist-ipk）。产出单个 `frpcmgrd_<版本>-1_all.ipk`。本地也可 `make ipk VERSION=1.2.34`。

> Windows/git-bash 也能跑（内置 `cygpath` 适配）；CI 在 Linux 上无此转换。

**发布自动化（已融进 goreleaser，无独立 job）**：CI 的 `goreleaser` job 在跑 goreleaser 之前先用 `build-ipk.sh` 把 all 包打到 `openwrt-dist/`，再由 goreleaser 的 `release.extra_files`（见 [.goreleaser.yml](../.goreleaser.yml)）与各架构二进制/tar 包**一并上传到同一个 Release**。所以每次发布的打包天然包含这个 ipk。

---

## 目录文件清单

```
openwrt/
├── README.md                       本文档
├── nfpm.yaml                       nfpm 打包模板（__占位符__ 由 build-ipk.sh 渲染）
├── build-ipk.sh                    单 all 包生成脚本
├── files/
│   ├── etc/
│   │   ├── init.d/frpcmgrd          procd 服务脚本（读 UCI → 注入 FRPCMGR_* 环境变量）
│   │   └── config/frpcmgrd          UCI 默认配置
│   └── usr/sbin/frpcmgrd-fetch      按 CPU 联网拉二进制（含 10 路镜像 + 空间预检）
└── scripts/
    ├── postinst.sh                 装后调 fetcher 拉二进制 → enable+start
    ├── prerm.sh                    卸载/升级前 stop+disable
    └── postrm.sh                   真正卸载时清理自取的二进制（升级时跳过）
```

---

## OpenWrt 25.12 / apk（APKv3）说明

OpenWrt 25.12（2026-03 发布）默认包管理器换成 **apk**（APKv3 + ADB 索引 + 签名），与 ipk **格式不同、不能直接 `apk add`**（报 `v2 package format error`，`--allow-untrusted` 也救不了）。nfpm 产的 “apk” 是 Alpine 风味 APKv2，同样不适用于 OpenWrt 的 apk。原生支持 25.12 需走 OpenWrt SDK（APKv3 + 签名），属独立二期工程，本目录未实现。

25.12 用户过渡办法：直接下 `frpcmgrd` 的 `tar.gz` 裸二进制装到 `/usr/bin`，再把本目录 `files/etc/init.d/frpcmgrd`、`files/etc/config/frpcmgrd` 手动落位（完全绕开包管理器，等价于 `frpcmgrd-fetch` 干的事）。

---

## 后续增强（未实现，已规划）

- **luci-app-frpcmgr（瘦面板）**：LuCI 里表单配端口/令牌、按钮启停、显示版本、跳转 frpcmgrd 自带后台、一键触发 `frpcmgrd-fetch` 更新。纯资源包（`PKGARCH:=all`）。
- **原生 apk（APKv3）产线**：需引入 OpenWrt SDK。

> 给后续 LuCI 的稳定契约：服务名 `frpcmgrd`，init `/etc/init.d/frpcmgrd`，UCI `frpcmgrd.main.{http_addr,token,data_dir,version,download_proxy,…}`，拉取器 `/usr/sbin/frpcmgrd-fetch`。改这些名字会破坏后续 LuCI，务必保持兼容。
