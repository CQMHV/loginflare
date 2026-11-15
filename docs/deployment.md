# Deploy Loginflare

[简体中文](deployment.zh-CN.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CQMHV/loginflare)

Use the button for a new repository, or import your existing organization repository in **Workers & Pages → Create application → Import a repository**. In either case, select `main`, leave the root at the repository root, and use `pnpm build:deploy` and `pnpm run deploy`. Leave preview builds disabled for this Worker. Cloudflare assigns the resource IDs. The release creates or binds D1 and two private R2 buckets, one for assets and one for instance keys.

You need an active Cloudflare zone for your login hostname, R2 enabled, and Workers Paid with [Email Sending](https://developers.cloudflare.com/email-service/) for real delivery.

Default bucket names derive from the full Worker name. Names that would exceed R2's 63-character limit include a deterministic SHA-256 prefix, so Workers sharing a long name prefix receive different buckets. Existing live bindings and explicitly configured bucket names are preserved.

1. Enter three **Worker secrets** in Cloudflare. If the existing repository import only offers build variables, add the values under the Worker’s **Settings → Variables and Secrets** when the Worker appears. Do not add them to build variables or Git.

   | Field | Example or purpose |
   | --- | --- |
   | `SETUP_ORIGIN` | `auth.example.com` — the permanent login and OIDC issuer hostname |
   | `SETUP_ADMIN_EMAIL` | The mailbox that will create the first administrator |
   | `CF_SETUP_TOKEN` | Short-lived Cloudflare **User API Token** described below |

2. Open the Worker’s `workers.dev` URL to see progress. The Worker connects the login hostname, configures `noreply@notify.<zone>`, and creates a Turnstile widget. If a DNS conflict is reported, resolve the named record in Cloudflare. Setup resumes from that step.
3. Open the login hostname and select **Send setup link**. Open the email link, choose a username and password, and sign in. The link expires in 20 minutes and can be used once. Registration and OAuth authorization open after the administrator is created.

### When setup needs attention

The installation page shows the current step, recovery guidance and a diagnostic code. Keep it open to check progress automatically. After a configuration correction, setup checks existing resources before continuing. Check the three secrets above under the Worker's **Settings → Variables and Secrets**; do not enter the token in a web form, build variables or Git.

| Page guidance | Next step |
| --- | --- |
| Access denied or wrong token type | Check `CF_SETUP_TOKEN` expiry, use the User API Token described below, and verify the selected account, zone and permissions. |
| DNS or hostname assignment conflict | Check the named record and Worker custom-domain assignment before changing them. Do not overwrite unrelated services. |
| Sending-domain verification or rate limiting | Keep the page open for automatic progress checks. For persistent failures, check Email Sending and the Worker's installation logs. |
| Cloudflare result could not be confirmed | A previous write may have succeeded. Keep the instance and resources while setup reconciles them; do not create replacements, delete resources or clear the database to retry. |
| Instance keys, private storage or database do not match | Follow the recovery instructions below to check the original D1, R2 and instance configuration. Regenerating keys or clearing data does not recover an existing instance. |

For other failures, use the diagnostic code to check the Worker's installation logs. If administrator email delivery fails, correct the email configuration and request the link again; an existing valid invitation remains valid.

### One-time token

In **My Profile → API Tokens**, create a custom **User API Token** with a short expiry that leaves time for DNS verification. Restrict it to the selected Cloudflare account and login zone:

- Account: Workers Scripts **Edit**, Turnstile **Edit**, Email Sending **Edit**.
- Zone: Zone **Read**, Workers Routes **Edit**, DNS **Edit**.

Use the token once in the Worker’s `CF_SETUP_TOKEN` secret. When the resources are ready, Loginflare removes the installation secrets from the Worker. The token itself expires in Cloudflare. Workers Builds uses a separate deployment credential with Workers, D1, and R2 write access.

### Updates and recovery

Workers Builds publishes from the connected repository’s `main`. The deploy script checks the target Worker, storage bindings, migration history, and current branch before promotion. A code-only release applies no migrations. Pending migrations on an existing instance need a reviewed SHA-256 entry in [the online migration list](../migrations/online.json). Test with representative data and verify that the previously deployed Worker can continue to serve throughout the change. Incompatible changes need a separately reviewed operations procedure and a planned service window.

Each file is applied in a D1 batch with its history entry. A failure names the file and leaves the current Worker serving. Previously committed files remain applied. Fix the pending file and retry from the latest `main`; do not edit already-applied files. [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) covers database recovery when needed.

To replace a Worker, bind the original D1, asset bucket, and private bucket, keeping the same Worker name and issuer. The private bucket contains authentication keys and instance configuration; leave public access disabled. Loginflare stops if the original material is missing or its fingerprint differs. Worker rollback does not roll back D1 or R2. This installation path does not adopt databases from the older browser maintenance flow.
