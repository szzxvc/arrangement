import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const cli = resolve('node_modules/wrangler/bin/wrangler.js');
const persist = resolve('.test-runtime/browser');
await rm(persist, { recursive: true, force: true });
const migration = spawn(
  process.execPath,
  [cli, 'd1', 'migrations', 'apply', 'club-work-checkin-db', '--local', '--persist-to', persist],
  { stdio: 'inherit' },
);
const code = await new Promise((resolve) => migration.on('exit', resolve));
if (code !== 0) process.exit(Number(code) || 1);
const server = spawn(
  process.execPath,
  [
    cli,
    'dev',
    '--port',
    '8790',
    '--ip',
    '127.0.0.1',
    '--persist-to',
    persist,
    '--var',
    'APP_ENV:development',
    '--var',
    'SESSION_COOKIE_SECURE:false',
  ],
  { stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.kill(signal);
  });
server.on('exit', (code) => process.exit(code ?? 0));
