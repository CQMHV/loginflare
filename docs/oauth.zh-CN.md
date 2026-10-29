# 外部应用与 OAuth/OIDC

[English](oauth.md) · [架构说明](architecture.md) · [中文 README](../README.zh-CN.md)

Loginflare 使用 `@better-auth/oauth-provider` 和 Better Auth 1.7.13，让独立 Web 应用使用已有账号登录。协议行为由上游提供；Loginflare 通过正式扩展接口和 D1 约束增加应用管理、本地化同意页面及账号安全策略。

## 接入约定

Issuer 为 `${AUTH_URL}/api/auth`，例如 `https://identity.example.com/api/auth`。先确定公开 Origin，再注册应用；部署后保持 issuer 稳定。客户端应通过发现文档获得各接口地址。

| 客户端 | 认证方式 | 密钥位置 | 授权方式 |
| --- | --- | --- | --- |
| 服务端 Web | `client_secret_basic` | 仅应用服务端 | 授权码与 PKCE S256 |
| SPA | `none` | 无客户端密钥 | 授权码与 PKCE S256 |

范围为 `openid profile email offline_access`：`openid` 用于用户身份，`profile` 允许读取资料字段，`email` 允许读取邮箱字段，`offline_access` 请求可刷新的授权。Loginflare 管理员角色不是外部应用的权限，不加入身份声明。ID Token 描述已认证身份，不能当作业务 API 的 Bearer 凭据。

本轮不提供机器客户端授权、原生/移动客户端、设备授权、动态注册、自定义资源 audience 或业务 API 权限。UserInfo 使用不透明 Access Token，ID Token 由 Better Auth JWT 插件使用 RS256 签名。

应用管理仅对管理员开放，应用归属于整个实例，由管理员共同管理。后台可创建、编辑名称、精确回调地址、精确退出回跳地址和允许范围，停用、恢复应用以及轮换服务端客户端密钥。类型在创建后固定。密钥明文仅在创建或轮换时显示一次，不在列表中返回。

`GET /api/admin/applications` 是有界管理列表，与 OAuth 协议分开。它接受签名游标和完整客户端 ID 或名称的精确检索，只返回摘要字段、ISO UTC 创建日期、前后页游标和 issuer。后台在 URL 中保留游标与检索，仅显示本页条数。配置详情和变更继续使用上游管理 API；回调 Origin 和退出 URI 的索引投影避免协议检查枚举全部客户端，原生精确回调校验仍为准。接口约定和本地验证边界参见[规模说明](scaling.md)。

所有应用首次接入都需要用户同意；新增权限范围需要再次授权，不提供跳过同意的“可信应用”开关。

登录与退出回跳均须注册精确 HTTPS 地址。Web 客户端规则拒绝通配符、片段、内嵌凭据、HTTP 和直接使用回环主机名/IP 的地址。上游区分客户端认证能力与 URI 应用类型：Loginflare 两种客户端都使用 `application_type: web`。本地示例使用 `web.localhost` 等 HTTPS 子域，保持此规则，不把浏览器应用改为原生应用类型。

## 协议接口

除特别说明外，下列路径均相对于 issuer。协议由上游提供，Hono 限制公开路径、方法、请求格式与跨域访问。

| 用途 | 路径 |
| --- | --- |
| OIDC 发现 | `/.well-known/openid-configuration` |
| OAuth 授权服务器元数据 | `/.well-known/oauth-authorization-server` |
| 签名公钥 | `/jwks` |
| 授权 | `/oauth2/authorize` |
| 交换及刷新令牌 | `/oauth2/token` |
| 用户信息 | `/oauth2/userinfo` |
| 撤销令牌 | `/oauth2/revoke` |
| 检查令牌 | `/oauth2/introspect` |
| 应用发起中心退出 | `/oauth2/end-session` |

`/.well-known/oauth-authorization-server/api/auth` 则相对于公开 Origin。JWT 插件单独的 `/token` 不是应用登录接口，继续关闭。

SPA 协议请求使用与已注册回调关联的精确 Origin。这不会开放 Loginflare 账号或管理接口的跨域访问，不应为了 CORS 将外部应用加入账号体系的 `trustedOrigins`。发现文档和签名公钥不要求用户会话。

登录与同意页默认使用 `/en-us/`，用户可以切换 `/zh-cn/`。语言切换、注册、验证邮箱与找回密码过程须原样保留签名 OAuth 查询；过期流程从外部应用重新开始。

