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

已提交的 `wrangler.jsonc` 包含本地配置以及独立的 `staging`、`production` 节。构建远程环境前，先填入其 D1 数据库 ID 和公开配置。本地密钥放在被忽略的 `.dev.vars` 中；`pnpm setup:local` 可安全生成，已有文件不会覆盖。远程认证和 Turnstile 密钥使用 Worker Secrets，不写进已提交配置。不同环境的认证密钥应独立，常规重新部署时保持稳定。

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

D1 迁移命令接受的是**数据库 ID**，而非绑定名或数据库名。核实目标后，远程迁移命令形式为：

```powershell
cf d1 migrations apply <database-id> --dir migrations
```

`pnpm db:migrate` 封装本地迁移，并与开发使用同一份本地状态目录。初始化本地数据库时不要使用远程命令形式。

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

启动新 Worker 版本前，先将已提交迁移应用到正确环境。常规更新不得以新空数据库替换已有数据库。远程执行前审阅 SQL；需要时先使用 D1 支持的备份与恢复机制。

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

## 更新与故障排查

- 部署经过测试的锁文件和迁移集合，不对生产运行未经审阅的结构生成。
- 判断部署工具不可用之前，先检查登录、权限、目标账号和网络连接。
- 远程写入结果不确定时，先查询资源或版本的实际状态，再决定是否重试。
- 邮件发送失败时检查 Email Service 配置与投递记录，不跳过邮箱验证。
- Turnstile 不可用或配置错误时修复配置，不能伪造验证成功。
- Worker 回滚不会自动撤销 D1 结构或数据变化，切换版本前核对数据库兼容性。
