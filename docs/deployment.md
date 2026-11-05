# Deployment and operations

[简体中文](deployment.zh-CN.md) · [README](../README.md)

## First installation

The default flow is **Deploy to Cloudflare → configure in the browser → verify email and create the administrator**. Cloudflare provisions D1 and private R2 storage for a single Worker. The browser wizard owns the public address, sending configuration and Turnstile. Real Cloudflare acceptance remains a release requirement; local tests do not establish that the complete hosted flow has passed.

1. Prepare a Cloudflare account, a domain already using Cloudflare DNS on that account, and Workers Paid. Sending transactional messages to arbitrary users also requires Cloudflare Email Service onboarding; Email Routing alone does not provide this ability. See [Email Service](https://developers.cloudflare.com/email-service/).
2. Create a dedicated **User API Token** in your user profile, restricted to the account and zones below. Do not use an Account API Token: Turnstile is currently unsupported by that token type in the [official compatibility matrix](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/).
3. Use the deployment button, choose your account and resource names, and provide only `CF_SETUP_TOKEN` as the first-install secret. This differs from the deployment credentials used by Workers Builds itself.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CQMHV/loginflare)

4. Use `pnpm build:deploy` as the build command and `pnpm run deploy` as the deploy command. Use Node.js 24 and the pnpm version in `packageManager`. Deployment uploads code; it does not migrate business data or replay an initial secrets file.
5. Open `/setup` on the deployed address. Enter the dedicated token again to prove ownership, prepare the database, choose the public HTTPS address and sending domain, and continue through domain, email and production Turnstile configuration. A `workers.dev` address is supported; attaching a custom domain needs the additional zone route permission below. When the chosen address uses a different Origin, continue on that address and re-enter the installation token; credentials never travel in the navigation link.
6. Create the candidate administrator and verify the email. The link may be opened on another device. Return to the authorized installation browser, privately save the recovery file, and complete installation. The email link itself cannot grant administrator privileges.
7. Confirm temporary credential cleanup, then revoke the dedicated installation token in Cloudflare. Subsequent code deployments do not require it.

A dedicated sending subdomain such as `notify.example.com` is recommended. Conflicting DNS records stop the step and remain untouched. Billing, domain onboarding and account eligibility actions are completed in the dashboard; return to the wizard to check again.

### Token permissions

| API operation | Permission | Resource scope |
| --- | --- | --- |
| Read account information | Account Settings Read | Target account |
| Read Worker/version/deployment/secret names; update or delete secrets; write recovery challenge | Workers Scripts Read/Write or the corresponding Workers Editor role | Target account; narrow to this Worker when available |
| Confirm zone ownership | Zone Read | Selected zones |
| Read and create required DNS records | DNS Read/Write | Selected zones |
| Attach a custom domain | Worker edit access plus Workers Routes Write | This Worker and every affected zone |
| Read, create and configure Turnstile | Turnstile Sites Read/Write | Target account |
| Read and provision sending subdomains | Email Sending read/edit | Target account and sending zone; exact minimum permissions require isolated acceptance |

Worker edit access does not replace Zone > Workers Routes > Write for custom domains. See [Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/).

Deployment credentials provision D1/R2; installation and migrations access them through bindings and do not need extra D1/R2 management permissions on the installation token. Do not grant token-management or unrelated Worker creation/deletion permissions. The minimum sending-endpoint permission mapping is not fully established by public documentation and must not be presented as verified.

## Configuration ownership and redeployment

`wrangler.jsonc` is the public release template. `wrangler.local.jsonc` is development-only. Keep pre-existing maintainer configuration in an ignored private config and explicitly select it after checking its resources; never point an existing installation at the template's fresh resources.

The repository owns entrypoints, compatibility flags, assets, D1/R2/email bindings, Cron declarations, environment category and build metadata. The wizard owns these Worker Secrets:

- `AUTH_URL`: fixed public Origin and `${AUTH_URL}/api/auth` issuer.
- `EMAIL_FROM`: sender on the onboarded sending domain.
- `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`: paired production widget values.
- `BETTER_AUTH_SECRET`: the installation's stable authentication and encryption key.
- `LOGINFLARE_CONFIG_REVISION`: the requested runtime configuration revision.

