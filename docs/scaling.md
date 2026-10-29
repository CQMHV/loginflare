# Scaling and local validation

[English README](../README.md) · [中文 README](../README.zh-CN.md) · [Architecture](architecture.md) · [Operations](deployment.md)

Loginflare is a complete account and identity platform for independent deployments, from small teams to large public-facing services. The maintainer's personal test instance is a deployment choice, not a product restriction. Operators supply their own Cloudflare resources and validate their own workload.

The implementation uses one Worker and one D1 database per environment. D1 is the only supported database backend. Hyperdrive, PostgreSQL, external SQL databases, sharding, and read replicas are not implemented deployment options.

## Capacity dimensions

A million registered accounts is a data-volume scenario. It does not mean a million concurrent sessions, simultaneous logins, or requests per second. Account records, active sessions, OAuth grants, email challenges, and rate-limit keys grow at different rates. The relevant limits depend on database size, write contention, traffic distribution, cryptographic work, email delivery volume, and the selected Cloudflare plan.

Local validation establishes correctness and query behavior in the local runtime. It cannot establish production D1 throughput, global latency, a Cloudflare service guarantee, or a safe public traffic ceiling. No production load-test result is claimed here. Plan remote capacity checks separately against a reviewed test environment and budget.

## Bounded list APIs

Account and management reads use these same-origin JSON endpoints:

| Endpoint | Authorization | Exact lookup fields | Additional response fields |
| --- | --- | --- | --- |
| `GET /api/admin/users` | Verified, active administrator | `id`, `username`, `email` | None |
| `GET /api/admin/applications` | Verified, active administrator | `clientId`, `name` | `issuer` |
| `GET /api/account/sessions` | Verified, active owner with a fresh session | None | `hasOtherSessions` |

The parameters are `limit`, `cursor`, and, for a lookup, the pair `lookupField` / `lookupValue`. The default limit is 20; accepted limits are integers from 1 to 100. User email and username lookups are normalized to lowercase. Application names match the complete stored name. Unknown parameters, duplicate parameters, unsupported fields, arbitrary sorts, offsets, and substring filters are rejected.

```text
GET /api/admin/users?limit=20
GET /api/admin/users?limit=20&lookupField=username&lookupValue=example_user
GET /api/admin/applications?limit=20&lookupField=name&lookupValue=Example%20Web
GET /api/account/sessions?limit=20
```

Each list returns this shape, with endpoint-specific item fields:

```json
{
    "items": [],
    "pageInfo": {
        "nextCursor": null,
        "previousCursor": null
    }
}
```

Application list items contain only `clientId`, `name`, `type`, `disabled`, and `createdAt`. Configuration details and client-secret creation/rotation remain separate operations. User lists project the fields needed for the management table. Session items retain the owner's native session token for native revocation; responses are private and must not be logged or cached.

The native `/api/auth/admin/list-users` and `/api/auth/list-sessions` endpoints are closed. There is no legacy alias or total-count response. Native `/api/auth/revoke-session` and `/api/auth/revoke-other-sessions` remain the session mutation operations.

Lists seek through descending `(createdAt, id)` indexes, or `(createdAt, clientId)` for applications, and read at most `limit + 1` result rows to determine the next boundary. Cursors are opaque HMAC-signed positions bound to the entity, owner, and exact lookup. Reuse the returned cursor with the same lookup; do not construct, edit, or transfer it between endpoints or users. Malformed or mismatched cursors return `INVALID_CURSOR`.

The UI offers Previous, Next, and Return to latest and reports only the current page's size. It preserves the cursor and search in the URL across reloads and detail navigation. Submitting a changed lookup starts at the latest matching records. Lists are live reads, not database snapshots: concurrent edits and deletions can change visible records. Return to latest restarts from the current newest boundary.

`hasOtherSessions` is an independent existence check across the owner's active sessions. The ability to revoke other sessions does not depend on how many records happen to be on the current page. The current-session badge compares stable session IDs.

## Indexed protocol lookups

OAuth protocol processing remains owned by the pinned Better Auth provider. Loginflare stores parsed callback Origins in `oauthClient.metadata.loginflareRedirectOrigins` and maintains an indexed `oauthClientUri` projection for exact Origin and post-logout destination checks. Migration preparation uses the URL parser; client creation and updates synchronize the projection through database triggers. Native callback strings remain authoritative. Protocol checks no longer enumerate every application to find an allowed destination.

The application list uses a bounded projection rather than loading every client configuration. Client mutation, detail lookup, authorization-code consumption, refresh rotation, consent, token signing, and secret hashing continue to use native provider behavior.

