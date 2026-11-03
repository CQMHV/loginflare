# 第三方登录

[English](social.md) · [部署说明](deployment.zh-CN.md) · [应用接入](oauth.zh-CN.md)

管理员在 **管理控制台 → 第三方登录** 配置 Google、GitHub、Microsoft、Discord、X、Telegram、通用 OpenID Connect 和 OAuth 2.0 连接器，同一类型可创建多个实例。外部应用继续使用 Loginflare 的 issuer 和 OAuth/OIDC 接口，无须持有上游客户端凭据。上游访问令牌、刷新令牌和 ID Token 仅用于本次认证，不保存用于业务 API 或退出。

## 配置连接器

1. 创建连接器，填写显示名称、客户端 ID 和密钥。新建连接器默认停用。将生成的完整回调 `${AUTH_URL}/api/auth/callback/<连接器ID>` 登记到上游客户端的回调白名单。
2. Google 使用 Web 应用 OAuth 客户端，按平台要求配置同意屏幕及测试用户。GitHub 使用 OAuth App 并登记授权回调地址。Microsoft 在 Entra 应用注册中添加 Web 重定向 URI，填写应用（客户端）ID 和客户端密钥的值；租户默认为 `common`（工作、学校及个人账号），也可选择 `organizations`、`consumers` 或具体租户 UUID，须与应用支持的账号类型一致。Discord 在 Developer Portal 创建应用并登记 OAuth2 Redirects。预设复用 Better Auth 的提供方实现与固定协议端点；Microsoft 默认只请求 `openid profile email`，Discord 请求 `identify email`，所有预设均启用 state 和 PKCE，Microsoft 另外校验签名、issuer 与租户、audience 和 nonce。
3. OIDC 填写精确的 issuer、discovery 地址、scopes 及客户端认证方式。Discovery 返回的 issuer 必须一致；授权、令牌、UserInfo 和 JWKS 地址均须为公开 HTTPS 服务。连接器验证签名、issuer、audience、有效期和 nonce，始终包含 `openid` scope。
4. OAuth 2.0 填写授权、令牌、受保护用户资料端点、scopes 和客户端认证方式。通过点分 JSON 字段名映射稳定 subject、昵称、邮箱、邮箱已验证布尔值和头像地址，例如 `data.id`；可选字段留空即不读取。不能执行脚本或表达式。Subject 必须是提供方分配的稳定标识，不应使用邮箱或昵称。普通 OAuth 仅信任受保护用户资料接口，不信任未经验证的 ID Token。
5. 保存后点击 **测试登录** 检查返回资料，再启用连接器。测试只进行上游认证，不创建用户或身份绑定；仅当前管理员可发起。在连接器列表拖动手柄调整顺序，松开后自动保存；也支持触屏拖动和键盘操作。测试使用已保存配置。

**X**：在开发者控制台配置 OAuth 2.0 的机密 Web App，登记连接器完整回调地址，填写 OAuth 2.0 客户端 ID 和密钥。预设使用 `users.read tweet.read`、state 和 S256 PKCE，从受保护的用户资料接口读取稳定用户 ID，不请求离线访问或写入权限。配置步骤详见 [X 官方 OAuth 2.0 指南](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)。

