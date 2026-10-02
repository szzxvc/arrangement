import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Snapshot } from '../../shared/types';
async function register(page: Page, username: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill('测试密码 123456');
  await page.getByRole('button', { name: '注册并登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();
}
async function createProject(
  page: Page,
  name = '社团展准备',
  description = '一起准备展台、制作海报、完成作品。',
) {
  await page.getByRole('button', { name: '＋ 新建项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill(name);
  await page.getByLabel('项目描述', { exact: true }).fill(description);
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
  return new URL(page.url()).pathname;
}
async function invite(page: Page, username: string) {
  await page.getByRole('button', { name: '＋ 邀请成员', exact: true }).click();
  await page.getByLabel('对方的用户名').fill(username);
  await page.getByRole('button', { name: '发送邀请', exact: true }).click();
  await expect(page.getByText('邀请已发送，对方接受后即可加入。')).toBeVisible();
}
async function fillTime(
  page: Page,
  which: '开始' | '结束',
  date: string,
  hour: string,
  minute: string,
) {
  const group = page.getByRole('group', { name: `${which}时间 北京时间 · 24 小时制` });
  await group.getByLabel('日期', { exact: true }).fill(date);
  await page.getByLabel(`${which}时间小时`, { exact: true }).selectOption(hour);
  await page.getByLabel(`${which}时间分钟`, { exact: true }).selectOption(minute);
}
async function noOverflow(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
}
async function newUser(browser: Browser, prefix: string, timezoneId?: string) {
  const context = await browser.newContext({ baseURL: 'http://localhost:8790', timezoneId });
  const page = await context.newPage();
  const username = `${prefix}${randomUUID().slice(0, 8)}`;
  await register(page, username);
  return { context, page, username };
}

test('多用户完整流程：邀请隔离、互斥、取消确认、普通成员强制操作与跨日预约', async ({
  browser,
}) => {
  const creator = await newUser(browser, '创建者'),
    member = await newUser(browser, '普通成员'),
    outsider = await newUser(browser, '未加入成员');
  try {
    const path = await createProject(
      creator.page,
      '秋季社团展准备',
      '这是只有已加入成员可以访问的协作项目。',
    );
    await member.page.goto(path);
    await expect(member.page.getByRole('heading', { name: '暂时无法访问这个项目' })).toBeVisible();
    await invite(creator.page, member.username);
    await member.page.goto('/');
    await expect(member.page.getByText(`${creator.username} 邀请你加入`)).toBeVisible();
    await expect(member.page.getByRole('link', { name: /进入项目/ })).toHaveCount(0);
    await member.page.getByRole('button', { name: '接受邀请', exact: true }).click();
    await member.page.getByRole('link', { name: /进入项目/ }).click();
    await creator.page.reload();
    await expect(creator.page.getByText(member.username, { exact: true })).toBeVisible();
    await creator.page.getByRole('button', { name: '▶ 开始干活', exact: true }).click();
    await expect(creator.page.getByRole('button', { name: '■ 结束干活' })).toBeVisible();
    await member.page.getByRole('button', { name: '▶ 开始干活', exact: true }).click();
    await expect(member.page.getByText(`${creator.username} 干活中，请勿同时工作`)).toBeVisible();
    let changes = 0;
    member.page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/work-state')) changes++;
    });
    await member.page.getByRole('button', { name: `修改${creator.username}的工作状态` }).click();
    await member.page.getByRole('button', { name: '取消', exact: true }).click();
    expect(changes).toBe(0);
    await member.page.getByRole('button', { name: `修改${creator.username}的工作状态` }).click();
    await member.page.getByRole('button', { name: '确认修改' }).click();
    await expect(member.page.getByText('成员工作状态已更新。')).toBeVisible();
    await expect(member.page.getByRole('heading', { name: '当前无人干活' })).toBeVisible();
    await member.page.getByRole('button', { name: `修改${creator.username}的工作状态` }).click();
    await member.page.getByRole('button', { name: '确认修改' }).click();
    await expect(
      member.page.getByRole('heading', { name: `${creator.username} 正在干活` }),
    ).toBeVisible();
    await member.page.getByRole('button', { name: '操作记录' }).click();
    await expect(member.page.getByText('强制操作', { exact: true })).toHaveCount(2);
    await invite(member.page, outsider.username);
    await member.page.getByRole('button', { name: '◷ 预约干活', exact: true }).click();
    await fillTime(member.page, '开始', '2030-12-31', '23', '59');
    await fillTime(member.page, '结束', '2031-01-01', '00', '01');
    await expect(member.page.getByRole('button', { name: '确认预约', exact: true })).toBeEnabled();
    await member.page.getByRole('button', { name: '确认预约', exact: true }).click();
    await expect(
      member.page.getByText('2030-12-31 23:59–2031-01-01 00:01', { exact: true }),
    ).toBeVisible();
    await creator.page.reload();
    await creator.page.getByRole('button', { name: '◷ 预约干活', exact: true }).click();
    await fillTime(creator.page, '开始', '2030-12-31', '23', '59');
    await fillTime(creator.page, '结束', '2031-01-01', '00', '01');
    await expect(
      creator.page.getByText(new RegExp(`该时段已被 ${member.username} 预约`)),
    ).toBeVisible();
    await expect(
      creator.page.getByRole('button', { name: '确认预约', exact: true }),
    ).toBeDisabled();
    await creator.page.keyboard.press('Escape');
    await member.page.getByRole('button', { name: /^取消预约 2030/ }).click();
    await member.page.getByRole('button', { name: '确认取消预约', exact: true }).click();
    await expect(member.page.getByText('预约已取消，时段已释放。')).toBeVisible();
    await expect(
      member.page.getByRole('heading', { name: `${creator.username} 正在干活` }),
    ).toBeVisible();
    await member.page.getByRole('button', { name: '历史与已取消' }).click();
    await expect(member.page.getByText('已取消', { exact: true })).toBeVisible();
    await creator.page.getByRole('button', { name: '■ 结束干活', exact: true }).click();
    await expect(creator.page.getByRole('heading', { name: '当前无人干活' })).toBeVisible();
    await creator.page.screenshot({ path: 'test-results/desktop-flow.png', fullPage: true });
    await creator.page.setViewportSize({ width: 390, height: 900 });
    await creator.page.screenshot({ path: 'test-results/mobile-project.png', fullPage: true });
  } finally {
    await creator.context.close();
    await member.context.close();
    await outsider.context.close();
  }
});

for (const width of [360, 390, 768, 1440])
  test(`${width}px：长文本、手机预约、键盘取消和深链刷新`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const username = `社团成员${randomUUID().slice(0, 8)}很长的中文用户名称测试`;
    await register(page, username);
    await noOverflow(page, width);
    const name = '这是一个比较长的社团项目名称'.repeat(5).slice(0, 80),
      description = '工作说明与协作安排'.repeat(220).slice(0, 2000);
    const path = await createProject(page, name, description);
    await page.reload();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await page.getByText('项目描述', { exact: true }).click();
    await expect(page.getByText(description, { exact: true })).toBeVisible();
    await noOverflow(page, width);
    await page.getByRole('button', { name: '＋ 邀请成员', exact: true }).click();
    await page.getByLabel('对方的用户名').fill('不存在的测试成员');
    await page.getByRole('button', { name: '发送邀请', exact: true }).click();
    await expect(page.getByText('找不到该用户', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '▶ 开始干活', exact: true }).click();
    await expect(page.getByRole('button', { name: '■ 结束干活', exact: true })).toBeVisible();
    const open = page.getByRole('button', { name: '◷ 预约干活', exact: true });
    await open.click();
    await expect(page.getByRole('dialog', { name: '预约干活', exact: true })).toBeVisible();
    await noOverflow(page, width);
    const dialog = page.getByRole('dialog');
    expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(open).toBeFocused();
    await open.click();
    await fillTime(page, '开始', '2030-10-03', '14', '30');
    await fillTime(page, '结束', '2030-10-03', '15', '30');
    await expect(page.getByRole('button', { name: '确认预约', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '确认预约', exact: true }).click();
    await expect(page.getByText('预约已创建。')).toBeVisible();
    await noOverflow(page, width);
    await page.getByRole('button', { name: /^取消预约/ }).click();
    await page.getByRole('button', { name: '确认取消预约', exact: true }).click();
    await page.getByRole('button', { name: '■ 结束干活', exact: true }).click();
    await expect(page.getByRole('heading', { name: '当前无人干活' })).toBeVisible();
    if (width === 390)
      await page.screenshot({ path: 'test-results/mobile-flow.png', fullPage: true });
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill('测试密码 123456');
    await page.getByRole('button', { name: '登录，进入我的项目', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(path));
  });

test('异地浏览器仍按北京时间预约；用户文本按普通文本显示；未知 API JSON', async ({ browser }) => {
  const user = await newUser(browser, '时区成员', 'America/Los_Angeles');
  let dialogs = 0;
  user.page.on('dialog', (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });
  try {
    const malicious = '<img src=x onerror=alert(1)>';
    const path = await createProject(user.page, malicious, '<script>alert(2)</script>');
    await expect(user.page.getByRole('heading', { name: malicious, exact: true })).toBeVisible();
    expect(dialogs).toBe(0);
    expect(await user.page.locator('img').count()).toBe(0);
    await user.page.getByRole('button', { name: '◷ 预约干活', exact: true }).click();
    await fillTime(user.page, '开始', '2030-01-01', '00', '00');
    await fillTime(user.page, '结束', '2030-01-01', '00', '01');
    await expect(user.page.getByRole('button', { name: '确认预约', exact: true })).toBeEnabled();
    await user.page.getByRole('button', { name: '确认预约', exact: true }).click();
    await expect(user.page.getByText('预约已创建。')).toBeVisible();
    const snapshot = (await user.page.evaluate(
      async (path) => (await fetch(`/api${path}/snapshot`)).json(),
      path,
    )) as Snapshot;
    expect(snapshot.reservations[0].startAt).toBe(Date.parse('2030-01-01T00:00:00+08:00') / 1000);
    const unknown = await user.page.evaluate(async () => {
      const r = await fetch('/api/no-such-route');
      return { status: r.status, type: r.headers.get('content-type') };
    });
    expect(unknown.status).toBe(404);
    expect(unknown.type).toContain('application/json');
  } finally {
    await user.context.close();
  }
});

test('提交后丢失响应自动复用请求标识，离线提示及联网同步', async ({ page, context }) => {
  await register(page, `重试成员${randomUUID().slice(0, 8)}`);
  const path = await createProject(page);
  let first = true;
  const ids: string[] = [];
  await page.route(`**/api${path}/work/start`, async (route) => {
    ids.push(route.request().headers()['x-request-id']);
    if (first) {
      first = false;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: '▶ 开始干活', exact: true }).click();
  await expect(page.getByRole('button', { name: '■ 结束干活', exact: true })).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  await page.getByRole('button', { name: '操作记录' }).click();
  await expect(page.locator('.activity-list li')).toHaveCount(1);
  await context.setOffline(true);
  await page.getByRole('button', { name: '■ 结束干活', exact: true }).click();
  await expect(page.getByText(/网络连接中断/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '■ 结束干活', exact: true })).toBeVisible();
  await expect(page.getByText(/暂时无法同步/).first()).toBeVisible({ timeout: 10000 });
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText(/暂时无法同步/)).toHaveCount(0);
  await page.getByRole('button', { name: '■ 结束干活', exact: true }).click();
  await expect(page.getByRole('heading', { name: '当前无人干活' })).toBeVisible();
});

test('隐藏时暂停轮询、恢复后立即同步，旧快照不覆盖操作结果', async ({ page }) => {
  await register(page, `同步成员${randomUUID().slice(0, 8)}`);
  const path = await createProject(page);
  let requests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/snapshot')) requests++;
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenRequests = requests;
  await page.waitForTimeout(5500);
  expect(requests).toBe(hiddenRequests);
  await page.evaluate(() => {
    delete (document as unknown as Record<string, unknown>).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => requests).toBeGreaterThan(hiddenRequests);
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    captured = new Promise<void>((resolve) => {
      ready = resolve;
    });
  let first = true;
  await page.route(`**/api${path}/snapshot`, async (route) => {
    if (!first) {
      await route.continue();
      return;
    }
    first = false;
    const response = await route.fetch();
    ready();
    await held;
    try {
      await route.fulfill({ response });
    } catch {
      /* 旧请求已被前端中止。 */
    }
  });
  await captured;
  await page.getByRole('button', { name: '▶ 开始干活', exact: true }).click();
  await expect(page.getByRole('button', { name: '■ 结束干活', exact: true })).toBeVisible();
  release();
  await page.waitForTimeout(300);
  await expect(page.getByRole('button', { name: '■ 结束干活', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '■ 结束干活', exact: true }).click();
  await expect(page.getByRole('heading', { name: '当前无人干活' })).toBeVisible();
});
