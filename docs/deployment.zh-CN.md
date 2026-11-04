# 部署与运维

[English](deployment.md) · [中文 README](../README.zh-CN.md)

## 首次部署

默认流程是 **部署按钮 → 网页配置 → 验证邮箱并创建管理员**。Cloudflare 创建 D1、私有 R2 桶并部署单个 Worker；安装向导管理公开地址、发信和 Turnstile 配置。完整流程的真实 Cloudflare 隔离验收仍是发布条件，不能以本地测试替代。

1. 准备 Cloudflare 账号、同账号中已经接入 Cloudflare DNS 的域名和 Workers Paid。向任意用户发送事务邮件还需要开通 Cloudflare Email Service；Email Routing 本身不提供这项能力。[Email Service](https://developers.cloudflare.com/email-service/)
2. 在用户个人资料的 API Tokens 中创建专用 **User API Token**，按下表限定账号及 Zone。不要创建 Account API Token：官方目前将 Turnstile 标为不兼容该类型。[令牌兼容性](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
3. 点击部署按钮，选择账号和资源名称，仅在首次安装时提供 `CF_SETUP_TOKEN`。它与 Cloudflare Builds 自身用于上传代码的部署凭据不同。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CQMHV/loginflare)

4. 构建命令使用 `pnpm build:deploy`，部署命令使用 `pnpm run deploy`；Node.js 使用 24，pnpm 使用 `packageManager` 指定版本。部署命令只上传代码，不执行数据库迁移或重新上传初始机密文件。
5. 打开部署地址的 `/setup`。再次输入专用令牌验证归属，准备数据库，选择公开 HTTPS 地址与发信域名，再继续向导配置域名、邮件和正式 Turnstile。默认可使用 `workers.dev` 地址；自定义域名需要额外的目标 Zone 路由写权限。公开地址属于另一个 Origin 时，请前往该地址并重新输入安装令牌；跳转链接不携带凭据。
6. 创建候选管理员并查收邮件。验证链接可以在其他设备打开；验证后返回原先已授权的安装页面，下载并私密保存恢复资料，再完成安装。邮件链接本身不能授予管理员权限。
7. 在页面确认临时凭据已清理，然后在 Cloudflare 撤销专用安装令牌。后续代码部署不再需要这个令牌。

向导默认建议单独的发信子域，例如 `notify.example.com`。DNS 冲突会停止该步骤，不会覆盖既有记录。套餐开通、域名转入及服务资格等账号操作由用户在控制台完成，返回向导后复检。

### 令牌权限

| 接口操作 | 权限 | 资源范围 |
| --- | --- | --- |
| 查询账号 | Account Settings Read | 目标账号 |
| 查询 Worker/版本/部署/机密名称，更新和删除机密、写入恢复挑战 | Workers Scripts Read/Write，或对应 Workers Editor | 目标账号；可用时进一步限到当前 Worker |
| 确认 Zone 归属 | Zone Read | 选择的目标 Zone |
| 查询、创建所需 DNS 记录 | DNS Read/Write | 选择的目标 Zone |
| 绑定自定义域名 | Worker 编辑权限及 Workers Routes Write | 当前 Worker 和每个受影响 Zone |
| 查询、创建、配置 Turnstile | Turnstile Sites Read/Write | 目标账号 |
| 查询、配置发信子域 | Email Sending 读取及编辑 | 目标账号和发信 Zone；最小权限映射需要隔离实测确认 |

Worker 编辑权限不能代替自定义域名需要的 Zone > Workers Routes > Write。[Workers 权限](https://developers.cloudflare.com/workers/authorization/workers/)

D1/R2 资源创建由部署工具的凭据完成；安装和迁移通过绑定访问，不要求安装令牌另有 D1/R2 管理权限。不授予账号令牌创建、删除其他 Worker 等无关权限。发信接口的最小权限尚未得到完整公开文档确认，不能将推测的权限清单当作已经验收。

## 配置归属与再次部署

`wrangler.jsonc` 是公开发布模板；`wrangler.local.jsonc` 只用于本地开发。迁移前的维护者配置应移至 Git 忽略的私有配置文件，核实资源后显式选择；不得将公共模板的新资源名直接用于已有实例。

仓库管理入口、兼容标志、资产、D1/R2/邮件绑定、Cron 声明和环境类别。安装向导通过 Worker Secrets 管理：

- `AUTH_URL`：固定公开 Origin，也决定 `${AUTH_URL}/api/auth` issuer。
- `EMAIL_FROM`：已经接入发信服务的域名地址。
- `TURNSTILE_SITE_KEY`、`TURNSTILE_SECRET_KEY`：配对的正式组件密钥。
- `BETTER_AUTH_SECRET`：实例认证及加密密钥，常规部署保持不变。
- `LOGINFLARE_CONFIG_REVISION`：向导写入的配置修订号。

这些字段不能同时出现在发布模板的 `vars` 中，空字符串也不允许。发布校验会拒绝冲突；`keep_vars` 不是防覆盖的唯一依据。根 `.dev.vars.example` 仅声明首次安装令牌，本地示例为 `.dev.vars.local.example`。安装令牌不是后续部署的 required secret。

配置更新不保证重启运行实例。页面区分应用构建、Worker 运行时版本和配置修订号，并等待目标运行配置被观察到；不以代码提交号判断配置生效。[绑定更新](https://developers.cloudflare.com/workers/runtime-apis/bindings/#making-changes-to-bindings)

认证密钥的唯一选定值先以加密恢复材料持久化，再写入 Worker Secrets。请求超时后必须先查询实际状态；不能通过重新生成密钥重试。安装恢复资料包含认证材料，应保存在 Git 之外。全部配置生效并完成安装后，临时恢复材料和安装凭据进入持久化清理流程。

Cloudflare Builds 只部署用户仓库中的代码，不会自动替用户同步上游。更新代码后，待执行的数据库升级在维护页面推进。再次部署不得更换 D1/R2 绑定、issuer、认证密钥或重放初始机密文件。

本地检查发布构建：

```powershell
pnpm install --frozen-lockfile
pnpm build:deploy
pnpm run deploy --dry-run
```

实际上传仅在核对目标后运行 `pnpm run deploy`。常规构建、依赖安装和本地测试不创建远程资源。

## 已有实例首次切换

旧部署说明采用“迁移后部署”。当前实现对 legacy/adoption 实例固定返回 `VERIFIED_LEGACY_DRAIN_REQUIRED`，没有强行解除入口；平台排空证据机制验证前，不允许旧实例迁移。以下是必须先验收的停服及过渡流程，不能视为当前已经放行的操作，也不能直接沿用旧 Builds 命令。

1. 暂停云端生产、非生产和预览构建触发器，核对实际部署命令，处理已经排队或正在执行的旧任务。先将云端命令改为只构建、部署，并收回旧构建凭据的业务数据库写权限。
2. 部署不改变业务结构的过渡版本：建立独立控制表，开放维护与恢复入口，关闭业务准入并停用 Cron。过渡版本配置需明确启用过渡模式；普通新安装不要启用。
3. 核对旧版本入口全部停止接收新调用，并取得旧 HTTP 请求、延后工作、定时任务以及已发出 D1/R2 操作的终态证据。过渡版本不能追溯登记旧版本工作；固定等 3–5 秒、流量切换或没有新日志都不是充分证据。
4. 私密保存恢复点、对应 R2 对象和认证密钥，核对原密钥能够解密现有材料，再通过已验证的切换流程进入独占迁移。
5. 全部迁移及检查通过后恢复业务和 Cron，最后恢复已经修正的构建触发器。

旧版本排空判据必须在真实 Cloudflare 环境确认。无法证明时保持停服并阻止 DDL，不提供忽略排空记录的快捷开关。此前实例不会因管理员数量变化重新进入首次安装。

## 网页升级与维护恢复

访问 `/maintenance`。正常服务期间或新构建刚关闭准入、尚未越过排空屏障时，可用管理员会话换取绑定升级任务的短期维护会话；业务结构不可用时，可用新的临时 User API Token 恢复。恢复必须向当前实例可信绑定的 Worker 写入一次性临时挑战，由目标运行时观察后签发会话。令牌有效、只读 Worker 或能写其他 Worker 均不足以证明权限。挑战不轮换已有认证密钥。

新构建会自动关闭业务准入。即使已经显示 draining，网页和 CLI 仍须保存当前升级任务的备份确认，才能推进排空与迁移；上一次任务的确认不会沿用。备份确认不代替旧版本排空的终态证据。

安装及维护入口先于浏览器账号、品牌和普通认证初始化运行。控制表有独立引导和协议版本；旧库、迁移中途失败和未知业务迁移不会使维护入口依赖最新业务表。

网页和 CLI 共用持久化维护协议：原子关闭新准入，登记请求及后台任务，排空 D1 与 R2 工作，再获取独占执行代次。执行锁默认 90 秒，执行期间每 15 秒尝试续期，使用数据库时间。接管增加代次；每个写事务在同事务校验代次，旧执行者不能继续提交。R2 和 Cloudflare 配置操作先登记意图，结果不明时阻止冲突执行；租约过期不能证明它们已经结束。

安装会话使用随机令牌及数据库摘要，删除安装令牌不会丢失清理恢复能力。管理员提权、永久完成标记与 `cleanup_pending` 同事务提交；之后只允许授权主体重试清理，不重新开放配置和首个管理员创建。`waitUntil()` 仅能辅助推进，不能保证清理完成。[后台执行限制](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)

### 迁移和 CLI

历史 SQL 保持原样。构建迁移包识别完整触发器与顶层事务；一个迁移文件的全部语句、执行代次校验、迁移登记及进度提交必须处于同一个 D1 `batch()` 事务。保留外键延迟指令的原有顺序，不能按分号切开触发器或为分批拆散文件事务。

可以按文件、预处理批次和检查批次推进。确认 `MIGRATION_FILE_ROLLED_BACK` 时，当前文件已整体回滚，之前成功文件仍已提交；`MIGRATION_COMMIT_UNCONFIRMED` 或 `UPGRADE_STEP_FAILED` 表示提交结果待确认，须先核对持久化进度，不可盲目重试。其他检查失败保持维护状态。页面分别显示失败文件、当前文件和此前已提交列表，不将整轮未完成误称为整轮回滚。大规模回填超出平台限制时停止，保持维护并说明所需专项迁移，不能假设 CLI 可绕过 D1 限制。[批量事务](https://developers.cloudflare.com/d1/worker-api/d1-database/) · [执行限制](https://developers.cloudflare.com/d1/platform/limits/)

远程 CLI 通过同一维护接口推进，凭据只从私密文件读取：

```powershell
node scripts/database.mjs check --url https://accounts.example.com --cookie-file private-cookie.txt
node scripts/database.mjs migrate --url https://accounts.example.com --cookie-file private-cookie.txt --backup-confirmed
```

也可用 `--token-file private-token.txt` 进行写挑战恢复。Cookie 文件保存原始 Cookie 请求头；两个文件都不要提交 Git。只有明确核对可信原密钥、且没有旧密文可验证时，才可使用 `--confirm-key`；错误密文不能通过该参数跳过。旧 `--env staging|production` 远程直写方式不再用于升级。

## 本地开发、备份与发布验收

```powershell
pnpm install --frozen-lockfile
pnpm setup:local
pnpm db:migrate
pnpm db:check
pnpm dev
```

访问 `http://localhost:5173`。本地配置、模拟发信和测试 Turnstile 与公开模板分开，不发送真实邮件。`pnpm build` 在本地选择本地配置；`pnpm build:deploy` 及 Workers Builds 选择公开发布配置。手动选择私有部署配置时使用 `LOGINFLARE_CONFIG`，并在构建阶段确认目标。

`pnpm db:backup` 保存本地 D1/R2 快照与必要配置；联合备份前先停止写入。远程升级前另行核实 D1 恢复点、匹配的 R2 对象及认证密钥。Worker 回滚不撤销数据库和对象变化，恢复旧数据库不能重新生成已删除对象。完整远程备份系统不属于此安装向导。

发布必须通过 `pnpm check`、相关浏览器测试，并在明确授权的真实 Cloudflare 隔离资源完成以下验收：

- 全新部署、配置生效、跨设备邮箱验证及首个管理员完成；普通注册和未授权提权被拒绝。
- 已有实例首次停服切换，旧命令、请求和 R2 清理均得到处理；证据不足时拒绝升级。
- 网页/CLI 竞争、租约过期接管、旧执行者恢复均不会并发迁移或越代提交。
- 迁移失败后维护页仍可用；只读令牌、其他 Worker 令牌及重放挑战被拒绝。
- 完成提交后中断、删除令牌成功但响应丢失均可恢复，安装不会重开。
- 长度合法但与旧密文不匹配的密钥阻止升级。
- 对 `0014`、`0015` 的表复制、删除、重命名、触发器及登记步骤注入失败，当前文件整体回滚，之前文件保持已提交。
- 删除并撤销安装令牌后，再次自动构建部署仍保留资源、配置和认证凭据。

发布阻断的待验证项包括：旧版本与 R2 排空的可靠证据、发信接口最小权限、Secrets/挑战更新的实际观测与恢复、部署按钮及再次发布的绑定保留行为，以及远程 D1 历史迁移回滚和执行限制。每项记录官方依据或隔离实测证据；本地通过不代表完整线上流程已验证。
