import { scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { nowSeconds } from '../shared/time';
import type { User } from '../shared/types';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ENV: string;
  SESSION_COOKIE_SECURE: string;
  DEV_ALLOWED_ORIGINS?: string;
}
export interface Auth {
  user: User;
  tokenHash: string;
  csrfToken: string;
}
export type AppContext = Context<{ Bindings: Env; Variables: { auth: Auth } }>;
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export const fail = (
  code: string,
  message: string,
  status = 400,
  details?: Record<string, unknown>,
): never => {
  throw new AppError(code, message, status, details);
};
export const uid = () => crypto.randomUUID();
export const stmt = (c: AppContext, sql: string, ...args: (string | number | null)[]) =>
  c.env.DB.prepare(sql).bind(...args);
export async function sha256(value: string) {
  return Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  ).toString('hex');
}
export const charLength = (value: string) => Array.from(value).length;
export function usernameInput(value: unknown) {
  if (typeof value !== 'string') return fail('VALIDATION_ERROR', '请输入用户名');
  const username = value.trim().normalize('NFKC');
  if (
    charLength(username) < 3 ||
    charLength(username) > 32 ||
    !/^[\p{Script=Han}a-zA-Z0-9_.-]+$/u.test(username)
  ) {
    return fail(
      'VALIDATION_ERROR',
      '用户名需为 3–32 个字符，可用中文、字母、数字、下划线、连字符或点号',
    );
  }
  return { username, normalized: username.toLowerCase() };
}
export function passwordInput(value: unknown): string {
  if (typeof value !== 'string' || charLength(value) < 8 || charLength(value) > 128)
    return fail('VALIDATION_ERROR', '密码需为 8–128 个字符');
  return value;
}
export function textInput(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') return fail('VALIDATION_ERROR', `请输入${label}`);
  const result = value.trim();
  if (!result || charLength(result) > max)
    return fail('VALIDATION_ERROR', `${label}需为 1–${max} 个字符`);
  return result;
}
export const PASSWORD_PARAMS = { N: 16384, r: 8, p: 5, keylen: 64, maxmem: 64 * 1024 * 1024 };
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(
    password,
    Buffer.from(salt, 'hex'),
    PASSWORD_PARAMS.keylen,
    PASSWORD_PARAMS,
  ).toString('hex');
  return { salt, hash };
}
export interface PasswordRow {
  id: string;
  username: string;
  password_hash: string;
  password_salt: string;
  password_n: number;
  password_r: number;
  password_p: number;
  password_keylen: number;
}
export function verifyPassword(password: string, row: PasswordRow | null) {
  const params = row
    ? { N: row.password_n, r: row.password_r, p: row.password_p, maxmem: PASSWORD_PARAMS.maxmem }
    : PASSWORD_PARAMS;
  const candidate = scryptSync(
    password,
    Buffer.from(row?.password_salt ?? '0'.repeat(32), 'hex'),
    row?.password_keylen ?? 64,
    params,
  );
  const stored = Buffer.from(row?.password_hash ?? '0'.repeat(128), 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored) && !!row;
}
export async function readBody(c: AppContext): Promise<Record<string, unknown>> {
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json'))
    return fail('VALIDATION_ERROR', '请求必须使用 JSON 格式');
  if (Number(c.req.header('content-length') ?? 0) > 16384)
    return fail('VALIDATION_ERROR', '请求内容过长', 413);
  // 限制实际流量，不能仅信任 Content-Length。
  const reader = c.req.raw.body?.getReader();
  if (!reader) return fail('VALIDATION_ERROR', '请求内容不能为空');
  let length = 0;
  const parts: Uint8Array[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > 16384) {
      await reader.cancel();
      return fail('VALIDATION_ERROR', '请求内容过长', 413);
    }
    parts.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return data as Record<string, unknown>;
  } catch {
    return fail('VALIDATION_ERROR', '请求内容不是有效 JSON');
  }
}
export function checkOrigin(c: AppContext) {
  const origin = c.req.header('origin');
  const same = new URL(c.req.url).origin;
  const dev = c.env.APP_ENV === 'development' ? (c.env.DEV_ALLOWED_ORIGINS ?? '').split(',') : [];
  if (!origin || (origin !== same && !dev.includes(origin)))
    fail('CSRF_REJECTED', '请求来源无效，请刷新页面后重试', 403);
  if (c.req.header('sec-fetch-site') === 'cross-site')
    fail('CSRF_REJECTED', '请求来源无效，请刷新页面后重试', 403);
}
export async function getAuth(c: AppContext): Promise<Auth> {
  const token = getCookie(c, 'club_session');
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return fail('UNAUTHENTICATED', '请先登录', 401);
  const tokenHash = await sha256(token);
  const row = await stmt(
    c,
    `SELECT u.id, u.username, s.csrf_token AS csrfToken FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
    tokenHash,
    nowSeconds(),
  ).first<User & { csrfToken: string }>();
  if (!row) return fail('UNAUTHENTICATED', '登录已过期，请重新登录', 401);
  return { user: { id: row.id, username: row.username }, csrfToken: row.csrfToken, tokenHash };
}
export async function sessionData(userId: string) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: await sha256(token),
    userId,
    csrfToken: randomBytes(32).toString('base64url'),
    expiresAt: nowSeconds() + 7 * 86400,
  };
}
export function sessionStatement(c: AppContext, session: Awaited<ReturnType<typeof sessionData>>) {
  return stmt(
    c,
    'INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    session.tokenHash,
    session.userId,
    session.csrfToken,
    session.expiresAt,
    nowSeconds(),
  );
}
function secureCookie(c: AppContext) {
  return c.env.APP_ENV !== 'development' || c.env.SESSION_COOKIE_SECURE !== 'false';
}
export function applySessionCookie(c: AppContext, token: string) {
  setCookie(c, 'club_session', token, {
    path: '/',
    httpOnly: true,
    secure: secureCookie(c),
    sameSite: 'Lax',
    maxAge: 7 * 86400,
  });
}
export function clearSessionCookie(c: AppContext) {
  deleteCookie(c, 'club_session', {
    path: '/',
    httpOnly: true,
    secure: secureCookie(c),
    sameSite: 'Lax',
  });
}
export async function rateLimitAuth(c: AppContext, normalized: string) {
  const now = nowSeconds();
  const ip = c.req.header('cf-connecting-ip') ?? 'local-development';
  const buckets = ['ip:' + (await sha256(ip)), 'account:' + (await sha256(normalized))];
  const results = await c.env.DB.batch<{ attempts: number }>(
    buckets.map((bucket) =>
      stmt(
        c,
        `
    INSERT INTO auth_rate_limits (bucket, window_started, attempts) VALUES (?, ?, 1)
    ON CONFLICT (bucket) DO UPDATE SET
      attempts = CASE WHEN window_started <= ? THEN 1 ELSE attempts + 1 END,
      window_started = CASE WHEN window_started <= ? THEN ? ELSE window_started END
    RETURNING attempts`,
        bucket,
        now,
        now - 600,
        now - 600,
        now,
      ),
    ),
  );
  if (results[0].results[0].attempts > 40 || results[1].results[0].attempts > 10) {
    c.header('Retry-After', '600');
    fail('RATE_LIMITED', '尝试过于频繁，请十分钟后再试', 429);
  }
  // 持久限流；每次认证附带有索引的过期清理，防止桶无限增长。
  await stmt(c, 'DELETE FROM auth_rate_limits WHERE window_started < ?', now - 86400).run();
  await stmt(c, 'DELETE FROM sessions WHERE expires_at <= ?', now).run();
}
export async function requireMembership(c: AppContext, projectId: string) {
  const exists = await stmt(
    c,
    'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    c.get('auth').user.id,
  ).first();
  if (!exists) fail('NOT_FOUND', '项目不存在或你尚未加入', 404);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export interface Mutation {
  requestId: string;
  userId: string;
  fingerprint: string;
  operationId: string;
  cached: { body: Record<string, unknown>; status: number } | null;
}
export async function mutation(c: AppContext, body: Record<string, unknown>): Promise<Mutation> {
  const requestId = c.req.header('x-request-id');
  if (!requestId || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestId))
    return fail('VALIDATION_ERROR', '请求缺少有效操作标识，请刷新重试');
  const userId = c.get('auth').user.id;
  const fingerprint = await sha256(c.req.method + ' ' + c.req.path + ' ' + canonical(body));
  const row = await stmt(
    c,
    'SELECT fingerprint, response_json, status_code FROM mutation_requests WHERE user_id = ? AND request_id = ?',
    userId,
    requestId,
  ).first<{ fingerprint: string; response_json: string; status_code: number }>();
  if (row && row.fingerprint !== fingerprint)
    return fail('IDEMPOTENCY_MISMATCH', '同一操作标识不能用于不同请求', 409);
  return {
    requestId,
    userId,
    fingerprint,
    operationId: uid(),
    cached: row ? { body: JSON.parse(row.response_json), status: row.status_code } : null,
  };
}
export function guard(
  c: AppContext,
  op: Mutation,
  condition: string,
  ...args: (string | number | null)[]
) {
  return stmt(
    c,
    `UPDATE mutation_requests SET guard = CASE WHEN (${condition}) THEN 1 ELSE 0 END WHERE user_id = ? AND request_id = ?`,
    ...args,
    op.userId,
    op.requestId,
  );
}
export async function commit(
  c: AppContext,
  op: Mutation,
  body: Record<string, unknown>,
  statements: D1PreparedStatement[] = [],
  status = 200,
): Promise<Response> {
  if (op.cached) return Response.json(op.cached.body, { status: op.cached.status });
  try {
    // 幂等结果与业务 SQL 是一个原子批次；任何约束失败都会回滚整个批次。
    await c.env.DB.batch([
      stmt(
        c,
        `INSERT INTO mutation_requests (user_id, request_id, fingerprint, response_json, status_code, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        op.userId,
        op.requestId,
        op.fingerprint,
        JSON.stringify(body),
        status,
        nowSeconds(),
      ),
      ...statements,
    ]);
  } catch (error) {
    const message = dbError(error);
    if (
      message.includes('mutation_requests.user_id') ||
      message.includes('mutation_requests.request_id')
    ) {
      const row = await stmt(
        c,
        'SELECT fingerprint, response_json, status_code FROM mutation_requests WHERE user_id = ? AND request_id = ?',
        op.userId,
        op.requestId,
      ).first<{ fingerprint: string; response_json: string; status_code: number }>();
      if (row?.fingerprint === op.fingerprint)
        return Response.json(JSON.parse(row.response_json), { status: row.status_code });
      if (row) return fail('IDEMPOTENCY_MISMATCH', '同一操作标识不能用于不同请求', 409);
    }
    throw error;
  }
  return Response.json(body, { status });
}
export function dbError(error: unknown): string {
  if (!(error instanceof Error)) return '';
  return error.message + (error.cause ? ' ' + dbError(error.cause) : '');
}
export const isGuardError = (error: unknown) => dbError(error).includes('mutation_guard');
export function pagination(c: AppContext) {
  const raw = c.req.query('page') ?? '1';
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100000)
    return fail('VALIDATION_ERROR', '分页参数无效');
  return { page: Number(raw), limit: 20, offset: (Number(raw) - 1) * 20 };
}
