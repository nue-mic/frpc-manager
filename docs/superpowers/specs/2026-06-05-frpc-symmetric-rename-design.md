# 设计文档：frpc-manager 全面对称改名 + 一键迁移命令

> 日期：2026-06-05
> 状态：待 review
> 作者：rthink + Claude

## 1. 背景与目标

本仓库（FRP **客户端** 管理器）与姊妹仓库 `frps-manager`（FRP **服务端** 管理器）功能同构。
`frps-manager` 已采用完整对称命名（`frpsmgrd` / `FRPSMGR_` / module `…/frps-manager`），
而本仓库仍沿用中性的 `frp*` 命名（`frpmgrd` / `FRPMGR_` / module `…/frp-manager-server`），
导致两套服务在二进制名、服务名、环境变量、数据目录上**无法区分**，并存部署时易混淆甚至端口/服务名冲突。

**目标**：把本仓库的所有内部与对外标识从中性 `frp*` 改为客户端专属的 `frpc*`，与服务端 `frps*` 严格对称；
并提供一个独立、幂等、随时可执行的 `fmc upgrade-legacy` 命令，把已部署的旧 `frpmgrd` 实例一键迁移到新 `frpcmgrd`。

## 2. 目标命名映射（最终态）

| 维度 | 旧 | 新 |
|---|---|---|
| 二进制 / 服务名 / `cmd/` 目录 | `frpmgrd` | `frpcmgrd` |
| 环境变量前缀 | `FRPMGR_` | `FRPCMGR_` |
| Go module | `github.com/mia-clark/frp-manager-server` | `github.com/mia-clark/frpc-manager` |
| 数据目录（Linux） | `/var/lib/frpmgrd` | `/var/lib/frpcmgrd` |
| 数据目录（macOS） | `/usr/local/var/frpmgrd` | `/usr/local/var/frpcmgrd` |
| 数据目录（FreeBSD） | `/var/db/frpmgrd` | `/var/db/frpcmgrd` |
| 配置文件 | `/etc/frpmgrd/frpmgrd.env` | `/etc/frpcmgrd/frpcmgrd.env` |
| Windows 目录 | `%ProgramFiles%\frpmgrd`、`%ProgramData%\frpmgrd\{data,logs}` | `…\frpcmgrd\…` |
| 管理命令 | `fmc` | `fmc`（**不变**，已与服务端 `fms` 对称） |
| release / 镜像名 | `frpc-manager` | `frpc-manager`（**不变**，已完成） |

## 3. 改动面清单（按提交切分）

每个提交都必须能独立通过 `go vet` / `go test` / 前端 `tsc` / `sh -n`。

### 提交 1 — Go module 改名
- `go.mod`：module 声明 → `github.com/mia-clark/frpc-manager`
- 全部 `.go` 的 import（约 30 个文件：`internal/**`、`pkg/**`、`services/**`、`cmd/**`）
- **ldflags 联动（易漏）**：`Makefile`、`.goreleaser.yml`、`deploy/Dockerfile` 中
  `-X github.com/mia-clark/frp-manager-server/pkg/version.*` → 新 module path。
  module 改了 ldflags 不改 → 版本号注入失效（与上一轮"保留旧 module 故保留旧 ldflags"相反）。

### 提交 2 — 二进制 / 服务名 `frpmgrd → frpcmgrd`
- `git mv cmd/frpmgrd cmd/frpcmgrd`
- `Makefile`：`BIN`、`main` 路径 `./cmd/frpcmgrd`、产物名
- `.goreleaser.yml`：`project_name`、`builds[].binary`、`builds[].main`
- `deploy/Dockerfile`：构建输出名、`COPY`、`ENTRYPOINT`
- `deploy/entrypoint.sh`、`deploy/docker-compose.yml`、`deploy/docker-compose.standalone.yml`（`container_name` 等）
- `scripts/install.sh`：`SERVICE_NAME`、`BIN_NAME`（→ 派生 unit/init/plist/数据目录全部跟随）
- `scripts/install.ps1`：`$ServiceName`、`$BinName`、`$InstallDir`、`$DataDir`、`$LogDir`
- 应用内字符串：`internal/api/docs.go`、`internal/sysinfo/sysinfo.go`（标题/默认值）

### 提交 3 — 环境变量前缀 `FRPMGR_ → FRPCMGR_`
- `internal/appcfg/appcfg.go`：所有读取键
- `cmd/frpcmgrd/main.go`：引用处
- `scripts/install.sh` / `install.ps1`：写入 env 文件 / 服务环境变量的键名
- `deploy/Dockerfile`、`entrypoint.sh`、`docker-compose*.yml`
- `web/e2e/fixtures/daemon.ts`（测试设置 env）

### 提交 4 — `fmc upgrade-legacy` 迁移命令（见第 4 节）

### 提交 5 — 文档同步
- `README.md`、`CLAUDE.md`、`docs/API.zh-CN.md`、`docs/README-server.md`、各 `web/**/README.md`、`web/src/pages/tomlSnippets.ts`
- `CHANGELOG.md`：**新增**一条改名记录（不改旧条目）

## 4. `fmc upgrade-legacy` 命令设计

