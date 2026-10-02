import { Hono } from 'hono';
import {
  AppError,
  applySessionCookie,
  clearSessionCookie,
  checkOrigin,
  commit,
  dbError,
  fail,
  getAuth,
  guard,
  hashPassword,
  isGuardError,
  mutation,
  pagination,
  passwordInput,
  PASSWORD_PARAMS,
  rateLimitAuth,
  readBody,
  requireMembership,
  sessionData,
  sessionStatement,
  stmt,
  textInput,
  uid,
  usernameInput,
  verifyPassword,
} from './core';
import type { AppContext, Env, Auth, PasswordRow, Mutation } from './core';
import { formatRange, nowSeconds } from '../shared/time';
import type { Activity, Member, Project, Reservation } from '../shared/types';

const app = new Hono<{ Bindings: Env; Variables: { auth: Auth } }>();
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
  if (c.req.path.startsWith('/api')) c.header('Cache-Control', 'no-store');
  if (c.req.path.startsWith('/api') && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method))
    checkOrigin(c);
  await next();
});
app.use('/api/*', async (c, next) => {
  if (['/api/auth/register', '/api/auth/login'].includes(c.req.path)) return next();
  const auth = await getAuth(c);
  c.set('auth', auth);
  if (!['GET', 'HEAD'].includes(c.req.method) && c.req.header('x-csrf-token') !== auth.csrfToken)
    fail('CSRF_REJECTED', '安全验证已失效，请刷新页面后重试', 403);
  await next();
});

app.post('/api/auth/register', async (c) => {
  const body = await readBody(c);
  const { username, normalized } = usernameInput(body.username);
  const password = passwordInput(body.password);
  await rateLimitAuth(c, normalized);
  const id = uid();
  const credentials = hashPassword(password);
  const session = await sessionData(id);
  try {
    await c.env.DB.batch([
      stmt(
        c,
        `INSERT INTO users (id, username, normalized_username, password_algorithm, password_salt, password_hash, password_n, password_r, password_p, password_keylen, created_at)
        VALUES (?, ?, ?, 'scrypt', ?, ?, ?, ?, ?, ?, ?)`,
        id,
        username,
        normalized,
        credentials.salt,
        credentials.hash,
        PASSWORD_PARAMS.N,
        PASSWORD_PARAMS.r,
        PASSWORD_PARAMS.p,
        PASSWORD_PARAMS.keylen,
        nowSeconds(),
      ),
      sessionStatement(c, session),
    ]);
  } catch (error) {
    if (dbError(error).includes('users.normalized_username'))
      return fail('USERNAME_TAKEN', '该用户名已被注册', 409);
    throw error;
  }
  applySessionCookie(c, session.token);
  return c.json(
    { user: { id, username }, csrfToken: session.csrfToken, serverNow: nowSeconds() },
    201,
  );
});
app.post('/api/auth/login', async (c) => {
  const body = await readBody(c);
  // 格式错误与不存在账号使用同一提示；有效账号和来源限流始终先于密码计算。
  let normalized: string;
  try {
    normalized = usernameInput(body.username).normalized;
    passwordInput(body.password);
  } catch {
    return fail('INVALID_CREDENTIALS', '用户名或密码错误', 401);
  }
  await rateLimitAuth(c, normalized);
  const row = await stmt(
    c,
    'SELECT * FROM users WHERE normalized_username = ?',
    normalized,
  ).first<PasswordRow>();
  if (!verifyPassword(body.password as string, row))
    return fail('INVALID_CREDENTIALS', '用户名或密码错误', 401);
  const session = await sessionData(row!.id);
  await sessionStatement(c, session).run();
  applySessionCookie(c, session.token);
  return c.json({
    user: { id: row!.id, username: row!.username },
    csrfToken: session.csrfToken,
    serverNow: nowSeconds(),
  });
});
app.get('/api/auth/me', (c) =>
  c.json({ user: c.get('auth').user, csrfToken: c.get('auth').csrfToken, serverNow: nowSeconds() }),
);
app.post('/api/auth/logout', async (c) => {
  await stmt(c, 'DELETE FROM sessions WHERE token_hash = ?', c.get('auth').tokenHash).run();
  clearSessionCookie(c);
  return c.json({ ok: true });
});

