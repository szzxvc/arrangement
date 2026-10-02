# Windows 部署指南

这份指南把程序发布到你自己的 Cloudflare Workers 账户；Windows 电脑用于安装、构建与管理，上线后不需要一直开机。

## 1. 准备

1. 在 [Node.js 官网](https://nodejs.org/) 安装 Node.js **24 LTS** 的 Windows 安装包，保留 npm 和 PATH 默认选项。至少需要 Node.js 22.12。
2. 注册或登录 [Cloudflare](https://dash.cloudflare.com/)，启用 Workers，并开通 **Workers Paid**。本项目的密码算法需超过免费计划 10 毫秒 CPU 预算，不建议直接用免费计划上线。
3. 下载项目 ZIP，右键“全部解压缩”，例如解压到 `C:\Projects\club-work-checkin`。工程根目录应能看见 `package.json` 和 `wrangler.jsonc`。
4. 打开 Windows Terminal 或 PowerShell。无需 WSL、Docker、PHP、独立 SQLite 安装或 Git。

后续命令一行一行执行。文中的 `C:\Projects\club-work-checkin` 请换成你的真实目录。指南统一使用 `npm.cmd`、`npx.cmd`，可避免 PowerShell 执行策略阻止 `npm.ps1`；不需要更改系统执行策略。

```powershell
Set-Location -LiteralPath 'C:\Projects\club-work-checkin'
node --version
npm.cmd --version
npm.cmd ci
```

推荐 `npm ci`，它严格使用锁文件。`npm install` 也能安装，但通常不需要重新选择依赖版本。第一次安装和后续部署需要网络能访问 npm 和 Cloudflare；浏览器测试安装还需访问 Playwright 浏览器下载源。

## 2. 先在电脑上试用

```powershell
Copy-Item -LiteralPath .dev.vars.example -Destination .dev.vars
npm.cmd run db:migrate:local
npm.cmd run dev
```

迁移如果询问是否继续，输入 `y`。终端显示 Vite 地址后，在浏览器打开：

```text
http://localhost:5173
```

注册两个账号即可试用：用普通窗口登录一个账号，用 Edge／Chrome 的 InPrivate／无痕窗口登录另一个。创建项目，邀请第二个账号，在第二个账号首页接受，再测试开始、结束、预约和强制状态修改。

本地启动会同时运行前端 5173 与后端 8787。请保留终端窗口，按 `Ctrl+C` 结束。本地账户与数据位于 `.wrangler\state\`，下次启动会保留；这些数据**不会自动同步到云端**。上线后需要重新注册真实账号。

`.dev.vars` 是本地 HTTP 专用配置，关闭 Secure Cookie 并允许两个开发端口。它不会随发布上传；生产仍采用 `APP_ENV=production`、Secure Cookie 和同源校验。不要把 `.dev.vars` 上传到 Git，也不要把这些开发值写入生产配置。

## 3. 执行检查

可以在另一个 PowerShell 窗口进入同一目录执行：

```powershell
npm.cmd run check
npm.cmd run deploy:preview
```

检查依次包含 TypeScript、真实本地 Workers／D1 的自动化测试、生产前端构建。`deploy:preview` 仅打包演练，不会创建在线网站。

若还想运行浏览器完整流程：

```powershell
npx.cmd playwright install chromium
npm.cmd run test:browser
```

测试会自行使用 8790 端口及独立的 `.test-runtime\browser\` 数据，不触碰你的日常本地数据库。Windows 无需配置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`；项目验证时的 Linux 系统 Chromium 路径不要复制到 Windows。

如果 Chromium 下载失败，也可以使用本机已安装的 Edge。下面是默认安装路径；如果你的路径不同，请相应调整。变量只在当前 PowerShell 终端生效，测试结束后移除：

```powershell
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
npm.cmd run test:browser
Remove-Item Env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
```

## 4. 登录 Cloudflare 并创建云端数据库

```powershell
npx.cmd wrangler login
```

Wrangler 会打开浏览器请求 Cloudflare 授权。授权后回到终端继续：

```powershell
npx.cmd wrangler whoami
npx.cmd wrangler d1 create club-work-checkin-db
```

有多个 Cloudflare 账户时选择你计划部署的同一个账户。创建结果会包含数据库名称和真正的数据库 UUID。

用 VS Code 或记事本打开 `wrangler.jsonc`，把下面唯一的占位值替换成刚得到的 UUID：

```jsonc
"d1_databases": [{
  "binding": "DB",
  "database_name": "club-work-checkin-db",
  "database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID",
  "migrations_dir": "migrations"
}]
```

保留 `binding` 为 `DB`。如果改了数据库名称，还需同时修改 `package.json` 中两条迁移命令的名称。D1 标识不是登录密钥，但必须与你当前账户实际创建的数据库一致。不要使用文档中的占位值进行远端迁移。

Worker 名称默认为 `club-work-checkin`，可将 `wrangler.jsonc` 的 `name` 改为你希望的英文小写名称，例如 `my-club-checkin`。不要改变入口、静态资源绑定、API 优先路由或生产 Cookie 配置。

程序本身不要求你设置 JWT 密钥、邮箱密钥或第三方服务密钥。会话令牌在运行时随机生成，D1 存令牌摘要，Cloudflare CLI 授权由 Wrangler 管理。

## 5. 云端迁移与正式发布

确认配置中的数据库标识已经替换，然后执行：

```powershell
npm.cmd run db:migrate:remote
npm.cmd run deploy
```

云端迁移如果询问确认，检查终端显示的账户与数据库，再输入 `y`。正常结果会显示 `0001_initial.sql` 已应用。

`deploy` 会先重新运行检查，再将 Worker 和前端静态资源一起发布。成功后终端会输出实际网址，通常类似：

```text
https://club-work-checkin.<你的账户子域>.workers.dev
```

这里是格式示例，不是已经创建的链接。请以终端返回的真实网址为准。如果还未设置 Workers 子域，按照 Wrangler 或 Cloudflare 控制台的引导设置。

从这个 HTTPS 地址访问并注册账号。电脑浏览器和手机浏览器使用同一个地址即可，无需安装客户端。生产数据库与本地数据库独立。

自定义域名可以之后在 Cloudflare 控制台的 Workers & Pages → 对应 Worker → Settings → Domains & Routes 设置。应用使用同源接口，一般无需修改代码。浏览器对外访问必须使用 HTTPS。

## 6. 上线后必须完成的验收

本项目已经完成本地真实 Workers／D1 测试，但本次交付没有你的 Cloudflare 凭据，**未执行云端迁移、远端密码资源测量或正式发布**。请在你的账户完成：

1. 注册两个真实账号。刷新和重新打开页面后仍保持登录，退出后当前会话立即失效。
2. 创建项目。另一个账号接受邀请前看不到详情，接受后正常进入。直接复制项目链接给未加入账号应显示不可访问。
3. 两个账号同时点击开始，只能一人干活；冲突提示带当前工作者用户名。另一个成员经确认可以结束当前工作者，也可在项目空闲时开始目标成员。
4. 创建相邻预约应成功；重叠预约应拒绝。只能取消本人的当前或未来预约。预约和取消不自动改变工作状态。
5. 直接刷新 `/projects/项目标识` 深链接仍能打开；未知 `/api/anything` 返回 JSON 错误。
6. 用手机试验按钮、邀请和跨日预约。关掉页面或退出后，实际干活仍保留，必须手动结束。
7. 在 Worker 的 Metrics／Observability 中查看认证路径 CPU 时间、错误、内存相关异常和 D1 用量，确认所选 Paid 套餐适合你的规模。不要在诊断日志中记录密码、Cookie 或请求体。

如果云端数据库迁移出现触发器解析错误，保留报错文字并先核对锁文件安装、LF 换行和 Wrangler 版本。不要通过删除预约触发器“修复”部署；触发器是并发正确性的必要保护。

## 7. 更新、数据与备份

修改代码后：

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run db:migrate:remote
npm.cmd run deploy
```

只有新增迁移才会改变云端表结构；已经应用的迁移不要直接编辑来更新线上数据库。新功能应新增迁移文件。重新发布 Worker 不会清空 D1；不要删除再建数据库来更新代码。

云端备份：

```powershell
New-Item -ItemType Directory -Force -Path '..\club-backups'
npx.cmd wrangler d1 export club-work-checkin-db --remote --output '..\club-backups\club-backup.sql'
```

备份含账号密码派生结果、会话摘要、CSRF 令牌和私人项目记录，必须保存在受控目录，不能公开分享。文件名固定会覆盖旧备份，可改成带日期的名字。Cloudflare D1 Time Travel 可用于恢复到先前时间点；具体保留期限以账户套餐与官方说明为准。恢复会改变线上数据，先在备份或测试数据库验证。

前端构建结果在 `dist\`；源码 ZIP 可用 `npm.cmd run package` 重新生成。打包排除了真实配置变量、本地数据库、依赖目录和浏览器测试会话。

## 8. 常见问题

### PowerShell 提示“禁止运行脚本”

用本指南的 `npm.cmd` 和 `npx.cmd`。通常是 PowerShell 阻止了 `npm.ps1`，不需要关闭电脑的安全策略。

### Node 版本错误或安装不成功

安装 Node.js 24 LTS 后重新打开终端。运行 `node --version` 检查 PATH 使用的是新版本；不要使用旧的 Node 18／20。`npm ci` 需要联网，网络阻断时先处理 npm 连接再重试。

### 页面登录成功却马上退出

本地访问使用 `http://localhost:5173`，确认已复制 `.dev.vars.example`，随后重启开发进程。不要在开发过程中混用 `localhost` 与 `127.0.0.1`：浏览器把它们视为不同站点，Cookie 分开存储。线上必须使用 HTTPS，保留生产 Secure Cookie。

### 请求来源或安全验证失败

先刷新页面恢复会话关联的 CSRF 令牌。本地按示例端口启动；如果改端口，更新 `.dev.vars` 的开发来源列表并重启。生产接口应从同域前端调用，不要配置全开放 CORS。

### 提示用户名或密码错误／忘记密码

英文字母大小写不影响用户名；密码中的首尾空格是密码的一部分。目前没有自动找回功能。不要尝试文档里不存在的邮件找回入口。如管理员需处理账号密码，应另外制定经过验证的后台流程；本版没有内置管理员重置接口。

### 其他人干活中，预约到我也不能开始

实际工作状态必须手动结束。预约不会自动交接。任意成员可点击当前工作者状态，确认结束，再开始自己或另一个成员；每个操作分别确认并记录。

### 显示“状态已变化”

这是旧确认保护。关闭弹窗，等待页面同步，再点击目标成员确认。不要复用旧工作记录标识强行结束新的工作。

### 无法同步或离线

页面会保留最近看到的状态并提示同步失败。恢复联网会自动刷新；提交结果未确认时，同一次操作重试会复用请求标识，服务端避免重复创建。以刷新后的服务端状态为准。

### 迁移找不到数据库／配置仍是占位值

确认 `wrangler whoami` 的账户与创建 D1 时相同，确认 `database_id` 已填真实 UUID；保持数据库名称与迁移命令一致。`--local` 和 `--remote` 是两个独立环境。

### 部署提示 CPU 配置不适用于免费套餐

启用 Workers Paid。密码派生已经在本地 runtime 验证，单次本地墙钟耗时约百余毫秒，免费计划的 10 毫秒 CPU 额度无法作为可靠基线。不要降低 scrypt 参数或改用普通摘要来绕过额度。

### 端口被占用

关闭旧的开发终端和浏览器测试进程后重试。正常开发用 5173／8787，浏览器测试用 8790。不要结束不认识的系统进程。

### workers.dev 在某些网络不稳定

部署不等于所有网络都已验证。用你的实际电脑、手机网络检查可访问性；必要时在 Cloudflare 中配置你自己的域名。本次未验证中国大陆网络表现。

## 9. 费用与运行限制

默认 CPU 上限为 30 秒，Worker isolate 总内存上限以 Cloudflare 当前官方限制为准（当前文档为 128 MB）。scrypt 的 `maxmem=64 MiB` 是算法允许的内存预算，不代表整个 Worker 只使用这个数，也不代表已经测量云端峰值内存。

每个可见项目页五秒一次轮询，约 720 次 API 请求／小时。20 个成员一直各开一个项目页，约 14,400 次 API 请求／小时；另外还有读写 D1、登录密码计算与静态资源等消耗。隐藏标签暂停轮询。实际费用须按账户套餐、D1 读写行和并发规模核算。

这是面向小社团的第一版。历史、审计和幂等结果保留；用户量大时需设计留存策略与更高效同步。本次没有验证云端 CPU、峰值内存、生产压力或持续运行费用。

官方参考：[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)、[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)。
