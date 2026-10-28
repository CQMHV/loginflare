# Loginflare

An open-source account and identity center built for Cloudflare.

[简体中文](README.zh-CN.md) · [Deployment](docs/deployment.md) · [Application integration](docs/oauth.md) · [Architecture](docs/architecture.md)

Loginflare provides email/password accounts, verified email sign-in, password recovery, a personal account center, session management, and an administrator console. Other websites can sign in with Loginflare through OAuth/OIDC. The application runs as one Cloudflare Worker with D1, Email Service, Turnstile, and Workers Static Assets.

The default language is **`en-US`**. Users can select **`zh-CN`**. Page URLs use lowercase language segments: `/en-us/` and `/zh-cn/`.

## Features

- Register, verify email, resend verification, sign in, and sign out.
- Recover a forgotten password and change a known password.
- Update a display name and manage active sessions.
- Find users by exact email, inspect their accounts, suspend or restore ordinary accounts, and revoke their sessions.
- Register server Web and SPA clients through the administrator console, with exact redirects, consent, and client-secret rotation.
- OpenID Connect sign-in using authorization code + PKCE S256, discovery, UserInfo, RS256 ID Tokens, refresh tokens, and application-initiated central logout.
- English and Simplified Chinese pages, error messages, and transactional emails.
- Better Auth account/session primitives, D1-backed rate limiting, and server-verified Turnstile challenges.

This release does not offer social login, MFA, organizations, multi-tenancy, account deletion, email changes, browser-based role assignment, impersonation, or administrator-set passwords. OAuth client credentials, native/device clients, dynamic client registration, custom business API permissions, and coordinated logout across all applications are also outside its scope. Those endpoints are not exposed.

## Interface

The interface follows Material Design 3 and uses **Material Web (`@material/web` 2.5.0)** Web Components inside React 19. Shared MD3 design tokens define the color, typography, shape, and interaction styles across authentication, account, and administrator pages. Components are bundled with the application; the interface uses system fonts and does not load UI components or fonts from an external CDN.

The theme uses Cloudflare orange (`#F38020`) for brand accents and primary button fills, paired with dark labels. Deeper orange is used for links and focus indicators to preserve contrast on light surfaces.

Light and dark themes follow the system by default. The theme menu can select Light, Dark, or System; this browser preference persists across reloads and synchronizes between tabs. It is separate from the account's language preference. The initial theme is applied before React loads, and Turnstile follows the active theme.

