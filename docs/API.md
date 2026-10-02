# 接口说明

路径全部同源，响应为 JSON。成功响应直接返回数据。错误格式：

```json
{
  "error": {
    "code": "PROJECT_BUSY",
    "message": "张三 干活中，请勿同时工作",
    "details": { "activeUserId": "uuid", "activeUsername": "张三" }
  }
}
```

## 认证与请求头

注册、登录必填 `username` 与 `password`，提交 JSON，并发送与站点完全匹配的 `Origin`。浏览器通过同源 `fetch` 自动发送 Origin。

认证成功设置 `club_session` Cookie 并返回 `{ user: { id, username }, csrfToken, serverNow }`。客户端获取 `/api/auth/me` 恢复会话及 CSRF 令牌。Cookie 由浏览器管理，不能放进 localStorage。

已登录 POST 需这些请求头：

```text
Content-Type: application/json
Origin: https://你的站点
X-CSRF-Token: 当前会话返回的防护令牌
X-Request-ID: 本次业务变更的唯一标识
```

业务变更请求标识需为 16–128 个字符，可用英文、数字、下划线或连字符，推荐 UUID。空请求体也发送 `{}`。同一次操作网络重试必须复用标识和参数；更改参数或新操作使用新标识。

注册／登录／退出不使用业务幂等结果缓存。注册响应未确认时可使用原用户名和密码登录核实；重复注册不会创建第二个同名账号。退出后原会话立刻无效。

时间全部为 **UTC 整数秒**，`startAt`、`endAt` 还需为 60 的整数倍。客户端输入固定北京时间，并显式转换，不发送无偏移日期字符串。

## 路由

| 方法与路径 | JSON 请求体／查询 | 返回数据 |
| --- | --- | --- |
| `POST /api/auth/register` | `{ username, password }` | 用户、CSRF、服务端时间；201 |
| `POST /api/auth/login` | `{ username, password }` | 用户、CSRF、服务端时间 |
| `GET /api/auth/me` | 无 | 用户、CSRF、服务端时间 |
| `POST /api/auth/logout` | `{}` | `{ ok: true }` |
| `GET /api/projects` | 无 | `{ projects: Project[] }`，仅本人项目 |
| `POST /api/projects` | `{ name, description }` | `{ projectId }`；201 |
| `GET /api/projects/:p/snapshot` | 无 | 项目、成员、活动工作、预约、审计与服务端时间 |
| `POST /api/projects/:p/invitations` | `{ username }` | `{ invitationId }`；201 |
| `GET /api/invitations` | 无 | `{ invitations: Invitation[] }`，仅本人 pending |
| `POST /api/invitations/:i/accept` | `{}` | `{ ok: true, projectId }` |
| `POST /api/invitations/:i/reject` | `{}` | `{ ok: true, projectId }` |
| `POST /api/projects/:p/work/start` | `{}` | `{ workSessionId, state: "working" }` |
| `POST /api/projects/:p/work/stop` | `{ workSessionId }` | `{ workSessionId, state: "resting" }` |
| `POST /api/projects/:p/members/:u/work-state` | 明确状态和期望记录，见下文 | 工作记录与目标状态 |
| `GET /api/projects/:p/reservations` | `view=upcoming\|history&page=1&from=秒&to=秒` | `{ items, page, hasMore, serverNow }` |
| `POST /api/projects/:p/reservations` | `{ startAt, endAt }` | `{ reservationId }`；201 |
| `POST /api/projects/:p/reservations/:r/cancel` | `{}` | `{ ok: true }`，只允许本人 |
| `GET /api/projects/:p/activity` | `page=1` | `{ items, page, hasMore }` |

分页固定每页 20 项。`view` 默认 `upcoming`，当前与未来 active 按开始升序；history 包括已结束和已取消。`from`／`to` 为可选范围，筛选与 `[from, to)` 相交的预约。快照预约首屏最多 20 项，并提供 `reservationsHasMore`。

快照成员：

```json
{
  "id": "成员 uuid",
  "username": "张三",
  "joinedAt": 1790938800,
  "version": 4,
  "workSessionId": null,
  "startedAt": null
}
```

`workSessionId === null` 为休息中，否则为干活中。`version` 随每次真实工作状态变化增加，确认弹窗必须保存打开时的版本。

## 强制状态请求

休息 → 干活：

```json
{
  "state": "working",
  "expectedState": "resting",
  "expectedWorkSessionId": null,
  "expectedVersion": 4
}
```

干活 → 休息：

```json
{
  "state": "resting",
  "expectedState": "working",
  "expectedWorkSessionId": "打开弹窗时的当前工作 uuid",
  "expectedVersion": 5
}
```

先向用户展示目标和转换并二次确认；取消时不发送请求。状态变动后返回 409 `STATE_CHANGED`，刷新后重新确认。项目已有其他工作者时返回 `PROJECT_BUSY`；接口不会自动交接。

## 错误码

| HTTP | 错误码 | 含义 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | 字段、分钟精度、范围或请求格式不合法 |
| 401 | `UNAUTHENTICATED` | 未登录、会话失效或已过期 |
| 401 | `INVALID_CREDENTIALS` | 统一用户名或密码错误 |
| 403 | `CSRF_REJECTED` | 来源或会话防护令牌不匹配 |
| 404 | `NOT_FOUND` | 未找到或没有访问权限；不暴露私人项目存在性 |
| 404 | `USER_NOT_FOUND` | 项目成员邀请完整用户名时无对应账号 |
| 409 | `USERNAME_TAKEN` | 规范化用户名重复 |
| 409 | `PROJECT_BUSY` | 有其他人正在干活，带当前用户安全信息 |
| 409 | `STATE_CHANGED` | 旧工作标识、状态版本或确认过期 |
| 409 | `RESERVATION_CONFLICT` | 有重叠有效预约，带预约者及起止时间 |
| 409 | `ALREADY_MEMBER` | 被邀请人已加入 |
| 409 | `INVITATION_ALREADY_PENDING` | 同目标已有待处理邀请 |
| 409 | `INVITATION_NOT_PENDING` | 邀请已经处理且与当前操作冲突 |
| 409 | `IDEMPOTENCY_MISMATCH` | 同一请求标识对应不同参数或路径 |
| 413 | `VALIDATION_ERROR` | JSON 请求超过 16 KiB |
| 429 | `RATE_LIMITED` | 认证限流，附带 `Retry-After: 600` |
| 500 | `INTERNAL_ERROR` | 安全的通用服务端错误，无底层异常细节 |

私有响应均携带 `Cache-Control: no-store`。接口没有跨域授权，不建议从其他站点直接调用。
