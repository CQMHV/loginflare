# API 资源、权限、角色与审计日志

[English](access-control.md) · [应用接入](oauth.zh-CN.md) · [架构](architecture.md)

Loginflare 沿用授权码和刷新令牌流程，为业务 API 签发绑定资源的访问令牌。管理员定义资源和权限，将权限组合为角色、给用户分配角色，并明确允许应用请求资源。用户同意授权是另一个独立条件；关联资源或同意授权都不会给用户自动分配角色。

## 配置业务 API

以订单 API 为例：

1. 在「管理后台 → API 资源」创建「订单 API」，标识符填写 `https://api.example.com`。
2. 添加权限 `orders:read` 和 `orders:write`，填写便于理解的显示名称。
3. 创建「订单查看者」等业务角色，选择 `orders:read`。
4. 在目标用户的管理详情页分配这个业务角色。
5. 在资源的应用区域，添加允许请求该资源的应用客户端 ID。
6. 为实时令牌检查另外创建一个服务端 Web 应用，将它也关联到该资源；密钥仅配置在 API 服务端。即使这个应用仅用于令牌检查，注册的回调地址仍须满足精确 HTTPS 地址规则。

资源标识符是无查询、片段和嵌入凭据的精确 HTTPS URI，用于定义令牌 audience，Loginflare 不会下载这个地址。需要更换标识符时创建新资源；修改显示名称不改变原有 audience。权限 scope 是稳定标识符，与可修改的名称、说明分开。`openid`、`profile`、`email` 和 `offline_access` 保留给身份协议。

业务角色与 Loginflare 的本站 `admin`、`user` 管理角色相互独立。名称为「管理员」的业务角色不会授予后台管理权限；本站管理员以用户身份访问业务 API 时，同样需要获得业务权限。

服务之间访问 API 时，管理员将业务权限 ID 分配给独立的机器角色，再把机器角色分配给机器应用。机器角色维护自己的资源关联和 scope 上限，不使用用户角色或浏览器会话，令牌 subject 表示机器而非用户。客户端凭据及生命周期规则见[机器身份](management-api.zh-CN.md)；下文人类用户的授权码流程继续执行原有同意和 MFA 检查。

## 请求资源令牌

继续使用应用当前的 OIDC SDK、授权码和 S256 PKCE，在授权请求中增加资源及业务 scope：

```text
resource=https://api.example.com
scope=openid profile email offline_access orders:read
```

首版每个流程请求一个业务资源。包含 `openid` 时，原生提供方还可能将 UserInfo 地址放入访问令牌的 audience。因此 API 应检查 audience 是否包含自己的精确资源标识，不能假定 `aud` 总是字符串。

当前 `openid-client` 服务端示例中的相应调用可以写为：

```ts
const resource = 'https://api.example.com';
const authorizationUrl = oidc.buildAuthorizationUrl(config, {
    ...authorizationParameters, // 保留原有 state、nonce、回调地址和 PKCE。
    resource,
    scope: 'openid profile email offline_access orders:read',
});
const tokens = await oidc.authorizationCodeGrant(config, currentUrl, checks, { resource });
const renewed = await oidc.refreshTokenGrant(config, tokens.refresh_token!, { resource });
```

按[接入文档](oauth.zh-CN.md)保存轮换后的刷新令牌并串行续期。资源、scope、所选账号、MFA 与用户同意贯穿同一个经过校验的授权流程；应用无法通过向令牌接口提交资源标识或角色名称自行获得权限。

请求的任一业务权限不可用时，整个请求会被拒绝，不会静默签发缺少部分权限的令牌。刷新不能扩大原始授权的 scope，也不能改为其他资源。

调用 API 时，将取得的**访问令牌**放入 `Authorization: Bearer …`。ID Token 用于向应用确认用户登录，不能作为业务 API 的访问凭据。不请求业务资源的普通登录继续使用现有身份令牌和 UserInfo 行为。

## Workers/Hono 鉴权示例

可运行的示例位于 [examples/worker-api](../examples/worker-api/README.md)，复用仓库已安装并固定版本的 Hono 和 JOSE，无须新增数据库、队列、账号存储或第三方服务。

示例依次检查：

- 配置好的 issuer 所发布的 JWKS、RS256 签名及 `typ: at+jwt`。
- 精确 issuer、API audience、有效期、用户、签发客户端与已签名 scope。
- 每次请求都通过认证后的 introspection 检查当前授权，不缓存成功的授权结果。
- 接口所需权限：GET `/orders` 需要 `orders:read`，POST `/orders` 需要 `orders:write`。

仅已取得的公开签名密钥会被缓存。示例拒绝上游重定向，限制 JWKS 和 introspection 的响应体大小及请求时间，不转发 Cookie。issuer、audience 来自 API 配置，令牌不能指定验证请求的目标地址。本地开发允许环回 HTTP issuer，部署后使用 HTTPS。

