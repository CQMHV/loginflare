# Hono / Workers Web 应用

[English](README.md)

这是独立的 OIDC 机密客户端，直接部署到 Workers，使用应用自己的 D1 保存会话；不要绑定 Loginflare 的数据库。本地 `server.mjs` 只负责 HTTPS 转接，Miniflare 执行同一份 Worker。

按[接入指南](../../docs/oauth.zh-CN.md)注册 Web 应用，将 `.env.example` 复制为 `.env` 并填写 issuer、client ID 和密钥，生成开发证书后运行 `pnpm example:web`。本地会话与自动生成的加密密钥保存在忽略目录 `work/server-web-state`，重启后保留。隔离测试可指定 `LOGINFLARE_WEB_STATE`，不要共享状态目录或密钥。

## 部署

1. 在示例 `wrangler.jsonc` 中设置 HTTPS 应用 origin、Loginflare issuer 和 client ID。在 Loginflare 中登记该 origin 的精确 `/callback`、`/logout-callback` 地址，允许 `openid profile email offline_access`。
2. 为应用单独创建 D1，把 database ID 写入 `SESSIONS` 绑定，并用示例配置执行 `migrations/0001_sessions.sql`。
3. 将 `LOGINFLARE_CLIENT_SECRET` 保存为 Worker secret。用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成 32 字节密钥，将其保存为 `LOGINFLARE_SESSION_KEY`。数据库备份须保留匹配密钥，改变密钥会使旧会话无法解密。
4. 完成类型和浏览器集成验证后，使用示例配置部署 Worker 并连接应用域名。资源创建和部署由运营者明确执行。

Cookie 只保存随机标识，其 SHA-256 摘要用作数据库主键。包含令牌与 CSRF 值的会话数据通过 AES-GCM 加密，行 ID 参与认证。会话有效期为八小时，定时任务每五分钟最多清理 500 条过期记录；按实际负载核对存储和清理容量。

刷新由 D1 条件写协调，跨 isolate 生效。竞争请求短暂等待已完成的刷新；崩溃或响应不明时不会重新消费已领取的令牌，而是要求重新登录。退出先删除本地会话，远程撤销未确认时明确提示。中央退出还会访问 Loginflare，其他应用的会话仍由各应用管理。

标准库校验 PKCE、state、nonce、issuer、audience、签名和 subject。上游请求限时五秒、响应限 64 KiB，禁止跟随重定向。不记录令牌或完整回调链接。示例只展示资料，实际产品可在此基础上增加业务页面。