const projectSelect = `SELECT p.id, p.name, p.description, p.creator_id AS creatorId, p.created_at AS createdAt,
  u.username AS creatorUsername, (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS memberCount FROM projects p JOIN users u ON u.id = p.creator_id`;
const reservationSelect = `SELECT r.id, r.user_id AS userId, u.username, r.start_at AS startAt, r.end_at AS endAt,
  r.status, r.created_at AS createdAt, r.cancelled_at AS cancelledAt FROM reservations r JOIN users u ON u.id = r.user_id`;
const activitySelect = `SELECT a.id, u.username AS actorUsername, t.username AS targetUsername,
  a.from_state AS fromState, a.to_state AS toState, a.reason, a.work_session_id AS workSessionId, a.occurred_at AS occurredAt
  FROM audit_events a JOIN users u ON u.id = a.actor_id JOIN users t ON t.id = a.target_id`;
app.get('/api/projects', async (c) => {
  const result = await stmt(
    c,
    `${projectSelect} WHERE EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?) ORDER BY p.created_at DESC, p.id`,
    c.get('auth').user.id,
  ).all<Project>();
  return c.json({ projects: result.results });
});
app.post('/api/projects', async (c) => {
  const body = await readBody(c);
  const op = await mutation(c, body);
  if (op.cached) return commit(c, op, {});
  const name = textInput(body.name, '项目名称', 80);
  const description = textInput(body.description, '项目描述', 2000);
  const id = uid(),
    now = nowSeconds();
  return commit(
    c,
    op,
    { projectId: id },
    [
      stmt(
        c,
        'INSERT INTO projects (id, name, description, creator_id, created_at) VALUES (?, ?, ?, ?, ?)',
        id,
        name,
        description,
        op.userId,
        now,
      ),
      stmt(
        c,
        'INSERT INTO project_members (project_id, user_id, joined_at) VALUES (?, ?, ?)',
        id,
        op.userId,
        now,
      ),
    ],
    201,
  );
});
app.get('/api/projects/:projectId/snapshot', async (c) => {
  const projectId = c.req.param('projectId');
  await requireMembership(c, projectId);
  const now = nowSeconds();
  // D1 batch 的一致读取同时返回成员状态与活动记录，没有逐成员请求。
  const [project, members, reservations, activity] = await c.env.DB.batch([
    stmt(c, `${projectSelect} WHERE p.id = ?`, projectId),
    stmt(
      c,
      `SELECT u.id, u.username, m.joined_at AS joinedAt, m.state_version AS version, w.id AS workSessionId, w.started_at AS startedAt
      FROM project_members m JOIN users u ON u.id = m.user_id LEFT JOIN work_sessions w ON w.project_id = m.project_id AND w.user_id = m.user_id AND w.ended_at IS NULL
      WHERE m.project_id = ? ORDER BY m.joined_at, u.id`,
      projectId,
    ),
    stmt(
      c,
      `${reservationSelect} WHERE r.project_id = ? AND r.status = 'active' AND r.end_at > ? ORDER BY r.start_at, r.id LIMIT 21`,
      projectId,
      now,
    ),
    stmt(
      c,
      `${activitySelect} WHERE a.project_id = ? ORDER BY a.occurred_at DESC, a.rowid DESC LIMIT 20`,
      projectId,
    ),
  ]);
  return c.json({
    project: project.results[0],
    members: members.results,
    reservations: reservations.results.slice(0, 20),
    reservationsHasMore: reservations.results.length > 20,
    activity: activity.results,
    serverNow: now,
  });
});

