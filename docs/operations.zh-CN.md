# 运行诊断与恢复

[English](operations.md)

`GET /api/health` 只检查 Worker 在线，不访问 D1 或 R2。`GET /api/readiness` 在正式域名上的实例能读取 D1 和当前私有密钥材料时返回 200，否则返回不含配置细节的 503；它绕过正常的 30 秒材料缓存。探测应设置合理间隔，例如每分钟一次。它不发送邮件、不调用 Turnstile，也不检查媒体投递。未完成安装的实例不就绪。

生产 `http_request` 结构化日志对正常请求采样 1%，记录所有 5xx。使用请求 ID 排查故障；采样日志不能计算精确登录转化率。认证审计区分未完成 MFA 和已完成登录，正常的认证拒绝不属于服务故障。

监控 readiness、5xx、延迟、`email_recovery_delivery_failed`、`database_maintenance_failed` 和部署输出；其他邮件错误沿请求失败路径记录。邮件持续失败时检查投递配置，不绕过邮箱验证。清理故障应先检查最早积压任务和执行预算。不要记录请求体、Cookie、令牌、完整 OAuth 地址或邮件链接。

启用账号 Webhook 后，还应检查 `webhook_delivery_failed`、`webhook_maintenance` 和最早的待投递、失败记录；接收端失败不会阻塞登录。将实例认证密钥与加密订阅密钥一并保留，独立接收端的 secret、inbox 去重记录及归档/检查点备份也应保持一致。相关改动后运行[隔离事件恢复演练](webhooks.zh-CN.md#投递与恢复)。审计转存失败由独立 Worker 记录 `audit_export_failed`，有界轮询须在源审计 90 天保留期内追上进度。

升级前核对 Worker、D1、媒体 R2、PRIVATE R2、issuer、迁移账本与待执行文件摘要。在线迁移必须验证旧 Worker 仍可服务后再审核 `migrations/online.json`，不能仅以 SQL 成功为依据。保留原私有安装材料及指纹。

本地恢复前停止全部写入，按[扩容文档](scaling.md#schema-and-recovery-gate)制作并校验快照，再恢复到隔离状态目录。检查结构、外键和媒体引用，并实际验证密码登录、已启用的 TOTP、旧会话与刷新令牌轮换。

远程恢复保留原绑定和 issuer，使用经过核对的 D1 恢复点，并恢复匹配的 R2 数据与私有材料。单独的 D1 恢复点不能证明跨存储一致性，不要对已恢复数据重新运行首次安装。Worker 回退只恢复代码。本版本不提供一键远程导入恢复命令，也不承诺恢复时长或生产吞吐。
