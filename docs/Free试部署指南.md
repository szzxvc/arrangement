# Workers Free 试部署指南

这是现有应用的免费套餐试部署配置。密码算法仍为 `scrypt N=16384, r=8, p=5`。Free 单次请求的 CPU 限制为 10 毫秒；本地测试通过或部署成功都不能保证注册、登录在云端可用。

官方限制与额度：[Workers](https://developers.cloudflare.com/workers/platform/limits/)、[D1](https://developers.cloudflare.com/d1/platform/pricing/)。Free 当前包括每天 100,000 次 Worker 请求、5,000,000 行 D1 读取、100,000 行 D1 写入及 5 GB 总存储。超过每日额度会拒绝后续请求或查询。

## 登录与数据库

在项目根目录运行，使用已开通 Workers Free 的账户：

```powershell
npx.cmd wrangler login
npx.cmd wrangler whoami
npx.cmd wrangler d1 create club-work-checkin-free-db
```

将输出的数据库 UUID 填入 `wrangler.free.jsonc` 的 `database_id`。当前配置包含本项目试部署账户与数据库的标识；在其他账户部署时，同时将 `account_id` 改为 `whoami` 输出的账户标识。这些标识不是登录密钥，OAuth Token 或 API Token 不应写进源码。保留 `binding: "DB"`。免费试部署使用 `club-work-checkin-free` Worker 和 `club-work-checkin-free-db` 数据库。

## 迁移与发布

```powershell
npm.cmd run db:migrate:free:remote
npm.cmd run deploy:free:preview
npm.cmd run deploy:free
```

`deploy:free:preview` 仅打包演练。`deploy:free` 完成类型检查、测试和构建后，使用免费试部署配置发布到 Workers；命令不会更改账户套餐。

## 云端验收

1. 打开发布输出的 HTTPS 网址，检查首页和登录页。
2. 注册独立测试账号，退出后重新登录，确认会话和 Secure Cookie 可用。
3. 创建项目，完成一次开始、结束和未来时段预约。
4. 在 Workers Logs 中检查 CPU 时间和 `exceededCpu`。重复少量注册、登录，避免把偶尔允许的 CPU 突发误认为稳定可用。

如果出现 Error 1102 或 `exceededCpu`，应视为现有认证超出免费运行预算。移除 CPU 配置不会增加 Free 的额度；需要调整认证架构或选择满足当前计算预算的套餐。部署试验结果需记录在验证文档中。

## 本项目实际试部署结果

2026-10-02 已发布到 [试部署网站](https://club-work-checkin-free.lirenfei2021.workers.dev)，用户在控制台确认账户为 Workers Free，远端迁移和 19 项 HTTP 功能验收通过。云端注册／登录 CPU 实测 181–194 毫秒，超过 Free 标称额度；免费长期稳定性尚未证明。详情见 [验证记录](验证记录.md)。