Loginflare 登录页允许使用主邮箱或用户名和同一密码登录，两种方式均执行邮箱验证、Turnstile 与账号停用检查，并继续原有签名授权请求。辅助邮箱可以接收验证及找回密码验证码，不能作为登录账号标识。切换主邮箱会更新后续邮箱声明，不改变用户 ID、用户名或 OIDC subject。用户名是可以修改的登录标识，与显示名称分开；应用应使用 OIDC `sub` 作为稳定的账号标识。

## 上游默认有效期与生命周期

锁定版本的源代码使用以下默认值。这些是令牌有效期上限，不保证凭据在整个时间段内始终可用。

| 凭据 | 默认值 |
| --- | --- |
| 授权码 | 600 秒 |
| Access Token | 3,600 秒 |
| ID Token | 36,000 秒 |
| Refresh Token | 2,592,000 秒 |
| 刷新令牌重放宽限 | 0 秒 |

刷新令牌会轮换。客户端应保存新令牌，串行处理同时发生的刷新请求，不能复用已消费的旧令牌。示例通过标准 SDK 处理协议。

停用应用使用上游的停用标记，不会批量删除所有凭据；恢复后，原本仍有效且未过期的凭据可能重新可用。轮换 Web 客户端密钥会替换客户端认证密钥，但不会撤销所有已签发令牌。轮换后须更新应用服务端受保护的配置。

锁定版本的撤销和 introspection 接口要求机密客户端认证。因此 SPA 示例不会在没有密钥时调用这些接口并声称撤销成功。

原生刷新令牌撤销也会删除关联的 Access Token；重复撤销已撤销或不存在的令牌，在此版本可能返回错误。Web 示例先撤销 Access Token，再撤销 Refresh Token，始终清除本地会话。远程撤销失败时，会明确提示本地已退出，但远程撤销未能确认。

应用退出和 Loginflare 中心退出是两个操作：

- 退出当前应用会清除应用自己的会话或内存令牌。服务端 Web 示例还会使用自身密钥请求撤销凭据；撤销失败会明确报错。
- 中心退出通过原生 `end_session_endpoint`，携带 ID Token hint 和已注册的退出回跳地址。确认与对应 Loginflare 会话的终止由上游处理。普通中心退出保留原生 `offline_access` 刷新授权；账号与授权仍符合条件时，可以继续换取新令牌。
- 本轮不会通知所有其他应用清除各自会话。应用自行管理会话有效期，不应仅凭旧 ID Token 判断账号当前状态。

原生退出确认页仅发送 Origin 形式的 referrer，不发送协议查询；表单策略仅放行精确已登记退出回跳地址的 Origin，继续保留上游签名 Cookie 确认校验。

签名密钥使用上游的 D1 模型，保持 JWT 私钥加密开启。常规部署应保留数据库、issuer 和认证密钥。当前 JWT 配置未开启自动签名密钥轮换。

## 账号安全事件

普通退出与主动安全撤销具有不同含义。Loginflare 在原生 OAuth 行为上应用以下策略：

| 操作 | OAuth 授权影响 |
| --- | --- |
| 普通退出或应用发起中心退出 | 保留原生离线刷新授权，不视为账号安全撤销 |
| 撤销指定会话 | 永久撤销源自该会话的授权 |
| 撤销其他会话或修改密码 | 撤销其他会话的授权，包括原会话已普通退出的离线授权；保留当前会话授权 |
| 重置密码 | 撤销用户全部 OAuth 授权 |
| 管理员撤销用户全部会话 | 撤销用户全部 OAuth 授权 |
| 停用账号 | 撤销用户全部 OAuth 授权，拒绝后续签发和 UserInfo 访问 |
| 恢复账号 | 允许重新登录和授权，不恢复已撤销授权 |

小型 `oauthGrantPolicy` 表记录原生授权的最初会话，使刷新轮换和普通退出后仍能追溯。Better Auth 正式生命周期钩子先设置 `session.oauthRevokedAt`，D1 触发器在同一语句中撤销已有授权；插入约束阻止原生会话删除前的间隙继续签发首次授权，也阻止并发刷新在撤销后插入有效后继令牌。签发与 UserInfo 通过上游 claims 扩展检查邮箱验证和停用状态。这套策略不替代授权码处理、刷新轮换或令牌签名。

过期清理由独立的有界定时批次执行。仍被保留凭据引用的会话或刷新令牌不会被删除，授权策略也会保留到相关凭据有效期和引用允许回收之后。因此普通离线刷新和安全撤销的语义不取决于清理是否已经执行。

