import type { Daemon } from '../fixtures/daemon';
import { minimalConfig } from './toml';

/**
 * 直接调 daemon REST API 的 helper. 用于在测试中快速 setup 状态
 * (绕过 UI 加速, UI 自己的交互由 spec 内的 page actions 测).
 */
export function api(daemon: Daemon) {
  const h = { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' };

  return {
    async createConfig(id: string) {
      const r = await fetch(`${daemon.baseURL}/api/v1/configs`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ id, config: minimalConfig(id) }),
      });
      if (!r.ok) throw new Error(`createConfig(${id}) failed: ${r.status} ${await r.text()}`);
    },

    async start(id: string) {
      const r = await fetch(`${daemon.baseURL}/api/v1/configs/${id}/start`, {
        method: 'POST',
        headers: h,
      });
      if (!r.ok) throw new Error(`start(${id}) failed: ${r.status} ${await r.text()}`);
    },

    async stop(id: string) {
      const r = await fetch(`${daemon.baseURL}/api/v1/configs/${id}/stop`, {
        method: 'POST',
        headers: h,
      });
      if (!r.ok) throw new Error(`stop(${id}) failed: ${r.status} ${await r.text()}`);
    },

    async getLogs(id: string, lines = 100): Promise<string[]> {
      const r = await fetch(
        `${daemon.baseURL}/api/v1/configs/${id}/logs?lines=${lines}`,
        { headers: h },
      );
      if (!r.ok) throw new Error(`getLogs(${id}) failed: ${r.status}`);
      const body = (await r.json()) as { lines: string[] };
      return body.lines ?? [];
    },

    async clearLogs(id: string) {
      const r = await fetch(`${daemon.baseURL}/api/v1/configs/${id}/logs`, {
        method: 'DELETE',
        headers: h,
      });
      if (!r.ok) throw new Error(`clearLogs(${id}) failed: ${r.status}`);
    },

    /** 轮询 GET /logs 直到 id 至少累积 N 行, 超时抛错. */
    async waitForLogLines(id: string, atLeast: number, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const lines = await this.getLogs(id, atLeast * 2);
        if (lines.length >= atLeast) return lines;
        await new Promise((res) => setTimeout(res, 500));
      }
      throw new Error(`waitForLogLines(${id}, ${atLeast}) timed out`);
    },
  };
}
