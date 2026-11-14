# Account deletion


[简体中文](account-deletion.zh-CN.md)

Ordinary verified, active users can request deletion from **Account center → Security → Delete account**. The dialog requires the current password, or linked-provider reauthentication for a passwordless account. Password accounts with enabled MFA must also supply a current TOTP. Passwordless reauthentication already completes enabled MFA before issuing the session- and purpose-bound security proof.

The user reviews every owned application's name and client ID and explicitly acknowledges deletion. Deleting those applications also removes other users' authorizations for them. Other users' accounts, applications owned by other people, and instance-managed machine identities remain separate. Administrator accounts cannot use this operation. It does not add an operator, administrator or machine API for deleting another account, or an ownership-transfer workflow. A legacy instance-managed client whose native `userId` references this ordinary account must be resolved by the operator first; it is never silently deleted.

## HTTP contract

Both endpoints are same-origin account operations. Use the currently selected browser account and normal session credentials; client IDs and machine access tokens do not establish user authority.

- `GET /api/account/deletion-preview` returns `{ preview, applications: [{ clientId, name }], expiresIn: 600 }`. The signed preview binds the user, exact session and current application list. It does not contain credentials.
- `POST /api/account/delete` accepts `{ preview, password?, code? }`. Send JSON and the exact account Origin. Passwordless accounts supply the previously established `account/delete` proof through its signed HttpOnly cookie. Unknown fields, including a target user ID, are rejected. A successful request returns `202 { operationId, status: "pending" }`.

Missing/ineligible sessions receive 401/403. A stale or foreign preview receives 400. Application, credential or MFA changes detected at the final write receive 409 and require another review. Missing TOTP receives `ACCOUNT_DELETION_MFA_REQUIRED`; wrong codes use the native verification errors. POST is limited to five attempts per account per minute, with `Retry-After` on 429. Requests are never automatically retried after an uncertain response.

## Acceptance and cleanup

Acceptance is a D1 transaction: recheck the current session, password hash or consumed proof, MFA configuration, ordinary-user status and exact application list; create one durable job; disable eligible owned applications; freeze the user; record the acceptance audit. Existing disabled/restricted applications stay disabled. The deletion marker prevents restoration, profile/credential changes and further credential issuance. Online token checks reject the account and its applications immediately. Existing JWTs verified offline and independent application sessions still follow their own expiry and revalidation policy.

The existing five-minute Cron processes at most four deletion batches per invocation within the maintenance budget, reserving capacity for ordinary expiry collection. A mutation selects at most 100 records. A one-minute job lease and persisted stage allow a later invocation to resume after a crash. Cleanup removes access tokens before refresh tokens, codes and grant policy before consent, and child records before clients and the user. Stages are persisted ordinals: do not reorder them in a later release without migrating pending jobs. Pending jobs do not expire; completed job receipts and audit events expire after 90 days. Failures use the existing `database_maintenance_failed` diagnostic; operators can locate jobs and events by the operation/user ID.

The native email-verification token identifies an email address. Reused addresses must not accept links issued before the new account existed. Verification rejects such older tokens, and cleanup retains address reservations for at least two seconds before releasing them to keep issued-at seconds distinct. This is a lower bound, not a cleanup-time guarantee.

Avatar metadata is detached and marked for the existing R2 garbage collector, which retains retry information if object deletion fails. Cached public photos can remain visible for up to five minutes after removal. Security audit records retain their normal 90-day lifetime and do not record passwords, proof tokens, TOTP codes or application secrets. `/en-us/account-deleted` and `/zh-cn/account-deleted` are public informational receipt pages; they do not expose job or account data.

Apply migration `0025_account_deletion.sql` before using this build. It appends job state, guards and indexes, preserves ordinary suspension behavior and prevents its unbounded revocation fan-out during deletion. Existing deployments retain the reviewed online-migration gate; this change does not approve or perform a remote migration or deployment.
