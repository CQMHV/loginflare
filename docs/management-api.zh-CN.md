# 机器身份与管理 API

[English](management-api.md) · [API 访问控制](access-control.zh-CN.md) · [OAuth 接入](oauth.zh-CN.md)

Loginflare 将机器身份与用户、浏览器会话分开。管理员创建机器应用和机器角色，分配所需权限，将客户端 ID 与一次性密钥交给自动化服务。服务通过 `client_credentials` 获取短期 OAuth 访问令牌，不需要冒充管理员登录或使用浏览器 Cookie。

版本化接口为 `/api/management/v1`。公开的 `GET /api/management/v1/openapi.json` 提供 OpenAPI 3.1 文档，包含输入字段、响应结构、接口 scope、分页和错误；文档不包含实例数据或凭据。其他管理接口要求当前有效且 audience 精确匹配的机器访问令牌。

## 创建最小权限机器身份

1. 在「管理后台 → 机器角色」创建角色，仅选择任务需要的权限。例如定时检查审计日志只需 `management:audit:read`。
2. 在「管理后台 → 机器应用」创建应用，将一次性客户端密钥保存到自动化服务的私有配置。
3. 为机器应用分配角色。新建应用没有默认管理权限。
4. 在服务端配置 issuer、客户端 ID 与密钥。不能把机器密钥交给 SPA、浏览器脚本或无法保密的客户端。

机器角色与用户业务角色、本站 `admin` 管理员角色相互独立，可以包含管理 scope 和已登记的业务 API 权限。角色变更维护服务端控制的客户端授权上限及允许资源；机器不能通过修改令牌请求扩大权限。每个令牌请求一个资源，其他业务 API 的令牌不能用于管理 API。

人类管理员使用 `/api/admin/machines` 管理机器应用、角色分配、密钥轮换及令牌撤销，创建或编辑机器角色并查看权限。这些接口沿用当前标签页账号和管理员验证。公开管理 API 及普通开发者登录应用不能创建或修改机器权限。

## 获取管理令牌

向已配置 issuer 的原生令牌接口发送表单，使用 `client_secret_basic`：

```text
POST https://identity.example.com/api/auth/oauth2/token
Authorization: Basic <客户端ID与密钥分别表单编码，以冒号连接后Base64>
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
resource=urn:loginflare:management
scope=management:audit:read
```

响应包含 `access_token`、`token_type: Bearer`、最长 300 秒的 `expires_in` 以及实际 `scope`，不签发 ID Token 或刷新令牌。需要时使用机器当前凭据重新获取访问令牌；每个任务显式请求最少权限，读与写分别授权。

令牌是 RS256 JWT，类型为 `at+jwt`，issuer 为 `${AUTH_URL}/api/auth`，`sub` 是机器客户端 ID，并带有 `lf_principal: machine` 及服务端签发的机器凭据代次。每次管理请求均验证签名、精确 audience、有效期、当前应用状态、权限上限与代次。浏览器会话、用户访问令牌、ID Token 和其他 API 的令牌不能认证管理调用者。

固定资源 `urn:loginflare:management` 由迁移建立；资源管理不能借重命名、停用、删除或关联它来获取机器权限。本轮没有动态客户端注册、模拟管理员或机器自行授权入口。

## 权限与操作

下表路径均相对于 `/api/management/v1`：

| Scope | 操作 |
| --- | --- |
| `management:users:read` | `GET /users`、`GET /users/:userId` |
| `management:users:write` | `PATCH /users/:userId` 修改 `name` 或 `banned`；`POST /users/:userId/revoke-sessions`，请求体 `{}` |
| `management:applications:read` | `GET /applications`、`GET /applications/:clientId` |
| `management:applications:write` | `POST /applications`、`PATCH /applications/:clientId`、`POST /applications/:clientId/rotate-secret` |
| `management:resources:read` | 读取资源、权限列表和允许的应用关联 |
| `management:resources:write` | 创建、修改、删除业务资源及权限，关联或解除允许访问的登录应用 |
| `management:roles:read` | `GET /roles`、`GET /roles/:id`，读取用户业务角色 |
| `management:roles:write` | 创建、修改、删除用户业务角色 |
| `management:role-assignments:read` | `GET /users/:userId/roles` |
| `management:role-assignments:write` | `PUT /users/:userId/roles`，请求体 `{ "roleIds": [...] }` |
| `management:audit:read` | `GET /audit-logs`、`GET /audit-logs/:id` |

