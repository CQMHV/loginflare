# Business event notifications

[简体中文](webhooks.zh-CN.md)

Administrators configure Webhooks and inspect delivery records at `/en-us/admin/webhooks`. These are asynchronous account facts, separate from security audit logs. They do not run synchronous Actions or grant machine access to webhook administration.

## Configure a receiver

1. Prepare a public HTTPS receiver at port 443. Use the [receiver example](../examples/webhook-receiver/README.md) to verify signatures and accept each event into a durable, deduplicated inbox.
2. Create a disabled webhook, choose events and save the signing key shown once. Store it as a secret in the receiver. Configuration lists never reveal it; Loginflare encrypts it using the instance authentication secret.
3. Enable the subscription after the receiver is ready. Only future facts are subscribed; there is no historical backfill. At most 20 subscriptions may be enabled and 100 configurations retained.
4. Inspect delivery records, filter by subscription ID, event ID or status, and review result codes and attempts. Redelivery uses the current configuration and retains the same event ID. Keep the receiver idempotent.

Targets must resolve exclusively to public addresses at configuration and delivery time. Private, loopback, reserved and mixed private/public DNS answers, nonstandard ports, credentials in URLs and redirects are rejected. Keep `global_fetch_strictly_public` enabled in the deployed Worker: runtime fetch enforcement also protects the connection against DNS changes. Avoid credentials in destination query parameters; administrators can read configured URLs.

Changing the destination, selected events, enabled state or signing key advances the configuration generation. Queued old-generation deliveries are cancelled in bounded background passes; an already sent request may finish. Renaming alone keeps queued deliveries. To rotate a key, disable the subscription, rotate, update the receiver secret, enable again, then redeliver any retained events needed by the application. Repeated rotation with a stale version is rejected. Only disabled configurations without retained delivery records can be deleted.

## Version 1 contract

```json
{
  "version": "v1",
  "id": "e5dd4b593f434fafb36a4f6d896d57b2",
  "type": "user.updated",
  "occurredAt": "2026-11-14T00:00:00.000Z",
  "subject": { "type": "user", "id": "account-id" },
  "data": { "fields": ["name", "locale"] }
}
```

| Type | Data | Fact |
| --- | --- | --- |
| `user.created` | `emailVerified: boolean` | A user row is created, including verified social provisioning. |
| `email.verified` | `primary: boolean` | Initial verified provisioning or an email changes from unverified to verified. No email address is included. |
| `user.updated` | `fields: string[]` | Actual changes to `name`, `username`, `email`, `image`, `locale`; values are excluded. |
| `user.suspended` | `{}` | The account changes to suspended. Deletion's freeze is excluded. |
| `user.restored` | `{}` | The account changes from suspended to active. |
| `user.deleted` | `{}` | Final physical deletion completes. The subject ID and event survive the user. |

No password, token, OTP, secret, email address, profile value or complete authentication URL is sent. The subject ID is still personal data; protect receiver access and retention. Events describe committed database facts, not a successful HTTP operation: a multi-statement transaction that rolls back produces no event, while independently committed writes and later compensating writes can produce separate facts. A deletion request is not a completed deletion event. Notifications are not an application-session logout protocol.

Requests are JSON POSTs with these headers:

| Header | Value |
| --- | --- |
| `Loginflare-Event-Id` | Stable event ID across subscriptions and redelivery. |
| `Loginflare-Delivery-Id` | Stable delivery ID for one event/subscription pair. |
| `Loginflare-Timestamp` | Unix seconds for this send attempt. |
| `Loginflare-Signature` | `v1=` followed by lowercase hex HMAC-SHA256 of `timestamp + "." + exact raw body`, keyed by the signing key. |

Verify the MAC with constant-time cryptographic verification before parsing or acting. Reject timestamps outside a five-minute clock tolerance, validate the v1 shape and compare the event header with the body ID. Persist event-ID deduplication together with application writes before returning 2xx. A replay within the timestamp window or a newly signed manual redelivery must not repeat effects. The example stores a durable inbox and does not perform external side effects; a downstream processor needs its own retry/idempotency policy. Clocks must be synchronized.

## Delivery and recovery

SQLite triggers append immutable events and fan out deliveries in the same transaction as account changes. There are no foreign keys to the deleted subject. Successful mutation requests schedule best-effort `waitUntil` work; the existing five-minute Cron recovers due and interrupted tasks. Receiver availability does not block sign-in responses. Cron must remain enabled, and subscriptions/receiver secrets must be restored with backups of the instance authentication secret.

Conditional D1 claims with 30-second leases coordinate isolates. Each invocation sends at most three jobs with a 20-second admission budget; each request, DNS resolution and response read shares a five-second deadline. Responses are limited to 64 KiB, never persisted, and redirects are never followed. Only 2xx settles as success. After a settled failure, retry delays are 5 minutes, 30 minutes, 2 hours, 12 hours and 24 hours, for six settled attempts per cycle. Cron scheduling can add delay. A crashed or unconfirmed attempt is recorded as uncertain after its lease expires and does not consume the settled retry budget.

Delivery is **at least once, without ordering guarantees**. The receiver can accept an event before Loginflare loses the status write; a retry uses the same event ID. Manual redelivery starts a new retry cycle, keeps total attempts/history and requires an enabled matching subscription. State changes use version/cycle compare-and-swap guards. Final success, failure or cancellation is eligible for cleanup after seven days; completed attempts have the same retention. Pending deliveries and their referenced events remain until settled. Unreferenced events expire after seven days. Bounded child-first cleanup uses persistent scan cursors and may take additional Cron runs; a pending old event does not block cleanup of later rows.

This is a bounded D1 outbox, not a high-throughput external queue. With no request-triggered work, Cron alone admits at most three sends per five minutes, shared by new jobs and retries. Large fan-out or long backlogs need capacity planning and a separate measured design. Monitor pending age, attempts and failed records in the administrator console; do not infer a latency SLA from the retry schedule. Stored errors use finite result codes and HTTP status, never response bodies or raw exception details.

Migration `0027_business_events.sql` creates the new tables, indexes and native fact triggers without replaying historical users. Follow the normal reviewed migration and recovery procedure. No new main-Worker binding is required. The receiver and [audit exporter](../examples/audit-export/README.md) each use separate example databases and are deployed independently by their operator. Audit export copies security/management audit records through existing `management:audit:read`; it is not a webhook subscription.

`pnpm test:events:recovery` runs an isolated three-database recovery exercise under ignored `work/events-recovery`: stop the local runtime after receiver acceptance and a lost completion write, verify/copy a snapshot, restart from that copy and check duplicate suppression, uncertain-attempt recovery and audit continuation. All outbound traffic is simulated locally; the report contains counts and assertions without credentials.
