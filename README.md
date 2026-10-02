# 社团干活打卡

可部署到 Cloudflare Workers 的中文社团协作应用。前端 React + TypeScript + Vite，后端 Hono + TypeScript，数据保存在 D1，前后端通过 Workers Static Assets 同域提供。

**Windows 用户请先阅读 [Windows 部署指南](docs/Windows部署指南.md)。** 不需要服务器、Docker、WSL、邮箱服务或手机号码。

## 已实现的功能

- 用户名与密码注册、登录、密码显示、七天服务端会话、退出撤销当前会话。
- 用户名去空白、NFKC 规范化、英文大小写不敏感；密码支持中文与空格。
- 私有项目创建和项目列表，创建者在创建事务中自动成为成员。
- 全体已加入成员按完整用户名邀请；被邀请者接受或拒绝；接受前没有成员权限。
- 每项目最多一人实际干活；本人开始和结束，成员经确认修改他人状态。
- 一分钟精度预约、跨日时段、数据库防重叠、本人取消、历史分页。
- 工作操作人、目标、原因、时间和工作记录的审计；成员可查看操作记录。
- 五秒项目快照同步，隐藏时暂停，重新可见、获得焦点或联网时立即刷新。
- 请求幂等、旧确认冲突保护、来源与 CSRF 校验、持久认证限流。
- 电脑和手机界面、弹窗键盘操作、焦点恢复、离线和错误反馈。

## 默认业务规则

所有时间输入、显示与“今天”固定北京时间（UTC+8），数据库和 API 使用 UTC **整数秒**。工作状态按项目独立；同一个人可在不同项目干活。

预约是排班记录。预约开始、到期或取消不自动改变工作状态。即使当前时段是其他人预约，只要无人实际干活，成员仍可开始。关闭页面、退出登录、断网不自动结束干活。

预约使用 `[start, end)`，首尾相接允许，任何有效预约重叠都拒绝，包括本人预约。可以取消自己的当前或未来预约，不能取消他人的预约。已结束或已取消记录保留在历史中。

全体成员都可邀请与确认修改其他成员状态。强制开始不会抢占已有工作者；交接需分别确认结束原工作者、开始目标成员。状态版本和当前工作记录标识用于拒绝过期确认。

第一版没有自动找回密码、公开项目目录、全局用户搜索、自动签到、自动签出、成员移除、项目编辑／删除或管理员角色。密码务必妥善保存。

## 本地开发

需要 Node.js 22.12+，建议 Node.js 24 LTS。锁文件已经提供，日常安装推荐 `npm ci`。以下命令在项目根目录运行；PowerShell 遇到执行策略限制时使用 `npm.cmd` / `npx.cmd`。

```powershell
npm.cmd ci
Copy-Item .dev.vars.example .dev.vars
npm.cmd run db:migrate:local
npm.cmd run dev
```

访问 `http://localhost:5173`。Vite 将 `/api` 代理到 `127.0.0.1:8787`，前后端修改均会重载。开发会先构建静态文件，Worker 也可以在 `http://localhost:8787` 提供构建后的前端。

本地 D1 数据保存在 `.wrangler/state/`；重启保留。不要把此目录上传或发给其他人。`.dev.vars` 只供本地使用，生产配置在 `wrangler.jsonc`，部署不上传本地变量文件。

