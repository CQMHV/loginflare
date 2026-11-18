# 更新与恢复 Loginflare

[English](upgrading.md)

上游仓库维护源码、CI 和版本发行，不部署账号服务。下游 Fork 后可以修改源码，并将自己的仓库连接到 Cloudflare Workers Builds。完成[默认安装](deployment.zh-CN.md)后，对下游 `main` 的推送会自动构建、预检、执行兼容迁移、发布并验证，无须每次手动批准版本或运行升级命令。

## 同步目标版本

首个正式版本为 **0.1.0**，支持具有发布记录和私有实例存储的 23 项迁移基线（`aa10563825c7d7669e8be6d0ebab6aa35c84acf4`）及 27 项迁移基线（`3d721f99ee7de2cbf9471df298263fec9c9fb6a9`）。旧源码曾使用相同版本号，升级时按真实 Git 提交和迁移账本识别。维护者完成发行后，从上游选择固定标签。

## 从管理台准备更新

管理台的「版本更新」显示当前版本和上游最新正式版本。发现更新后，点「前往 GitHub 准备更新」，选择下游 `main`，再点 **Run workflow**。可以填写看到的版本标签，留空时使用运行时最新的正式版本。工作流准备一条供审阅的 PR，合并后才会触发正式部署。

首次使用时，在下游仓库启用 GitHub Actions 和 **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**。若 GitHub 要求批准机器人 PR 的检查，请按 PR 提示执行。Worker 只读公开发行信息，无需配置 GitHub 令牌。默认从构建仓库读取 GitHub 地址，无法识别时可在构建使用的 Wrangler `vars` 中设置 `LOGINFLARE_UPDATE_REPOSITORY` 为 `owner/repo`。

升级工作流核对已发布的上游标签及来源记录，再合并新旧版本之间的差异。遇到冲突、迁移顺序变化、无法确认来源或 GitHub 阻止更新工作流文件时，按运行日志在审阅分支手动同步相同标签。若已创建更新分支但 PR 创建被仓库策略阻止，修正权限后重跑即可。合并前检查下游 CI 和实例预检。

## 手动同步

