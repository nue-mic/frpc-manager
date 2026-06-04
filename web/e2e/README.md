# E2E Tests

基于 Playwright 的端到端测试，覆盖 frpmgrd UI 的关键回归 / 验证路径。

## 前置

- Node 20+
- 项目已构建出 daemon 二进制：

```bash
# 推荐
make build-host

# 或手动
cd web && npm run build
cd .. && go build -o bin/frpmgrd-dev.exe ./cmd/frpmgrd
```

## 首次安装浏览器

```bash
cd web
npm run test:e2e:install
```

## 跑测试

```bash
cd web
npm run test:e2e            # 无头运行
npm run test:e2e:ui         # Playwright UI 模式（调试用）
npm run test:e2e:report     # 跑完后查看 HTML 报告
```

只跑某一个 spec：

```bash
npm run test:e2e -- 04-log-isolation.spec.ts
```

## 架构

- 每个 spec 用 `fixtures/daemon.ts` 拿到独立 daemon fixture：
  - 启独立 `frpmgrd-dev.exe` 子进程
  - 监听 `:18080 + workerIndex`（端口逐 worker 偏移）
  - 独立 `e2e-tmp/<workerN>-<rand>/` 数据目录
  - 子进程 stdout/stderr 落到 `daemon.log`
- 串行 (`workers: 1`) 避免端口冲突
- 测试结束：
  - 成功：自动 kill daemon + 删 TempDir
  - 失败：kill daemon，**保留** TempDir 供事后查
- Trace / screenshot / video 仅在失败时保留，在 `playwright-report/` 和 `test-results/`

## 加新测试

1. `e2e/` 下新建 `NN-name.spec.ts`
2. 从 `./fixtures/daemon` import `test, expect`
3. **选择器集中加在 `helpers/selectors.ts`**，不要在 spec 文件内写裸 CSS / XPath
4. 复杂 setup 走 `helpers/api.ts` 直接调 REST API（绕过 UI 加速）
5. 跑 `npm run test:e2e -- NN-name.spec.ts` 调试

### 找不到选择器时

1. 用 `npm run test:e2e:ui -- NN-name.spec.ts` 在浏览器里交互定位
2. 或 `npx playwright codegen http://127.0.0.1:18080` 录制后复制选择器到 `selectors.ts`
3. 仍不行可在 React 组件加 `data-testid`，并在 commit message 中标注

### 创建配置

`helpers/toml.ts` 的 `minimalConfig(name)` 返回最小可用配置：指向 127.0.0.1:65530（永不连通），配 `loginFailExit=false` 让 frpc 持续重连产生稳定日志流。已包含 `auth.token` 占位值（避免常规配置 form 因 token required 静默拒绝保存）。

## 已覆盖场景

| # | Spec | 验证目标 |
|---|---|---|
| 1 | `01-login.spec.ts` | 登录正确/错误 token |
| 2 | `02-create-and-start.spec.ts` | 创建实例 + 启动到 started |
| 3 | `03-stun-roundtrip.spec.ts` | STUN 字段保存后刷新仍显示（natHoleStunServer 大小写回归） |
| 4 | `04-log-isolation.spec.ts` | 多实例日志按 `[inst=<id>]` 严格分流 |
| 5 | `05-log-clear.spec.ts` | Clear 仅清空本实例视图，其他实例不受影响 |

## 已知约束

- **必须先 build daemon** 才能跑 e2e（globalSetup 校验 `bin/frpmgrd-dev[.exe]` 存在）
- **Windows 杀软**可能拦截 daemon 子进程启动；如出现 EPERM/ACCESS_DENIED 把 `bin/` 加入白名单
- **场景 4-5** 依赖 frpc 日志隔离 feature 的代码（已合入 main / 此分支）

## 未来扩展

- **CI 集成**：GitHub Actions 加一段：
  ```yaml
  - run: cd web && npm ci --legacy-peer-deps
  - run: cd web && npx playwright install chromium
  - run: make build-host
  - run: cd web && npm run test:e2e
  - uses: actions/upload-artifact@v4
    if: failure()
    with: { name: playwright-report, path: web/playwright-report }
  ```
- **多浏览器**：`playwright.config.ts` 的 `projects` 段加 firefox / webkit
- **Visual regression**：用 `expect(page).toHaveScreenshot()`
- **更细测试**：代理增删 / TOML 视图一致性 / 仪表盘汇总（见 plan 文档场景 6-8）

## 故障排查

| 现象 | 原因 / 解决 |
|---|---|
| globalSetup 抛错 "frpmgrd binary not found" | 先 `make build-host` |
| Daemon 起不来（5s 超时） | 看 `e2e-tmp/<spec>/daemon.log` 末尾，可能 18080 端口被占 / 杀软拦截 / token env 配错 |
| 选择器找不到（Locator not found） | 用 `npm run test:e2e:ui` 实地探测 + 改 `selectors.ts` |
| 场景 4/5 失败 | 确认当前分支已合 `feature/frpc-logs-isolation`（`logs/frpc.log` 存在而非 per-id `.log`） |
| Form save 后无 success toast | 检查 `auth.token` 是否被 form validation 默默拒绝（`minimalConfig` 已修） |