### 4.1 定位
- 独立一等子命令，与 `install` / `update` 主流程**完全解耦**。
- 幂等：可重复执行；无旧部署时打印"未检测到旧版 frpmgrd，无需迁移"并退出 0。
- 前提：用户已用新版脚本装好 `frpcmgrd`（因此新 `fmc` 才带此子命令）。本命令只负责"搬旧数据 + 清旧服务"。

### 4.2 Linux / macOS（install.sh 生成的 fmc）
按序执行，每步幂等、失败可重入：
1. **探测旧部署**：旧服务 `frpmgrd`（systemd unit / openrc init / launchd plist 任一存在）或旧数据目录 `/var/lib/frpmgrd`（含平台变体）或旧 env `/etc/frpmgrd/frpmgrd.env` 存在 → 判定需迁移；否则提示无需迁移并退出。
2. **停止两侧服务**：停新 `frpcmgrd`（避免占用数据目录）；停 + disable 旧 `frpmgrd`。
3. **迁移数据目录**：旧 `/var/lib/frpmgrd`（平台变体）存在且新目录为空/不存在 → `mv` 整目录到新路径；若新目录已有数据 → **跳过 + 告警**（不覆盖用户新数据）。
4. **迁移 env**：把旧 `/etc/frpmgrd/frpmgrd.env` 内容中的 `FRPMGR_` 前缀 `sed` 为 `FRPCMGR_`，写入新 `/etc/frpcmgrd/frpcmgrd.env`（新文件已存在则跳过 + 告警）。
5. **清理旧物**：删除旧 unit/init/plist、旧二进制 `/usr/local/bin/frpmgrd`、空的旧 `/etc/frpmgrd`。
6. **启动新服务**：启动并健康检查 `frpcmgrd`，打印访问地址。

### 4.3 Windows（install.ps1 生成的 fmc.ps1）
1. 探测旧 nssm 服务 `frpmgrd` 或旧目录 `%ProgramData%\frpmgrd`。
2. 停 + `nssm remove frpmgrd confirm`；停新 `frpcmgrd`。
3. `Move-Item` `%ProgramData%\frpmgrd\{data,logs}` → `…\frpcmgrd\{data,logs}`（新目录已有数据则跳过 + 告警）。
4. 服务环境变量：以 `FRPCMGR_` 重建（值取自旧服务的 `FRPMGR_*`）。
5. 删旧二进制目录 `%ProgramFiles%\frpmgrd`（保留 nssm 若共用则谨慎）。
6. 启动新 `frpcmgrd` 服务 + 健康检查。

### 4.4 安全约束
- 数据用 `mv`/`Move-Item`（移动语义，用户已确认）；只有"新目录不存在/为空"才迁，避免覆盖。
- 全程 `priv`/管理员权限校验沿用现有封装。
- 迁移前打印将执行的动作摘要；关键删除操作有日志。

## 5. install / update 行为（明确不变更）
- 安装/升级脚本**完全无视**旧 `frpmgrd` 部署：不检测、不提示、不自动迁移。
- 纯新命名安装，所有旧部署迁移完全由用户手动 `fmc upgrade-legacy` 触发。
- 副作用知会：旧服务未迁移前仍在跑，可能与新服务端口冲突——这是已接受的取舍，由用户在需要时跑迁移命令解决。

## 6. 保留不动
- 管理命令名 `fmc`（已对称）。
- `docs/superpowers/{plans,specs}/*.md` 历史归档、`CHANGELOG.md` 旧条目（保历史真实，仅新增记录）。
- 上游 `github.com/fatedier/frp` 相关；`tmp/`、`bin/` 本地产物。

## 7. 关键风险与不受影响项
- **ldflags 联动**（第 3 节提交 1）：最易漏，专门核对。
- **install.ps1 的 UTF-8 BOM**：含中文，编辑后必须复核 `ef bb bf` 仍在。
- **`decodeJSON` 的 `DisallowUnknownFields`**：env 前缀属部署层，不进 JSON 请求体，**不受影响**；前端 API 字段绑定不涉及本次改名。
- **现有失败/历史 tag**：无关，不处理。

## 8. 验证策略
- 静态：`go vet ./...`、`go test ./...`、前端 `tsc -b`、`sh -n scripts/install.sh`。
- 残留核对：`rg "frpmgrd|FRPMGR_|frp-manager-server"`（排除 docs/superpowers、CHANGELOG 旧条目、bin、tmp、上游）应为空。
- BOM 复核：`install.ps1` 头三字节 = `ef bb bf`。
- 端到端：push 触发 CI 发 `v1.2.26`，确认 goreleaser 以 `project_name=frpcmgrd` 出包、release 资产名为 `frpcmgrd_1.2.26_*`。
- 迁移命令：在装有旧 `frpmgrd` 的环境实测 `fmc upgrade-legacy` 全流程（数据/配置搬迁、旧服务清除、新服务起来）。

## 9. 提交切分小结
1. Go module 改名（+ 全部 ldflags）
2. 二进制/服务名 `frpmgrd → frpcmgrd`
3. env 前缀 `FRPMGR_ → FRPCMGR_`
4. `fmc upgrade-legacy` 迁移命令（install.sh + install.ps1）
5. 文档同步 + CHANGELOG 新条目
