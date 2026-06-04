import type { Page, Locator } from '@playwright/test';

export const login = {
  tokenInput: (p: Page): Locator => p.getByPlaceholder(/api token|token/i),
  submitBtn: (p: Page): Locator => p.getByRole('button', { name: /登录|login|sign in/i }),
  errorMsg: (p: Page): Locator => p.getByText(/无效|invalid|失败|failed/i),
};

export const sidebar = {
  frpcInstancesItem: (p: Page): Locator => p.getByRole('menuitem', { name: /FRPC 实例|实例/i }),
  dashboardItem: (p: Page): Locator => p.getByRole('menuitem', { name: /仪表盘|dashboard/i }),
};

export const configList = {
  newConfigBtn: (p: Page): Locator => p.getByRole('button', { name: /新建配置|新建|add|create/i }),
  configCard: (p: Page, id: string): Locator =>
    p.locator(`text=ID: ${id}`).locator('xpath=ancestor::*[contains(@class,"config")][1]'),
  startBtn: (card: Locator): Locator => card.getByRole('button', { name: /启动|start/i }),
  stopBtn: (card: Locator): Locator => card.getByRole('button', { name: /停止|stop/i }),
  stateBadge: (card: Locator): Locator =>
    card.locator('text=/正在运行|未启动|started|stopped/i'),
};

export const detailTabs = {
  proxies: (p: Page): Locator => p.getByRole('tab', { name: /代理穿透规则|代理|proxies/i }),
  visualConfig: (p: Page): Locator => p.getByRole('tab', { name: /常规配置|可视化|visual/i }),
  toml: (p: Page): Locator => p.getByRole('tab', { name: /高级 TOML|toml/i }),
  logs: (p: Page): Locator => p.getByRole('tab', { name: /运行日志速览|日志/i }),
};

export const visualConfig = {
  stunInput: (p: Page): Locator => p.getByLabel(/STUN 服务地址|stun/i),
  saveBtn: (p: Page): Locator => p.getByRole('button', { name: /保存全部客户端配置|保存/i }),
  saveOkToast: (p: Page): Locator => p.getByText(/保存成功|saved/i),
};

export const logsView = {
  /** 单行日志容器; index.css 里的 .log-line 是项目实际使用的 class */
  lines: (p: Page): Locator => p.locator('.log-line'),
  clearBtn: (p: Page): Locator => p.getByRole('button', { name: /清空|clear/i }),
  /** 清空确认弹窗的确认按钮（如有） */
  confirmClearBtn: (p: Page): Locator =>
    p.getByRole('button', { name: /^确定$|^确认$|^ok$/i }),
};
