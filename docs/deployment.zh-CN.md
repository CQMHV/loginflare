# 部署 Loginflare

[English](deployment.md)

可选的 R2 图片直出配置见[公开图片交付](public-media.zh-CN.md)。

[![部署到 Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CQMHV/loginflare)

需要新建仓库时，使用部署按钮。已有组织仓库时，在 Cloudflare 的 **Workers & Pages → 创建应用 → 导入仓库** 中选择它。两种方式都使用 `main`，构建目录为仓库根目录，构建命令为 `pnpm build:deploy`，部署命令为 `pnpm run deploy`，关闭此 Worker 的预览构建。资源 ID 由 Cloudflare 分配；发布会创建或绑定 D1，以及分别存放站点文件和实例密钥的两个私有 R2 桶。

登录域名须属于一个已接入 Cloudflare 的有效站点。账号须启用 R2；实际发信需要 Workers Paid 和 [Email Sending](https://developers.cloudflare.com/email-service/)。

默认桶名由完整 Worker 名称派生。超过 R2 的 63 字符限制时，名称会包含确定的 SHA-256 摘要前缀，避免长名称同前缀的 Worker 共用桶。已有实例绑定和显式配置的桶名保持不变。

1. 在 Cloudflare 填写三项 **Worker 机密**。如果导入已有仓库时连接页只提供构建变量，等 Worker 出现在控制台后，在其 **设置 → 变量和机密** 中填写。不要写入 Git 或构建变量。

   | 字段 | 示例或用途 |
   | --- | --- |
   | `SETUP_ORIGIN` | `auth.example.com`，将用作正式登录域名和 OIDC issuer |
   | `SETUP_ADMIN_EMAIL` | 接收首个管理员安装链接的邮箱 |
   | `CF_SETUP_TOKEN` | 下文所述的短期 Cloudflare **User API Token** |

2. 打开 Worker 的 `workers.dev` 地址查看进度。Worker 会连接正式域名、配置 `noreply@notify.<所属域名>` 发信地址，并创建 Turnstile。遇到 DNS 冲突时，按页面显示的记录在 Cloudflare 解决冲突，安装会从该步继续。
3. 打开正式登录域名，点击「发送安装链接」。在邮箱打开链接，选择用户名和密码，然后登录。链接只能使用一次，20 分钟后失效。首个管理员创建后才开放注册与 OAuth 授权。

### 安装遇到问题时

安装页会显示当前步骤、处理建议和诊断码。保留页面即可自动检查进度；修正安装配置后，程序会核对已有资源再继续。请在 Worker 的“设置 → 变量和机密”中核对上面的三项机密，不要把令牌填入网页表单、构建变量或 Git。

| 页面提示 | 下一步 |
| --- | --- |
| 安装授权被拒绝或令牌类型错误 | 核对 `CF_SETUP_TOKEN` 有效期，确认使用下文要求的 User API Token，并检查所选账号、站点和权限。 |
| DNS 或域名归属冲突 | 核对页面指出的记录及 Worker 自定义域名归属，确认用途后再处理，不要覆盖无关服务的配置。 |
| 等待发信域名验证或请求限流 | 保持页面打开等待自动检查；持续失败时检查 Email Sending 状态及 Worker 安装日志。 |
| 无法确认 Cloudflare 处理结果 | 之前的写入可能已成功。保留当前实例与资源，等待程序核对；不要重复新建、删除资源或清空数据库来重试。 |
| 实例密钥、私有存储或数据库不匹配 | 按下文恢复说明核对原有 D1、R2 和实例配置，不能通过重新生成密钥或清空数据恢复已有实例。 |

其他错误请用页面诊断码核对 Worker 安装日志。管理员邮件发送失败时，可在修正邮件配置后重新请求安装链接；已经有效的邀请不会因此失效。

### 一次性授权令牌

在 Cloudflare 的 **我的个人资料 → API 令牌** 中创建自定义 **User API Token**，设置短有效期，并留出 DNS 验证时间。将资源限定在选定的 Cloudflare 账号和登录域名所属站点：

- 账号权限：Workers Scripts **Edit**、Turnstile **Edit**、Email Sending **Edit**。
- 站点权限：Zone **Read**、Workers Routes **Edit**、DNS **Edit**。

只在 Worker 的 `CF_SETUP_TOKEN` 机密中填写一次。资源就绪后，Loginflare 会自动删除 Worker 中的安装机密；令牌本身在 Cloudflare 按设定时间到期。后续发布使用 Workers Builds 自己的部署凭据，需有 Workers、D1 和 R2 写权限。

### 更新与恢复

Workers Builds 从所连接仓库的 `main` 发布。发布脚本核对 Worker、存储绑定、迁移记录和最新分支。纯代码更新不执行迁移；已有实例只自动运行已审核并在[在线迁移清单](../migrations/online.json)登记 SHA-256 的文件。审核前要用具有代表性的数据和上一版 Worker 验证：结构变更期间和完成后，上一版都能继续服务。不兼容的结构变更另走审核过的运维流程，并预留停机窗口。

每个迁移文件和对应记录在同一批 D1 事务中提交。失败时日志指出具体文件，当前 Worker 继续服务；此前已提交的迁移保留。修正未提交的文件后从最新的 `main` 重试。已提交的迁移文件不要再修改。需要恢复数据库时使用 [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)。

重建 Worker 时，保留原 Worker 名称及 issuer，绑定原 D1、原站点文件桶和原私有桶。私有桶保留认证密钥及实例配置，保持公开访问关闭。原密钥缺失或指纹不匹配时，Loginflare 会停止启动。Worker 回滚不会还原 D1 或 R2。这个安装流程不接管旧版网页维护流程的数据库。
