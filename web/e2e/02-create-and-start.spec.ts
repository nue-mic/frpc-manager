import { test, expect } from './fixtures/daemon';
import { api } from './helpers/api';
import { login, sidebar, configList } from './helpers/selectors';

test.describe('创建配置 + 启动', () => {
  test('通过 API 创建实例后, UI 应显示该实例并能启动到 started 状态', async ({ page, daemon }) => {
    await api(daemon).createConfig('inst_a');

    await page.goto(daemon.baseURL);
    await login.tokenInput(page).fill(daemon.token);
    await login.submitBtn(page).click();
    await sidebar.frpcInstancesItem(page).click();

    const card = configList.configCard(page, 'inst_a');
    await expect(card).toBeVisible();

    await configList.startBtn(card).click();
    await expect(configList.stateBadge(card)).toContainText(/正在运行|started/i, {
      timeout: 10000,
    });
  });
});