1. 将上游目标版本合入自己的开发分支，保留品牌、自有源码、部署配置和迁移。解决冲突后运行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm test:upgrade` 和 `pnpm test:e2e`。
2. 如需提前检查远程实例，使用下文的只读工具。更新前保留 D1 Time Travel 恢复点，并确认原 PRIVATE 和 AVATARS 桶仍可恢复；工具不会导出账号数据或密钥。
3. 合入下游 `main` 即接受此次更新，Workers Builds 自动执行 `pnpm build:deploy` 和 `pnpm run deploy`。构建校验所选配置。发布核对实例、历史和资源，取得锁后迁移并发布。运维回归由 GitHub CI 和 `pnpm check` 执行。
4. 确认构建成功且发布阶段为 `verified`。已有账号服务须由目标构建返回健康的 readiness；首次安装只验证目标构建存活，之后按安装页面完成配置。

完整 GitHub CI 是上游发行门禁。下游 GitHub CI 与 Cloudflare Builds 默认独立运行，Cloudflare 自动部署不表示已经等待 GitHub 全部测试；本轮不新增等待工作流。需要合并前全绿时，在下游为 `main` 配置对应的 PR 必需检查。

## 独立升级工具

工具随源码版本交付，先切换到目标版本再运行。凭据仅从 `CLOUDFLARE_API_TOKEN` 读取，不写入命令参数、Git 或报告。沿用部署所需的账号读取、Workers、D1 和 R2 权限；只读命令不新增授权、不创建资源。

```sh
pnpm upgrade:status --remote --account ACCOUNT_ID --worker WORKER
pnpm upgrade:plan --remote --account ACCOUNT_ID --worker WORKER --json
pnpm upgrade:verify --remote --account ACCOUNT_ID --worker WORKER
```

`status` 报告阻断问题；`plan` 遇到阻断返回非零退出码。D1 的只读 SELECT 会经查询 API 的 HTTP POST 发送，不包含写入 SQL。报告包含目标资源 ID、源码提交、版本、已执行数量、待执行迁移、摘要、上次发布阶段和阻断原因，不包含用户资料或实例密钥。

`targetVersion` 表示当前源码的目标版本；`activeWorker` 表示线上绑定记录的版本和提交，旧版没有的信息显示为 `null`。从 Git 源码运行 `verify` 时还核对当前已提交的 HEAD；从没有 Git 历史的发行包运行时，仅验证版本、迁移、发布记录与服务的一致性，并标记 `sourceVerification: archive-version-only`。

远程报告的 `configuration` 列出使用的 Wrangler 文件和环境。预检、构建和发布请使用相同的 `LOGINFLARE_CONFIG` 与 `CLOUDFLARE_ENV`。默认文件是 `wrangler.jsonc`。所选配置或环境变更后需要重新构建。

需要主动重试整次发布时，在已提交、与 `origin/main` 一致的干净源码上运行：

```sh
pnpm build:deploy
pnpm upgrade:apply --remote --account ACCOUNT_ID --worker WORKER
```

主动发布与自动部署使用相同实现及保护。`--dry-run` 仍只是 Wrangler 打包演练，不替代远程只读预检。

本地数据库演练明确使用隔离目录，不接触开发数据库或远程资源：

```sh
pnpm upgrade:plan --local --state work/upgrade-demo --json
pnpm upgrade:apply --local --state work/upgrade-demo
pnpm upgrade:verify --local --state work/upgrade-demo
```

本地 `apply` 只演练数据库发布，不启动或发布 Worker。完整旧版及新版 Worker 的本地协议验证运行 `pnpm build` 后的 `pnpm test:upgrade`。该测试读取固定 Git 历史，浅克隆须先获取 `release.json` 中的基线提交；发行包不含 Git 历史，历史矩阵应在源码仓库运行。

## 迁移与自有修改

`release.json` 固定官方版本和迁移摘要，`migrations/online.json` 登记审核过的在线兼容迁移。0.1.0 已验证 0024–0027 执行后，23 项基线旧 Worker 的密码登录、原会话、OIDC PKCE、UserInfo 和刷新令牌仍可用；当前 27 项基线也通过相同回归。该证据由 `scripts/upgrade-compatibility.mjs` 持续验证，深度修改的 Fork 需要单独验证。

下游自有迁移保留原名称、摘要和审批记录；例如验收环境的 `0024_acceptance_probe.sql` 不属于官方迁移。新增自有迁移须追加到完整历史，并在代表性数据及自己的上一版 Worker 验证后登记 SHA-256。顺序冲突或已执行文件被改动时发布阻断，不会自动重排、改名或删除记录。未经审核或不兼容的变更另走维护流程。

旧版网页维护流程数据库不在自动接管范围内。必需迁移或实例密钥不完整时，新 Worker 不处理业务；安装入口和存活检查仍保留。迁移检查按实例缓存 30 秒，readiness 强制重新核对；不在每个请求扫描整个历史。发布前另行验证目标数据库结构。

## 失败后处理

| 阶段或问题 | 处理方式 |
| --- | --- |
| 预检阻断 | 按具体提示核对原 Worker、D1、两个桶、迁移历史；不要清空数据库或重新生成密钥。 |
| `migrating` | 单个迁移与记录在一批 D1 事务内提交；此前成功的迁移保留。修正未应用的问题后重试。 |
| `publishing` 或发布结果不明 | 发布可能已被接收，锁保留至租约到期。先查看 Cloudflare 活跃部署，不要删除锁或立即并发重发。 |
| `published` / `post-processing` | 新版已发布，后处理可能未完成。重新发布会继续幂等处理，不回滚此前成功的迁移。 |
| `verifying` | 新版可能已上线但健康未确认。检查活跃构建和日志，运行 `upgrade:verify`；验证通过不会擅自改写上次发布阶段，完整重试后才记录 `verified`。 |
| Worker 回滚 | 只改变运行代码，不还原 D1 或 R2。数据库恢复使用 D1 Time Travel，并核对原 PRIVATE 密钥和图片元数据的一致性。 |

公开图片域名、PRIVATE 私有性、issuer 与原有绑定均继续校验；同步版本不会自动开启 R2 直出。恢复操作与真实环境升级由下游维护者自行执行。

## 上游发行

维护者在版本说明、兼容性证据和全部 CI 就绪后，为准确的 `main` 提交创建版本标签，再手动运行 **Prepare source release**。工作流复跑同一提交的完整 CI、跨版本矩阵和浏览器测试，产出源码包、`SHA256SUMS`、来源信息及草稿 Release，不部署服务。检查草稿后再单独发布；工作流不覆盖已有 Release。
