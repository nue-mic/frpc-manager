/**
 * 生成最小可用 ClientConfigV1 JSON. 每个 instance 都默认指向 127.0.0.1:65530
 * 这个永远拒绝连接的端口, 配合 loginFailExit=false 让 frpc 持续重连,
 * 从而产生稳定的日志流供测试用.
 */
export function minimalConfig(name: string) {
  return {
    serverAddr: '127.0.0.1',
    serverPort: 65530,
    loginFailExit: false,
    log: { level: 'info', maxDays: 1 },
    frpmgr: { name },
  };
}
