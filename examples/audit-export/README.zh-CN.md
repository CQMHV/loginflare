# 持久化审计转存

[English](README.md)

独立定时 Worker 通过现有管理 API 将白名单审计字段复制到自身 D1 归档，复用[管理客户端](../management-worker/src/client.ts)，仅请求 `management:audit:read`，每次调用取得短期令牌，不开放 HTTP 触发或归档读取接口。原管理示例仍用于读取最新一页；本示例补充持久化续读与去重。

创建专用机器应用与角色，只授予审计读取权限。配置 `AUTH_ISSUER`、`MACHINE_CLIENT_ID`，将 `.dev.vars.example` 复制为 `.dev.vars` 并填入 `MACHINE_CLIENT_SECRET`。用 `pnpm exec wrangler d1 migrations apply DB --local --config examples/audit-export/wrangler.jsonc` 应用本地迁移；运行 `pnpm example:audit-export`，调用其本地 `/__scheduled` 入口。隔离测试实例应使用独立数据库和状态目录。示例对 Loginflare 只读，写入仅发生在示例自身归档中。

部署前创建独立 D1，填入 ID，用本示例配置应用自身迁移，将机器密钥存为 Worker secret，审查每五分钟 Cron 后自行部署配置。不要将 Loginflare 数据库用作归档库。`pnpm check` 包含测试、binding 生成和部署 dry-run，不会部署。

每次调用取得 60 秒 D1 租约，先读取最新 100 条，再从上次游标继续较早记录的扫描。归档按审计 ID 去重，并与下一页签名游标一起提交。单次最多五页，使用 20 秒启动预算和有限网络请求。API 或存储失败保留已提交进度；进程中断后租约到期可恢复。扫描到底后，后续调用重新开始一轮，补到读取旧页期间新增的记录。源密钥轮换导致游标失效时重新扫描，以 ID 去重。更换 issuer 或机器身份会报 `ARCHIVE_SOURCE_CHANGED`；请明确为另一个源或身份使用新的归档库，不要混用游标作用域。

归档保留源提供的操作者/目标 ID、结果与原因、请求 ID、IP、User-Agent、事件时间；未知字段会被丢弃，不保存机器令牌、密钥或原始 API 响应。日志仅含计数或固定失败代码。归档访问、加密/备份、个人数据保留和后续转存由应用负责。本例无限期保留记录；D1 容量有限，需按自身场景规划并实现受审查的生命周期。

这是**至少一次读取并复制的示例**，不是源快照，也不保证无限吞吐或无损复制。源审计保留 90 天；没有额外调用时，Cron 每五分钟最多读取 500 条，还包括最新页和重复扫描的开销。必须在源过期前完成扫描，监控失败与积压；长时间停机或持续超预算负载可能让记录在读取前过期。只读轮询无法原子确认源删除。带租约检查点表示进度，不证明历史归档完整。业务 Webhook 通知使用另一份独立合同。
