# Passkeys

[简体中文](passkeys.zh-CN.md)

Verified, available accounts can add, list, name, rename and delete passkeys under **Account → Security → Passkeys**. Administrators can use them too. First register through email/password or a configured provider; passkey-only signup is not exposed.

Use **Sign in with a passkey** on the login page, including after selecting a remembered account or continuing an OAuth request. This release uses an explicit button. Unlock the authenticator with its PIN or biometric check. TOTP-enabled accounts still complete TOTP or the existing recovery-code flow. Email verification, suspension, deletion, browser-account capacity and selected-account checks apply.

## Deployment

Apply `0026_passkeys.sql` before this version. It adds the native credential table, an internal session reference, indexes and guards, without changing issuer, user IDs or keys. It is additive for older Workers. Remote migration approval and deployment are separate operations.

Pending MFA login challenges issued before source binding was introduced must restart sign-in after upgrading. New challenges explicitly retain their passkey or password/provider source in the existing verification store; no additional migration is needed. If the credential is removed while MFA is pending, completion returns HTTP 400 with `PASSKEY_NOT_AVAILABLE`, including final-insert races. A credential already unavailable before verification does not consume a recovery code.

`@better-auth/passkey@1.7.13` matches the locked Better Auth version. The browser helper is `@simplewebauthn/browser@13.3.0`. Both are MIT licensed; notices use the existing license generator. The helper handles serialization without requiring newer browser JSON APIs. Native verification runs in the existing Workers runtime, without a new binding or external verification service.

RP ID is exactly the hostname of `AUTH_URL`. The WebAuthn Origin allowlist contains exactly `AUTH_URL`, without wildcard or parent-domain overrides. Use the permanent HTTPS login hostname in production; changing it can invalidate existing credentials. Localhost development is supported. Unsupported browsers retain password/provider login. Authenticators must support discoverable credentials and user verification.

## Management and security

A still-live older session can enroll after fresh password/provider confirmation. Enrollment uses that exact reauthentication as its freshness evidence; other native session-freshness policies are unchanged.

Management uses the existing current-password or linked-provider reauthentication dialog. Provider proofs are single-use and bound to user, session and `passkeys/add`, `passkeys/rename` or `passkeys/delete`. Passkeys are login credentials in this release, not sensitive-operation proofs. Keep a password or an enabled linked provider for management; verified-email password recovery keeps its existing rules.

Accounts can register at most 20 passkeys; names contain 1–100 trimmed characters. The list returns names, registration dates and device/backup metadata, without public keys or credential IDs. Labels do not rename authenticator entries. Deletion removes the server credential; optionally remove the saved OS/password-manager copy separately. WebAuthn Signal API synchronization is deferred: upstream generates distinct authenticator user handles without persisting them for a trustworthy complete credential list.

Deletion atomically requires another passkey, a password or an enabled provider. Ownership and reauthentication are checked at the write. Concurrent deletions cannot remove the last usable method. Removed credentials cannot authenticate again, including pending TOTP/recovery-code logins started with that credential. Each MFA challenge retains its exact passkey and browser-flow binding through the final session insert; removing another credential does not invalidate it. Existing sessions keep their existing revocation semantics.

| Method | Path under `/api/auth` | Input |
| --- | --- | --- |
| POST | `/passkey/generate-register-options` | `{ password? }` |
| POST | `/passkey/verify-registration` | `{ response, name? }` |
| GET | `/passkey/generate-authenticate-options` | Pending browser authentication flow |
| POST | `/passkey/verify-authentication` | `{ response, oauth_query? }` |
| GET | `/passkey/list-user-passkeys` | Current selected session |
| POST | `/passkey/update-passkey` | `{ id, name, password? }` |
| POST | `/passkey/delete-passkey` | `{ id, password? }` |

Writes require exact Origin and JSON. Client registration context, `createSession`, target users and anonymous enrollment are excluded. Ceremony and management endpoints are rate limited. Native challenges expire after five minutes and are atomically consumed across isolates. Signed challenge cookies are isolated by browser authentication flow. Enrollment binds its exact user/session and reauthentication to the final insert; a short-lived verification permit is consumed by the insert trigger. Abandoned permits expire through existing maintenance. Internal version guards can contain the existing password hash, never plaintext passwords.

Both ceremonies require authenticator user verification, enforced server-side. Upstream validates ceremony type, challenge, RP ID, Origin and signatures. Database guards reject counter regression, unavailable accounts and session creation using a concurrently removed credential. Audits record creation, renaming, deletion and authentication outcomes without credential material or authentication responses.

## Cleanup, recovery and upgrades

Account deletion appends bounded stages for enrollment/permit records and credentials, preserving existing durable stage ordinals. Whole-instance backups include these D1 rows. Restore with the same issuer/RP ID. The isolated recovery exercise enrolls a real software authenticator, restores a snapshot and signs into the restored Worker with it.

Run `pnpm check`, `pnpm exec playwright test tests/e2e/passkeys.spec.ts` and `pnpm test:scale --sizes=10 --duration=3`. The last command measures only a small isolated local workload and recovery, not production capacity. Upgrade checks pin the upstream version, endpoints and credential schema. Review challenge consumption, RP/Origin, user verification, MFA integration, multi-account/OAuth continuation, final-write guards and recovery when upgrading dependencies. Browser tests use Chromium virtual authenticators; other engines and real devices need release smoke tests.