外部应用可能另有本地会话或已验证过的 ID Token，Loginflare 撤销凭据不会自动抹除这些本地产物。应用自行决定会话有效期与重新验证方式，本轮没有跨应用协同退出。

## 标准客户端示例

示例是仓库内独立运行的应用，不增加生产服务或多包结构，使用根项目锁定的开发依赖 `openid-client` 6.8.8、`oidc-client-ts` 3.5.0。

| 示例 | 本地地址 | 回调路径 | 退出回调路径 |
| --- | --- | --- | --- |
| 服务端 Web | `https://web.localhost:5181` | `/callback` | `/logout-callback` |
| SPA | `https://spa.localhost:5182` | `/callback` | `/logout-callback` |

1. 启动 Loginflare，以管理员登录，创建服务端 Web 应用，配置 `https://web.localhost:5181/callback` 和 `https://web.localhost:5181/logout-callback`。再创建 SPA，使用对应的 `https://spa.localhost:5182` 地址。示例允许全部四个范围。
2. 将各示例的 `.env.example` 复制为 `.env`，填入应用标识与 Web 应用仅显示一次的密钥。`.env` 已被 Git 忽略。不能将密钥放入 `VITE_` 变量。默认 issuer 为 `http://localhost:5173/api/auth`。
3. 使用下面的命令生成本地证书。需要已安装 OpenSSL，脚本也会寻找 Git for Windows 随附的版本；必要时用 `LOGINFLARE_OPENSSL` 指定已安装的可执行文件。脚本只写入被忽略的 `work/example-tls/key.pem`、`cert.pem`，不更改系统信任或 DNS。

```powershell
pnpm example:tls
pnpm example:web
pnpm example:spa
```

分别在两个终端运行 Web 和 SPA 命令，再访问表中的地址。生成的证书涵盖两个主机名，有效期为 30 天；可以接受本地浏览器证书提示，或用 `LOGINFLARE_TLS_KEY`、`LOGINFLARE_TLS_CERT` 指定环境已信任的开发证书。用 `pnpm example:tls --force` 可重新生成示例证书，不能将私钥或证书提交到 Git。

服务仅监听 `127.0.0.1`。支持标准 `.localhost` 行为的浏览器会在本地解析这些名称。如果 DNS 代理覆盖了此行为，可配置仅用于开发的浏览器解析规则，将 `web.localhost` 和 `spa.localhost` 指向 `127.0.0.1`；自动化浏览器测试使用了这两条精确 Chromium 解析规则。仓库不会修改 hosts、安装根证书或创建隧道，测试中的证书例外仅作用于本地测试浏览器上下文。

Web 示例把密钥、令牌、应用会话保存在 Node 进程中，通过 `openid-client` 校验 state、nonce、issuer、audience 和 ID Token 签名，读取 UserInfo 时匹配预期 subject。浏览器只保存随机 HttpOnly、Secure、SameSite=Lax 会话 Cookie，应用表单校验 Origin 和会话内 CSRF 值。请求发生时，若 Access Token 剩余不足一分钟便刷新。重启后会话丢失，示例不是生产会话存储方案。

SPA 的 SDK 用户与令牌仅保存在内存中。SDK 的短期授权事务使用 `sessionStorage` 以跨越页面回跳；另有一个布尔值记录刷新页面后是否重新发起顶层授权。localStorage 和 sessionStorage 均不保存令牌。页面打开期间通过 SDK 的刷新令牌流程续期；清除本地状态不代表服务端令牌已撤销。

示例展示资料字段，不打印 Access Token、Refresh Token、客户端密钥或完整回调链接；错误提示也不直接输出可能包含协议数据的 SDK 异常。

## 验证

Workers 测试覆盖协议行为与独立的安全事件策略。浏览器测试通过实际 Web、SPA 示例验证应用管理、本地化同意、刷新、应用退出、中心退出及 SPA 内存存储，现有账号、主题与移动端检查仍包含在测试中。

单纯构建成功或 SDK 类型检查通过不能证明互通。使用 `pnpm test`、`pnpm test:e2e` 和 `pnpm build` 做本地验证。测试使用本地 D1 和模拟邮件，不涉及远程资源、真实邮件、隧道或部署授权。

参考：[Better Auth OAuth provider](https://better-auth.com/docs/plugins/oauth-provider)、[openid-client](https://github.com/panva/openid-client)、[oidc-client-ts](https://authts.github.io/oidc-client-ts/)。
