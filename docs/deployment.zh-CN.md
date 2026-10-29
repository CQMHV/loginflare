# 部署与运维

[English](deployment.md) · [中文 README](../README.zh-CN.md)

## 前置条件

本地测试和生产构建通过后再部署。任何远程变更前，核对目标账号、环境、Worker、数据库 ID、公开地址和发信域名。

- 具有 Workers Paid 的 Cloudflare 账号，用于向任意用户发送事务邮件。
- 由 Cloudflare DNS 管理且已接入 Cloudflare Email Sending 的域名。
- 发信域名所需的 SPF、DKIM 和退信 DNS 记录。
- 覆盖部署域名的正式 Turnstile 组件及密钥。
- staging 与 production 分别使用独立 D1 数据库、Worker 密钥和公开地址。
- 安装并登录 Cloudflare CLI（`cf`），具有目标账号的适当权限。

Email Sending 当前为 Beta，生产上线前应核对最新的 [Email Service 官方说明](https://developers.cloudflare.com/email-service/)。仅配置 Email Routing 不等于可以向任意收件人发送事务邮件。

本仓库不会在安装依赖、本地开发、测试或构建时自动创建远程资源或部署。

## 配置环境

维护者的测试实例位于 `https://loginflare-staging.cqmhv.workers.dev`，使用独立 D1 和 Turnstile 组件，production 尚未配置。独立使用者配置自己的环境。通过 Cloudflare Workers Builds 部署时，设置 `CLOUDFLARE_ENV=staging`、`NODE_VERSION=24` 和 `PNPM_VERSION=11.25.0`，构建命令使用 `pnpm build`，部署命令使用 `node scripts/database.mjs migrate --env staging && pnpm exec wrangler deploy`。迁移封装完成数据预处理与结构检查后才允许继续部署，构建令牌需要目标环境的 Worker 部署和 D1 迁移、查询权限。认证与 Turnstile 密钥保存为运行时 Worker Secrets，不放入构建变量或仓库。升级已有实例时须另外核实远程构建配置。

已提交的 `wrangler.jsonc` 包含本地配置以及独立的 `staging`、`production` 节。构建远程环境前，先填入其 D1 数据库 ID 和公开配置。本地密钥放在被忽略的 `.dev.vars` 中；`pnpm setup:local` 可安全生成，已有文件不会覆盖。远程认证和 Turnstile 密钥使用 Worker Secrets，不写进已提交配置。不同环境的认证密钥应独立，常规重新部署时保持稳定。

保留 `nodejs_compat` 和 `global_fetch_strictly_public` 两个兼容标志。OIDC 退出会请求 issuer 的 `/api/auth/jwks` 验证 ID Token hint；后一个标志让同区请求经过公开 Worker 入口，即使使用较新的兼容日期也需要显式配置。参见 [Cloudflare 请求路由说明](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)。

| 配置 | 位置 | 用途 |
| --- | --- | --- |
| `APP_ENV` | 对应环境的 `vars` | `development`、`staging` 或 `production` |
| `AUTH_URL` | 对应环境的 `vars` | 完整应用 Origin，远程使用 HTTPS，不带结尾斜杠 |
| `EMAIL_FROM` | 对应环境的 `vars` | 使用已验证域名的发件人 |
| `TURNSTILE_SITE_KEY` | 对应环境的 `vars` | 部署域名对应的公开站点密钥 |
| `BETTER_AUTH_SECRET` | Worker Secret | 至少 32 字符的随机认证密钥 |
| `TURNSTILE_SECRET_KEY` | Worker Secret | 与正式站点密钥配对的私密密钥 |
| `DB` | 对应环境的 D1 绑定 | 独立数据库 ID 与迁移目录 |
| `EMAIL` | 对应环境的 `send_email` 绑定 | Cloudflare Email Service 发信能力 |

可信 Origin 取自 `AUTH_URL`，应与公开 Origin 一致。必需配置缺失时明确报错，不跳过邮箱验证或防机器人校验。开发环境以外会拒绝 Turnstile 测试密钥。

开发默认使用本地模拟绑定。远程邮件绑定会发送真实邮件，本地测试不需要启用。

## Cloudflare CLI

资源管理优先使用 `cf`。当前锁定的 `cf` 开发/构建路径要求 Beta 版 Vite 插件，因此项目使用稳定 Cloudflare Vite 插件和 Wrangler 完成开发、构建、类型生成和部署。该版 `cf` 尚未实现本地 D1 查询，故本地提权使用 Wrangler，远程迁移和查询使用 `cf`。

先发现合适的资源命令并阅读对应帮助，再执行：

```powershell
cf cli search "apply SQL database migrations from local files"
cf cli search "deploy a worker project"
cf cli search "set a worker secret"
```

命令发现查询保持匿名，不加入账号标识、域名、邮箱、资源名或令牌。

使用仓库提供的封装执行迁移，确保不会跳过数据预处理和结构检查。核实目标后：

```powershell
node scripts/database.mjs migrate --env staging
node scripts/database.mjs check --env staging
```

`pnpm db:migrate`、`pnpm db:check` 均针对 `.cloudflare/state` 中的本地数据。远程操作明确使用 `node scripts/database.mjs ... --env staging|production`；封装解析并打印所选数据库 ID，底层 `cf` 迁移使用该 ID。初始化本地数据库时不要使用远程目标。`check` 仅检查，不修复；`migrate` 预处理数据、应用已提交 SQL 并检查最终结果。

构建与部署分开。Cloudflare Vite 插件要求在**构建时**选择目标环境，不能靠部署时的 `--env` 参数选择。使用 PowerShell 构建 staging：

```powershell
$env:CLOUDFLARE_ENV = 'staging'
pnpm build
```

检查生成的 Worker 配置及绑定数据库 ID，然后在不上传的情况下检查：

```powershell
pnpm exec wrangler deploy --dry-run
```

明确需要部署后，上传同一份 staging 构建：

```powershell
pnpm exec wrangler deploy --secrets-file .dev.vars.staging
Remove-Item Env:CLOUDFLARE_ENV
```

`.dev.vars.staging` 必须保存真实的 staging 认证与 Turnstile 密钥，不能使用本地示例的测试密钥；该文件已被 Git 忽略。生产环境需要重新以 `CLOUDFLARE_ENV=production` 构建，并使用生产密钥文件，不能复用本地或 staging 构建。参见 [Cloudflare 环境说明](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/)。

预先创建并核实目标 D1 数据库，将 ID 填入对应配置；部署时不要接受意外的资源创建。真实密钥不得写入已提交脚本或可能被历史记录保存的命令行参数。临时密钥文件应妥善保护，不再需要时清理。

## 数据库与管理员初始化

启动新 Worker 版本前，先备份已核实的目标，通过封装应用已提交迁移，并要求结构检查通过。常规更新不得以新空数据库替换已有数据库。远程执行前审阅 SQL，并保留该数据库的恢复点。

升级前暂停应用注册、回调编辑及其他涉及预处理数据的写入，保持停写窗口直到预处理、迁移、结构与 URI 索引检查、新 Worker 切换全部完成。Origin 回填同时比较原回调和元数据，遇到并发变更会中止；检查会双向核对派生元数据和索引登记。这些检查只负责发现不一致，不会自行暂停写入或完成版本切换。已有远程构建触发器须单独检查和更新，仓库不会自动建立停写窗口。

OAuth/OIDC 在 `0002_oauth.sql`、`0003_oauth_policy.sql` 中增加上游数据表和 `oauthGrantPolicy` 安全状态，启动新版前须应用两份迁移。保留已有账号、签名密钥、授权策略状态与稳定的 `BETTER_AUTH_SECRET`；删除策略记录不是支持的撤销或恢复方式。外部应用开始接入后，保持 `${AUTH_URL}/api/auth` issuer 稳定。

用户名登录通过 `0004_username.sql` 增加可为空、按大小写不敏感规则保持唯一的 `user.username`，部署包含用户名功能的版本前须先应用。已有账号仍可通过邮箱登录，再在个人资料中自行选择用户名；迁移不会代为生成或占用用户名。

邮箱管理通过 `0005_emails.sql` 增加 `userEmail` 和 `emailChallenge`，部署包含此功能的版本前须先应用。迁移登记已有主邮箱并保留验证状态；主辅邮箱共享大小写不敏感的唯一约束，数据库触发器保护注册、主邮箱切换和验证凭据失效。每个账号最多管理十个邮箱；未验证辅助邮箱占用超过一天后，再次添加该地址时可回收。密码恢复改为向指定的已验证绑定邮箱发送验证码，再交给原生流程重置密码，原公开重置链接请求入口已移除。不需要新增绑定或密钥。

`0006_management.sql` 增加游标列表索引和 OAuth URI 投影表，`0007_maintenance.sql` 增加过期索引与授权策略回收边界。应用 SQL 前，封装通过 URL 解析器生成回调 Origin 元数据，并分批将原生日期列统一为 ISO UTC 文本。无效的已有回调必须先处理。最终检查按已提交迁移核对表、列、索引和触发器，检查外键及回调元数据与索引一致性，并拒绝无效原生日期存储；不会悄悄修复结构差异，也不在请求中支持两种日期格式。自动部署必须保留预处理和结构检查步骤。

五分钟 Cron Trigger 在现有 Worker 和 D1 上执行有界过期清理，无需新增资源或密钥。凭据使用时仍检查有效期，清理延后不会使过期令牌恢复有效。关注 `database_maintenance` 和 `database_maintenance_failed` 事件；持续积压或预算耗尽时应评估流量和数据库，不应删除仍有效的授权策略记录。运行边界参见[规模说明](scaling.md)。

在管理后台创建生产应用，配置精确 HTTPS 登录回调和退出回跳地址。服务端客户端密钥应存放在相应应用受保护的服务端配置中，不能发给浏览器应用。SPA 已注册 Origin 只获得协议接口的 CORS 权限，不获得账号或管理接口访问权。刷新与安全撤销规则参见[应用接入](oauth.zh-CN.md)。

先通过普通注册创建预期的管理员账号，并完成邮箱验证。运维命令必须针对指定的已存在、已验证账号；账号不存在或邮箱未验证时应失败。重复执行已成功的提权没有额外影响。

本地开发：

```powershell
pnpm admin:promote -- --email admin@example.com --local
```

远程执行时，明确指定环境，并核实打印出的数据库目标：

```powershell
pnpm admin:promote -- --email admin@example.com --env staging
```

仅当目标确实是生产时使用 `--env production`。未指定目标、数据库 ID 为占位符或无效、远程复用本地数据库 ID 时，命令会拒绝执行。远程查询使用参数绑定；本地 Wrangler 查询使用正确转义的 SQL 字面量，以无 shell 的结构化进程参数传递。不能把“第一个注册用户”作为自动初始化管理员的依据。提权后退出并重新登录。

## 备份与恢复

本地快照命令：

```powershell
pnpm db:backup
```

可在后面传入输出目录，默认创建 `work/backups/` 下的新时间戳目录。Node SQLite 备份 API 在本地开发运行时生成一致性快照；manifest 记录 `d1/` 中的数据库文件，以及保存的本地配置、托管测试凭据和存在时的 `.dev.vars`。备份包含认证材料，应私密保存并保持在 Git 之外。该命令不会访问远程 D1。

恢复时先停止开发服务，将现有状态移至旁边保留，再把 manifest 的 `d1/` 文件恢复到 `.cloudflare/state/v3/d1`，配置和凭据恢复到各自原相对路径。认证密钥和 Origin 应与数据库匹配，因为签名私钥经过加密，已有凭据属于该实例。使用 `pnpm db:check` 检查后再打开；恢复演练仅在隔离目录进行，不覆盖正在使用的开发数据库。

staging 或 production 迁移前，通过 D1 支持的恢复机制记录并核实恢复点。实际远程恢复前核对数据库和恢复点。本地 SQLite 快照不等于远程 D1 备份，Worker 版本回滚也不会撤销数据库结构或数据变化。

## staging 验收

使用自己控制的邮箱与账号。真实邮件送达检查是明确的远程操作，不属于本地自动化测试。

将构建提升到生产前检查：

1. 两套小写语言路径均可访问，新访客默认进入 `/en-us/`。
2. 注册、验证邮箱、登录、密码恢复和本地化邮件链接可用。
3. 普通用户不能访问管理接口或修改受保护的账号字段。
4. 停用普通用户会使旧会话失效，恢复后需重新登录。
5. Turnstile 使用正式密钥并拒绝无效挑战，限流数据在请求间持久保存。
6. API 失败返回安全的 JSON，而非 SPA HTML 或内部诊断信息。
7. 日志不含密码、会话令牌、完整验证或重置链接。
8. Web、SPA 应用能够发现配置的 issuer、完成同意并通过 PKCE S256 交换授权码；无效回调和未注册 Origin 被拒绝。
9. 重置密码、主动撤销会话和停用账号使相应 OAuth 授权失效；恢复账号不会恢复旧授权。普通中心退出保留原生离线刷新语义。
10. 常规部署后签名密钥仍可使用；日志不包含 OAuth 授权码、客户端密钥或令牌。
11. 迁移与结构检查通过，游标翻页和精确检索可用，定时任务报告有界清理且不删除仍有效的凭据。

## 更新与故障排查

- 部署经过测试的锁文件和迁移集合，不对生产运行未经审阅的结构生成。
- 判断部署工具不可用之前，先检查登录、权限、目标账号和网络连接。
- 远程写入结果不确定时，先查询资源或版本的实际状态，再决定是否重试。
- 邮件发送失败时检查 Email Service 配置与投递记录，不跳过邮箱验证。
- Turnstile 不可用或配置错误时修复配置，不能伪造验证成功。
- Worker 回滚不会自动撤销 D1 结构或数据变化，切换版本前核对数据库兼容性。
