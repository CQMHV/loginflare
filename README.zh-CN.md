# Loginflare

基于 Cloudflare 的开源账号与身份管理系统。

[English](README.md) · [部署说明](docs/deployment.zh-CN.md) · [应用接入](docs/oauth.zh-CN.md) · [架构说明](docs/architecture.md) · [规模与验证](docs/scaling.md)

Loginflare 是完整可用的通用账号与身份管理平台，面向从小团队到大型公开服务的独立部署。它包含面向用户的账号中心、管理控制台，以及供独立 Web 和 SPA 应用接入的标准 OAuth/OIDC 登录能力，支持邮箱或用户名登录、邮箱验证、密码恢复和会话管理。系统通过一个 Cloudflare Worker 运行，使用 D1、Email Service、Turnstile 和 Workers Static Assets。

维护者当前运行供本人功能验收的测试实例，这不限制独立部署的实际用途。该实例的管理后台仅限管理员访问。其他使用者通过 fork 代码、自行配置资源并独立部署来使用 Loginflare。Web/SPA 示例用于验证完整的应用接入流程；面向具体业务的应用可在独立分支中开发，加入各自的品牌和业务规则。

产品默认语言为 **`en-US`**，可手动选择 **`zh-CN`**。页面网址使用小写语言段：`/en-us/`、`/zh-cn/`。

## 功能

- 注册、验证邮箱、重发验证邮件，使用邮箱或用户名登录，以及退出。
- 找回密码，以及通过当前密码修改密码。
- 修改显示名称与用户名、查看和撤销活跃会话。
- 在独立页面管理主邮箱与辅助邮箱，通过验证码验证新地址并切换主邮箱。
- 按完整 ID、用户名或主邮箱精确查找与查看用户、停用与恢复普通账号、撤销用户会话。
- 管理员注册服务端 Web 与 SPA 客户端，配置精确回调地址、用户同意与客户端密钥轮换。
- 通过授权码 + PKCE S256 登录，提供 OIDC 发现、UserInfo、RS256 ID Token、刷新令牌和应用发起的中心退出。
- 英文和简体中文页面、错误提示与事务邮件。
- 复用 Better Auth 的账号与会话能力，使用 D1 原子持久化限流和定时过期数据清理，服务端验证 Turnstile。

当前版本不包含社交登录、MFA、组织、多租户、删除账号、网页分配角色、模拟登录或管理员代设密码。OAuth 机器客户端授权、原生/设备客户端、动态注册、自定义业务 API 权限和跨应用协同退出也不在范围内，相应接口不对外开放。

用户名与显示名称分别设置。注册表单要求填写唯一用户名，长度为 3–30 个字符，仅含英文字母、数字、下划线或点；用户名以小写保存，登录不区分大小写。已有账号可以继续通过邮箱登录，并在个人资料中补设用户名。用户名可以修改，设置后不能清空。两种登录方式均要求邮箱已验证，邮箱登录只接受主邮箱。

**邮箱管理**独立页面统一管理一个主邮箱和多个辅助邮箱，所有地址在全部账号间保持唯一，不区分主辅。添加邮箱需要当前密码，并验证发送到该地址的验证码。已验证的辅助邮箱经密码确认后可设为主邮箱，原主邮箱保留为辅助邮箱；删除主邮箱前必须先切换。找回密码先输入用户名或主邮箱，再向该账号指定的已验证主邮箱或辅助邮箱发送验证码。辅助邮箱不能作为登录账号标识。

## 界面

账号中心和管理后台使用独立布局与导航。个人资料、邮箱、安全和登录会话位于账号中心，用户与应用管理位于管理后台。管理员通过明确入口切换区域，普通用户不能进入后台。

页面采用 Material Design 3 风格，在 React 19 中使用 **Material Web（`@material/web` 2.5.0）** Web Components。认证页面、个人中心和管理后台通过共享的 MD3 设计令牌统一颜色、排版、形状和交互样式。组件随应用打包，界面采用系统字体，不通过外部 CDN 加载 UI 组件或字体。

主题以 Cloudflare 橙色（`#F38020`）作为品牌强调色和主按钮底色，搭配深色文字；链接与焦点指示采用深橙，以确保在浅色背景上的对比度。

浅色与深色主题默认跟随系统。主题菜单可选择浅色、深色或跟随系统，选择保存在当前浏览器中，刷新后保留并在标签页之间同步，与账号语言偏好独立。初始主题在 React 加载前应用，Turnstile 同步使用当前主题。

