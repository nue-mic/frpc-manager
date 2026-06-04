import { test, expect } from './fixtures/daemon';
import { api } from './helpers/api';
import { login, sidebar, configList, detailTabs, logsView } from './helpers/selectors';

test.describe('日志 Clear 仅清空本实例视图, 不影响其他实例', () => {
  test('清空 inst_a 视图后, inst_b 日志依然完整', async ({ page, daemon }) => {
    const a = api(daemon);

    // 使用场景专属 ID，避免与同 worker 中其他场景的实例冲突
    const idA = 'logclr_a';
    const idB = 'logclr_b';

    await a.createConfig(idA);
    await a.createConfig(idB);
    await a.start(idA);
    await a.start(idB);
    await a.waitForLogLines(idA, 3, 30000);
    await a.waitForLogLines(idB, 3, 30000);

    await page.goto(daemon.baseURL);
    await login.tokenInput(page).fill(daemon.token);
    await login.submitBtn(page).click();
    await sidebar.frpcInstancesItem(page).click();

    // 选 logclr_a 进日志页
    await configList.configCard(page, idA).click();
    await detailTabs.logs(page).click();
    await expect(logsView.lines(page).first()).toBeVisible({ timeout: 10000 });

    // 清空 logclr_a（直接点击，无 Popconfirm 弹窗）
    await logsView.clearBtn(page).click();

    // 等待 2s: 清空 API 完成后前端状态已重置
    // 此时 WS 仍然活跃，新行会慢慢出现（frpc 约每 2~3s 重连一次）
    await page.waitForTimeout(2000);

    // logclr_a 清空后应该几乎为空（至多 1~2 行是清空后 WS 推入的新行）
    const remainingA = await logsView.lines(page).count();
    expect(remainingA, 'logclr_a 清空后不应超过 2 行').toBeLessThanOrEqual(2);

    // 切到 logclr_b: LogViewSince 未变，历史日志仍完整
    await configList.configCard(page, idB).click();
    await detailTabs.logs(page).click();
    await expect(logsView.lines(page).first()).toBeVisible({ timeout: 10000 });
    const linesB = await logsView.lines(page).count();
    expect(linesB, 'logclr_b 历史日志不应受 logclr_a clear 影响').toBeGreaterThanOrEqual(3);
  });
});
