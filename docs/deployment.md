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

The maintainer's test instance is `https://loginflare-staging.cqmhv.workers.dev`, with its own D1 database and Turnstile widget; production is unconfigured. Independent operators configure their own environments. For Cloudflare Workers Builds, set `CLOUDFLARE_ENV=staging`, `NODE_VERSION=24`, and `PNPM_VERSION=11.25.0`, use `pnpm build` as the build command, and `node scripts/database.mjs migrate --env staging && pnpm exec wrangler deploy` as the deploy command. The migration wrapper performs data preparation and the schema gate before deployment can proceed. The build token needs Worker deployment and D1 migration/query access to that environment. Authentication and Turnstile secrets are runtime Worker Secrets, not build variables or repository files. Verify the remote build configuration separately when upgrading an existing instance.

The committed `wrangler.jsonc` contains a local configuration and explicit `staging` / `production` sections. Replace the remote D1 placeholder IDs and empty public configuration before building for either environment. Keep development secrets in the ignored `.dev.vars` file; `pnpm setup:local` generates it safely without overwriting an existing file. Store remote authentication and Turnstile secrets as Worker secrets, never as committed configuration. Authentication secrets must be unique per environment and remain stable across routine redeployments.

Keep the `global_fetch_strictly_public` compatibility flag enabled alongside `nodejs_compat`. OIDC logout verifies its ID Token hint by fetching the issuer's `/api/auth/jwks`; this flag routes that same-zone request through the public Worker entry point. It requires explicit configuration even with a recent compatibility date. See [Cloudflare's fetch routing documentation](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public).

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

Use the shipped wrapper for migrations so data preparation and schema checks cannot be skipped. After reviewing the exact target:

```powershell
node scripts/database.mjs migrate --env staging
node scripts/database.mjs check --env staging
```

`pnpm db:migrate` and `pnpm db:check` target local state in `.cloudflare/state`. Use the explicit `node scripts/database.mjs ... --env staging|production` form for remote operations. The wrapper resolves and prints the selected database ID; `cf` migration operations receive that ID. Do not use a remote target to initialize local data. `check` is read-only; `migrate` prepares data, applies the committed SQL, and checks the result.

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

Back up the reviewed target, apply the committed migrations through the wrapper, and require its schema gate to pass before starting the new Worker version. Do not replace an established database with a fresh one during routine updates. Review migration SQL and preserve the database's recovery point before remote changes.

Before upgrading, pause application registration, callback editing, and other writes to data being prepared. Keep that window in place through preparation, migrations, schema/URI-registry checks, and switching to the new Worker. Origin backfill compares both the stored callbacks and metadata before writing and aborts on a concurrent change; the gate verifies the derived metadata and registry in both directions. These checks detect inconsistent state but do not pause writers or complete the version switch themselves. An existing remote build trigger must be reviewed and updated separately; the repository does not automatically establish this write window.

OAuth/OIDC adds versioned provider tables and `oauthGrantPolicy` security state in migrations `0002_oauth.sql` and `0003_oauth_policy.sql`. Apply both before enabling the new build. Preserve existing account data, signing keys, grant policy, and the stable `BETTER_AUTH_SECRET`; deleting policy rows is not a supported way to revoke or restore credentials. Keep `${AUTH_URL}/api/auth` stable as the issuer after applications begin using it.

Username sign-in adds a nullable, case-insensitively unique `user.username` in `0004_username.sql`. Apply it before deploying the username-enabled build. Existing accounts keep their email sign-in and choose a username through their account profile; the migration does not invent or reserve usernames for them.

Email management adds `userEmail` and `emailChallenge` in `0005_emails.sql`. Apply it before deploying the email-enabled build. The migration registers every existing primary email and preserves its verification state. Primary and secondary addresses share a case-insensitive unique registry; database triggers protect native registration, primary switches and proof invalidation. Accounts manage at most ten addresses. Unverified secondary reservations can be reclaimed after one day when adding that address. Recovery now uses a code sent to a selected verified registered email, followed by the native password reset; the old public reset-link request endpoint is removed. This needs no additional bindings or secrets.

`0006_management.sql` adds indexed cursor-list access and the OAuth URI projection; `0007_maintenance.sql` adds expiry indexes and grant-policy collection bounds. Before applying SQL, the wrapper derives redirect Origins using the URL parser and normalizes native date columns to ISO UTC text in bounded batches. Invalid stored callbacks must be resolved before migration. The final check compares committed tables, columns, indexes and triggers, checks foreign keys and callback metadata/registry consistency, and rejects invalid native date storage. It does not silently repair a failed schema check or permit mixed request-time date formats. Keep this preparation and check in automated deployment commands.

The five-minute Cron Trigger performs bounded expiry cleanup on the existing Worker and D1. It needs no new resources or secrets. Credential validity is checked on use, so an overdue collection run does not make an expired token valid. Monitor `database_maintenance` and `database_maintenance_failed` events; sustained backlog or exhausted budgets call for workload and database review, not deletion of live grant-policy rows. See [Scaling](scaling.md) for the operational boundaries.

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

## Backup and restore

For a local snapshot:

```powershell
pnpm db:backup
```

An optional output directory can be passed as the next argument. The default is a new timestamped directory under `work/backups/`. Node's SQLite backup API produces consistent snapshots while local development is running. The manifest records database files under `d1/` and the saved local configuration and managed test credentials, including `.dev.vars` when present. Keep the backup private and outside Git; it contains authentication material. This command never contacts a remote D1 database.

To restore, stop the development server, keep the existing state aside, and restore the manifest's `d1/` files to `.cloudflare/state/v3/d1` together with each configuration and credential file at its original relative path. Preserve the matching authentication secret and origin: signing keys are encrypted and existing credentials belong to that instance. Check the restored schema with `pnpm db:check` before opening it. Perform restore drills in an isolated directory so verification does not overwrite the active development database.

For staging or production, record and validate a recovery point using D1's supported recovery facilities before migration. Confirm the selected database and restore point before an actual remote restore. A local SQLite snapshot is not a remote D1 backup, and a Worker rollback does not reverse schema or data changes.

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
11. The migration/schema gate passes, cursor pages and exact lookups work, and the scheduled handler reports bounded maintenance without removing live credentials.

## Updates and troubleshooting

- Deploy the exact tested lockfile and migration set; do not run unreviewed schema generation against production.
- Investigate CLI authentication, permissions, selected account, and connectivity before concluding that a deployment tool is unavailable.
- After an uncertain remote write, inspect the resulting resource/version before retrying.
- If email delivery fails, inspect Email Service configuration and its delivery records. Do not bypass email verification.
- If Turnstile is unavailable or misconfigured, fix the configuration; do not substitute a successful CAPTCHA result.
- A Worker rollback does not automatically undo D1 schema/data changes. Confirm database compatibility before switching versions.
