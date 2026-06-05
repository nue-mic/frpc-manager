# 设计文档：「帮助 / 文档」独立菜单页

> 日期：2026-06-05
> 状态：已批准
> 作者：rthink + Claude

## 1. 目标
新增独立菜单页 `帮助 / 文档`，集中放：
1. FRPC / FRPS 两个仓库链接（区分客户端与服务端）。
2. 安装 / Docker / 常用命令的**可一键复制**速查（直接复制即用）。
3. 简短使用手册（3~4 句话讲清登录与使用流程）。

## 2. 文件改动
- **新建** `web/src/pages/Help.tsx`（lazy 加载，跟随主题）
- `web/src/App.tsx`：加 lazy import + `<Route path="help">`
- `web/src/components/MainLayout.tsx`：「系统」菜单组新增 `帮助 / 文档`（图标 `ReadOutlined`）

## 3. Help.tsx 内容

### 顶部：使用手册（3~4 句）
- FRPC 是 frp **客户端**管理器；配合 FRPS **服务端**管理器（独立仓库）。
- 装上守护进程 → 浏览器开 `http://IP:端口/` → 填 API Token 登录 → 网页上增删改启停隧道。

### 仓库链接（两个按钮，新窗口跳转）
- FRPC 客户端 → `https://github.com/mia-clark/frpc-manager`
- FRPS 服务端 → `https://github.com/mia-clark/frps-manager`

### Collapse 折叠面板（默认展开「一键安装」）

**面板 1 — 一键安装**：
- Linux/macOS · 国内镜像：`curl -fsSL https://gh-raw.966788.xyz/frp-mgr/install.sh | sh`
- Linux/macOS · GitHub 官方：`sh -c "$(curl -fsSL https://raw.githubusercontent.com/mia-clark/frpc-manager/main/scripts/install.sh)"`
- Windows（管理员 PowerShell）：`irm https://raw.githubusercontent.com/mia-clark/frpc-manager/main/scripts/install.ps1 | iex`

**面板 2 — Docker 部署**：
- `docker run`（一行，自动生成随机 token）：
  ```
  docker run -d --name frpcmgrd --network host \
    -e FRPCMGR_API_TOKEN="$(openssl rand -hex 32)" \
    -v $(pwd)/data:/data \
    ghcr.io/mia-clark/frpc-manager:latest
  ```
- docker compose（下载 standalone.yml + .env.example 后启动）：
  ```
  curl -O https://raw.githubusercontent.com/mia-clark/frpc-manager/main/deploy/docker-compose.standalone.yml
  curl -O https://raw.githubusercontent.com/mia-clark/frpc-manager/main/deploy/.env.example
  mv .env.example .env
  docker compose -f docker-compose.standalone.yml up -d
  ```

**面板 3 — 常用 fmc 命令**：
```
fmc start            # 启动
fmc stop             # 停止
fmc restart          # 重启
fmc status           # 状态
fmc logs -f          # 实时日志
fmc info             # 完整信息（地址/令牌/路径）
fmc update           # 升级
fmc upgrade-legacy   # 一键迁移旧版 frpmgrd
fmc uninstall        # 卸载
```

## 4. 复用组件 `<CmdBlock>`（Help.tsx 内联）
单个 props：`{ code: string; lang?: string }`。
- 渲染：等宽字体代码块 + 右上角"复制"按钮。
- 复制：`navigator.clipboard.writeText(code)` → `message.success('已复制')`；失败 fallback 用 `document.execCommand('copy')` + 隐藏 textarea。
- 样式：跟随 AntD token；代码块底色用 `token.colorFillTertiary`。

## 5. 技术约束
- 纯前端，无新后端 API。
- 不引第三方代码高亮库（YAGNI）。
- 跟随全站亮/暗主题（不像登录页那样固定深色）。

## 6. 范围之外
- 不放 FRPS 的安装命令（它是另一个程序，仅给仓库链接跳转）。
- 不做全文搜索、多语言、外链预览。

## 7. 验证
- `tsc -b && vite build` 通过。
- 本地 `npm run dev`：菜单出现「帮助 / 文档」；命令复制 → message 提示「已复制」；两个仓库链接新窗口能打开；亮/暗主题切换正常。