## 验证命令

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run deploy:preview
npx.cmd playwright install chromium
npm.cmd run test:browser
```

`npm run check` 依次执行类型检查、Vitest 和生产构建。`deploy:preview` 是 Wrangler 打包演练，不会发布。浏览器测试使用独立的 `.test-runtime/browser/` 数据库；每次测试重建这个测试目录，不触碰普通开发数据库。浏览器测试占用 8790 端口。

Vitest 通过 Miniflare 启动真实 Workers runtime，加载完整迁移，走真实 D1 绑定和 HTTP 接口；不以 mock 数据库代替约束测试。迁移解析使用固定版本 Wrangler 的 SQL 解析器，保留完整触发器。

测试入口和 Vite 配置兼容 Windows 目录联接：测试在加载 Vitest 前统一真实目录和盘符大小写，构建使用真实项目路径。

## 部署

默认配置以 **Workers Paid** 为部署基线，CPU 上限设置为 30 秒。密码派生保持 `scrypt N=16384, r=8, p=5`；不为免费额度降低强度。未承诺免费套餐可运行。

尝试 Workers Free 请阅读 [Free 试部署指南](docs/Free试部署指南.md)，使用 `wrangler.free.jsonc`。该配置使用单独的 Worker 和 D1 数据库，不设置自定义 CPU 上限。Free 每次请求有 10 毫秒 CPU 限制，现有密码派生可能超限，必须完成云端注册、登录验收后再判断能否使用。

```powershell
npx.cmd wrangler login
npx.cmd wrangler d1 create club-work-checkin-db
```

将输出的真实 `database_id` 填入 `wrangler.jsonc`，替换 `REPLACE_WITH_YOUR_D1_DATABASE_ID`，保留 `binding: "DB"`。随后：

```powershell
npm.cmd run db:migrate:remote
npm.cmd run deploy
```

详细逐步操作、云端验收、备份、更新和故障排查见 [Windows 部署指南](docs/Windows部署指南.md)。本项目已使用单独的 Free 配置完成云端试部署与功能验收，网址和 CPU 测量见 [验证记录](docs/验证记录.md)；现有认证超过 Free 的标称 CPU 额度，尚未证明免费稳定运行。

## 配置与密钥

| 配置 | 用途 | 生产值 |
| --- | --- | --- |
| `DB` | D1 绑定 | 真实数据库标识，绑定名必须保持 `DB` |
| `ASSETS` | 前端静态资源绑定 | Wrangler 自动提供 |
| `APP_ENV` | 区分生产与本地开发 | `production` |
| `SESSION_COOKIE_SECURE` | 本地 HTTP 可关闭 Secure | `true`；生产代码即使值为 false 也强制 Secure |
| `DEV_ALLOWED_ORIGINS` | 5173 开发代理来源 | 仅开发环境读取，生产忽略 |

应用没有必需的第三方 API 密钥：会话和 CSRF 令牌用安全随机数生成，服务端仅保存会话令牌摘要。Wrangler 登录凭据由 CLI 管理，不写进工程。不要将账号密码、Cookie、令牌放入日志、源码、前端环境变量或提交到 Git。

## 目录

```text
src/                       中文 React 页面、同步与 HTTP 客户端
worker/                    Hono API、认证、权限与原子幂等操作
shared/                    API 类型与固定北京时间函数
migrations/0001_initial.sql 表、索引、外键、预约保护与工作审计触发器
tests/api.test.ts           真实 D1 并发、认证、权限和事务测试
tests/time.test.ts          时区、午夜、跨月跨年与精度测试
tests/navigation.test.ts    安全登录回跳测试
tests/browser/             浏览器完整流程与响应式验证
scripts/                   浏览器测试服务、源码打包
docs/                      Windows 部署、架构、接口与验证记录
public/                    图标和静态响应安全头
wrangler.jsonc             Worker、D1、Static Assets、生产变量
.dev.vars.example          本地变量示例
package-lock.json          精确依赖锁文件
```

## 安全与并发实现

工作状态由未结束的 `work_sessions` 推导。部分唯一索引保证每项目只有一条；普通和强制开始共用这项约束。结束明确绑定项目、目标、工作记录、未结束条件，避免旧页面结束下一次工作。

工作变化触发数据库审计与成员版本更新，同一事务中完成。零行条件更新没有审计副作用。所有多语句写入使用 D1 `batch()`；创建项目和接受邀请也遵守原子性。

业务变更要求 `X-Request-ID`。用户、请求标识、请求指纹和结果同业务 SQL 一起提交；重复标识返回原结果，同标识不同参数返回冲突。重放前仍校验当前会话和项目／目标权限。认证采用用户名唯一约束；登录创建新会话，退出撤销当前会话，这三类认证接口不使用业务结果缓存。

只读取 D1 主库，没有启用读副本或用 Worker 内存锁。私人接口 `Cache-Control: no-store`；用户内容由 React 按普通文本渲染；生产静态资源带 CSP 等安全头。

## 资源消耗与适用规模

项目页每五秒一次快照，单个一直可见的项目页约 720 次 API 请求／小时，认证、权限和快照合计约六条查询／次。D1 按实际读写行计费，成员数、预约数、历史规模和同时打开的页面都会影响成本；这不是固定费用估算。

本地 Workers runtime 已实际运行选定 scrypt 参数，云端试部署测得注册／登录 CPU 为 181–194 毫秒。墙钟基准和云端 CPU 分别记录在 [验证记录](docs/验证记录.md)。需继续在 Workers Metrics 查看资源消耗和异常，核对账户的 Workers／D1 额度。

本版适合小社团。快照读取全部项目成员，邀请列表读取本人全部待处理邀请；预约与工作历史分页。审计、工作历史和幂等结果持续保留；大量长期使用需制定容量与留存策略。未提供默认密码账号、生产种子数据或自动清空数据库功能。

## 文档与交付

- [Windows 部署指南](docs/Windows部署指南.md)
- [接口说明](docs/API.md)
- [架构与事务说明](docs/架构说明.md)
- [验证记录](docs/验证记录.md)
- [原始需求计划](docs/原始需求计划.md)

使用 `npm run package` 可以重新生成 `release/club-work-checkin.zip`，并同步更新项目根目录和 `release/` 中的文件清单。压缩包保留完整源码、锁文件、迁移、测试、说明与当前前端构建结果；排除依赖安装目录、本地数据库、真实变量、账号和测试会话。包内只包含一份本次生成的清单。
