# Architecture

[English README](../README.md) · [简体中文说明](../README.zh-CN.md)

## Runtime boundaries

```text
Browser: React 19 + Material Web + React Router + react-i18next
    |
    | same-origin HTTPS
    v
Cloudflare Worker
    +-- Workers Static Assets: browser application
    +-- Hono: routing, request boundaries, authorization, safe errors
         +-- Better Auth: email/password, sessions, admin and CAPTCHA plugins
              +-- D1: users, accounts, sessions, verification and rate-limit records
              +-- Email Service binding: transactional delivery
              +-- Turnstile: server-side verification
```

The application has one Worker and one D1 database per environment. Local, staging, and production data and secrets are isolated. It does not require KV, R2, Queues, Durable Objects, an external database, or an external email provider.

Authentication instances are constructed with the current request's bindings. Request-scoped database objects must not be cached globally. Authentication schema changes use versioned SQL migrations rather than a second user model.

## Browser interface

The interface follows Material Design 3. React 19 renders the actual Web Components provided by the pinned `@material/web` 2.5.0 dependency. Shared MD3 design tokens control colors, typography, shapes, and interaction states across authentication forms, account pages, and administrator views. Layout and responsive styles remain in application CSS.

Brand emphasis uses `--loginflare-brand` (`#F38020`) with dark `--loginflare-on-brand` labels. The MD3 primary role uses a deeper orange for readable links, field labels, and focus indicators. Filled-button label/icon tokens cover normal, hover, focus, and pressed states; destructive actions retain the semantic error palette.

`/assets/theme.js` is a same-origin, blocking head script that applies the initial theme before the client module loads, without inline script or a weaker CSP. It owns the browser-local `loginflare.theme` preference (`system`, `light`, or `dark`), observes system color-scheme changes and cross-tab storage events, and exposes a stable snapshot to React through `useSyncExternalStore`. Manual choices override the system until System is selected again. Dark mode replaces the MD3 color roles and browser `color-scheme`; the brand orange stays the same. Turnstile is recreated with the active theme, invalidating the previous client-side CAPTCHA token until the new widget completes. No account schema or authentication API changes are required.

Material Web is bundled into the client build and uses system fonts; UI components and fonts are not loaded from an external CDN. Its Apache-2.0 license and dependency notices are included in the generated third-party notices. The upstream project is in [maintenance mode](https://github.com/material-components/material-web/discussions/5642); the dependency version is explicitly pinned.

## HTTP surface

Page paths are localized under `/en-us/` and `/zh-cn/`. Language identifiers inside the program remain `en-US` and `zh-CN`. Explicit URL language takes precedence over saved preferences.

API routes are not localized. `/api/auth/*` reaches the selected Better Auth endpoints through Hono's route/method boundary. `/api/health` only reports service health. Unknown API routes return JSON errors, never the SPA HTML entrypoint.

Only required user and administrator operations are exposed. The presence of a Better Auth plugin does not expose all of its operations. Role assignment, account deletion, email changes, administrator-set passwords, and impersonation are excluded from the public HTTP surface.

User lookup uses an exact email equality filter through Better Auth's native list-users endpoint. The UI trims and lowercases email input. The HTTP boundary permits only the email equality filter, supported sort fields, and bounded pagination. This keeps long addresses searchable within D1's LIKE/GLOB pattern limits without introducing a separate query implementation.

## Identity and authorization

`user` and `admin` share one account system. Public signup produces ordinary users. Email verification is required before sign-in. Administrator provisioning is an operator action against a specified existing verified account; it is not triggered by signup order or a public setup route.

The console can inspect ordinary users, suspend/restore them, and revoke their sessions. Administrator accounts cannot be suspended through this console. Browser navigation checks improve the experience; server checks enforce permissions.

Sessions are stored and checked in D1, without a cached cookie user snapshot or read replicas. Suspension revokes sessions, and restoring an account does not restore them. Password change revokes other sessions; password recovery revokes all sessions. No browser persistent storage contains authentication tokens.

## Mail and failure behavior

Email Service sends verification and password recovery messages using both HTML and plain text in the account's preferred language. The verification/reset token value must survive URL handling unchanged. Delivery failures provide a retry/resend path, without automatically switching providers or bypassing verification.

Local email delivery is simulated. Production configuration must include the verified sending domain and required email binding. Logs must omit secrets, passwords, session tokens, and full recovery or verification URLs.

Structured API request logs include a generated request ID, method, known route, status, and duration. Reset-link path tokens are replaced with `:token`; request queries, bodies, and cookies are never logged. Automatic platform invocation logs and traces are disabled, and query-string redaction is enabled, so platform URL capture does not bypass application redaction.

Turnstile and persistent rate limits protect sensitive authentication endpoints. Missing/invalid challenges and verification service failures reject the request. Production must never use Turnstile test credentials.

## Validation boundaries

Vitest and Workers integration tests exercise the Worker with local data. Playwright exercises localized user and administrator journeys in a real browser. Local mail simulation and Turnstile test behavior are used instead of production resources. Remote deployment, real delivery, and resource provisioning are separate operator actions.
