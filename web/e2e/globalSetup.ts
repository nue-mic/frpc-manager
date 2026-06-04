import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Playwright globalSetup — 在所有 worker 启动前调用一次。
 *
 * 职责：
 *   1. 找到 bin/frpmgrd-dev[.exe] 或 bin/frpmgrd[.exe]，塞到 FRPMGRD_BIN env var
 *   2. ensure web/e2e-tmp/ 目录存在（mkdtempSync 要求父目录存在）
 *
 * 不在职责内：
 *   - 主动构建 daemon（避免每次跑测都触发昂贵的 Go 编译）
 *   - 启动 daemon（那是每个 spec 的 daemon fixture 干的事）
 */
export default async function globalSetup() {
  const projectRoot = resolve(__dirname, '..', '..');
  const candidates = [
    resolve(projectRoot, 'bin', 'frpmgrd-dev.exe'),
    resolve(projectRoot, 'bin', 'frpmgrd-dev'),
    resolve(projectRoot, 'bin', 'frpmgrd.exe'),
    resolve(projectRoot, 'bin', 'frpmgrd'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `frpmgrd binary not found at any of:\n  ${candidates.join('\n  ')}\n` +
        `Run \`make build-host\` (or build manually: \`cd web && npm run build; cd .. && go build -o bin/frpmgrd-dev.exe ./cmd/frpmgrd\`) first.`,
    );
  }
  process.env.FRPMGRD_BIN = found;

  const e2eTmp = resolve(__dirname, '..', 'e2e-tmp');
  mkdirSync(e2eTmp, { recursive: true });

  // eslint-disable-next-line no-console
  console.log(`[globalSetup] frpmgrd binary: ${found}`);
}
