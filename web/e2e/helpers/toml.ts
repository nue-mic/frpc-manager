/**
 * 生成最小可用 ClientConfigV1 JSON. 每个 instance 都默认指向 127.0.0.1:65530
 * 这个永远拒绝连接的端口, 配合 loginFailExit=false 让 frpc 持续重连,
 * 从而产生稳定的日志流供测试用.
 *
 * 注意: 必须包含 auth.token, 否则进入「常规配置」UI 编辑时 form validation
 * 会因 token required 而静默拒绝保存。E2E 不在乎 token 内容，给个占位值即可。
 */
export function minimalConfig(name: string) {
  return {
    serverAddr: '127.0.0.1',
    serverPort: 65530,
    loginFailExit: false,
    auth: { method: 'token', token: 'e2e-frps-token' },
    log: { level: 'info', maxDays: 1 },
    frpmgr: { name },
  };
}