缺失、过期、撤销、签名错误、audience 错误等不可用凭据返回 `401 invalid_token`；有效凭据缺少接口权限返回 `403 insufficient_scope`；验证服务不可用返回 `503 authorization_unavailable`，不会在故障时放行。POST 仅演示写权限校验，不持久化订单。

### 实时授权与撤销

JWT 在过期前仍可能通过签名验证。仅在本地检查签名无法观察之后发生的角色调整、资源限制、应用停用、账号停用或授权撤销；资源访问令牌的有效期限制了这种离线接受窗口。

示例在本地验证后进行实时 introspection，使 Loginflare 可以结合当前资源、应用、用户权限及授权状态，在 JWT 到期前拒绝访问。使用 API 独立的机密客户端凭据，密钥始终留在服务端，只关联该 API 实际服务的资源。不能把这个密钥交给公开 SPA。示例不缓存成功的 introspection 结果。

移除用户角色或角色权限、删除权限或资源、停用资源或应用、取消应用与资源的关联，会永久撤销受影响的 API 授权。恢复角色或关联不会让旧 JWT、刷新令牌重新可用，需要重新发起授权；没有变化的角色分配不会触发撤销。只在本地验证 JWT 签名的 API 仍存在上文说明的过期窗口。

API 仍需自行执行对象级规则。例如 `orders:read` 允许读取订单，但某个具体订单是否属于当前用户，需要业务 API 另行判断。业务角色管理不自动实现数据行归属、组织或租户隔离。

## 管理接口

以下同源 JSON 接口要求有效且邮箱已验证的本站管理员；写操作检查精确 Origin、内容类型和输入字段，使用当前标签页选中的账号。底层提供方的资源管理接口继续不直接对外开放。

| 操作 | `/api/admin/access` 下的路径 |
| --- | --- |
| 列出、创建资源 | `GET/POST /resources` |
| 读取、修改、删除资源 | `GET/PATCH/DELETE /resources/:id` |
| 列出权限 | `GET /permissions` |
| 创建资源权限 | `POST /resources/:id/permissions` |
| 修改、删除权限 | `PATCH/DELETE /permissions/:id` |
| 列出、关联允许的应用 | `GET/POST /resources/:id/applications` |
| 取消关联应用 | `DELETE /resources/:id/applications/:clientId` |
| 列出、创建角色 | `GET/POST /roles` |
| 读取、修改、删除角色 | `GET/PATCH/DELETE /roles/:id` |
| 读取、替换用户的业务角色 | `GET/PUT /users/:userId/roles` |

分页列表沿用有界查询和签名游标。提交的权限 ID、角色 ID 都由服务端验证，不能分配不存在的权限，也不能借此把用户提升为本站管理员。控制台删除操作需要确认，同时移除相关关联。用户同意、应用资源范围和用户业务角色分别管理。

资源访问令牌默认有效期为 300 秒，可配置为 60–3600 秒。每个资源和每个角色最多包含 100 个权限，每个用户最多分配 100 个业务角色，实例最多登记 1000 个业务权限。

## 审计日志

「管理后台 → 审计日志」提供事件分页列表与详情。记录操作类型、成功或失败、操作者与目标标识、应用、时间、请求 ID，以及可取得且长度受限的客户端地址和 User-Agent。认证、MFA、授权和安全操作分别记录；第一因素通过但验证未完成，不计为完整登录成功。

`GET /api/admin/audit-logs` 使用签名游标，支持按 `event`、`outcome`、`actorUserId`、`targetUserId`、`clientId` 精确查询；`GET /api/admin/audit-logs/:id` 读取单个事件。普通用户及应用所有者身份不授予日志读取权限。访问控制管理的变更和审计记录在同一事务内写入。

审计保留 90 天，纳入现有有界定时清理。日志不保存密码、验证码、Cookie 值、客户端密钥、Bearer 令牌及完整 OAuth、邮件验证地址，与采样的 Worker 请求诊断日志分开。人类操作者使用 `actorUserId`，机器自动化使用 `actorClientId`，后者也支持精确查询。[版本化管理 API](management-api.zh-CN.md)通过独立机器 scope 提供相应访问控制管理和审计读取。本轮使用 D1 存储事件，不增加 Webhook 或完整外部日志导出流水线。

## 升级与验收

切换到新版本前，沿用现有迁移工具应用 `0019_api_access.sql` 和 `0020_audit_logs.sql`，保留 issuer、数据库和认证密钥。主 Worker 复用现有绑定和清理任务。

在隔离环境验证应用与资源关联、最小权限、缺失及错误 audience 的令牌、MFA 与用户同意续接、刷新、移除角色后的实时检查，以及审计访问权限。自动测试不授权操作真实账号、生产流量或远程迁移。
