import { test, expect } from './fixtures/daemon';
import { api } from './helpers/api';
import { login, sidebar, configList, detailTabs, logsView } from './helpers/selectors';

test.describe('多实例日志严格分流', () => {
  test('inst_a 的日志视图只显示 [inst=inst_a] 行, inst_b 同理', async ({ page, daemon }) => {
    const a = api(daemon);

    // 使用场景专属 ID，避免与同 worker 中其他场景的实例冲突
    const idA = 'logiso_a';
    const idB = 'logiso_b';

    // setup: 创建 2 实例 + 启动 + 等积累日志
    await a.createConfig(idA);
    await a.createConfig(idB);
    await a.start(idA);
    await a.start(idB);
    await a.waitForLogLines(idA, 3, 30000);
    await a.waitForLogLines(idB, 3, 30000);

    // 通过 UI 验证分流
    await page.goto(daemon.baseURL);
    await login.tokenInput(page).fill(daemon.token);
    await login.submitBtn(page).click();
    await sidebar.frpcInstancesItem(page).click();

    // 选 logiso_a
    await configList.configCard(page, idA).click();
    await detailTabs.logs(page).click();
    await expect(logsView.lines(page).first()).toBeVisible({ timeout: 10000 });

    const linesA = await logsView.lines(page).allTextContents();
    expect(linesA.length).toBeGreaterThan(0);
    for (const line of linesA) {
      expect(line, `logiso_a view leaked logiso_b line: ${line}`).toContain(`[inst=${idA}]`);
      expect(line, `logiso_a view leaked logiso_b line: ${line}`).not.toContain(`[inst=${idB}]`);
    }

    // 切到 logiso_b
    await configList.configCard(page, idB).click();
    await detailTabs.logs(page).click();
    await expect(logsView.lines(page).first()).toBeVisible({ timeout: 10000 });

    const linesB = await logsView.lines(page).allTextContents();
    expect(linesB.length).toBeGreaterThan(0);
    for (const line of linesB) {
      expect(line, `logiso_b view leaked logiso_a line: ${line}`).toContain(`[inst=${idB}]`);
      expect(line, `logiso_b view leaked logiso_a line: ${line}`).not.toContain(`[inst=${idA}]`);
    }
  });
});
