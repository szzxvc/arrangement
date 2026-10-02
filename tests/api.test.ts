import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  call,
  count,
  createRuntime,
  futureMinute,
  makeProject,
  makeUser,
  migrate,
} from './helpers';
import type { Runtime, TestUser } from './helpers';
let runtime: Runtime;
beforeAll(async () => {
  runtime = await createRuntime();
  await migrate(runtime);
});
afterAll(async () => {
  await runtime?.dispose();
});
async function team(size = 2) {
  const users: TestUser[] = [];
  for (let i = 0; i < size; i++) users.push(await makeUser(runtime));
  return { users, project: await makeProject(runtime, users) };
}
async function member(project: string, user: TestUser, id = user.id) {
  const snap = await call(runtime, `/api/projects/${project}/snapshot`, user);
  return snap.data.members.find((m: { id: string }) => m.id === id);
}
const forceBody = (m: { version: number; workSessionId: string | null }) => ({
  state: m.workSessionId ? 'resting' : 'working',
  expectedState: m.workSessionId ? 'working' : 'resting',
  expectedWorkSessionId: m.workSessionId,
  expectedVersion: m.version,
});

describe('账号、会话与安全', () => {
  it('用户名字符与长度、密码 8–128 字符边界，保留纯空格密码', async () => {
    for (const username of ['ab', 'a'.repeat(33), '不合法@名称', '名称😀测试']) {
      expect(
        (await call(runtime, '/api/auth/register', undefined, { username, password: '12345678' }))
          .status,
      ).toBe(400);
    }
    const name = `边界${randomUUID().slice(0, 8)}`;
    for (const password of ['1234567', '密'.repeat(129)])
      expect(
        (await call(runtime, '/api/auth/register', undefined, { username: name, password })).status,
      ).toBe(400);
    for (const password of [' '.repeat(8), '密'.repeat(128)]) {
      const username = `密码边界${randomUUID().slice(0, 8)}`;
      expect(
        (await call(runtime, '/api/auth/register', undefined, { username, password })).status,
      ).toBe(201);
      expect(
        (await call(runtime, '/api/auth/login', undefined, { username, password })).status,
      ).toBe(200);
    }
  });
  it('在真实 Workers runtime 执行 scrypt 参数并测量墙钟耗时', async () => {
    const result = await runtime.mf.dispatchFetch('http://club.test/__test/benchmark');
    const data = (await result.json()) as { wallMs: number[]; N: number; p: number };
    expect(data.N).toBe(16384);
    expect(data.p).toBe(5);
    expect(data.wallMs).toHaveLength(3);
    console.log('LOCAL_WORKER_SCRYPT_BENCHMARK', JSON.stringify(data));
  });
  it('注册、中文和空格密码、规范化登录、失败统一提示、安全 Cookie 与会话刷新', async () => {
    const suffix = randomUUID().slice(0, 8),
      username = ` Ａlice.${suffix} `,
      password = ' 中文 密码123 ';
    const registered = await call(runtime, '/api/auth/register', undefined, { username, password });
    expect(registered.status).toBe(201);
    expect(registered.data.user.username).toBe(`Alice.${suffix}`);
    expect(registered.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(registered.headers.get('set-cookie')).toMatch(/Secure/);
    expect(registered.headers.get('set-cookie')).toMatch(/SameSite=Lax/);
    const token = registered.headers.get('set-cookie')!.match(/club_session=([^;]+)/)![1];
    const user: TestUser = {
      ...registered.data.user,
      token,
      csrf: registered.data.csrfToken,
      ip: randomUUID(),
    };
    expect((await call(runtime, '/api/auth/me', user)).status).toBe(200);
    const wrong = await call(runtime, '/api/auth/login', undefined, {
      username,
      password: password.trim(),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.data.error.message).toBe('用户名或密码错误');
    expect(
      (await call(runtime, '/api/auth/login', undefined, { username: `alice.${suffix}`, password }))
        .status,
    ).toBe(200);
    const row = await runtime.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(user.id)
      .first<Record<string, unknown>>();
    expect(row!.password_hash).not.toBe(password);
    expect(row!.password_salt).toHaveLength(32);
    expect(row!.password_p).toBe(5);
    expect((await call(runtime, '/api/auth/logout', user, {})).status).toBe(200);
    expect((await call(runtime, '/api/auth/me', user)).status).toBe(401);
  });
  it('并发 NFKC 同名注册只有一个账号和一个对应会话', async () => {
    const suffix = randomUUID().slice(0, 8),
      username = `test.${suffix}`;
    const results = await Promise.all([
      call(runtime, '/api/auth/register', undefined, {
        username: ` TEST.${suffix} `,
        password: '12345678',
      }),
      call(runtime, '/api/auth/register', undefined, { username, password: '12345678' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.data.error.code).toBe('USERNAME_TAKEN');
    expect(
      await count(runtime, 'SELECT COUNT(*) n FROM users WHERE normalized_username = ?', username),
    ).toBe(1);
    expect(
      await count(
        runtime,
        'SELECT COUNT(*) n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.normalized_username = ?',
        username,
      ),
    ).toBe(1);
  });
  it('会话过期、未登录读写均拒绝', async () => {
    const user = await makeUser(runtime);
    await runtime.db
      .prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?')
      .bind(user.id)
      .run();
    expect((await call(runtime, '/api/auth/me', user)).status).toBe(401);
    expect((await call(runtime, '/api/projects')).status).toBe(401);
    expect(
      (
        await call(runtime, '/api/projects', undefined, {
          name: '无权项目',
          description: '不应该创建',
        })
      ).status,
    ).toBe(401);
  });
  it('跨站、缺少 Origin 或 CSRF 拒绝，私有数据禁止缓存', async () => {
    const { users, project } = await team();
    expect(
      (
        await call(runtime, `/api/projects/${project}/work/start`, users[0], {}, randomUUID(), {
          Origin: 'https://evil.test',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(runtime, `/api/projects/${project}/work/start`, users[0], {}, randomUUID(), {
          Origin: '',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(runtime, `/api/projects/${project}/work/start`, users[0], {}, randomUUID(), {
          'X-CSRF-Token': '',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(runtime, `/api/projects/${project}/work/start`, users[0], {}, randomUUID(), {
          'Sec-Fetch-Site': 'cross-site',
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(runtime, `/api/projects/${project}/snapshot`, users[0])).headers.get(
        'cache-control',
      ),
    ).toBe('no-store');
    expect(
      await count(runtime, 'SELECT COUNT(*) n FROM work_sessions WHERE project_id = ?', project),
    ).toBe(0);
  });
  it('持久限流在昂贵计算前执行，并按账号与地址分别限制', async () => {
    const name = `限流${randomUUID().slice(0, 8)}`;
    const bucket = 'account:' + createHash('sha256').update(name.toLowerCase()).digest('hex');
    await runtime.db
      .prepare('INSERT INTO auth_rate_limits VALUES (?, ?, 10)')
      .bind(bucket, Math.floor(Date.now() / 1000))
      .run();
    const result = await call(runtime, '/api/auth/register', undefined, {
      username: name,
      password: '12345678',
    });
    expect(result.status).toBe(429);
    expect(result.data.error.code).toBe('RATE_LIMITED');
    const ip = '203.0.113.7';
    await runtime.db
      .prepare('INSERT INTO auth_rate_limits VALUES (?, ?, 40)')
      .bind('ip:' + createHash('sha256').update(ip).digest('hex'), Math.floor(Date.now() / 1000))
      .run();
    const fromIp = await call(
      runtime,
      '/api/auth/login',
      undefined,
      { username: '不存在用户', password: '12345678' },
      randomUUID(),
      { 'cf-connecting-ip': ip },
    );
    expect(fromIp.status).toBe(429);
    expect(
      await count(runtime, 'SELECT COUNT(*) n FROM users WHERE normalized_username = ?', name),
    ).toBe(0);
  });
});
describe('私有项目和邀请事务', () => {
  it('创建项目及创建者成员原子、项目列表隔离、猜标识无权', async () => {
    const { users, project } = await team(1),
      outsider = await makeUser(runtime);
    expect(
      (await call(runtime, '/api/projects', users[0])).data.projects.some(
        (p: { id: string }) => p.id === project,
      ),
    ).toBe(true);
    expect((await call(runtime, '/api/projects', outsider)).data.projects).toEqual([]);
    expect((await call(runtime, `/api/projects/${project}/snapshot`, outsider)).status).toBe(404);
    expect((await call(runtime, `/api/projects/${project}/work/start`, outsider, {})).status).toBe(
      404,
    );
    expect((await call(runtime, `/api/projects/${project}/reservations`, outsider)).status).toBe(
      404,
    );
    expect(
      await count(runtime, 'SELECT COUNT(*) n FROM project_members WHERE project_id = ?', project),
    ).toBe(1);
    const requestId = randomUUID(),
      body = { name: '幂等创建', description: '只创建一次' };
    const [a, b] = await Promise.all([
      call(runtime, '/api/projects', users[0], body, requestId),
      call(runtime, '/api/projects', users[0], body, requestId),
    ]);
    expect(a.data.projectId).toBe(b.data.projectId);
  });
  it('邀请未接受不能查看，只有目标可接受，并发接受只入会一次', async () => {
    const { users, project } = await team(1),
      invitee = await makeUser(runtime),
      outsider = await makeUser(runtime);
    const invited = await call(runtime, `/api/projects/${project}/invitations`, users[0], {
      username: invitee.username,
    });
    expect(invited.status).toBe(201);
    const id = invited.data.invitationId;
    expect((await call(runtime, '/api/invitations', invitee)).data.invitations).toHaveLength(1);
    expect((await call(runtime, `/api/projects/${project}/snapshot`, invitee)).status).toBe(404);
    expect((await call(runtime, `/api/invitations/${id}/accept`, outsider, {})).status).toBe(404);
    const duplicate = await call(runtime, `/api/projects/${project}/invitations`, users[0], {
      username: invitee.username,
    });
    expect(duplicate.status).toBe(409);
    const accepted = await Promise.all(
      Array.from({ length: 6 }, () => call(runtime, `/api/invitations/${id}/accept`, invitee, {})),
    );
    expect(accepted.every((r) => r.status === 200)).toBe(true);
    expect(
      await count(
        runtime,
        'SELECT COUNT(*) n FROM project_members WHERE project_id = ? AND user_id = ?',
        project,
        invitee.id,
      ),
    ).toBe(1);
    expect((await call(runtime, `/api/projects/${project}/snapshot`, invitee)).status).toBe(200);
    expect(
      (
        await call(runtime, `/api/projects/${project}/invitations`, invitee, {
          username: outsider.username,
        })
      ).status,
    ).toBe(201);
  });
  it('拒绝与再次邀请、无用户／已成员／非法输入不会产生成员', async () => {
    const { users, project } = await team(1),
      target = await makeUser(runtime);
    const invitation = await call(runtime, `/api/projects/${project}/invitations`, users[0], {
      username: target.username,
    });
    expect(
      (await call(runtime, `/api/invitations/${invitation.data.invitationId}/reject`, target, {}))
        .status,
    ).toBe(200);
    expect(
      (await call(runtime, `/api/invitations/${invitation.data.invitationId}/accept`, target, {}))
        .data.error.code,
    ).toBe('INVITATION_NOT_PENDING');
    expect(
      (
        await call(runtime, `/api/projects/${project}/invitations`, users[0], {
          username: target.username,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(runtime, `/api/projects/${project}/invitations`, users[0], {
          username: '无此账号',
        })
      ).data.error.message,
    ).toBe('找不到该用户');
    expect(
      (
        await call(runtime, `/api/projects/${project}/invitations`, users[0], {
          username: users[0].username,
        })
      ).data.error.message,
    ).toBe('该用户已加入项目');
    expect(
      await count(runtime, 'SELECT COUNT(*) n FROM project_members WHERE project_id = ?', project),
    ).toBe(1);
  });
  it('接受与拒绝混合并发不留下半加入成员', async () => {
    const { users, project } = await team(1),
      target = await makeUser(runtime);
    const result = await call(runtime, `/api/projects/${project}/invitations`, users[0], {
      username: target.username,
    });
    const id = result.data.invitationId;
    const results = await Promise.all([
      call(runtime, `/api/invitations/${id}/accept`, target, {}),
      call(runtime, `/api/invitations/${id}/reject`, target, {}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const row = await runtime.db
      .prepare('SELECT status FROM project_invitations WHERE id = ?')
      .bind(id)
      .first<{ status: string }>();
    expect(
      await count(
        runtime,
        'SELECT COUNT(*) n FROM project_members WHERE project_id = ? AND user_id = ?',
        project,
        target.id,
      ),
    ).toBe(row!.status === 'accepted' ? 1 : 0);
  });
});
describe('单人干活、强制修改与幂等', () => {
  it('实际时间由服务端生成，活动历史分页', async () => {
    const { users, project } = await team(1),
      before = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 11; i++) {
      const start = await call(runtime, `/api/projects/${project}/work/start`, users[0], {
        startedAt: 1,
      });
      expect(
        (
          await call(runtime, `/api/projects/${project}/work/stop`, users[0], {
            workSessionId: start.data.workSessionId,
            endedAt: 1,
          })
        ).status,
      ).toBe(200);
    }
    const rows = await runtime.db
      .prepare('SELECT started_at, ended_at FROM work_sessions WHERE project_id = ?')
      .bind(project)
      .all();
    expect(
      rows.results.every(
        (row) => Number(row.started_at) >= before && Number(row.ended_at) >= before,
      ),
    ).toBe(true);
    const a = await call(runtime, `/api/projects/${project}/activity`, users[0]),
      b = await call(runtime, `/api/projects/${project}/activity?page=2`, users[0]);
    expect(a.data.items).toHaveLength(20);
    expect(a.data.hasMore).toBe(true);
    expect(b.data.items).toHaveLength(2);
    expect(b.data.hasMore).toBe(false);
  });
  it('20 名成员同时开始只有一人；直接查询数据库验证约束与审计', async () => {
    const { users, project } = await team(20);
    const results = await Promise.all(
      users.map((u) => call(runtime, `/api/projects/${project}/work/start`, u, {})),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 409 && r.data.error.code === 'PROJECT_BUSY'),
    ).toHaveLength(19);
    expect(
      await count(
        runtime,
        'SELECT COUNT(*) n FROM work_sessions WHERE project_id = ? AND ended_at IS NULL',
        project,
      ),
    ).toBe(1);
    expect(
      await count(runtime, 'SELECT COUNT(*) n FROM audit_events WHERE project_id = ?', project),
    ).toBe(1);
    expect(
      await count(
        runtime,
        'SELECT COUNT(*) n FROM mutation_requests WHERE user_id IN (SELECT user_id FROM project_members WHERE project_id = ?)',
        project,
      ),
    ).toBe(2); // 创建+成功开始
  });
  it('不同项目独立；本人重复开始返回原工作记录', async () => {
    const { users, project } = await team(1),
      otherProject = await makeProject(runtime, users);
    const results = await Promise.all([
      call(runtime, `/api/projects/${project}/work/start`, users[0], {}),
      call(runtime, `/api/projects/${otherProject}/work/start`, users[0], {}),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const repeat = await call(runtime, `/api/projects/${project}/work/start`, users[0], {});
    expect(repeat.data.workSessionId).toBe(results[0].data.workSessionId);
    expect(
      await count(runtime, 'SELECT COUNT(*) n FROM work_sessions WHERE project_id = ?', project),
    ).toBe(1);
  });
  it('丢失响应后开始／结束重复同标识只执行一次，不同参数拒绝', async () => {
    const { users, project } = await team(1),
      requestId = randomUUID();
    const results = await Promise.all([
      call(runtime, `/api/projects/${project}/work/start`, users[0], {}, requestId),
      call(runtime, `/api/projects/${project}/work/start`, users[0], {}, requestId),
    ]);
    expect(results[0].data).toEqual(results[1].data);
    const id = results[0].data.workSessionId,
      stopId = randomUUID();
    const stops = await Promise.all([
      call(runtime, `/api/projects/${project}/work/stop`, users[0], { workSessionId: id }, stopId),
      call(runtime, `/api/projects/${project}/work/stop`, users[0], { workSessionId: id }, stopId),
    ]);
    expect(stops.every((r) => r.status === 200)).toBe(true);
    expect(
      (await call(runtime, `/api/projects/${project}/work/start`, users[0], {}, requestId)).data,
    ).toEqual(results[0].data);
    expect(
      (
        await call(
          runtime,
          `/api/projects/${project}/work/start`,
          users[0],
          { different: true },
          requestId,
        )
      ).data.error.code,
    ).toBe('IDEMPOTENCY_MISMATCH');
    expect(
      await count(runtime, 'SELECT COUNT(*) n FROM audit_events WHERE project_id = ?', project),
    ).toBe(2);
  });
  it('普通结束不能结束他人；旧记录不能结束新一轮且不留假审计', async () => {
    const { users, project } = await team(),
      start = await call(runtime, `/api/projects/${project}/work/start`, users[0], {});
    expect(
      (
        await call(runtime, `/api/projects/${project}/work/stop`, users[1], {
          workSessionId: start.data.workSessionId,
        })
      ).data.error.code,
    ).toBe('STATE_CHANGED');
    await call(runtime, `/api/projects/${project}/work/stop`, users[0], {
      workSessionId: start.data.workSessionId,
    });
    const next = await call(runtime, `/api/projects/${project}/work/start`, users[0], {});
    expect(
      (
        await call(runtime, `/api/projects/${project}/work/stop`, users[0], {
          workSessionId: start.data.workSessionId,
        })
      ).status,
    ).toBe(409);
    expect((await member(project, users[0])).workSessionId).toBe(next.data.workSessionId);
    expect(
      await count(runtime, 'SELECT COUNT(*) n FROM audit_events WHERE project_id = ?', project),
    ).toBe(3);
  });
  it('普通成员强制开始与结束，记录真实操作人，重试不重复审计', async () => {
    const { users, project } = await team(),
      m = await member(project, users[1], users[0].id),
      requestId = randomUUID(),
      body = forceBody(m);
    const started = await call(
      runtime,
      `/api/projects/${project}/members/${users[0].id}/work-state`,
      users[1],
      body,
      requestId,
    );
    expect(started.status).toBe(200);
    expect(
      (
        await call(
          runtime,
          `/api/projects/${project}/members/${users[0].id}/work-state`,
          users[1],
          body,
          requestId,
        )
      ).data,
    ).toEqual(started.data);
    const current = await member(project, users[1], users[0].id);
    expect(
      (
        await call(
          runtime,
          `/api/projects/${project}/members/${users[0].id}/work-state`,
          users[1],
          forceBody(current),
        )
      ).status,
    ).toBe(200);
    const rows = await runtime.db
      .prepare('SELECT actor_id, target_id, reason FROM audit_events WHERE project_id = ?')
      .bind(project)
      .all();
    expect(rows.results).toHaveLength(2);
    expect(
      rows.results.every(
        (r) => r.actor_id === users[1].id && r.target_id === users[0].id && r.reason === 'forced',
      ),
    ).toBe(true);
  });
  it('占用时强制开始拒绝，不抢占；旧确认与状态来回变化也拒绝', async () => {
    const { users, project } = await team(),
      stale = await member(project, users[1], users[0].id);
    const start = await call(runtime, `/api/projects/${project}/work/start`, users[0], {});
    const other = await member(project, users[0], users[1].id);
    expect(
      (
        await call(
          runtime,
          `/api/projects/${project}/members/${users[1].id}/work-state`,
          users[0],
          forceBody(other),
        )
      ).data.error.code,
    ).toBe('PROJECT_BUSY');
    expect(
      (
        await call(
          runtime,
          `/api/projects/${project}/members/${users[0].id}/work-state`,
          users[1],
          forceBody(stale),
        )
      ).data.error.code,
    ).toBe('STATE_CHANGED');
    await call(runtime, `/api/projects/${project}/work/stop`, users[0], {
      workSessionId: start.data.workSessionId,
    });
    expect(
      (
        await call(
          runtime,
          `/api/projects/${project}/members/${users[0].id}/work-state`,
          users[1],
          forceBody(stale),
        )
      ).data.error.code,
    ).toBe('STATE_CHANGED');
    expect(
      await count(runtime, 'SELECT COUNT(*) n FROM audit_events WHERE project_id = ?', project),
    ).toBe(2);
  });
  it('普通与强制混合并发不突破互斥，双重结束只审计一次', async () => {
    const { users, project } = await team(3),
      target = await member(project, users[2], users[1].id);
    const results = await Promise.all([
      call(runtime, `/api/projects/${project}/work/start`, users[0], {}),
      call(
        runtime,
        `/api/projects/${project}/members/${users[1].id}/work-state`,
        users[2],
        forceBody(target),
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const snap = await call(runtime, `/api/projects/${project}/snapshot`, users[2]),
      active = snap.data.members.find((m: { workSessionId: string | null }) => m.workSessionId);
    const owner = users.find((u) => u.id === active.id)!;
    const stopped = await Promise.all([
      call(runtime, `/api/projects/${project}/work/stop`, owner, {
        workSessionId: active.workSessionId,
      }),
      call(
        runtime,
        `/api/projects/${project}/members/${owner.id}/work-state`,
        users[2],
        forceBody(active),
      ),
    ]);
    expect(stopped.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await count(
        runtime,
        'SELECT COUNT(*) n FROM work_sessions WHERE project_id = ? AND ended_at IS NULL',
        project,
      ),
    ).toBe(0);
    expect(
      await count(runtime, 'SELECT COUNT(*) n FROM audit_events WHERE project_id = ?', project),
    ).toBe(2);
  });
});
describe('预约重叠、边界、取消与数据库保护', () => {
  it('完全相同、左交叠、右交叠、包含、被包含和自己的预约全部拒绝', async () => {
    const { users, project } = await team(),
      s = futureMinute();
    expect(
      (
        await call(runtime, `/api/projects/${project}/reservations`, users[0], {
          startAt: s,
          endAt: s + 600,
        })
      ).status,
    ).toBe(201);
    for (const [a, b] of [
      [s, s + 600],
      [s - 60, s + 60],
      [s + 540, s + 660],
      [s - 60, s + 660],
      [s + 60, s + 120],
    ]) {
      const result = await call(runtime, `/api/projects/${project}/reservations`, users[1], {
        startAt: a,
        endAt: b,
      });
      expect(result.status).toBe(409);
      expect(result.data.error.code).toBe('RESERVATION_CONFLICT');
      expect(result.data.error.details.username).toBe(users[0].username);
    }
    expect(
      (
        await call(runtime, `/api/projects/${project}/reservations`, users[0], {
          startAt: s,
          endAt: s + 60,
        })
      ).status,
    ).toBe(409);
    expect(
      await count(runtime, 'SELECT COUNT(*) n FROM reservations WHERE project_id = ?', project),
    ).toBe(1);
  });
  it('首尾相接允许，零长、反向、过去、非整分钟及无效数字拒绝', async () => {
    const { users, project } = await team(1),
      s = futureMinute();
    for (const body of [
      { startAt: s, endAt: s },
      { startAt: s, endAt: s - 60 },
      { startAt: s - 3600, endAt: s },
      { startAt: s + 1, endAt: s + 60 },
      { startAt: '2026-10-03', endAt: s },
      { startAt: s, endAt: s + 61 },
    ])
      expect(
        (await call(runtime, `/api/projects/${project}/reservations`, users[0], body)).status,
      ).toBe(400);
    expect(
      (
        await call(runtime, `/api/projects/${project}/reservations`, users[0], {
          startAt: s,
          endAt: s + 60,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(runtime, `/api/projects/${project}/reservations`, users[0], {
          startAt: s + 60,
          endAt: s + 120,
        })
      ).status,
    ).toBe(201);
  });
  it('20 名成员同时预约只有一个成功，SQL 查询无重叠', async () => {
    const { users, project } = await team(20),
      s = futureMinute();
    const results = await Promise.all(
      users.map((u) =>
        call(runtime, `/api/projects/${project}/reservations`, u, { startAt: s, endAt: s + 600 }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    expect(
      await count(
        runtime,
        `SELECT COUNT(*) n FROM reservations a JOIN reservations b ON a.project_id = b.project_id AND a.id < b.id WHERE a.project_id = ? AND a.status = 'active' AND b.status = 'active' AND a.start_at < b.end_at AND a.end_at > b.start_at`,
        project,
      ),
    ).toBe(0);
  });
  it('重复预约同标识只建一条；他人无权取消，取消后重新预约', async () => {
    const { users, project } = await team(),
      outsider = await makeUser(runtime),
      s = futureMinute(),
      req = randomUUID(),
      body = { startAt: s, endAt: s + 120 };
    const responses = await Promise.all([
      call(runtime, `/api/projects/${project}/reservations`, users[0], body, req),
      call(runtime, `/api/projects/${project}/reservations`, users[0], body, req),
    ]);
    expect(responses[0].data.reservationId).toBe(responses[1].data.reservationId);
    const id = responses[0].data.reservationId;
    expect(
      (await call(runtime, `/api/projects/${project}/reservations/${id}/cancel`, users[1], {}))
        .status,
    ).toBe(404);
    expect(
      (await call(runtime, `/api/projects/${project}/reservations/${id}/cancel`, outsider, {}))
        .status,
    ).toBe(404);
    expect(
      (await call(runtime, `/api/projects/nonexistent/reservations/${id}/cancel`, users[0], {}))
        .status,
    ).toBe(404);
    const cancelReq = randomUUID();
    expect(
      (
        await call(
          runtime,
          `/api/projects/${project}/reservations/${id}/cancel`,
          users[0],
          {},
          cancelReq,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          runtime,
          `/api/projects/${project}/reservations/${id}/cancel`,
          users[0],
          {},
          cancelReq,
        )
      ).status,
    ).toBe(200);
    expect(
      (await call(runtime, `/api/projects/${project}/reservations`, users[1], body)).status,
    ).toBe(201);
    const history = await call(
      runtime,
      `/api/projects/${project}/reservations?view=history`,
      users[0],
    );
    expect(history.data.items[0].status).toBe('cancelled');
  });
  it('取消与创建同时执行，结果符合数据库提交顺序', async () => {
    const { users, project } = await team(),
      s = futureMinute(),
      body = { startAt: s, endAt: s + 600 };
    const booked = await call(runtime, `/api/projects/${project}/reservations`, users[0], body);
    const results = await Promise.all([
      call(
        runtime,
        `/api/projects/${project}/reservations/${booked.data.reservationId}/cancel`,
        users[0],
        {},
      ),
      call(runtime, `/api/projects/${project}/reservations`, users[1], body),
    ]);
    expect(results[0].status).toBe(200);
    expect([201, 409]).toContain(results[1].status);
    const active = await count(
      runtime,
      `SELECT COUNT(*) n FROM reservations WHERE project_id = ? AND status = 'active'`,
      project,
    );
    expect(active).toBe(results[1].status === 201 ? 1 : 0);
  });
  it('数据库更新触发器保护时间、状态与项目变更，失败不改变原数据', async () => {
    const { users, project } = await team(1),
      s = futureMinute();
    const first = await call(runtime, `/api/projects/${project}/reservations`, users[0], {
      startAt: s,
      endAt: s + 600,
    });
    const second = await call(runtime, `/api/projects/${project}/reservations`, users[0], {
      startAt: s + 600,
      endAt: s + 1200,
    });
    await expect(
      runtime.db
        .prepare('UPDATE reservations SET start_at = ? WHERE id = ?')
        .bind(s + 60, second.data.reservationId)
        .run(),
    ).rejects.toThrow('RESERVATION_CONFLICT');
    await call(
      runtime,
      `/api/projects/${project}/reservations/${first.data.reservationId}/cancel`,
      users[0],
      {},
    );
    await runtime.db
      .prepare('UPDATE reservations SET start_at = ?, end_at = ? WHERE id = ?')
      .bind(s + 60, s + 660, first.data.reservationId)
      .run();
    await expect(
      runtime.db
        .prepare(
          "UPDATE reservations SET status = 'active', cancelled_at = NULL, cancel_operation_id = NULL WHERE id = ?",
        )
        .bind(first.data.reservationId)
        .run(),
    ).rejects.toThrow('RESERVATION_CONFLICT');
    const otherProject = await makeProject(runtime, users);
    const other = await call(runtime, `/api/projects/${otherProject}/reservations`, users[0], {
      startAt: s + 600,
      endAt: s + 1200,
    });
    await expect(
      runtime.db
        .prepare('UPDATE reservations SET project_id = ? WHERE id = ?')
        .bind(project, other.data.reservationId)
        .run(),
    ).rejects.toThrow('RESERVATION_CONFLICT');
    await expect(
      runtime.db
        .prepare('UPDATE reservations SET end_at = start_at WHERE id = ?')
        .bind(second.data.reservationId)
        .run(),
    ).rejects.toThrow();
  });
  it('预约、取消及到期不改变工作；当前预约别人的时段也可手动开始', async () => {
    const { users, project } = await team(),
      now = Math.floor(Date.now() / 1000),
      s = Math.floor(now / 60) * 60;
    const id = randomUUID();
    await runtime.db
      .prepare(
        'INSERT INTO reservations (id, project_id, user_id, start_at, end_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(id, project, users[1].id, s, s + 600, now)
      .run();
    const start = await call(runtime, `/api/projects/${project}/work/start`, users[0], {});
    expect(start.status).toBe(200);
    await call(runtime, `/api/projects/${project}/reservations/${id}/cancel`, users[1], {});
    expect((await member(project, users[0])).workSessionId).toBe(start.data.workSessionId);
    await runtime.db
      .prepare(
        'INSERT INTO reservations (id, project_id, user_id, start_at, end_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(randomUUID(), project, users[0].id, s - 120, s - 60, now - 120)
      .run();
    expect((await member(project, users[0])).workSessionId).toBe(start.data.workSessionId);
    expect(
      (await call(runtime, `/api/projects/${project}/reservations?view=history`, users[0])).data
        .items,
    ).toHaveLength(2);
  });
  it('未来／历史分页及范围查询', async () => {
    const { users, project } = await team(1),
      s = futureMinute();
    await runtime.db.batch(
      Array.from({ length: 25 }, (_, i) =>
        runtime.db
          .prepare(
            'INSERT INTO reservations (id, project_id, user_id, start_at, end_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .bind(randomUUID(), project, users[0].id, s + i * 60, s + (i + 1) * 60, s - 600),
      ),
    );
    const first = await call(runtime, `/api/projects/${project}/reservations`, users[0]),
      second = await call(runtime, `/api/projects/${project}/reservations?page=2`, users[0]);
    expect(first.data.items).toHaveLength(20);
    expect(first.data.hasMore).toBe(true);
    expect(second.data.items).toHaveLength(5);
    expect(second.data.hasMore).toBe(false);
    expect(
      (
        await call(
          runtime,
          `/api/projects/${project}/reservations?from=${s + 60}&to=${s + 120}`,
          users[0],
        )
      ).data.items,
    ).toHaveLength(1);
    expect(
      (await call(runtime, `/api/projects/${project}/reservations?page=0`, users[0])).status,
    ).toBe(400);
  });
});
describe('数据库事务与持久化', () => {
  it('主操作或后续操作失败回滚整个 D1 batch', async () => {
    const user = await makeUser(runtime),
      id = randomUUID();
    await expect(
      runtime.db.batch([
        runtime.db
          .prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)')
          .bind(id, '回滚项目', '不应持久化', user.id, futureMinute()),
        runtime.db
          .prepare('INSERT INTO project_members (project_id, user_id, joined_at) VALUES (?, ?, ?)')
          .bind(id, '不存在的用户', futureMinute()),
      ]),
    ).rejects.toThrow();
    expect(await count(runtime, 'SELECT COUNT(*) n FROM projects WHERE id = ?', id)).toBe(0);
  });
  it('重启 Worker 后账号、成员、预约、工作状态和登录都持久', async () => {
    const persistent = await createRuntime();
    await migrate(persistent);
    const user = await makeUser(persistent),
      project = await makeProject(persistent, [user]),
      s = futureMinute();
    const start = await call(persistent, `/api/projects/${project}/work/start`, user, {});
    await call(persistent, `/api/projects/${project}/reservations`, user, {
      startAt: s,
      endAt: s + 120,
    });
    const directory = persistent.directory;
    await persistent.dispose(false);
    const restarted = await createRuntime(directory);
    try {
      const snapshot = await call(restarted, `/api/projects/${project}/snapshot`, user);
      expect(snapshot.status).toBe(200);
      expect(snapshot.data.members[0].workSessionId).toBe(start.data.workSessionId);
      expect(snapshot.data.reservations).toHaveLength(1);
      expect((await call(restarted, '/api/auth/me', user)).data.user.id).toBe(user.id);
    } finally {
      await restarted.dispose();
    }
  });
  it('未知接口返回 JSON，页面深链交给 Static Assets', async () => {
    const user = await makeUser(runtime);
    const result = await call(runtime, '/api/unknown', user);
    expect(result.status).toBe(404);
    expect(result.headers.get('content-type')).toContain('application/json');
    const page = await runtime.mf.dispatchFetch('http://club.test/projects/deep-link');
    expect(page.headers.get('content-type')).toContain('text/html');
  });
});
