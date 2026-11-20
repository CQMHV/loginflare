# 运行诊断与恢复

[English](operations.md)

`GET /api/health` 只检查 Worker 在线，不访问 D1 或 R2。`GET /api/readiness` 在正式域名上的实例能读取 D1 和当前私有密钥材料时返回 200，否则返回不含配置细节的 503；它绕过正常的 30 秒材料缓存。探测应设置合理间隔，例如每分钟一次。它不发送邮件、不调用 Turnstile，也不检查媒体投递。未完成安装的实例不就绪。

生产环境为所有返回 5xx 的 `/api/` 请求写入 `http_request` 结构化日志，对其他 `/api/` 响应采样 1%。使用请求 ID 排查故障；采样日志不能计算精确登录转化率。认证审计区分未完成 MFA 和已完成登录，正常的认证拒绝不属于服务故障。

`durationMs` 从 Worker 入口计至响应创建，包含安装状态解析与浏览器账号选择；不包含后台 `waitUntil` 投递和响应体传输。它不是浏览器 TTFB，也不是单独的数据库耗时。

2026 年 12 月 1 日，Workers Logs 从按事件条数计费切换到 Cloudflare Observability 计费。现有 Free、Pro 和 Business 账户自动切换，Enterprise 账户在合同续签时切换。摄入量按未压缩字节计算，包含 Cloudflare 自动附加的字段。适用的 Observability 数据集共享账户额度，默认保留 7 天。LoginFlare 保留 90 天的审计记录存储在 D1，独立于这些额度。 [切换前的 Workers Logs 定价](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing) · [Cloudflare Observability 定价](https://developers.cloudflare.com/observability/pricing/)

- **Free** 每天包含 0.5 GB 摄入额度。用尽后 Cloudflare 停止接收新事件，直到 UTC 00:00 重置。已接收的数据在到期前仍可查询。
- **Paid** 每个账期包含 50 GB 摄入额度和 10 GB-month 存储额度。超出后，摄入按 $0.25/GB 收费，存储按 $0.10/GB-month 收费。按均匀摄入和保留 7 天估算，每账期摄入约 43 GB 时就可能开始产生存储费。

切换后，在 Cloudflare 控制台选择生产 Worker 所在账户，打开 **Billing → Billable Usage**，查看 Observability 的摄入量、存储量、剩余额度和预估费用。Free 账户重点对照高峰日摄入量与日额度，Paid 账户同时检查账期内的摄入和存储。排查用量突增时，打开 **Workers & Pages → 生产 Worker → Observability**，查看对应时段的事件。账户总用量也可能包含其他 Worker 和数据集。 [Cloudflare 用量与计量](https://developers.cloudflare.com/observability/pricing/#plans) · [查看 Worker 日志](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#view-logs-from-the-dashboard)

`/assets/*` 和 `/favicon.svg` 下的公开文件由 Workers Static Assets 直接提供，不执行应用 Worker。维护环境专用配置时，应保留选择性的 `assets.run_worker_first` 路由和 `public/_headers`。HTML 页面、安装、API 和 OIDC 元数据仍经过 Worker；R2 图片读取也可通过明确配置的[公开图片域名](public-media.zh-CN.md)绕过 Worker，写入继续经过认证接口。页面路由显式读取根 HTML 以注入品牌，不存在的静态文件返回 404，不再回退为 SPA 页面。静态响应通过 `_headers` 保留安全头，并使用默认 ETag 缓存校验，无哈希脚本也不会被长期缓存。前置 WAF 仍可能独立统计或拦截这些请求，与 Worker 计费及应用限流无关。

必须保留 `REQUEST_LIMITER` Workers 限流绑定：每个边缘提供的来源地址每分钟最多放行 600 次动态请求，IPv6 按 /64 合并，并在安装、认证和 D1 读取之前执行。静态资源和 `/api/health` 的 GET/HEAD 请求除外。Cloudflare 的计数是单个位置上的近似限流，不代表全局配额；原有接口级和账号级额度继续生效。拒绝请求返回 429 和 `Retry-After`，限流绑定故障返回 503。更新环境专用 Wrangler 配置时应保留此绑定。

所有发信入口共享 D1 原子配额：每个规范化收件地址每分钟 3 封、每天 20 封；每个实例每分钟 300 封、每天 10,000 封。固定窗口从首次预留的尝试开始，收件地址键只保存 SHA-256 摘要。投递前先预留额度，服务商故障或结果不明仍计入尝试；额度不足时不替换已有验证码。匿名验证、账号恢复入口在抑制投递时仍返回不泄露账号状态的响应，已认证的验证码操作返回 429 和 `Retry-After`。额度耗尽应与投递故障分别排查；应用配额不能代替服务商限制或运营侧费用控制。

Webhook 扫描在产生事件的用户变更、通知配置变更及明确重试后触发，定时投递继续承担恢复。登录流程记录和其他无关的成功写请求不再启动空投递扫描。

认证 5xx 可通过 `X-Request-ID` 关联 `auth_request_failed.requestId`。固定的 `reason` 区分 `TURNSTILE_UNAVAILABLE`、`DATABASE_ERROR` 和 `AUTH_INTERNAL_ERROR`，不记录原始上游错误或 SQL。Turnstile 网络或 HTTP 故障返回 503 和 `TURNSTILE_UNAVAILABLE`，验证被拒绝仍返回 4xx。MFA 期间移除通行密钥会返回 400 和 `PASSKEY_NOT_AVAILABLE`，包括最终会话插入瞬间的删除竞态；此时应使用可用方式重新登录。

监控 readiness、5xx、延迟、`email_recovery_delivery_failed`、`database_maintenance_failed` 和部署输出；其他邮件错误沿请求失败路径记录。邮件持续失败时检查投递配置，不绕过邮箱验证。清理故障应先检查最早积压任务和执行预算。不要记录请求体、Cookie、令牌、完整 OAuth 地址或邮件链接。

启用账号 Webhook 后，还应检查 `webhook_delivery_failed`、`webhook_maintenance` 和最早的待投递、失败记录；接收端失败不会阻塞登录。将实例认证密钥与加密订阅密钥一并保留，独立接收端的 secret、inbox 去重记录及归档/检查点备份也应保持一致。相关改动后运行[隔离事件恢复演练](webhooks.zh-CN.md#投递与恢复)。审计转存失败由独立 Worker 记录 `audit_export_failed`，有界轮询须在源审计 90 天保留期内追上进度。

升级前核对 Worker、D1、媒体 R2、PRIVATE R2、issuer、迁移账本与待执行文件摘要。在线迁移必须验证旧 Worker 仍可服务后再审核 `migrations/online.json`，不能仅以 SQL 成功为依据。保留原私有安装材料及指纹。

本地恢复前停止全部写入，按[扩容文档](scaling.md#schema-and-recovery-gate)制作并校验快照，再恢复到隔离状态目录。检查结构、外键和媒体引用，并实际验证密码登录、已启用的 TOTP、旧会话与刷新令牌轮换。

远程恢复保留原绑定和 issuer，使用经过核对的 D1 恢复点，并恢复匹配的 R2 数据与私有材料。单独的 D1 恢复点不能证明跨存储一致性，不要对已恢复数据重新运行首次安装。Worker 回退只恢复代码。本版本不提供一键远程导入恢复命令，也不承诺恢复时长或生产吞吐。