## Atomic limits and maintenance

Authentication and list request boundaries consume persistent rate limits using a conditional D1 UPSERT. Checking and incrementing the allowance is one atomic database operation. A denied request neither increments the count nor extends the window. Storage failure fails closed; Turnstile and the endpoint-specific authentication rules remain enforced.

A Cron Trigger invokes expiry maintenance every five minutes on the same Worker. It needs no Queue, Durable Object, KV namespace, external service, or extra Cloudflare resource. Each run is limited by batch count and elapsed time and uses expiry indexes with a safety buffer. It processes rate counters, email challenges, native verification records, expired sessions/tokens, and eligible OAuth grant policy.

Reference checks prevent collection from deleting a refresh token with retained access-token records or a session still referenced by credentials. Grant-policy collection waits until credentials and relevant session lifetime no longer require the policy. This preserves revocation and offline-refresh semantics. Authentication still checks validity on use; expiry does not wait for garbage collection. Cleanup is independent of request latency and can resume after a partial run.

Maintenance emits counts, deferred records, and budget state without credentials. Persistent backlog, repeated failures, or exhausted budgets require operational review; they are not reasons to delete live token or grant-policy rows manually.

The Cron handler does not delete `userEmail` addresses. An unverified secondary address reserved for more than 24 hours remains subject to the existing targeted, lazy reclaim when that same address is added again. Verified addresses, primary addresses, and account records are outside expiry collection.

## Schema and recovery gate

Native Better Auth `DATE` columns use ISO UTC text. Custom email-challenge timestamps and rate-limit counters use explicit integer milliseconds. Request queries do not alternate between date encodings.

Before SQL migrations, the operator wrapper prepares stored callback metadata and normalizes native dates in bounded batches. Origin updates compare the old metadata and callback strings and abort on a concurrent change. After migration the gate checks committed table/column definitions, indexes, triggers, foreign keys, native date storage, and callback-metadata/URI-registry consistency. Run a read-only local check with:

```powershell
pnpm db:check
```

Remote checks require explicit environment selection:

```powershell
node scripts/database.mjs check --env staging
```

The migration wrapper includes the final check. Automated deployment must stop when preparation, migration, or the schema gate fails. Runtime schema autodiscovery is disabled; it is not a replacement for this gate.

Upgrades need an operator-controlled write window: pause application registration, callback editing, and related writes until preparation, migrations, final checks, and the new Worker switch complete. Compare-and-set and consistency checks detect conflicts; they do not establish this window or reconfigure an existing remote build trigger automatically. See the [deployment procedure](deployment.md).

Create a consistent local snapshot with `pnpm db:backup`, optionally followed by an output directory. By default a fresh timestamped backup is written under `work/backups/`. The manifest includes local D1 snapshots, existing `.dev.vars`, and managed local credentials. Treat it as private authentication material. Recover the matching database, origin, and authentication secret together; encrypted signing keys depend on that secret.

Stop development before restoring `d1/` files to `.cloudflare/state/v3/d1` and restoring other manifest files to their original paths. Run restore verification in an isolated directory. A local backup is not a remote D1 recovery point. For a remote update, use the reviewed environment's D1 recovery facilities and verify its target before restoring.

## Local scale harness

```powershell
pnpm build
pnpm test:scale
pnpm test:scale --sizes=10,10000 --duration=30
```

The default registered-user dataset sizes are 10, 100,000, and 1,000,000. Workload windows default to 30 seconds and exercise concurrency levels of 1, 10, and 50. `--sizes` selects a smaller set for iteration; `--duration` controls the window length in seconds. Generated state and reports live in a fresh `work/scale/<run-id>` directory, separate from the normal development database. The harness does not reuse staging data, create Cloudflare resources, send real mail, or deploy anything.

Regular CI runs `pnpm test:scale --sizes=10,10000 --duration=3` after the platform build. These smaller datasets exercise the same mixed operations, concurrency levels, maintenance, and restoration checks, without enforcing machine-dependent latency or throughput thresholds. Any invalid or failed workload request saves the report and fails the command. The million-user run remains an independent manual validation.

Read the generated report together with the machine/runtime details, dataset composition, workload, concurrency, duration, errors, and query plans. Local throughput and latency numbers describe that specific run. Compare index use and behavior across dataset sizes; do not turn one local requests-per-second figure into a remote capacity claim. Test results must distinguish seeded volume, active workload, and concurrency.

