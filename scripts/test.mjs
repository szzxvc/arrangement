import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

// 在加载 Vitest 之前统一真实目录和盘符大小写，兼容 Windows 目录联接。
const root = realpathSync('.').replace(/^[a-z]:/, (drive) => drive.toUpperCase());
const result = spawnSync(
  process.execPath,
  [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
