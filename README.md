# Loginflare

An open-source account and identity management system built for Cloudflare.

[简体中文](README.zh-CN.md) · [Deployment](docs/deployment.md) · [Application integration](docs/oauth.md) · [Architecture](docs/architecture.md)

Loginflare is a fully functional system for general account and identity management. It combines a user account center, an administrator console, and standard OAuth/OIDC sign-in for independent Web and SPA applications, with email or username sign-in, email verification, password recovery, and session management. The system runs as one Cloudflare Worker with D1, Email Service, Turnstile, and Workers Static Assets.

The maintainer currently runs only a personal test instance for functional checks, and its management console requires administrator access. Other users use Loginflare by forking this repository, configuring their own resources, and deploying independent instances. The Web/SPA examples exercise the complete integration flows. Applications for specific business needs can build on this project in separate branches, with their own branding and business rules.

The default language is **`en-US`**. Users can select **`zh-CN`**. Page URLs use lowercase language segments: `/en-us/` and `/zh-cn/`.

## Features

- Register, verify email, resend verification, sign in with an email address or username, and sign out.
- Recover a forgotten password and change a known password.
- Update a display name and username, and manage active sessions.
- Manage primary and secondary email addresses on a dedicated page, verify new addresses with codes, and choose the primary sign-in email.
- Find users by exact email, inspect their accounts, suspend or restore ordinary accounts, and revoke their sessions.
- Register server Web and SPA clients through the administrator console, with exact redirects, consent, and client-secret rotation.
- OpenID Connect sign-in using authorization code + PKCE S256, discovery, UserInfo, RS256 ID Tokens, refresh tokens, and application-initiated central logout.
- English and Simplified Chinese pages, error messages, and transactional emails.
- Better Auth account/session primitives, D1-backed rate limiting, and server-verified Turnstile challenges.

This release does not offer social login, MFA, organizations, multi-tenancy, account deletion, browser-based role assignment, impersonation, or administrator-set passwords. OAuth client credentials, native/device clients, dynamic client registration, custom business API permissions, and coordinated logout across all applications are also outside its scope. Those endpoints are not exposed.

Usernames are separate from display names. The registration form asks for a unique username of 3–30 ASCII letters, numbers, underscores, or dots; usernames are stored in lowercase and sign-in is case-insensitive. Existing accounts can continue using email and choose a username in their profile. Users can change their username; an existing username cannot be cleared. Email verification is required for both sign-in methods. Only the primary email works as an email sign-in identifier.

The **Email addresses** page manages one primary email and additional secondary emails. Every address is unique across all accounts, regardless of its role. Adding an address requires the current password and verification of a code sent to that address. A verified secondary email can become primary after password confirmation; the previous primary remains secondary. The primary address must be replaced before it can be removed. Password recovery starts with the username or primary email and sends a code to a specified verified primary or secondary address belonging to that account. Secondary emails never identify an account for sign-in.

## Interface

The interface follows Material Design 3 and uses **Material Web (`@material/web` 2.5.0)** Web Components inside React 19. Shared MD3 design tokens define the color, typography, shape, and interaction styles across authentication, account, and administrator pages. Components are bundled with the application; the interface uses system fonts and does not load UI components or fonts from an external CDN.

The theme uses Cloudflare orange (`#F38020`) for brand accents and primary button fills, paired with dark labels. Deeper orange is used for links and focus indicators to preserve contrast on light surfaces.

Light and dark themes follow the system by default. The theme menu can select Light, Dark, or System; this browser preference persists across reloads and synchronizes between tabs. It is separate from the account's language preference. The initial theme is applied before React loads, and Turnstile follows the active theme.

Material Web is licensed under Apache-2.0 and is currently in [upstream maintenance mode](https://github.com/material-components/material-web/discussions/5642). Loginflare pins its version and includes its third-party license notices.

## Local development

Requirements: Node.js 24 LTS and pnpm 11.25.0, as declared in `packageManager`. The project pins its Cloudflare tooling as development dependencies. Install from the committed lockfile and generate local secrets:

```powershell
pnpm install --frozen-lockfile
pnpm setup:local
```

`setup:local` creates the ignored `.dev.vars` file with a random authentication secret and the official Turnstile development test secret. It leaves an existing file unchanged. `.dev.vars.example` documents the variables; its placeholder authentication secret is deliberately rejected. Initialize the local database and start the app:

```powershell
pnpm db:migrate
pnpm dev
```

Open `http://localhost:5173` (the configured authentication origin). A fresh browser opens English by default. The development email binding simulates delivery locally: inspect its output for registration-verification links and email-management/recovery codes. Local development does not need to send real email or create Cloudflare resources. Never use the Turnstile test configuration for a production deployment.

Development and the operator commands share `.cloudflare/state`. Local CLI configuration/registry files are kept in `.cloudflare/tool-config`; both directories are ignored. The resource commands prefer `cf`. This version uses stable Vite/Wrangler for development, build, generated Worker types and deployment because the pinned `cf` development/build path requires the beta Vite plugin. Local administrator promotion also uses Wrangler because this `cf` version has no local D1 query implementation. Remote D1 operations continue to use `cf`.

### First administrator

Register the intended administrator as an ordinary account and verify its email. Promote that exact address with the local operator command:

```powershell
pnpm admin:promote -- --email admin@example.com --local
```

The command requires an existing, verified account and is idempotent. Sign out and sign in again after promotion. Registration never automatically creates an administrator. The web console cannot assign roles or suspend another administrator.

## Validation

`pnpm check` runs type checking, Worker integration tests, operator-command tests, and the production build. Run `pnpm test:e2e` as well to exercise the browser flows. The [CI workflow](.github/workflows/ci.yml) runs both on pull requests and pushes to `main`, using local D1, simulated email, and Turnstile test keys; browser reports are retained for seven days.

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

Passwords contain 8–128 characters. Registration-verification tokens expire after one hour, and sessions last seven days with Better Auth's standard renewal behavior; cookie session caching is disabled. Email-management and recovery codes expire after ten minutes and allow at most five attempts. Verified recovery hands off a ten-minute token to Better Auth's native password reset. Each account can manage up to ten email addresses; unverified secondary reservations can be reclaimed after one day when that address is added again.

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
