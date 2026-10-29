# Architecture

[English README](../README.md) · [简体中文说明](../README.zh-CN.md)

Loginflare is a general account and identity platform for independent deployments from small teams to large public-facing services. It combines a user account center, an administrator console, and standard OAuth/OIDC integration. The maintainer's personal test instance does not restrict independent deployment uses. Other operators fork the repository and configure their own instances. Business-specific applications can build on the platform in separate branches with their own branding and rules.

## Runtime boundaries

```text
Browser: React 19 + Material Web + React Router + react-i18next
    |
    | same-origin HTTPS
    v
Cloudflare Worker
    +-- Workers Static Assets: browser application
    +-- Hono: routing, request boundaries, authorization, safe errors
         +-- Better Auth: email/password, username, sessions, admin, CAPTCHA, OAuth provider and JWT
              +-- D1: accounts, sessions, verification, rate limits, OAuth clients/tokens/consents, signing keys
              +-- Email Service binding: transactional delivery
              +-- Turnstile: server-side verification
```

The application has one Worker and one D1 database per environment. Local, staging, and production data and secrets are isolated. It does not require KV, R2, Queues, Durable Objects, an external database, or an external email provider.

D1 is the only implemented database backend. Registered-account volume and concurrent request capacity are separate dimensions. Large public deployments must be measured against their own traffic mix and current platform limits; a million stored accounts is not a claim of a million concurrent users. Hyperdrive and external SQL backends are future integrations, not supported configurations. See [Scaling and validation](scaling.md).

Authentication instances are constructed with the current request's bindings. Request-scoped database objects must not be cached globally. Authentication schema changes use versioned SQL migrations rather than a second user model.

## Browser interface

The interface follows Material Design 3. React 19 renders the actual Web Components provided by the pinned `@material/web` 2.5.0 dependency. Shared MD3 design tokens control colors, typography, shapes, and interaction states across authentication forms, account pages, and administrator views. Layout and responsive styles remain in application CSS.

Account preferences, email addresses, and sessions use Material lists and list items, with Material dividers between records. Action links use Material text or icon buttons. Sidebar navigation keeps React Router links with Material ripple and focus-ring components, preserving current-page announcements, keyboard activation, and native link behavior. Cards, avatars, status labels, and tables use application markup because the pinned Material Web package has no corresponding components.

The account center (`/account/*`) and administrator console (`/admin/*`) mount separate layouts and navigation trees. Account navigation contains only personal profile, emails, security and sessions; administrator navigation contains only users and applications. An administrator can explicitly switch areas, and each area's brand link returns to its own home. The entire administrator layout requires the administrator guard, while API authorization remains enforced by the server. The localized `/admin` entry opens user management. Theme, language and sign-out controls share the visual shell without combining the two areas' navigation.

Brand emphasis uses `--loginflare-brand` (`#F38020`) with dark `--loginflare-on-brand` labels. The MD3 primary role uses a deeper orange for readable links, field labels, and focus indicators. Filled-button label/icon tokens cover normal, hover, focus, and pressed states; destructive actions retain the semantic error palette.

`/assets/theme.js` is a same-origin, blocking head script that applies the initial theme before the client module loads, without inline script or a weaker CSP. It owns the browser-local `loginflare.theme` preference (`system`, `light`, or `dark`), observes system color-scheme changes and cross-tab storage events, and exposes a stable snapshot to React through `useSyncExternalStore`. Manual choices override the system until System is selected again. Dark mode replaces the MD3 color roles and browser `color-scheme`; the brand orange stays the same. Turnstile is recreated with the active theme, invalidating the previous client-side CAPTCHA token until the new widget completes. No account schema or authentication API changes are required.

