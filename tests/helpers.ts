import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';

export interface TestUser {
  id: string;
  username: string;
  token: string;
  csrf: string;
  ip: string;
}
export async function createRuntime(persist?: string) {
  const bundle = await build({
    entryPoints: ['tests/runtime-entry.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    external: ['node:*'],
    target: 'es2022',
  });
  const directory = persist ?? (await mkdtemp(join(tmpdir(), 'club-d1-')));
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-04-26',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'test-db' },
    d1Persist: directory,
    bindings: { APP_ENV: 'production', SESSION_COOKIE_SECURE: 'true' },
    serviceBindings: {
      ASSETS: async () =>
        new Response('<!doctype html><html lang="zh-CN">前端测试桩</html>', {
          headers: { 'content-type': 'text/html' },
        }),
    },
  });
  const db = await mf.getD1Database('DB');
  return {
    mf,
    db,
    directory,
    async dispose(remove = true) {
      await mf.dispose();
      if (remove) await rm(directory, { recursive: true, force: true });
    },
  };
}
export type Runtime = Awaited<ReturnType<typeof createRuntime>>;
export async function migrate(runtime: Runtime) {
  const migration = await readFile('migrations/0001_initial.sql', 'utf8');
  // 与 Wrangler 同一解析器，保留完整 BEGIN/END 触发器。
  const statements = unstable_splitSqlQuery(migration);
  await runtime.db.batch(statements.map((sql) => runtime.db.prepare(sql)));
}
const fixtureSalt = randomBytes(16).toString('hex');
const fixtureHash = scryptSync('fixture-password', Buffer.from(fixtureSalt, 'hex'), 64, {
  N: 16384,
  r: 8,
  p: 5,
  maxmem: 64 * 1024 * 1024,
}).toString('hex');
export async function makeUser(
  runtime: Runtime,
  username = `成员${randomUUID().slice(0, 8)}`,
): Promise<TestUser> {
  const id = randomUUID(),
    token = randomBytes(32).toString('base64url'),
    csrf = randomBytes(32).toString('base64url'),
    now = Math.floor(Date.now() / 1000);
  await runtime.db.batch([
    runtime.db
      .prepare(
        `INSERT INTO users (id, username, normalized_username, password_algorithm, password_salt, password_hash, password_n, password_r, password_p, password_keylen, created_at) VALUES (?, ?, ?, 'scrypt', ?, ?, 16384, 8, 5, 64, ?)`,
      )
      .bind(id, username, username.toLowerCase(), fixtureSalt, fixtureHash, now),
    runtime.db
      .prepare(
        'INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(createHash('sha256').update(token).digest('hex'), id, csrf, now + 604800, now),
  ]);
  return { id, username, token, csrf, ip: randomUUID() };
}
export async function call(
  runtime: Runtime,
  path: string,
  user?: TestUser,
  body?: Record<string, unknown>,
  requestId = randomUUID(),
  extra: Record<string, string> = {},
) {
  const response = await runtime.mf.dispatchFetch(`http://club.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: 'http://club.test',
      'cf-connecting-ip': user?.ip ?? randomUUID(),
      ...(user ? { Cookie: `club_session=${user.token}`, 'X-CSRF-Token': user.csrf } : {}),
      ...(body !== undefined
        ? { 'Content-Type': 'application/json', 'X-Request-ID': requestId }
        : {}),
      ...extra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await response.json()) as Record<string, any>;
  return { status: response.status, data, headers: response.headers };
}
export async function makeProject(runtime: Runtime, members: TestUser[]) {
  const result = await call(runtime, '/api/projects', members[0], {
    name: '测试协作项目',
    description: '真实 D1 事务与并发验证',
  });
  if (result.status !== 201) throw new Error(JSON.stringify(result.data));
  const id: string = result.data.projectId;
  if (members.length > 1)
    await runtime.db.batch(
      members
        .slice(1)
        .map((u) =>
          runtime.db
            .prepare(
              'INSERT INTO project_members (project_id, user_id, joined_at) VALUES (?, ?, ?)',
            )
            .bind(id, u.id, Math.floor(Date.now() / 1000)),
        ),
    );
  return id;
}
export const futureMinute = () => Math.ceil(Date.now() / 60000) * 60 + 600;
export async function count(runtime: Runtime, sql: string, ...args: (string | number)[]) {
  return (await runtime.db
    .prepare(sql)
    .bind(...args)
    .first<{ n: number }>())!.n;
}
