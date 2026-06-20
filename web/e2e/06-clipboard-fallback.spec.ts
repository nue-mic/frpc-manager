import { test, expect } from './fixtures/daemon';
import { api } from './helpers/api';
import { login, sidebar, configList } from './helpers/selectors';

/**
 * 复现并验证「非安全上下文剪贴板」修复。
 *
 * 真实场景：用户通过 http:// + 局域网 IP 访问后台（如 OpenWrt），此时浏览器的
 * navigator.clipboard 是 undefined，旧代码直接 navigator.clipboard.writeText 会抛
 * "Cannot read properties of undefined (reading 'writeText')" → 行内「分享」复制失败。
 *
 * 本测试在页面脚本运行前移除 navigator.clipboard，模拟该环境，断言：点击行内分享后
 * 出现「已复制…」成功提示，而不是复制失败错误（证明 execCommand 兜底生效）。
 */
test.describe('剪贴板兜底（非安全上下文 http + 局域网 IP）', () => {
  test('navigator.clipboard 不可用时，行内「分享」应复制成功而非报错', async ({ page, daemon }) => {
    const id = 'inst_clip';
    await api(daemon).createConfig(id);

    // 加一个 stcp 代理（可配对），让该行出现「分享」图标
    const r = await fetch(`${daemon.baseURL}/api/v1/configs/${id}/proxies`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proxy: { name: 'e2e-share-ssh', type: 'stcp', secretKey: 'sk-e2e', localIP: '127.0.0.1', localPort: 22 },
      }),
    });
    expect(r.ok, `add proxy failed: ${r.status} ${await r.text()}`).toBeTruthy();

    // 关键：在任何页面脚本前移除 navigator.clipboard，模拟非安全上下文
    await page.addInitScript(() => {
      try {
        Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true });
      } catch {
        /* ignore */
      }
    });

    await page.goto(daemon.baseURL);
    await login.tokenInput(page).fill(daemon.token);
    await login.submitBtn(page).click();
    await sidebar.frpcInstancesItem(page).click();

    // 选中实例 → 右侧代理表出现
    const card = configList.configCard(page, id);
    await expect(card).toBeVisible();
    await card.click();

    // 该代理行的「分享」图标（ShareAltOutlined → .anticon-share-alt）
    const row = page.locator('.ant-table-row', { hasText: 'e2e-share-ssh' });
    await expect(row).toBeVisible();
    const shareBtn = row.locator('.anticon-share-alt');
    await expect(shareBtn).toBeVisible();
    await shareBtn.click();

    // 断言：出现「已复制…」成功提示（证明兜底生效）
    await expect(page.getByText(/已复制.*(配对信封|可移植信封|粘贴)/)).toBeVisible({ timeout: 8000 });
    // 且不出现旧的复制失败/writeText 错误
    await expect(page.getByText(/复制失败|writeText|Cannot read properties/)).toHaveCount(0);
  });
});