Worker tests cover pagination boundaries, ownership, cursor rejection, concurrency-sensitive limits, expiry cleanup, and credential/security invariants. Browser tests exercise URL persistence, exact lookup, detail return, forward/back navigation, current-session marking, and revoking other sessions from a tail page containing only one record. Protocol and SDK tests remain necessary; faster list queries do not by themselves establish OAuth interoperability.

All automated database and email work remains local. Browser flows use a separate Miniflare at `http://localhost:5174` and generated state/mail under `work/e2e/<run-id>`. Test fixtures emulate Turnstile and reject external browser/API traffic; the Worker permits only a local request to its own JWKS endpoint for the native logout verifier. API automatic redirects are disabled. Neither the test-only browser widget nor the Miniflare delivery stub is imported by the production Worker. Remote resource creation, paid-environment traffic tests, production email, and deployment require their own explicit operator action.

## Recorded local validation

The [local benchmark report](benchmarks/local-scale.md) and [machine-readable measurements](benchmarks/local-scale.json) record the completed 2026-10-29 run (Asia/Shanghai). Each dataset used three 30-second mixed-workload stages at concurrency 1, 10, and 50. All 14,399 measured requests succeeded; warmup, grant setup, maintenance, and restoration checks are separate from those request counts.

| Registered users | Seeded SQLite size (MiB) | Measured requests | Errors | Restored session and refresh |
| ---: | ---: | ---: | ---: | --- |
| 10 | 0.35 | 4,617 | 0 | Passed |
| 100,000 | 120.04 | 5,133 | 0 | Passed |
| 1,000,000 | 1,208.92 | 4,649 | 0 | Passed |

These sizes include the associated fixture accounts, addresses, sessions, applications, grants, and token-rotation history; they are not a bytes-per-user guarantee. Indexed user-list and exact-lookup requests used four SQL statements, the indexed Origin probe and atomic limit operation used one, and native refresh used ten in this workload. Statement counts stayed the same across the three dataset sizes. They are not billed `rows_read` or `rows_written`.

Snapshot restoration checked SQLite integrity, foreign keys, the original user count, and the matching local authentication secret. A Worker started on the restored copy accepted the original session cookie and rotated the last native refresh token. Maintenance preserved the active session and grant in all three datasets. All outbound requests were intercepted locally; the blocked-request count was zero.

Read the full report for hardware, runtime versions, fixture composition, latency percentiles, and query plans. The results describe a local closed-loop mixed workload with test-only CAPTCHA/mail and suppressed terminal logs. They do not establish Cloudflare network latency, sustained production throughput, a production SLA, or a D1 bill. Data volume, active load, retention, deployment limits, and real-world latency must be evaluated separately for an actual deployment.

## 中文摘要

项目定位覆盖小团队到大型公开平台的独立部署；维护者只运行测试实例，不限制其他部署的用途。当前后端仅支持 D1，未接入 Hyperdrive 或外部 SQL。百万注册是数据量，不是百万并发或线上吞吐承诺。

三类列表改用有索引的签名游标，仅返回本页条数；用户可按 ID、用户名或主邮箱精准检索，应用按客户端 ID 或完整名称检索。URL 保留游标与检索，详情返回恢复列表位置。原生全量会话与用户列表入口关闭，原生撤销操作保留。

限流通过原子 D1 操作执行，过期验证码、限流与令牌等记录由原 Worker 的有界定时任务清理，不新增 Cloudflare 资源。Cron 不删除用户邮箱；未验证辅助邮箱超过 24 小时后仍仅在再次添加同一地址时按既有规则惰性回收。迁移包含回调元数据和日期预处理及结构检查；更新前备份，恢复演练仅在隔离目录进行。

`pnpm test:scale` 默认使用 10、10 万、100 万注册数据量，30 秒窗口和 1/10/50 并发档位；可用 `--sizes=10,10000 --duration=30` 缩小运行。结果位于独立 `work/scale/<run-id>`，只代表本机运行；尚未声称任何线上压测结果。测试不创建付费资源，不发送真实邮件。

常规 CI 在构建后执行 `pnpm test:scale --sizes=10,10000 --duration=3`，沿用混合操作、三个并发档位、维护和恢复检查，不设置依赖机器性能的延迟或吞吐阈值。负载请求无效或失败时会保存报告并让命令失败退出。百万任务仍独立手动运行。

本次三个规模已全部完成，共 14,399 次混合请求，零错误；三个规模的备份恢复后认证、刷新令牌轮换及数据一致性检查均通过。百万用户夹具的初始 SQLite 文件约 1,209 MiB，包含关联数据和索引。详见[本地报告](benchmarks/local-scale.md)；这不等于百万并发，也不能推算线上 SLA 或实际账单。
