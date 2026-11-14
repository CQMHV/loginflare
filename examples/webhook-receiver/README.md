# Signed webhook receiver

[简体中文](README.zh-CN.md)

This independent Worker implements the [v1 contract](../../docs/webhooks.md). It accepts `POST /webhooks`, verifies the exact body with timestamped HMAC, validates finite event fields and writes a D1 inbox keyed by event ID. Duplicates return 200 without replacing the first record; storage failures return 503 so the sender can retry. There are no external business side effects or public inbox-reading routes.

For local verification, create a disabled subscription in Loginflare, copy `.dev.vars.example` to `.dev.vars` and set its one-time signing key. Run `pnpm exec wrangler d1 migrations apply DB --local --config examples/webhook-receiver/wrangler.jsonc`, then `pnpm example:webhook`. Send a locally signed fixture; Loginflare deliberately rejects loopback receivers. A public test receiver requires an operator-configured public HTTPS address.

For deployment, create a separate D1 database and set its ID in this example's config. Apply its migration using that config and store `WEBHOOK_SECRET` as a Worker secret. Deploy and configure its public HTTPS hostname yourself, then enable the subscription. Never bind Loginflare's database. These instructions do not create resources automatically.

Use `pnpm check` to typecheck, run the Worker integration tests and build this example with `--dry-run`. Keep inbox IDs for the complete period in which the business can receive/replay an event; this example retains them indefinitely. Plan personal-data retention and backup policy before production. Add business changes to the same D1 transaction, or implement a separate durable inbox processor with its own recovery and idempotency. An HTTP call after inserting the inbox is not an atomic business effect.