app.post('/api/projects/:projectId/invitations', async (c) => {
  const projectId = c.req.param('projectId');
  await requireMembership(c, projectId);
  const body = await readBody(c),
    op = await mutation(c, body);
  if (op.cached) return commit(c, op, {});
  const { normalized } = usernameInput(body.username);
  const target = await stmt(
    c,
    'SELECT id FROM users WHERE normalized_username = ?',
    normalized,
  ).first<{ id: string }>();
  if (!target) return fail('USER_NOT_FOUND', '找不到该用户', 404);
  if (
    await stmt(
      c,
      'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
      projectId,
      target.id,
    ).first()
  )
    return fail('ALREADY_MEMBER', '该用户已加入项目', 409);
  const id = uid();
  try {
    return await commit(
      c,
      op,
      { invitationId: id },
      [
        guard(
          c,
          op,
          `NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?)`,
          projectId,
          target.id,
        ),
        stmt(
          c,
          `INSERT INTO project_invitations (id, project_id, inviter_id, invitee_id, created_at) VALUES (?, ?, ?, ?, ?)`,
          id,
          projectId,
          op.userId,
          target.id,
          nowSeconds(),
        ),
      ],
      201,
    );
  } catch (error) {
    if (isGuardError(error)) return fail('ALREADY_MEMBER', '该用户已加入项目', 409);
    if (dbError(error).includes('project_invitations.project_id'))
      return fail('INVITATION_ALREADY_PENDING', '已向该用户发送邀请，请等待处理', 409);
    throw error;
  }
});
app.get('/api/invitations', async (c) => {
  const result = await stmt(
    c,
    `SELECT i.id, i.project_id AS projectId, p.name AS projectName, u.username AS inviterUsername, i.created_at AS createdAt
    FROM project_invitations i JOIN projects p ON p.id = i.project_id JOIN users u ON u.id = i.inviter_id
    WHERE i.invitee_id = ? AND i.status = 'pending' ORDER BY i.created_at DESC`,
    c.get('auth').user.id,
  ).all();
  return c.json({ invitations: result.results });
});
for (const action of ['accept', 'reject'] as const) {
  app.post(`/api/invitations/:invitationId/${action}`, async (c) => {
    const id = c.req.param('invitationId');
    const invitation = await stmt(
      c,
      'SELECT project_id, status FROM project_invitations WHERE id = ? AND invitee_id = ?',
      id,
      c.get('auth').user.id,
    ).first<{ project_id: string; status: string }>();
    if (!invitation) return fail('NOT_FOUND', '邀请不存在', 404);
    const body = await readBody(c),
      op = await mutation(c, body);
    if (op.cached) return commit(c, op, {});
    const status = action === 'accept' ? 'accepted' : 'rejected';
    if (invitation.status === status)
      return commit(c, op, { ok: true, projectId: invitation.project_id });
    if (invitation.status !== 'pending')
      return fail('INVITATION_NOT_PENDING', '该邀请已处理，请刷新列表', 409);
    const now = nowSeconds();
    const statements = [
      stmt(
        c,
        `UPDATE project_invitations SET status = ?, resolved_at = ?, resolved_operation_id = ? WHERE id = ? AND invitee_id = ? AND status = 'pending'`,
        status,
        now,
        op.operationId,
        id,
        op.userId,
      ),
    ];
    if (action === 'accept')
      statements.push(
        stmt(
          c,
          `INSERT INTO project_members (project_id, user_id, joined_at)
      SELECT project_id, invitee_id, ? FROM project_invitations WHERE id = ? AND status = 'accepted' AND resolved_operation_id = ? ON CONFLICT (project_id, user_id) DO NOTHING`,
          now,
          id,
          op.operationId,
        ),
      );
    statements.push(
      guard(
        c,
        op,
        `EXISTS (SELECT 1 FROM project_invitations WHERE id = ? AND invitee_id = ? AND status = ?)`,
        id,
        op.userId,
        status,
      ),
    );
    try {
      return await commit(c, op, { ok: true, projectId: invitation.project_id }, statements);
    } catch (error) {
      if (isGuardError(error))
        return fail('INVITATION_NOT_PENDING', '该邀请已被处理，请刷新列表', 409);
      throw error;
    }
  });
}