Material Web is licensed under Apache-2.0 and is currently in [upstream maintenance mode](https://github.com/material-components/material-web/discussions/5642). Loginflare pins its version and includes its third-party license notices.

## Local development

Requirements: Node.js 24 LTS and pnpm. The project pins its Cloudflare tooling as development dependencies. Install from the committed lockfile and generate local secrets:

```powershell
pnpm install --frozen-lockfile
pnpm setup:local
```

`setup:local` creates the ignored `.dev.vars` file with a random authentication secret and the official Turnstile development test secret. It leaves an existing file unchanged. `.dev.vars.example` documents the variables; its placeholder authentication secret is deliberately rejected. Initialize the local database and start the app:

```powershell
pnpm db:migrate
pnpm dev
```

Open `http://localhost:5173` (the configured authentication origin). A fresh browser opens English by default. The development email binding simulates delivery locally: inspect its output to open verification and reset links. Local development does not need to send real email or create Cloudflare resources. Never use the Turnstile test configuration for a production deployment.

Development and the operator commands share `.cloudflare/state`. Local CLI configuration/registry files are kept in `.cloudflare/tool-config`; both directories are ignored. The resource commands prefer `cf`. This version uses stable Vite/Wrangler for development, build, generated Worker types and deployment because the pinned `cf` development/build path requires the beta Vite plugin. Local administrator promotion also uses Wrangler because this `cf` version has no local D1 query implementation. Remote D1 operations continue to use `cf`.

### First administrator

Register the intended administrator as an ordinary account and verify its email. Promote that exact address with the local operator command:

```powershell
pnpm admin:promote -- --email admin@example.com --local
```

The command requires an existing, verified account and is idempotent. Sign out and sign in again after promotion. Registration never automatically creates an administrator. The web console cannot assign roles or suspend another administrator.

## Validation

```powershell
pnpm typecheck
pnpm test
pnpm test:ops
pnpm test:e2e
pnpm build
```

Integration and browser tests use isolated local data, simulated email, and Turnstile test responses. They must not be pointed at a production account or database. Install Chromium when setting up Playwright on a new machine:

Browser tests load Cloudflare's official Turnstile test widget and require internet access. Database operations and email delivery remain local. On Windows, the test configuration uses an installed Chrome by default; set `PLAYWRIGHT_CHANNEL` to select another installed channel, or use bundled Chromium on other platforms.

```powershell
pnpm exec playwright install chromium
```

## Account behavior

- Email verification is required before sign-in.
- Changing a password requires the current password and revokes other sessions.
- Resetting a password revokes all sessions and requires a fresh sign-in.
- Suspending an account revokes existing sessions and blocks new sign-ins. Restoring it does not restore old sessions.
- Session checks use D1 rather than a cookie-cached user snapshot.
- Only the server can set role, email verification, and suspension fields.
- Protected responses are not cached. Logs must not contain passwords, session tokens, or full verification/reset links.

The pinned Better Auth version uses password lengths of 8–128, one-hour verification and password-reset tokens, and seven-day sessions with its standard renewal behavior. Loginflare keeps those defaults while explicitly disabling cookie session caching.

## Connect another application

Administrators create applications under **Applications**. Server applications use `client_secret_basic`; browser SPAs use `none` and never receive a secret. Both require authorization code + PKCE S256 and first-use consent. Discover the provider at `${AUTH_URL}/api/auth/.well-known/openid-configuration`.

See the [integration guide](docs/oauth.md) for callbacks, token lifetimes, security-event revocation, and the standard `openid-client` / `oidc-client-ts` examples. The examples use local HTTPS subdomains and locally generated certificates; no system trust-store changes or remote resources are required.

Ordinary central logout retains native `offline_access` refresh authorization. Applications own their local sessions; logging out of Loginflare does not sign every application out. Security actions such as password recovery and account suspension have separate credential-invalidation rules described in the integration guide.

## Languages and URLs

The program, translation resources, stored preferences, and HTML `lang` use `en-US` / `zh-CN`; URL segments use `en-us` / `zh-cn`. An explicit page URL determines its language. Switching language keeps the current page and query parameters, including case-sensitive tokens.

The root entry uses the saved preference, or `en-US` when none exists. Browser language is not used to choose Chinese automatically. Unsupported or incorrectly cased language segments return 404. API routes remain under `/api/*`, without language prefixes. Transactional email follows the account's language preference and returns the user to the matching localized result page.

## Deployment

See the [deployment guide](docs/deployment.md) for separate staging/production data, secrets, domain and email setup, migrations, and administrator provisioning.

Cloudflare Email Sending is currently Beta and arbitrary-recipient transactional delivery requires Workers Paid. A verified sending domain and real Turnstile configuration are required for production. Missing security configuration is an error; Loginflare does not silently skip email verification or bot protection.

Local installation, tests, and builds do not authorize remote resource creation, real email delivery, or deployment. Perform those operations deliberately against a verified target environment.

## License

Copyright © 2026 Loginflare contributors.

Loginflare is available under **either the [MIT License](LICENSE-MIT) or the [Apache License 2.0](LICENSE-APACHE), at your option**. The SPDX expression is `MIT OR Apache-2.0`; package metadata uses `(MIT OR Apache-2.0)`. See [LICENSE](LICENSE).

Third-party dependencies and incorporated materials retain their own licenses and required notices. Adding them to this project does not relicense them under Loginflare's dual-license choice. Builds regenerate [third-party notices](public/assets/third-party-notices.txt) from the locked runtime dependencies and include them at `/assets/third-party-notices.txt`.