Release `vars` must not contain those same names, even as empty placeholders. Deployment validation rejects conflicts; `keep_vars` is only an additional safeguard. The root `.dev.vars.example` declares only the first-install token. Local development has `.dev.vars.local.example`. The deleted installation token must not be a required secret for later deployments.

Binding updates do not guarantee an isolate restart. The page distinguishes application build, Worker runtime version and configuration revision, and confirms that the requested runtime configuration is actually observed. A commit hash is not configuration confirmation. See [binding update behavior](https://developers.cloudflare.com/workers/runtime-apis/bindings/#making-changes-to-bindings).

The selected authentication key is persisted as encrypted recovery material before updating Worker Secrets. After an uncertain response, inspect actual state instead of generating another key. Recovery files contain authentication material and belong outside Git. Temporary recovery material and setup credentials are cleaned through persistent, retryable steps after configuration is confirmed and installation completes.

Workers Builds deploys your repository; it does not automatically synchronize upstream source changes. Database upgrades are advanced in maintenance after code deployment. Redeployment must retain resource bindings, issuer and authentication keys and must not replay the initial secrets file.

Check a release build locally:

```powershell
pnpm install --frozen-lockfile
pnpm build:deploy
pnpm run deploy --dry-run
```

Upload with `pnpm run deploy` only after checking the target. Dependency installation, ordinary builds and local tests do not create remote resources.

## First transition for an existing installation

The old deployment guide used migrations-before-deployment. The current implementation blocks legacy/adoption installations with `VERIFIED_LEGACY_DRAIN_REQUIRED` and has no force-unlock option. Migration cannot proceed before the platform drain-evidence mechanism is verified. The following downtime and transition procedure must first be accepted; it is not a claim that existing installations are already allowed through. Do not retain the old Builds command.

1. Pause production, non-production and preview build triggers. Check their actual commands and handle queued or running old jobs. Change cloud commands to code-only build/deployment and remove business-database write access from old build credentials.
2. Deploy a transition release without changing business schema. It bootstraps independent control tables, serves maintenance/recovery, closes business admission and disables Cron. Explicitly enable transition mode for this release; new installations should not enable it.
3. Check that no old-version entrypoint accepts new work. Obtain terminal-state evidence for old HTTP requests, deferred work, scheduled tasks and already-issued D1/R2 operations. A transition release cannot retrospectively register old work. Waiting 3–5 seconds, switching traffic or observing no new logs is insufficient.
4. Keep the recovery point, matching R2 objects and original authentication key, verify that the key decrypts existing material, and enter exclusive migration only through the verified transition procedure.
5. Restore business service and Cron after every migration and check passes, then re-enable the corrected build triggers.

The old-version drain criterion must be validated on real Cloudflare. When it cannot be proved, remain stopped and refuse DDL. There is no ignore-drain shortcut. Changes in administrator count never reopen an existing installation for setup.

## Browser upgrades and recovery

Open `/maintenance`. While service is ready or a new build has closed admission but has not crossed the drain barrier, an administrator session can authorize a short-lived session bound to the upgrade task. If business authentication is unavailable, use a fresh temporary User API Token. Recovery writes a one-time dedicated challenge to the trusted current Worker and waits for the target runtime to observe it. A valid token, read-only Worker access or write access to another Worker is insufficient. Challenges do not rotate existing authentication keys.

A new build closes business admission automatically. Even when status already shows draining, the browser and CLI must persist backup confirmation for the current upgrade task before advancing drain and migration. An earlier task's confirmation does not carry over, and backup confirmation does not replace evidence that legacy operations have terminated.

Installation and maintenance dispatch before browser-account, branding and ordinary authentication initialization. Control tables have their own bootstrap and protocol version. Older schemas, failed partial upgrades and unknown business migrations do not make recovery depend on the newest business tables.

Browser and CLI share the persistent maintenance protocol: atomically close new admission, register foreground/background work, drain D1 and R2, then acquire an exclusive execution generation. The default lease is 90 seconds, with renewal attempted every 15 seconds during execution using database time. Takeover increments the generation. Every write transaction checks its generation in the same transaction so stale executors cannot commit. R2 and Cloudflare mutations record durable intent before dispatch; an unknown outcome blocks conflicting work. Lease expiry does not prove these external operations ended.

Installation sessions use random tokens with database digests. Removing the setup token does not remove cleanup recovery. Administrator promotion, permanent completion and `cleanup_pending` commit in one transaction. Afterwards authorized callers may retry cleanup, but cannot reopen configuration or create another first administrator. `waitUntil()` may assist but is not a cleanup completion guarantee. See [background execution limits](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil).

### Migration execution and CLI

Historical SQL remains unchanged. Build-time parsing preserves complete triggers and distinguishes top-level transaction wrappers. A migration file's complete statements, generation checks, migration registration and progress commit run in one D1 `batch()` transaction, preserving foreign-key deferral order. Do not split triggers on semicolons or split a file's transaction to make it fit request batching.

Files, preprocessing batches and checks may span requests. `MIGRATION_FILE_ROLLED_BACK` confirms rollback of the entire current file while previous successful files remain committed. `MIGRATION_COMMIT_UNCONFIRMED` or `UPGRADE_STEP_FAILED` means the commit result must be checked against persistent progress before any retry. Other validation failures keep maintenance active. The page shows the failed/current file and previous commits; an unfinished upgrade is not presented as a rollback of all files. An indivisible historical backfill exceeding platform limits stops in maintenance and needs a reviewed migration strategy; switching to CLI does not bypass D1 limits. See [batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/) and [limits](https://developers.cloudflare.com/d1/platform/limits/).

Remote CLI drives the same maintenance API. Credentials are read from private files:

```powershell
node scripts/database.mjs check --url https://accounts.example.com --cookie-file private-cookie.txt
node scripts/database.mjs migrate --url https://accounts.example.com --cookie-file private-cookie.txt --backup-confirmed
```

Use `--token-file private-token.txt` instead for write-challenge recovery. The cookie file contains the raw Cookie header. Neither file belongs in Git. Only use `--confirm-key` after explicitly checking the original key against a trusted source when no old ciphertext exists for validation; it cannot bypass invalid ciphertext. The old remote `--env staging|production` direct-D1 upgrade path is no longer used.

## Local development, backup and release acceptance

```powershell
pnpm install --frozen-lockfile
pnpm setup:local
pnpm db:migrate
pnpm db:check
pnpm dev
```

Open `http://localhost:5173`. Local configuration, simulated mail and test Turnstile are separate from the release template and do not send real mail. Local `pnpm build` uses development configuration; `pnpm build:deploy` and Workers Builds choose the release template. Use `LOGINFLARE_CONFIG` to explicitly select a private config and check the target during build.

`pnpm db:backup` saves local D1/R2 state and required configuration. Stop writes before a combined snapshot. Before remote upgrades separately verify D1 recovery points, matching R2 objects and authentication keys. Worker rollback does not revert data or object changes, and restoring an old database does not recreate deleted objects. A complete remote-backup system is outside the installer.

Release requires `pnpm check`, relevant browser flows, and explicitly authorized real Cloudflare isolated acceptance:

- Fresh provisioning, observed configuration, cross-device email verification and first administrator completion; ordinary registration and unauthorized promotion remain blocked.
- First transition correctly handles old commands, requests and R2 cleanup; missing terminal evidence blocks upgrades.
- Browser/CLI races, expired leases and resumed stale executors cannot migrate concurrently or commit across generations.
- Recovery pages remain accessible after failed migrations; read-only tokens, tokens for other Workers and replayed challenges fail.
- Interruptions after completion commit or a successful secret deletion with a lost response recover without reopening setup.
- A sufficiently long but incorrect key cannot decrypt old material and blocks upgrades.
- Fault injection around copy/drop/rename/trigger/registration stages of `0014` and `0015` rolls back the whole current file while retaining previous commits.
- After setup-token deletion and revocation, another automated deployment retains bindings, runtime configuration and valid credentials.

Release-blocking checks still need recorded official evidence or isolated results: reliable old-version/R2 drain evidence; minimum sending-endpoint permissions; actual observation and recovery of Secrets/challenge changes; deploy-button provisioning and redeployment retention; and remote D1 historical migration rollback/limits. Passing local tests is not a claim that the hosted end-to-end flow has passed.
