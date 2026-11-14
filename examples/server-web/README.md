# Hono / Workers Web application

[简体中文](README.zh-CN.md)

This is an independent confidential OIDC client. It deploys directly to Workers and stores application sessions in its own D1 database, separate from Loginflare. The local `server.mjs` entry bridges HTTPS to Miniflare running the same Worker.

## Local integration

Follow [the application guide](../../docs/oauth.md#standard-client-examples) to register a Web client, copy `.env.example` to `.env`, fill in its client ID/secret and issuer, and generate development TLS files. Run `pnpm example:web`. Local state and an automatically generated encryption key live under ignored `work/server-web-state`; restarting preserves sessions. Use `LOGINFLARE_WEB_STATE` for an isolated test state directory. Never share this state or its key.

## Deploy your application

1. Configure your HTTPS application origin, Loginflare issuer and client ID in this example's `wrangler.jsonc`. Register exact `/callback` and `/logout-callback` URLs for that origin in Loginflare. Allow `openid profile email offline_access`.
2. Create a separate D1 database for the application, set its `database_id` in the `SESSIONS` binding, and apply `migrations/0001_sessions.sql` using the example's Wrangler config. Do not bind Loginflare's own database.
3. Set `LOGINFLARE_CLIENT_SECRET` as a Worker secret. Generate a 32-byte random encryption key (`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`) and store it as `LOGINFLARE_SESSION_KEY`. Keep that key with database backups; changing it makes existing sessions unreadable.
4. Run type checking and browser integration tests before deploying the example Worker using its config, then configure the application hostname. Resource creation and deployment are deliberate operator actions.

The cookie contains an opaque random handle whose SHA-256 hash identifies the database row. Session payloads, including tokens and CSRF values, use AES-GCM with the row ID as authenticated data. Sessions expire after eight hours; scheduled cleanup removes up to 500 expired rows every five minutes. Size retention and traffic against your own application workload.

Refresh uses a D1 conditional claim shared by all isolates. A caller waits briefly for another request's result; it never reuses a claimed token after a crash or uncertain response. A stale claim requires sign-in again. Logout deletes the local session before remote revocation and reports unconfirmed revocation. Central logout additionally visits Loginflare; other applications still own their own sessions.

Protocol operations use `openid-client` checks for PKCE, state, nonce, issuer, audience, signature and subject. Issuer responses have a five-second timeout, a 64 KiB bound and no followed redirects. Tokens and callback URLs are never logged. The sample displays only profile claims; adapt the application UI and business routes for your product.
