# Third-party sign-in

[简体中文](social.zh-CN.md) · [Deployment](deployment.md) · [Application integration](oauth.md)

Administrators configure Google, GitHub, OpenID Connect and OAuth 2.0 connections under **Administration → Third-party sign-in**. Multiple connections of each type are supported. Applications continue to integrate with Loginflare's issuer and OAuth/OIDC endpoints; they never need the upstream client credentials. Upstream access/refresh/ID tokens are used only during authentication and are not stored for API access or logout.

## Configure a connection

1. Create a connection with a display name, client ID and client secret. New connections are disabled. Copy its callback URL, `${AUTH_URL}/api/auth/callback/<connection-id>`, into the upstream client's exact redirect allowlist.
2. For Google, create a Web application OAuth client and configure its consent screen and test users as required by Google. For GitHub, create an OAuth App and set its authorization callback. These presets use Better Auth's provider implementations and fixed protocol endpoints.
3. For OIDC, enter the exact issuer, discovery URL, scopes and client authentication method. The discovery issuer must match; authorization, token, UserInfo and JWKS URLs must be public HTTPS services. The connector verifies signature, issuer, audience, expiry and nonce. `openid` is always included.
4. For OAuth 2.0, enter the authorization, token and protected user profile endpoints, scopes and client authentication method. Map the stable subject, name, email, verified-email boolean and avatar URL using dotted JSON field names, for example `data.id`. Empty optional mappings omit that field. Scripts and expressions are not supported. Use a provider-assigned immutable subject; do not map email or nickname as the subject. OAuth identities come from the protected profile response, never an unverified ID Token.
5. Save, use **Test sign-in**, inspect the returned profile, then enable the connection. Testing authenticates the current administrator with the upstream only; it creates neither users nor bindings. Set display order to arrange login buttons. Save edits before testing them.

Secrets are encrypted in D1 with `BETTER_AUTH_SECRET`. Management responses expose only whether a secret exists. Leave the secret blank while editing to keep it, or enter a replacement. Preserve the deployment secret in backups; changing it without migrating encrypted values breaks connection credentials and pending flows.

The connection ID is permanent and never reused. After the first identity is linked, its type, client ID, identity source/endpoints and subject mapping remain locked, including after unlinking. Create a new connection to replace an identity source. Secrets, labels, scopes and order can still change. Any saved change, disabling or archiving invalidates unfinished flows for the old revision. Archiving is permanent. Disabling/archiving removes login buttons and prevents new sign-ins without revoking existing Loginflare sessions.

## Registration and account linking

An identity is `(connection ID, stable subject)`. Changes to upstream email or name do not change its owner. A trusted verified email permits immediate passwordless registration without a username. Otherwise the browser must complete local email verification first; no user, placeholder email or login session is created before that verification. Existing primary and secondary emails are reserved across all accounts. A conflict never merges accounts: sign in to the original account and explicitly link the third-party identity from **Account → Security**.

Linking may use a third-party account with a different email. It does not change or add Loginflare email addresses. Binding and unlinking require identity confirmation and remain bound to the initiating user/session. Unlinking atomically retains at least one usable sign-in method; disabled or archived connections do not count. Unlinking leaves profile data intact.

Accounts with a password confirm it for sensitive operations. Passwordless accounts reauthenticate an already linked identity, and complete Loginflare MFA when enabled. The server issues a five-minute, one-use confirmation bound to the user, current session and operation. This applies to linking/unlinking, email changes, first password setup and MFA management. Email recovery can set the first password, keeps MFA enabled and revokes old sessions, application grants and pending authentication proofs. If no linked provider remains available, use recovery through a verified account email.

Third-party sign-in cannot bypass Loginflare MFA. No usable new session or downstream authorization code is delivered before its authenticator/recovery-code challenge succeeds. Language, purpose and signed application authorization context survive callback, email completion and MFA. The existing OAuth Provider resumes authorization after completion; downstream `sub` remains the Loginflare user ID.

Each successful login fills only an empty nickname/photo. Existing values, primary email and username are retained. A missing nickname remains unset; displays may fall back to email. Avatar import downloads only the authenticated profile's URL through a protected same-origin endpoint. It uses the existing image checks, centered square crop, 256-pixel WebP encoding and private R2 lifecycle; the final update requires the avatar still to be empty. Import failure does not block login and a later login retries, including after a photo was deleted.

## Operational and API notes

- Public discovery: `GET /api/social/providers` returns enabled connection names, types and ordering only.
- Administration: `GET/POST /api/admin/social-connections`, `PATCH /api/admin/social-connections/:id`, `POST /api/admin/social-connections/:id/test` with a locale. Updates require the current revision; archived records remain visible.
- Restricted authentication: `/api/auth/social/start`, `/social/flow`, `/social/email`, `/social/verify-email`, `/social/finish`. Start accepts only a connection ID, locale, purpose and validated continuation/security context. Administrator testing uses `purpose: test`; callbacks use `/api/auth/callback/:id`.
- Account capabilities and identities: `GET /api/auth/social/security`; sensitive writes use `/social/unlink`, `/social/set-password` and existing email/MFA endpoints. Callers cannot override upstream endpoints, scopes or redirects.
- Generic upstream requests validate public HTTPS URLs, DNS addresses and same-origin GET redirects, with time/byte limits. Private, loopback, metadata and reserved destinations are refused. Connection failures do not initialize or affect local password sign-in.
- Migration `0012_social_connections.sql` adds encrypted ten-minute, browser-bound single-use flow state, five-minute operation proofs, identity uniqueness and immutable-source guards. Existing scheduled maintenance removes expired state in bounded batches. Existing users and application issuers are unchanged.

Automated tests use isolated simulated upstreams and never operate real Google/GitHub accounts. Operators must supply configured client credentials for actual platform acceptance. SAML, organization SSO, WeChat/QQ-specific flows, upstream API authorization/token hosting and coordinated upstream logout are outside this release.
