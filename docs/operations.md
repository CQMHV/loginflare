# Operations and recovery

[简体中文](operations.zh-CN.md)

`GET /api/health` reports Worker liveness without accessing D1 or R2. `GET /api/readiness` returns 200 only when the canonical installed instance can read D1 and its current private key material; failures return 503 with no configuration details. It bypasses the normal 30-second key-material cache. Poll readiness at a bounded interval (for example once a minute). It does not send email, call Turnstile or verify media delivery. An incomplete installation is not ready.

Workers Logs contains structured `http_request` events: production samples successful requests at 1% and records all 5xx responses. Use request IDs to investigate failures. These sampled logs cannot supply an exact authentication conversion rate. Authentication audit events distinguish incomplete MFA from completed sign-in. Expected 4xx authentication refusals are not service outages.

Monitor readiness, 5xx rate and latency, `email_recovery_delivery_failed`, `database_maintenance_failed`, and deployment failure output. Other delivery errors follow the request failure path. Investigate repeated delivery failures without changing account-verification requirements. Inspect maintenance failures and oldest pending expiry work before increasing cleanup budgets. Never log request bodies, cookies, tokens, complete OAuth URLs or mail links.


Before upgrading, identify the exact Worker, D1, media R2 and PRIVATE R2 bindings, issuer, migration ledger and pending migration hashes. Validate the previous Worker against any online migration before adding its digest to `migrations/online.json`; do not add approval merely because SQL executes. Preserve private installation material and its fingerprint.

For local recovery, stop all writers, create and verify a snapshot as described in [Scaling](scaling.md#schema-and-recovery-gate), and restore into isolated state. Check schema/foreign keys and media references, then verify password login, enabled TOTP, an existing session and a rotating refresh token before accepting the recovery.

For remote recovery, retain the original bindings and issuer, use D1's recovery facilities for the reviewed recovery point, and recover matching R2 data and private material. A database recovery point alone is not a consistent multi-storage backup. Do not run setup against existing restored data. A Worker rollback restores code only. This release does not offer a turnkey remote import/restore command or promise a recovery time or production throughput.