**Telegram**：在 BotFather 中打开机器人的 **Login Widget** 设置，将连接器回调登记到 **Allowed URLs**，使用该处显示的 Login 客户端 ID 和客户端密钥，不是 Bot API Token。预设采用标准 OIDC 授权码流程，使用 `openid profile`、state、S256 PKCE 和 nonce；验证 ID Token 的签名、issuer、audience 和有效期后读取稳定 `sub`，不单独请求 UserInfo，也不索取手机号或机器人消息权限。详见 [Telegram Login 官方说明](https://core.telegram.org/bots/telegram-login)。

密钥通过 `BETTER_AUTH_SECRET` 加密保存到 D1，管理响应仅返回是否已配置。编辑时密钥留空表示保留，也可输入新密钥覆盖。备份须保留对应服务端密钥；直接替换密钥而不迁移密文会使连接器凭据及未完成流程失效。

连接器 ID 永久稳定且不可复用。首次绑定身份后，类型、客户端 ID、Microsoft 租户、身份来源/端点和 subject 映射永久锁定，解绑后仍不能替换；更换来源须新建连接器。仍可更新密钥、名称、scopes 和排序。保存认证配置、停用或归档会使旧版本未完成流程失效；仅调整排序不改变配置版本或中断认证。归档不可撤销。停用、归档会移除登录按钮并阻止新登录，但不会主动撤销已建立的本站会话。

## 连接器图标

Google、GitHub、Microsoft、Discord、X 和 Telegram 预设自带品牌图标，无须上传，已有连接器也会自动显示。默认图标跟随所选提供方类型变化；OIDC 和 OAuth 2.0 使用通用符号。自定义图标优先显示，切换类型时保留；移除自定义图标或图片加载失败时，恢复当前提供方的默认图标。默认图标随本站打包，不请求外部资源。

连接器编辑弹窗可通过现有图片选择器上传 PNG、JPEG、WebP 或 SVG 图标，与头像和品牌 Logo 共用文件限制：位图原文件最大为 20 MiB、单边最大为 16384 像素、总像素不超过一亿；SVG 原文件和所有处理后上传文件最大为 256 KiB。预览、裁剪后保存连接器，图标才会发布。位图统一编码为 256 像素方形 WebP；SVG 沿用现有校验并保留矢量输出。登录、注册按钮、账号绑定列表和第三方再次认证入口使用相同的图标规则。

图标存入现有 R2 存储桶，并通过本站同源地址提供。配置只接受已上传的 `iconId`，不接受任意图片 URL。上传后未保存的文件以及被替换的旧图标，会在一小时宽限期后纳入现有有界清理；仍被任一连接器引用的共享图标继续保留。修改图标不会改变绑定身份的来源或 subject。

## 注册与账号联动

身份由「连接器 ID + 稳定 subject」确定，上游邮箱或昵称改变不会改变身份归属。提供方返回可信已验证邮箱时直接创建无密码普通账号，不要求用户名；否则先完成本站邮箱验证，完成前不创建用户、占位邮箱或登录会话。Microsoft 的普通 `email` 声明不自动视为已验证，Discord 只信任资料中的 `verified: true`；未获可信验证状态时使用本站邮箱补全流程。X 和 Telegram 首次注册须补填并验证本站邮箱，X 账号认证标记及 Telegram 手机号验证均不作为邮箱验证。所有主邮箱和辅助邮箱均保持唯一。邮箱冲突时不会合并账号：请先登录原账号，再从 **账号中心 → 安全设置** 显式绑定。

可以绑定不同邮箱的第三方账号，但不会修改或增加本站邮箱。绑定和解绑均须先确认身份，并绑定发起用户及会话。解绑通过原子检查保留至少一种可用登录方式，已停用或归档连接器不计入。解绑不会删除用户资料。

有本站密码时，敏感操作继续确认当前密码；无密码时，通过已绑定的第三方身份重新认证，如已开启本站 MFA 还须完成动态码验证。服务端签发绑定用户、当前会话和操作用途的五分钟单次凭据，覆盖绑定/解绑、邮箱修改、首次设置密码和 MFA 管理。邮箱找回可为无密码账号补设密码，保留 MFA，并撤销旧会话、应用授权及未完成认证凭据。已绑定提供方均不可用时，可通过本站已验证邮箱恢复。

第三方登录不能绕过本站 MFA。验证器动态码或恢复码成功前，不交付可用的新会话或下游授权码。语言、操作目的和已签名的应用授权上下文贯穿回调、邮箱补填和 MFA，完成后由现有 OAuth Provider 继续授权。下游 `sub` 始终是本站用户 ID。

每次登录仅补齐为空的昵称和头像，已有值、主邮箱和用户名保持原值。缺少昵称时保留未设置，显示层可回退邮箱。头像只通过受保护的同源接口下载认证资料中的地址，复用图片校验、居中方形裁剪、256 像素 WebP 编码和私有 R2 生命周期；最终写入再次检查头像仍为空。导入失败不阻断登录，下次登录重试，主动删除头像后也会重新尝试。

## 接口与运维

- `GET /api/social/providers`：仅公开已启用连接器的名称、类型、图标地址和顺序。
- `POST /api/admin/social-connections/icon` 上传图标，返回 `iconId` 和 `iconUrl`。与头像和品牌 Logo 上传共用 256 KiB 上限，超限统一返回 HTTP 413 和 `IMAGE_UPLOAD_TOO_LARGE`；静态位图上传仍限制单边最大 2048 像素。将可为空的 `iconId` 随连接器配置保存；`GET/HEAD /social/icons/:id` 提供经过校验的图片。
- `GET/POST /api/admin/social-connections`、`PATCH /api/admin/social-connections/:id`：管理员管理接口；更新须提交当前版本，归档记录仍可查看。创建和编辑请求不接受 `position`。`POST /api/admin/social-connections/reorder` 使用完整的 `{ order, previousOrder }` ID 列表原子保存顺序；列表已被其他管理员修改时返回冲突。`POST /api/admin/social-connections/:id/test` 接受语言参数，发起测试登录。
- `/api/auth/social/start`、`/social/flow`、`/social/email`、`/social/verify-email`、`/social/finish`：受限认证入口，只接受连接器、语言、目的及经验证的续接/安全上下文。管理员通过 `purpose: test` 测试；回调为 `/api/auth/callback/:id`。
- `GET /api/auth/social/security` 返回实际安全能力及身份；`/social/unlink`、`/social/set-password` 与现有邮箱/MFA 接口执行敏感操作。浏览器不能覆盖上游端点、scopes 和回调地址。
- 通用连接器仅访问公开 HTTPS，校验 DNS 与同源 GET 重定向，并限制时间和响应体大小，拒绝私网、环回、元数据和保留地址。连接器故障不初始化或影响本站密码登录。
- 迁移 `0012_social_connections.sql` 增加加密的十分钟浏览器绑定单次状态、五分钟操作凭据、身份唯一约束和来源锁定。现有定时维护有界清理过期记录，不改变已有用户 ID 或应用 issuer。
- 图标功能新增迁移 `0013_social_icons.sql`，保存连接器图标引用及 R2 清理元数据。运行包含图标功能的版本前须先应用该迁移，继续复用现有 D1 和 R2 绑定。

- 迁移 `0014_social_provider_presets.sql` 扩展 Microsoft/Discord 类型并锁定已绑定 Microsoft 租户，保留已有连接器、图标、身份和未完成状态。
- 迁移 `0015_social_x_telegram.sql` 扩展 X/Telegram 类型，保留已有连接器、绑定、图标引用和未完成认证状态。

自动测试仅使用隔离模拟上游，不操作真实第三方账号；真实平台验收须运营者提供配置好的客户端凭据。本轮不包含 SAML、组织级 SSO、微信/QQ 专用流程、第三方业务 API 授权/令牌托管或联动退出。