async function activeWorker(c: AppContext, projectId: string) {
  return stmt(
    c,
    'SELECT w.id, w.user_id AS userId, u.username FROM work_sessions w JOIN users u ON u.id = w.user_id WHERE w.project_id = ? AND w.ended_at IS NULL',
    projectId,
  ).first<{ id: string; userId: string; username: string }>();
}
function busy(active: { userId: string; username: string }): never {
  return fail('PROJECT_BUSY', `${active.username} 干活中，请勿同时工作`, 409, {
    activeUserId: active.userId,
    activeUsername: active.username,
  });
}
async function startWork(
  c: AppContext,
  projectId: string,
  userId: string,
  op: Mutation,
  forced: boolean,
  expectedVersion?: number,
) {
  if (!forced) {
    const active = await activeWorker(c, projectId);
    if (active?.userId === userId)
      return commit(c, op, { workSessionId: active.id, state: 'working' });
    if (active) return busy(active);
  }
  const id = uid();
  const statements: D1PreparedStatement[] = [];
  if (forced)
    statements.push(
      guard(
        c,
        op,
        `EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = ? AND m.user_id = ? AND m.state_version = ?)
    AND NOT EXISTS (SELECT 1 FROM work_sessions w WHERE w.project_id = ? AND w.user_id = ? AND w.ended_at IS NULL)`,
        projectId,
        userId,
        expectedVersion!,
        projectId,
        userId,
      ),
    );
  statements.push(
    stmt(
      c,
      `INSERT INTO work_sessions (id, project_id, user_id, started_at, started_by, start_reason, start_operation_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      projectId,
      userId,
      nowSeconds(),
      op.userId,
      forced ? 'forced' : 'self',
      op.operationId,
    ),
  );
  try {
    return await commit(c, op, { workSessionId: id, state: 'working' }, statements);
  } catch (error) {
    if (isGuardError(error)) return fail('STATE_CHANGED', '成员状态已变化，请刷新后重新确认', 409);
    if (dbError(error).includes('work_sessions.project_id')) {
      const active = await activeWorker(c, projectId);
      if (!forced && active?.userId === userId)
        return commit(c, op, { workSessionId: active.id, state: 'working' });
      if (active) return busy(active);
      return fail('STATE_CHANGED', '项目状态已变化，请刷新后重试', 409);
    }
    throw error;
  }
}
async function stopWork(
  c: AppContext,
  projectId: string,
  userId: string,
  op: Mutation,
  workId: string,
  forced: boolean,
  expectedVersion?: number,
) {
  const statements: D1PreparedStatement[] = [];
  if (forced)
    statements.push(
      guard(
        c,
        op,
        `EXISTS (SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND state_version = ?)`,
        projectId,
        userId,
        expectedVersion!,
      ),
    );
  statements.push(
    stmt(
      c,
      `UPDATE work_sessions SET ended_at = ?, ended_by = ?, end_reason = ?, end_operation_id = ?
    WHERE id = ? AND project_id = ? AND user_id = ? AND ended_at IS NULL`,
      nowSeconds(),
      op.userId,
      forced ? 'forced' : 'self',
      op.operationId,
      workId,
      projectId,
      userId,
    ),
  );
  statements.push(
    guard(
      c,
      op,
      `EXISTS (SELECT 1 FROM work_sessions WHERE id = ? AND project_id = ? AND user_id = ? AND end_operation_id = ?)`,
      workId,
      projectId,
      userId,
      op.operationId,
    ),
  );
  try {
    return await commit(c, op, { workSessionId: workId, state: 'resting' }, statements);
  } catch (error) {
    if (isGuardError(error))
      return fail('STATE_CHANGED', '这次工作已结束或状态已变化，请刷新后重新确认', 409);
    throw error;
  }
}
app.post('/api/projects/:projectId/work/start', async (c) => {
  const projectId = c.req.param('projectId');
  await requireMembership(c, projectId);
  const body = await readBody(c),
    op = await mutation(c, body);
  if (op.cached) return commit(c, op, {});
  return startWork(c, projectId, op.userId, op, false);
});
app.post('/api/projects/:projectId/work/stop', async (c) => {
  const projectId = c.req.param('projectId');
  await requireMembership(c, projectId);
  const body = await readBody(c),
    op = await mutation(c, body);
  if (op.cached) return commit(c, op, {});
  if (typeof body.workSessionId !== 'string')
    return fail('VALIDATION_ERROR', '缺少当前工作记录标识');
  return stopWork(c, projectId, op.userId, op, body.workSessionId, false);
});
app.post('/api/projects/:projectId/members/:userId/work-state', async (c) => {
  const projectId = c.req.param('projectId'),
    userId = c.req.param('userId');
  await requireMembership(c, projectId);
  if (
    !(await stmt(
      c,
      'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
      projectId,
      userId,
    ).first())
  )
    return fail('NOT_FOUND', '成员不存在', 404);
  const body = await readBody(c),
    op = await mutation(c, body);
  if (op.cached) return commit(c, op, {});
  if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0)
    return fail('VALIDATION_ERROR', '缺少成员状态版本');
  const version = body.expectedVersion as number;
  if (
    body.state === 'working' &&
    body.expectedState === 'resting' &&
    body.expectedWorkSessionId === null
  )
    return startWork(c, projectId, userId, op, true, version);
  if (
    body.state === 'resting' &&
    body.expectedState === 'working' &&
    typeof body.expectedWorkSessionId === 'string'
  )
    return stopWork(c, projectId, userId, op, body.expectedWorkSessionId, true, version);
  return fail('VALIDATION_ERROR', '必须指定目标状态及原状态，不能自动切换');
});

app.post('/api/projects/:projectId/reservations', async (c) => {
  const projectId = c.req.param('projectId');
  await requireMembership(c, projectId);
  const body = await readBody(c),
    op = await mutation(c, body);
  if (op.cached) return commit(c, op, {});
  const start = body.startAt,
    end = body.endAt,
    now = nowSeconds();
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start % 60 !== 0 ||
    end % 60 !== 0 ||
    start < now ||
    end - start < 60 ||
    end > 253402271940
  )
    return fail('VALIDATION_ERROR', '请选择未来的整分钟时段，结束至少晚于开始一分钟');
  const id = uid();
  try {
    return await commit(
      c,
      op,
      { reservationId: id },
      [
        stmt(
          c,
          'INSERT INTO reservations (id, project_id, user_id, start_at, end_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          id,
          projectId,
          op.userId,
          start,
          end,
          now,
        ),
      ],
      201,
    );
  } catch (error) {
    if (dbError(error).includes('RESERVATION_CONFLICT')) {
      const conflict = await stmt(
        c,
        `${reservationSelect} WHERE r.project_id = ? AND r.status = 'active' AND ? < r.end_at AND ? > r.start_at ORDER BY r.start_at LIMIT 1`,
        projectId,
        start,
        end,
      ).first<Reservation>();
      if (conflict)
        return fail(
          'RESERVATION_CONFLICT',
          `该时段已被 ${conflict.username} 预约：${formatRange(conflict.startAt, conflict.endAt, now)}`,
          409,
          {
            reservationId: conflict.id,
            username: conflict.username,
            startAt: conflict.startAt,
            endAt: conflict.endAt,
          },
        );
      return fail('RESERVATION_CONFLICT', '该时段刚被预约，请刷新后重新选择', 409);
    }
    throw error;
  }
});
app.get('/api/projects/:projectId/reservations', async (c) => {
  const projectId = c.req.param('projectId');
  await requireMembership(c, projectId);
  const { page, limit, offset } = pagination(c),
    now = nowSeconds();
  const history = c.req.query('view') === 'history';
  if (c.req.query('view') && !['history', 'upcoming'].includes(c.req.query('view')!))
    return fail('VALIDATION_ERROR', '预约列表类型无效');
  const args: (string | number | null)[] = [projectId, now];
  let filter = history
    ? `(r.status = 'cancelled' OR r.end_at <= ?)`
    : `r.status = 'active' AND r.end_at > ?`;
  for (const [key, column, operator] of [
    ['from', 'end_at', '>'],
    ['to', 'start_at', '<'],
  ] as const) {
    const raw = c.req.query(key);
    if (raw !== undefined) {
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
        return fail('VALIDATION_ERROR', '日期范围无效');
      filter += ` AND r.${column} ${operator} ?`;
      args.push(Number(raw));
    }
  }
  const result = await stmt(
    c,
    `${reservationSelect} WHERE r.project_id = ? AND ${filter} ORDER BY r.start_at, r.id LIMIT ? OFFSET ?`,
    ...args,
    limit + 1,
    offset,
  ).all<Reservation>();
  return c.json({
    items: result.results.slice(0, limit),
    page,
    hasMore: result.results.length > limit,
    serverNow: now,
  });
});
app.post('/api/projects/:projectId/reservations/:reservationId/cancel', async (c) => {
  const projectId = c.req.param('projectId');
  await requireMembership(c, projectId);
  const reservationId = c.req.param('reservationId');
  const item = await stmt(
    c,
    'SELECT status, end_at FROM reservations WHERE id = ? AND project_id = ? AND user_id = ?',
    reservationId,
    projectId,
    c.get('auth').user.id,
  ).first<{ status: string; end_at: number }>();
  if (!item) return fail('NOT_FOUND', '预约不存在或不能取消他人的预约', 404);
  const body = await readBody(c),
    op = await mutation(c, body);
  if (op.cached) return commit(c, op, {});
  if (item.status === 'cancelled') return commit(c, op, { ok: true });
  const now = nowSeconds();
  if (item.end_at <= now) return fail('VALIDATION_ERROR', '已结束的预约不能取消');
  return commit(c, op, { ok: true }, [
    stmt(
      c,
      `UPDATE reservations SET status = 'cancelled', cancelled_at = ?, cancel_operation_id = ? WHERE id = ? AND project_id = ? AND user_id = ? AND status = 'active' AND end_at > ?`,
      now,
      op.operationId,
      reservationId,
      projectId,
      op.userId,
      now,
    ),
    guard(
      c,
      op,
      `EXISTS (SELECT 1 FROM reservations WHERE id = ? AND project_id = ? AND user_id = ? AND status = 'cancelled')`,
      reservationId,
      projectId,
      op.userId,
    ),
  ]);
});
app.get('/api/projects/:projectId/activity', async (c) => {
  const projectId = c.req.param('projectId');
  await requireMembership(c, projectId);
  const { page, limit, offset } = pagination(c);
  const result = await stmt(
    c,
    `${activitySelect} WHERE a.project_id = ? ORDER BY a.occurred_at DESC, a.rowid DESC LIMIT ? OFFSET ?`,
    projectId,
    limit + 1,
    offset,
  ).all<Activity>();
  return c.json({
    items: result.results.slice(0, limit),
    page,
    hasMore: result.results.length > limit,
  });
});
app.all('/api', (c) => c.json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404));
app.all('/api/*', (c) => c.json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  c.header('Cache-Control', 'no-store');
  if (error instanceof AppError)
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      error.status as 400,
    );
  // 禁止输出异常原文：数据库绑定值、请求、密码和令牌不进入日志。
  console.error('Unhandled application error', { path: c.req.path, name: error.name });
  return c.json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' } }, 500);
});
export default app;
