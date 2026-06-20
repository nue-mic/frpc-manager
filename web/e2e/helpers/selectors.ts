import type { Page, Locator } from '@playwright/test';

export const login = {
  // Input.Password with placeholder="API Token (Bearer 令牌)"
  tokenInput: (p: Page): Locator => p.getByPlaceholder(/API Token|Bearer/i),
  // Submit button text: "进入控制台"（曾为「验证并进入控制台」，已改名）
  submitBtn: (p: Page): Locator => p.getByRole('button', { name: /进入控制台|验证|登录|login|sign in/i }),
  errorMsg: (p: Page): Locator => p.getByText(/无效|invalid|失败|failed/i),
};

export const sidebar = {
  // Menu label: 'FRPC 实例'  key: '/configs'
  frpcInstancesItem: (p: Page): Locator =>
    p.getByRole('menuitem', { name: /FRPC 实例|实例/i }),
  dashboardItem: (p: Page): Locator =>
    p.getByRole('menuitem', { name: /仪表盘|dashboard/i }),
};

export const configList = {
  newConfigBtn: (p: Page): Locator =>
    p.getByRole('button', { name: /新建配置|新建|add|create/i }),
  // Uses data-testid="config-card-{id}" added to Configs.tsx Card components
  configCard: (p: Page, id: string): Locator =>
    p.locator(`[data-testid="config-card-${id}"]`),
  startBtn: (card: Locator): Locator =>
    card.getByRole('button', { name: /启动|start/i }),
  stopBtn: (card: Locator): Locator =>
    card.getByRole('button', { name: /停止|stop/i }),
  // Status badge: getStatusBadge() renders Badge with status text span (.ant-badge-status-text)
  // Use .first() to avoid strict-mode violation when nested spans also match
  stateBadge: (card: Locator): Locator =>
    card.locator('.ant-badge-status-text').first(),
};

export const detailTabs = {
  // Tab label: <Space><ThunderboltOutlined />代理穿透规则</Space>
  proxies: (p: Page): Locator =>
    p.getByRole('tab', { name: /代理穿透规则|代理|proxies/i }),
  // Tab label: <Space><EditOutlined />常规配置 (可视化)</Space>
  visualConfig: (p: Page): Locator =>
    p.getByRole('tab', { name: /常规配置|可视化|visual/i }),
  // Tab label: <Space><CodeOutlined />高级 TOML 配置</Space>
  toml: (p: Page): Locator =>
    p.getByRole('tab', { name: /高级 TOML|toml/i }),
  // Tab label: <Space><FileTextOutlined />运行日志速览</Space>
  logs: (p: Page): Locator =>
    p.getByRole('tab', { name: /运行日志速览|日志/i }),
};

export const visualConfig = {
  // Form.Item label="STUN 服务地址" name="natHoleStunServer" — plain Input
  stunInput: (p: Page): Locator =>
    p.getByLabel(/STUN 服务地址/i),
  // Submit button inside Form: exact text "保存全部客户端配置"
  saveBtn: (p: Page): Locator =>
    p.getByRole('button', { name: '保存全部客户端配置' }),
  // antd message.success() toast: "配置保存成功！"
  saveOkToast: (p: Page): Locator =>
    p.getByText(/配置保存成功/i),
};

export const logsView = {
  /** 单行日志容器; index.css 里的 .log-line 是项目实际使用的 class */
  lines: (p: Page): Locator => p.locator('.log-line'),
  clearBtn: (p: Page): Locator => p.getByRole('button', { name: /清空|clear/i }),
  /** 清空确认弹窗的确认按钮（如有） */
  confirmClearBtn: (p: Page): Locator =>
    p.getByRole('button', { name: /^确定$|^确认$|^ok$/i }),
};
