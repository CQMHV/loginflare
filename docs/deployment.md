# Deployment and operations

[简体中文](deployment.zh-CN.md) · [English README](../README.md)

## Prerequisites

Deploy only after local tests and a production build succeed. Review the target account, environment, Worker, database ID, public URL, and sending domain before making any remote change.

- A Cloudflare account with Workers Paid for arbitrary-recipient transactional email.
- A domain using Cloudflare DNS, onboarded to Cloudflare Email Sending.
- The required sending-domain SPF/DKIM and bounce DNS records.
- A Turnstile widget configured for the deployed hostnames, with production keys.
- Separate D1 databases, Worker secrets, and public URLs for staging and production.
- An installed, authenticated Cloudflare CLI (`cf`) with access to the intended account.

Email Sending is currently Beta. Check the current [Email Service documentation](https://developers.cloudflare.com/email-service/) before production rollout. Email Routing alone is not arbitrary-recipient transactional sending.

This repository does not create remote resources or deploy itself during dependency installation, local development, tests, or builds.

## Configure the environment

The staging environment is available at `https://loginflare-staging.cqmhv.workers.dev`, with its own `loginflare-staging` D1 database and Turnstile widget. Cloudflare Workers Builds connects it to this repository's `main` branch. Build variables are `CLOUDFLARE_ENV=staging`, `NODE_VERSION=24`, and `PNPM_VERSION=11.25.0`; the build command is `pnpm build`, and the deploy command is `pnpm exec wrangler d1 migrations apply DB --remote && pnpm exec wrangler deploy`. The dedicated build token can deploy Workers and apply D1 migrations in the configured account. Authentication and Turnstile secrets are runtime Worker Secrets, not build variables or repository files. Production remains unconfigured.

The committed `wrangler.jsonc` contains a local configuration and explicit `staging` / `production` sections. Replace the remote D1 placeholder IDs and empty public configuration before building for either environment. Keep development secrets in the ignored `.dev.vars` file; `pnpm setup:local` generates it safely without overwriting an existing file. Store remote authentication and Turnstile secrets as Worker secrets, never as committed configuration. Authentication secrets must be unique per environment and remain stable across routine redeployments.

| Setting | Location | Purpose |
| --- | --- | --- |
| `APP_ENV` | Environment's `vars` | `development`, `staging`, or `production` |
| `AUTH_URL` | Environment's `vars` | Exact application origin, HTTPS remotely, no trailing slash |
| `EMAIL_FROM` | Environment's `vars` | Sender using the verified domain |
| `TURNSTILE_SITE_KEY` | Environment's `vars` | Public key for the deployed hostname |
| `BETTER_AUTH_SECRET` | Worker secret | Random authentication secret, at least 32 characters |
| `TURNSTILE_SECRET_KEY` | Worker secret | Secret matching the production Turnstile site key |
| `DB` | Environment's D1 binding | Its independent database ID and migration directory |
| `EMAIL` | Environment's `send_email` binding | Cloudflare Email Service sender |

The trusted origin is taken from `AUTH_URL` and must match the public origin. Missing mandatory configuration is an error, not a reason to disable verification or CAPTCHA. Test Turnstile keys are rejected outside development.

Use Cloudflare's local bindings by default when developing. A remote email binding sends real messages and is not needed for the local test suite.

## Cloudflare CLI

Resource operations prefer `cf`. The pinned `cf` development/build toolchain requires a beta Vite plugin, so this project deliberately uses the stable Cloudflare Vite plugin and Wrangler for dev/build/type generation/deployment. Local promotion uses Wrangler because this `cf` version does not implement local D1 queries; remote migration/query operations use `cf`.

Discover resource commands and inspect their detailed help before invoking them:

```powershell
cf cli search "apply SQL database migrations from local files"
cf cli search "deploy a worker project"
cf cli search "set a worker secret"
```

Keep discovery queries anonymous; do not put account identifiers, domains, addresses, resource names, or tokens in them.

The CLI's D1 migration command accepts a **database ID**, not a binding or database name. After reviewing the exact target, the remote migration shape is:

```powershell
cf d1 migrations apply <database-id> --dir migrations
```

The local migration command is wrapped by `pnpm db:migrate` so that it uses the same local state directory as development. Do not use the remote form when initializing local development data.

Build and deployment are separate operations. With the Cloudflare Vite plugin, the target environment is selected **at build time**, not by a deploy-time `--env` flag. For staging, build using PowerShell:

```powershell
$env:CLOUDFLARE_ENV = 'staging'
pnpm build
```

Inspect the generated Worker configuration and bound database ID, then check without uploading:

```powershell
pnpm exec wrangler deploy --dry-run
```

When deployment is explicitly intended, deploy the same staged build:

```powershell
pnpm exec wrangler deploy --secrets-file .dev.vars.staging
Remove-Item Env:CLOUDFLARE_ENV
```

`.dev.vars.staging` must contain the real staging authentication and Turnstile secrets, not the local example's test keys. It is ignored by Git. For production, perform a new build with `CLOUDFLARE_ENV=production` and use the production secrets file. Do not reuse a local or staging build for production. See [Cloudflare environments](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/).

Pre-create and verify the intended D1 databases, then put their IDs in the environment configuration; do not accept unexpected provisioning during deployment. Do not include real secrets in committed scripts or shell arguments that may be retained in history. Protect and remove temporary secrets files when no longer needed.

## Database and administrator initialization

Apply the committed migrations to the correct environment before starting the new Worker version. Do not replace an established database with a fresh one during routine updates. Review migration SQL before a remote application, and use D1's supported backup/recovery tooling before making a change that requires it.

OAuth/OIDC adds versioned provider tables and `oauthGrantPolicy` security state in migrations `0002_oauth.sql` and `0003_oauth_policy.sql`. Apply both before enabling the new build. Preserve existing account data, signing keys, grant policy, and the stable `BETTER_AUTH_SECRET`; deleting policy rows is not a supported way to revoke or restore credentials. Keep `${AUTH_URL}/api/auth` stable as the issuer after applications begin using it.

Create production applications in the administrator console with exact HTTPS callback and post-logout URLs. Store server-client secrets in each application's protected server configuration, and never ship them to browser applications. Registered SPA Origins gain protocol-only CORS access, not access to account or administration APIs. See [application integration](oauth.md) for refresh and security-revocation behavior.

Create the intended administrator through ordinary registration and complete email verification. The administrator promotion command must target that exact existing verified account. An unverified or missing account is an error. Repeating a successful promotion is harmless.

For local development:

```powershell
pnpm admin:promote -- --email admin@example.com --local
```

For remote use, choose the environment explicitly and review the printed database target:

```powershell
pnpm admin:promote -- --email admin@example.com --env staging
```

Use `--env production` only when production is the intended target. The command refuses missing environment selection, placeholder/invalid database IDs, and a remote target that reuses the local database ID. The email is parameterized for remote queries; local Wrangler SQL uses a quoted literal passed as a structured process argument without a shell. Never bootstrap by assigning privileges to the first user who happens to register. Sign out and sign in again after promotion.

## Staging acceptance

Use addresses and accounts controlled by the operator. A real email delivery check is a deliberate remote action, not part of the local automated suite.

Verify the following before promoting a build to production:

1. Both lowercase localized URL prefixes load, and a fresh visitor defaults to `/en-us/`.
2. Registration, email verification, login, password recovery, and localized mail links work.
3. A normal account cannot access management endpoints or change protected user fields.
4. Suspending an ordinary account invalidates its old sessions; restoration requires a new login.
5. Turnstile uses real production keys and rejects invalid challenges; rate limits persist across requests.
6. API failures return safe JSON rather than SPA HTML or internal diagnostics.
7. Logs omit passwords, session tokens, and complete email verification/reset links.
8. Web and SPA applications discover the configured issuer, complete consent, and exchange codes with PKCE S256; invalid callbacks and unregistered Origins fail.
9. Password reset, explicit session revocation, and suspension invalidate the appropriate OAuth grants; restoration does not resurrect them. Ordinary central logout preserves native offline refresh semantics.
10. Signing keys survive a routine redeployment; OAuth codes, client secrets, and tokens are absent from logs.

## Updates and troubleshooting

- Deploy the exact tested lockfile and migration set; do not run unreviewed schema generation against production.
- Investigate CLI authentication, permissions, selected account, and connectivity before concluding that a deployment tool is unavailable.
- After an uncertain remote write, inspect the resulting resource/version before retrying.
- If email delivery fails, inspect Email Service configuration and its delivery records. Do not bypass email verification.
- If Turnstile is unavailable or misconfigured, fix the configuration; do not substitute a successful CAPTCHA result.
- A Worker rollback does not automatically undo D1 schema/data changes. Confirm database compatibility before switching versions.