Material Web is bundled into the client build and uses system fonts; UI components and fonts are not loaded from an external CDN. Its Apache-2.0 license and dependency notices are included in the generated third-party notices. The upstream project is in [maintenance mode](https://github.com/material-components/material-web/discussions/5642); the dependency version is explicitly pinned.

## HTTP surface

Page paths are localized under `/en-us/` and `/zh-cn/`. Language identifiers inside the program remain `en-US` and `zh-CN`. Explicit URL language takes precedence over saved preferences.

API routes are not localized. `/api/auth/*` reaches the selected Better Auth endpoints through Hono's route/method boundary. `/api/health` only reports service health. Unknown API routes return JSON errors, never the SPA HTML entrypoint.

Only required user and administrator operations are exposed. The presence of a Better Auth plugin does not expose all of its operations. Role assignment, account deletion, administrator-set passwords, and impersonation are excluded from the public HTTP surface. Email management and code-based recovery use the Loginflare email plugin; the generic native change-email and request-password-reset routes are not exposed.

External applications use the dedicated OAuth/OIDC surface. The issuer is `${AUTH_URL}/api/auth`; protocol requests use their native methods and content types. Registered SPA callback Origins receive protocol-only CORS access without account cookies. Account and administrator APIs remain same-origin JSON. Discovery and JWKS are public, while the JWT plugin's standalone `/token` route, dynamic registration, native/device grants, and client credentials remain closed.

Application management is exposed through `/api/admin/applications` with server-side administrator checks. Creation, detail, editing, disabling, and secret rotation use the provider's management APIs; the list uses a bounded D1 projection containing only client ID, name, type, disabled state, and creation time. General client self-registration remains closed. Clients share an instance reference and are managed by all instance administrators. Redirects use the upstream web-client policy: exact HTTPS URLs on non-loopback hostnames. The local examples satisfy that policy with HTTPS `web.localhost` and `spa.localhost` hostnames.

The list surface is `GET /api/admin/users`, `GET /api/admin/applications`, and `GET /api/account/sessions`. The native `/api/auth/admin/list-users` and `/api/auth/list-sessions` routes are not exposed. Lists use `(createdAt, id)` keys, or `(createdAt, clientId)` for applications, with descending indexed ordering and a bounded `limit + 1` read. A signed cursor binds its direction and position to the entity, owner, and exact lookup. User search supports ID, username, or primary email; application search supports client ID or full name. No arbitrary sort, offset, substring filter, or exact-total query is exposed. Responses contain `items` and `pageInfo` with next/previous cursors. Session pages also report `hasOtherSessions` independently of the page length. Native session-revocation operations remain in use.

The browser stores cursor and exact lookup parameters in the URL, restores them after detail navigation, and shows only the current page's size. Previous, Next, and Return to latest replace numbered pages and a total count.

OAuth callback Origins and exact post-logout destinations have an indexed `oauthClientUri` projection maintained by triggers. Callback strings remain authoritative in the native client fields. Migration preparation derives Origins with the URL parser into `metadata.loginflareRedirectOrigins`; protocol checks seek this index rather than enumerating every application. Creation and updates keep the metadata and indexed projection synchronized.

## Identity and authorization

`user` and `admin` share one account system. Public signup produces ordinary users. Email verification is required before sign-in. Administrator provisioning is an operator action against a specified existing verified account; it is not triggered by signup order or a public setup route.

The official Username plugin adds a unique, lowercase `username` to the existing user model, without a separate `displayUsername` field. Display names remain independent and need not be unique. The browser's sign-in field accepts an email address or username and selects the corresponding native password endpoint; both endpoints use Turnstile, persistent rate limiting, email-verification checks, and account-suspension rules. Username sign-in also preserves the provider-signed OAuth query. Usernames contain 3–30 ASCII letters, digits, underscores, or dots and match case-insensitively. The nullable field preserves existing accounts without inventing login names; those users can choose or change a username in their profile. Configuring username support does not change the account's stable user ID or OIDC subject.

The dedicated localized `/account/emails` page manages all addresses. Better Auth's `user.email` and `emailVerified` remain the authoritative primary email and its verification status. An email registry records primary and secondary addresses with global case-insensitive uniqueness, covering both registration and subsequent management. Verified secondary addresses can become primary; the previous primary remains registered as secondary. Only the primary address or username identifies a password sign-in, and the stable user ID, credentials and OIDC subject do not change when the primary address changes.

Email management requires a valid unbanned session, same-origin JSON, and current-password confirmation for sensitive changes. Adding an address proves mailbox access with a short-lived code. Recovery first resolves a username or primary email, then sends a code only to a specified verified address registered to that account. Unknown accounts and ineligible destinations return a generic challenge result. Codes bind the account, address, purpose and individual challenge, are stored as hashes, and have bounded attempts, lifetime and send rates. A verified recovery challenge produces a native Better Auth reset token; native reset owns password hashing, single-use consumption and security-event revocation. No secondary email can independently select an account.

The console can inspect ordinary users, suspend/restore them, and revoke their sessions. Administrator accounts cannot be suspended through this console. Browser navigation checks improve the experience; server checks enforce permissions.

Sessions are stored and checked in D1, without a cached cookie user snapshot or read replicas. Suspension revokes sessions, and restoring an account does not restore them. Password change revokes other sessions; password recovery revokes all sessions. No browser persistent storage contains authentication tokens.

The OAuth provider and core are pinned together at 1.7.13. Authorization code + PKCE S256 is required for both Web and SPA clients. The provider owns code consumption, token rotation, client secrets, consent, and protocol validation; its JWT plugin issues RS256 ID Tokens and encrypts private signing keys stored in D1. Access tokens are opaque because no business resource audiences are registered. Roles and administrator capabilities are not issued as application permissions.

Ordinary logout preserves the provider's `offline_access` refresh-token semantics. Security events have a separate Loginflare revocation policy. The [integration guide](oauth.md) describes the resulting behavior and the limits of application-owned sessions. There is no global logout notification service or custom OAuth protocol implementation.

## Mail and failure behavior

Email Service sends registration-verification links and email-management/recovery codes using both HTML and plain text in the account's preferred language. Registration token values must survive URL handling unchanged. Private verification delivery failures provide a retry/resend path. Public recovery delivery runs through the request's `waitUntil` callback and returns the same generic result on failed delivery, so delivery status and network latency do not disclose account eligibility. Failed delivery invalidates its challenge and records only a redacted failure event. There is no automatic provider switch or verification bypass.

Local email delivery is simulated. Production configuration must include the verified sending domain and required email binding. Logs must omit secrets, passwords, session tokens, and full recovery or verification URLs.

Structured API request logs include a generated request ID, method, known route, status, and duration. Development logs requests; remote environments retain server errors and a small sample of ordinary requests. Reset-link path tokens are replaced with `:token`; request queries, bodies, cookies, OAuth codes, client secrets, and tokens are never logged. Automatic platform invocation logs and traces are disabled, and query-string redaction is enabled.

Turnstile and persistent rate limits protect sensitive authentication endpoints. Missing/invalid challenges and verification service failures reject the request. Production must never use Turnstile test credentials.

## Data integrity and maintenance

Native Better Auth date columns use ISO UTC text consistently for comparison, ordering, and API serialization. Custom code-challenge and rate-limit clocks use explicit integer milliseconds. The migration wrapper prepares existing native dates and OAuth callback metadata before applying SQL migrations, then verifies the committed tables, columns, indexes, triggers, foreign keys, date storage, and callback/URI-registry consistency. Origin updates compare the old callback strings and metadata and stop on a conflict. Operators pause application registration, callback editing, and related writes until migration and the new Worker switch complete; the wrapper does not establish this window automatically. `pnpm db:check` checks local state without repairing it; remote checks require an explicit environment. Runtime schema autodiscovery remains disabled because deployment owns the schema gate.

Rate-limit consumption is an atomic conditional D1 UPSERT, so concurrent requests cannot each pass a separate read and overwrite the count. The custom request boundary preserves endpoint-specific windows, CAPTCHA, and native authentication behavior; denied requests do not extend the counter window. Limits fail closed if storage is unavailable.

A five-minute Cron Trigger invokes expiry maintenance on the existing Worker. Each run has bounded batches and time, uses expiry indexes, and retains a safety buffer. It collects expired rate counters, email challenges, verification records, credentials, and eligible grant-policy records. References are checked before deleting sessions or refresh tokens so cleanup cannot change offline authorization semantics through foreign-key cascades. Grant policy outlives every credential that could still use it. Records remain invalid when expired even if cleanup has not run; cleanup is separate from authentication validity and request latency.

Backups include a consistent SQLite snapshot for local D1 and the local configuration/credential files needed to reopen it. Database state, issuer, and authentication secret form one recovery unit, including encrypted signing keys. Remote updates use D1 recovery mechanisms against the reviewed environment. A Worker rollback alone does not restore database contents.

## Validation boundaries

Vitest and Workers integration tests exercise the Worker with local data. Playwright exercises localized user and administrator journeys and independent standard-client examples in a real browser. Example TLS certificates are local files, browser certificate exceptions and host-resolution overrides apply only to the test process, and system certificate/DNS settings remain unchanged. Local mail simulation and Turnstile test behavior are used instead of production resources. Remote deployment, real delivery, and resource provisioning are separate operator actions.