资源、权限、业务角色及用户角色路径沿用[访问控制接口](access-control.zh-CN.md#管理接口)的字段规则，改用版本化前缀。角色分配替换用户完整的业务角色集合，空数组表示移除这些分配，不改变用户的本站管理员权限或机器角色。

机器用户管理不能修改密码、MFA、主邮箱、验证标记或本站角色，也不能修改管理员账号、停用管理员或撤销管理员会话。首版不提供通过机器创建用户或删除账号的接口。

创建登录应用的请求格式为：

```json
{
    "name": "Automated SPA",
    "type": "spa",
    "redirectUris": ["https://app.example.com/callback"],
    "postLogoutRedirectUris": ["https://app.example.com/"],
    "scopes": ["openid", "profile"]
}
```

响应是顶层应用对象，包含 `clientId`；服务端 Web 应用还返回一次性 `clientSecret`，列表和详情不会回显密钥。客户端类型和所有权不可修改。该接口创建普通 Web/SPA 登录应用，机器身份与机器权限继续由管理员管理。

## 请求、分页与错误

发送 `Authorization: Bearer <access_token>`，POST、PATCH、PUT 使用 JSON。浏览器账号选择标识及 Cookie 不授予机器权限。这是服务端接口，不开放浏览器跨域访问。

列表接收 `limit`（1–100，默认 20）与签名 `cursor`，返回 `{ items, pageInfo: { nextCursor, previousCursor } }`。游标绑定机器身份、列表和精确查询条件，应保持相同筛选，不能转给其他身份。支持的精确查询字段见 OpenAPI；审计可区分人类 `actorUserId` 与机器 `actorClientId`。

| 状态码 | 含义 |
| --- | --- |
| 400 | 字段、未知参数、游标或操作无效；应用校验可包含 `fieldErrors` |
| 401 | 缺失、过期、撤销或其他无效机器令牌，`WWW-Authenticate` 报告 `invalid_token` |
| 403 | 缺少接口 scope，或操作受保护的权限；缺少 scope 时报告 `insufficient_scope` |
| 404 / 409 | 目标不存在或状态冲突 |
| 429 | 触发限流，按 `Retry-After` 等待 |
| 5xx | 请求未能完成，验证失败时不会放行 |

停用机器、主动撤销令牌、轮换密钥及收缩权限会使旧令牌代次失效。恢复应用或重新增加权限不会复活旧令牌；配置经授权调整后需重新获取令牌。写事务会再次核验机器当前代次及权限，防止初始认证与数据库变更之间的并发撤销被绕过。

每个管理调用有请求 ID；变更与机器操作者的审计记录原子写入，读取及被拒绝的请求也有相应事件。日志不保存 Bearer 令牌、客户端密钥、Cookie 或完整协议地址。机器以 `actorClientId` 记录，不伪装成人类管理员。

写操作超时或响应丢失时，不要自动重试。服务器可能已经提交变更，应先检查实际状态，再决定是否重试应用创建、密钥轮换等操作。创建应用和分配角色是不同请求，不构成跨请求事务。

## 定时 Worker 示例

[examples/management-worker](../examples/management-worker/README.md)在每次可信调用内获取令牌，读取最新一页有界审计数据。默认 Cron 任务只请求 `management:audit:read`，公开 fetch 处理器只提供只读健康响应，没有操作触发入口，仅记录数量摘要。

导出的客户端还提供登录应用创建和用户业务角色替换，供可信的自动开通代码调用。示例使用生成的绑定类型、有界响应、超时和手动重定向处理，不在全局缓存令牌或未完成请求，不自动重试写操作。Web 应用密钥返回可信调用者另行私密保存，不写入日志，也不会被默认定时任务创建后丢弃。

## 部署

切换版本前应用 `0021_machines.sql` 与 `0022_machine_audit.sql`，新增机器角色、权限映射、代次检查、受保护的管理资源及独立审计操作者。已有用户和登录应用不会自动转换为机器。主 Worker 无须新增绑定或密钥；每个自动化服务使用自己的机器密钥，与 Loginflare 服务端密钥分别管理。

在隔离环境验证最小权限读写、普通用户令牌拒绝、系统资源保护、代次撤销、并发变更、审计归属和 OpenAPI。自动测试及示例构建不部署服务，也不操作真实账号。
