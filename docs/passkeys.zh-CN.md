# 通行密钥

[English](passkeys.md)

已验证且可用的账号可在**账号中心 → 安全 → 通行密钥**添加、列出、命名、重命名和删除凭据，管理员也可使用。先通过邮箱密码或配置的提供方注册，不开放通行密钥首次注册。

登录页点击**使用通行密钥登录**，支持从记住的账号和 OAuth 请求继续。首版使用显式按钮。认证器须通过 PIN 或生物识别解锁；已开启 TOTP 的账号仍须验证动态码或原有恢复码。通行密钥不能绕过邮箱验证、封禁、注销状态、多账号容量及已选账号限制。

## 部署

启用此版本前应用 `0026_passkeys.sql`，追加原生凭据表、内部会话引用、索引和守卫，不改变 issuer、用户 ID 或密钥。迁移对旧 Worker 为追加式变更，远程迁移批准和部署仍分别执行。

升级后，来源绑定引入前签发但尚未完成的 MFA 登录需要重新发起。新 challenge 会在现有验证记录中明确保留通行密钥或密码/提供方来源，无需额外迁移。待完成 MFA 期间删除凭据后，完成请求返回 HTTP 400 和 `PASSKEY_NOT_AVAILABLE`，最终插入竞态也返回该结果。验证开始前已经失效的凭据不会导致恢复码被消耗。

官方 `@better-auth/passkey@1.7.13` 与现有 Better Auth 版本一致。浏览器使用 `@simplewebauthn/browser@13.3.0`，两者均为 MIT 许可证，声明沿用现有脚本生成。浏览器库处理参数及序列化，不依赖较新的浏览器 JSON API。验证复用上游实现，在现有 Workers 运行时执行，无需新绑定或外部验证服务。

RP ID 固定为 `AUTH_URL` 的完整主机名，允许的 WebAuthn Origin 精确等于 `AUTH_URL`，不接受通配或父域覆盖。生产使用永久 HTTPS 登录域名，修改域名可能使既有凭据不可用；本地支持 `localhost`。不支持的浏览器继续使用密码或提供方。认证器须支持可发现凭据及用户验证。

## 管理与安全

较早建立但仍有效的会话，在完成当前密码或提供方重认证后也可登记。登记以该次精确重认证作为新鲜度依据，其他原生操作的会话新鲜度策略不变。

管理操作复用当前密码或已绑定提供方的敏感操作重认证。提供方证明为一次性，绑定用户、会话及 `passkeys/add`、`passkeys/rename`、`passkeys/delete` 用途。首版通行密钥只作为登录凭据，不作为敏感操作证明。请保留密码或可用提供方用于管理；已验证邮箱的密码恢复仍遵循原有规则。

每个账号最多 20 个凭据，名称去除首尾空白后为 1–100 个字符。列表返回名称、登记日期及设备/备份元数据，不返回公钥或凭据 ID。本站名称不会修改认证器条目。删除只移除本站凭据，需要时另行从系统或密码管理器移除副本。暂不发送 WebAuthn Signal API 同步：上游生成独立认证器用户句柄，未持久化用于构造可靠的完整凭据清单。

删除在同一写入中检查所有权、重认证，并要求仍有另一个通行密钥、密码或启用的提供方。并发删除不能移除最后一种可用登录方式。移除后不能再以该凭据认证，包括已开始但尚未完成 TOTP 或恢复码的登录。每个 MFA challenge 保留精确凭据与浏览器流程绑定，直到最终会话插入；删除另一个凭据不影响该次登录。既有会话遵循原有撤销语义。

| 方法 | `/api/auth` 下的路径 | 输入 |
| --- | --- | --- |
| POST | `/passkey/generate-register-options` | `{ password? }` |
| POST | `/passkey/verify-registration` | `{ response, name? }` |
| GET | `/passkey/generate-authenticate-options` | 待完成的浏览器认证流程 |
| POST | `/passkey/verify-authentication` | `{ response, oauth_query? }` |
| GET | `/passkey/list-user-passkeys` | 当前选择的会话 |
| POST | `/passkey/update-passkey` | `{ id, name, password? }` |
| POST | `/passkey/delete-passkey` | `{ id, password? }` |

写操作要求精确 Origin 和 JSON，不接受客户端登记上下文、`createSession`、目标用户或匿名登记。认证与管理端点均限流。原生 challenge 有效期五分钟，由原生 D1 适配器跨实例原子消费；签名 Cookie 按浏览器认证流程隔离。登记在最终插入时再次校验账号、会话和重认证版本，短期写入许可由插入触发器消费，未消费记录通过现有维护任务过期。内部版本守卫可能含既有密码哈希，不含明文密码。

注册和登录均在服务端强制认证器用户验证。上游检查 ceremony 类型、challenge、RP ID、Origin 和签名；数据库阻止计数器回退、不可用账号写入，以及使用并发删除的凭据创建会话。审计记录创建、改名、删除及登录结果，不记录凭据材料或认证响应。

## 清理、恢复与升级

账号注销追加有界阶段清理登记/许可和通行密钥，不重排已持久化阶段。整实例备份包含这些 D1 数据，恢复时须保持 issuer/RP ID。隔离恢复演练会实际登记软件认证器、恢复快照，再以该凭据登录恢复后的 Worker。

执行 `pnpm check`、`pnpm exec playwright test tests/e2e/passkeys.spec.ts` 和 `pnpm test:scale --sizes=10 --duration=3`。后者只验证小规模本地负载和恢复，不代表生产容量。依赖合同测试锁定上游版本、端点和凭据字段；升级时复核 challenge 原子消费、Origin/RP、用户验证、MFA hook、多账号/OAuth 衔接、最终写入守卫与恢复。浏览器验收使用 Chromium 虚拟认证器，真实设备及其他引擎仍需发布前冒烟验证。
