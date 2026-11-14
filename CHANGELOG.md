# Changelog

## Unreleased

- Return an explicit passkey-unavailable 400 for interrupted MFA, including final session-insert races; retain 503 for actual storage failures.
- Classify authentication service failures by request ID without raw error logging. Report Turnstile outages separately with localized retry guidance and preserve normal verification refusals.

- Preserve the exact passkey source across TOTP/recovery-code login and reject removed credentials at the final session insert. Require pending MFA challenges without an authentication source to restart sign-in after upgrading.
- Recover expired webhook leases as uncertain attempts instead of cancelling live subscriptions; fence completion writes by lease ownership and expiry.
- Avoid default R2 bucket name collisions for long Worker names while preserving existing bindings and explicit resource names.

- Replace browser maintenance upgrades with reviewed CLI releases and a fingerprinted first-installation flow. Keep private instance configuration and authentication material in a separate private R2 bucket; require migration 0023 and the new installation inputs.
- Retire the old browser maintenance endpoints. The new installation flow does not adopt databases from that earlier flow; existing operators must review the documented upgrade and recovery boundary before rollout.

- Add administrator-managed signed account webhooks with a transactional D1 outbox, leased at-least-once delivery, bounded retries/history cleanup and manual redelivery. Migration 0027 is required.
- Add independent Workers examples for signature-verified deduplicated webhook inboxes and durable audit export using the existing read-only Management API.

- Add passkey enrollment, naming, renaming, removal and sign-in using the official version-matched Better Auth plugin. Keep verified-account policy, TOTP, browser account selection and OAuth continuation.
- Bind enrollment to the exact session and reauthentication, atomically consume challenges, and guard credential deletion, final session creation and counter updates. Include credentials in account cleanup and native snapshot recovery verification. Migration 0026 is required.

- Add ordinary-user account deletion with signed impact previews, password/provider reauthentication, enabled MFA and explicit confirmation of owned applications.
- Freeze the account and applications atomically, then use leased, resumable maintenance batches to remove credentials and associated data; preserve 90-day security audit retention and R2 deletion retries.
- Reject old email-verification links for a later account registered with the same address. Migration 0025 is required before activating these endpoints.

- Separate Worker liveness (`/api/health`) from uncached dependency readiness (`/api/readiness`).
- Rotate RS256 signing keys every 90 days, retaining old public keys for a 48-hour verification grace period. Existing keys receive a deadline through migration 0024.
- Validate the upstream MFA hook contract before extending its login coverage.
- Add SHA-256 manifests and explicit verification for newly created local snapshots.
- Document vulnerability reporting, contribution and release requirements.
- Replace the process-local Web client with a Hono/Workers application using encrypted D1 sessions and cross-isolate refresh coordination; keep the local HTTPS launch command.
- Convert the SPA to React with a single renewal coordinator for manual and timed refresh.
