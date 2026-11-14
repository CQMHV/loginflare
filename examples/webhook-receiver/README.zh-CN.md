# 签名通知接收端

[English](README.md)

独立 Worker 实现 [v1 合同](../../docs/webhooks.zh-CN.md)：接收 `POST /webhooks`，对原始请求体验证带时间戳的 HMAC，校验有限字段，并按事件 ID 写入 D1 inbox。重复事件返回 200，不覆盖首次记录；存储失败返回 503，让发送端重试。不执行外部业务副作用，也不公开 inbox 读取接口。

本地验证时，在 Loginflare 创建停用订阅，将 `.dev.vars.example` 复制为 `.dev.vars` 并填入仅显示一次的签名密钥。运行 `pnpm exec wrangler d1 migrations apply DB --local --config examples/webhook-receiver/wrangler.jsonc`，再运行 `pnpm example:webhook`，发送本地签名的测试事件。Loginflare 会拒绝环回接收地址；公开测试接收端需操作者自行配置公网 HTTPS 地址。

部署时创建独立 D1 数据库，将 ID 写入本示例配置，使用该配置应用自身迁移，将 `WEBHOOK_SECRET` 写入 Worker secret。自行部署并配置公开 HTTPS 域名后，再启用订阅。不要绑定 Loginflare 数据库；这些说明不会自动创建资源。

`pnpm check` 包含类型检查、Worker 集成测试与本示例的 `--dry-run` 构建。去重 ID 至少应保留至业务允许重放事件的期限结束，本例无限期保留。生产前明确个人数据保留与备份策略。业务写入应进入同一个 D1 事务，或由独立、可恢复且幂等的 inbox 消费者处理；写 inbox 后再调用 HTTP 不构成原子业务效果。