桌面滚动条采用主题主色的细圆角滑块和透明轨道，触屏设备保留原生滚动行为。

Material Web 采用 Apache-2.0 许可证，目前上游处于[维护模式](https://github.com/material-components/material-web/discussions/5642)。Loginflare 锁定其版本，并保留第三方许可声明。

## 本地开发

需要 Node.js 24 LTS 和 `packageManager` 中约定的 pnpm 11.25.0。项目的 Cloudflare 工具已锁定在开发依赖中。按锁文件安装依赖并生成本地密钥：

```powershell
pnpm install --frozen-lockfile
pnpm setup:local
```

`setup:local` 会生成被忽略的 `.dev.vars`，包含随机认证密钥和官方 Turnstile 开发测试密钥；已有文件不会覆盖。`.dev.vars.example` 用于说明变量，其中的占位认证密钥会被拒绝。然后初始化本地数据库并启动应用：

```powershell
pnpm db:migrate
pnpm db:check
pnpm dev
```

访问 `http://localhost:5173`，与配置的认证 Origin 保持一致。首次访问默认英语。开发邮件绑定会在本地模拟发送，可通过模拟输出获取注册验证链接及邮箱管理、密码恢复验证码；不需要发送真实邮件或创建远程资源。生产不能使用 Turnstile 测试配置。

开发与运维命令共享 `.cloudflare/state`，本地 CLI 配置和运行时注册文件放在 `.cloudflare/tool-config`；两者都已忽略。资源操作优先使用 `cf`。当前锁定的 `cf` 开发/构建路径要求 Beta 版 Vite 插件，因此开发、构建、Worker 类型生成和部署使用稳定 Vite/Wrangler。该 `cf` 版本也尚未实现本地 D1 查询，故本地管理员提权使用 Wrangler，远程 D1 操作继续使用 `cf`。

### 首个管理员

先将预期的管理员注册为普通账号，并完成邮箱验证，再运行本地运维命令提升指定邮箱：

```powershell
pnpm admin:promote -- --email admin@example.com --local
```

命令要求账号已存在且邮箱已验证，可重复执行。提升后退出并重新登录。第一个注册用户不会自动成为管理员；网页后台不能分配角色或停用其他管理员。

## 规模与数据运维

用户、应用和活跃会话列表通过创建时间与 ID 的复合索引进行签名游标分页。界面提供上一页、下一页和返回最新，仅显示本页条数；打开详情时在 URL 中保留游标和精确检索条件。列表不扫描精确总数，不使用 OFFSET。应用支持按完整客户端 ID 或名称匹配。接口与验证范围参见[规模说明](docs/scaling.md)。

当前只实现 D1 数据库后端。“百万注册账号”描述存储规模，不代表百万并发，也不是固定吞吐保证。公开部署前应结合实际流量、数据库大小、邮件量和 Cloudflare 套餐限制进行验证。Hyperdrive 或外部 SQL 数据库属于未来独立接入工作，当前不能切换使用。

迁移会把原生日期统一为 ISO UTC 文本，准备有索引的回调 Origin 元数据，并按已提交迁移检查最终结构。更新已有数据库前先备份，并将 issuer、认证密钥与数据库一起保留。过期数据由同一 Worker 的有界定时任务清理，不需要新增 KV、Queue、Durable Object 或其他 Cloudflare 资源。

## 验证

`pnpm check` 执行类型检查、Worker 集成测试、运维命令测试和生产构建；浏览器流程另用 `pnpm test:e2e` 验证。[CI 工作流](.github/workflows/ci.yml) 会在 PR 和推送到 `main` 时执行这两组检查，以及使用 10、10,000 个生成用户和三秒负载窗口的隔离规模检查。测试使用本地 D1、模拟邮件和 Turnstile 测试密钥，浏览器报告保留七天。百万用户基准仍单独手动运行。

```powershell
pnpm typecheck
pnpm test
pnpm test:ops
pnpm test:e2e
pnpm test:scale
pnpm build
```

浏览器测试会先构建应用，再于 `http://localhost:5174` 启动独立 Miniflare，数据和捕获邮件放在 `work/e2e/<run-id>`。测试夹具模拟 Turnstile，拒绝外部浏览器/API 请求并关闭 API 自动重定向；Worker 仅允许向自身发起本地 JWKS 请求。测试不复用日常开发数据库或服务。Windows 默认使用已安装的 Chrome，可用 `PLAYWRIGHT_CHANNEL` 指定其他浏览器渠道；其他平台默认使用 Playwright Chromium。安装依赖和浏览器仍需要正常下载。

集成与浏览器测试使用本地数据、模拟邮件和 Turnstile 测试响应，不应连接远程账号或数据库。`pnpm test:scale` 在独立目录使用生成数据验证规模，不创建付费 Cloudflare 资源，不发送真实邮件；参数与报告范围参见[规模说明](docs/scaling.md)。新机器设置 Playwright 时安装 Chromium：

```powershell
pnpm exec playwright install chromium
```

## 账号行为

- 验证邮箱后才能登录。
- 修改密码需要当前密码，成功后撤销其他会话。
- 重置密码撤销全部会话，需要重新登录。
- 停用账号撤销已有会话并阻止新登录；恢复账号不会恢复旧会话。
- 会话通过 D1 校验，不使用缓存的 Cookie 用户快照。
- 角色、邮箱验证状态和停用状态仅由服务端设置。
- 受保护响应不缓存；日志不应包含密码、会话令牌或完整的验证/重置链接。

密码长度为 8–128，注册邮箱验证令牌有效期为一小时，会话有效期为七天并按 Better Auth 默认规则续期，同时关闭 Cookie 会话缓存。邮箱管理与密码恢复验证码有效期为十分钟，最多尝试五次；恢复验证通过后，使用十分钟有效的令牌交给 Better Auth 原生流程重置密码。每个账号最多管理十个邮箱；未验证辅助邮箱占用超过一天后，再次添加该地址时可回收。

## 接入其他应用

管理员在**应用**页面创建客户端。服务端应用使用 `client_secret_basic`；浏览器 SPA 使用 `none`，不获取客户端密钥。两者均要求授权码 + PKCE S256，并在首次使用时取得用户同意。发现文档位于 `${AUTH_URL}/api/auth/.well-known/openid-configuration`。

[接入说明](docs/oauth.zh-CN.md)包含回调配置、令牌有效期、安全事件撤销策略，以及标准 `openid-client` / `oidc-client-ts` 示例。示例使用本地 HTTPS 子域和本地生成的证书，不修改系统证书信任，也不创建远程资源。

普通中心退出保留上游 `offline_access` 刷新授权语义。应用自行管理本地会话，退出 Loginflare 不代表所有应用都退出。密码恢复、停用账号等安全操作另有凭据失效规则，详见接入说明。

## 语言与网址

程序、翻译资源、账号偏好及 HTML `lang` 使用 `en-US` / `zh-CN`，网址语言段使用 `en-us` / `zh-cn`。显式页面网址决定当前语言，语言切换保留当前页面和查询参数，不改写大小写敏感的令牌。

根入口采用已保存偏好，没有偏好时使用 `en-US`；不会按浏览器语言自动切换中文。未知或大小写不规范的语言段返回 404。API 保持 `/api/*`，不加语言前缀。事务邮件采用账号语言偏好，完成验证或重置后返回对应语言页面。

## 部署

请查看[部署说明](docs/deployment.zh-CN.md)，配置测试与生产环境的数据隔离、密钥、域名和发信能力，再应用迁移、初始化管理员。

Cloudflare Email Sending 当前为 Beta，向任意用户发送事务邮件需要 Workers Paid。生产需要已验证发信域名和正式 Turnstile 配置。安全配置缺失时应用明确报错，不会跳过邮箱验证或防机器人校验。

本地安装、测试和构建不涉及远程资源创建、真实邮件发送或部署。执行这些操作时，应先确认目标环境并取得相应授权。

## 许可证

版权所有 © 2026 Loginflare contributors。

Loginflare 采用双许可证：使用者可自行选择 **[MIT](LICENSE-MIT) 或 [Apache-2.0](LICENSE-APACHE)**。SPDX 表达为 `MIT OR Apache-2.0`，包元数据使用 `(MIT OR Apache-2.0)`。参见 [LICENSE](LICENSE)。

第三方依赖及引入材料保留各自许可证和必要声明，不会因加入本项目而改用 Loginflare 的双许可证。构建时会根据锁定的运行时依赖重新生成[第三方许可声明](public/assets/third-party-notices.txt)，并包含在 `/assets/third-party-notices.txt` 中。
