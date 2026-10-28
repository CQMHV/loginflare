# External applications and OAuth/OIDC

[简体中文](oauth.zh-CN.md) · [Architecture](architecture.md) · [English README](../README.md)

Loginflare uses `@better-auth/oauth-provider` and Better Auth 1.7.13 to let independent Web applications use its accounts. OAuth/OIDC protocol behavior comes from the provider. Loginflare adds application administration, localized consent, and account security policy through supported hooks and D1 constraints.

## Client contract

The issuer is `${AUTH_URL}/api/auth`, for example `https://identity.example.com/api/auth`. Set the public origin before registering applications and keep the issuer stable. Clients should discover endpoints from the issuer instead of constructing token URLs themselves.

| Client | Authentication | Secret location | Authorization flow |
| --- | --- | --- | --- |
| Server Web | `client_secret_basic` | Application server only | Authorization code with PKCE S256 |
| SPA | `none` | No client secret | Authorization code with PKCE S256 |

The scope set is `openid profile email offline_access`. `openid` identifies the user, `profile` permits profile claims, `email` permits email claims, and `offline_access` requests renewable access. Loginflare administrator roles are not application permissions and are not added to identity claims. An ID Token describes the authenticated identity; it is not a bearer credential for an application's business API.

This iteration does not provide client credentials, native/mobile clients, device authorization, dynamic registration, custom resource audiences, or application-specific API authorization. It uses opaque access tokens for UserInfo and RS256 ID Tokens through Better Auth's JWT plugin.

The management console is administrator-only. Applications belong to the Loginflare instance and are shared between its administrators. The console creates and edits names, exact callback URLs, exact post-logout URLs, and permitted scopes; it disables/restores applications and rotates server client secrets. Client type is fixed at creation. Secret plaintext is shown once after creation or rotation, never returned in an application list.

Every application requires consent on first use. Expanded permissions require consent again. There is no trusted-application switch to skip consent.

Register exact HTTPS callback and post-logout URLs. Wildcards, fragments, embedded credentials, plain HTTP, and literal loopback hosts are rejected by the web-client policy. The provider distinguishes client authentication from URI application type: both Loginflare types use `application_type: web`. Local examples use HTTPS subdomains such as `web.localhost` without changing this policy or relabeling browser clients as native applications.

## Protocol surface

All paths below are relative to the issuer unless otherwise stated. The provider implements the protocol; Hono restricts the exposed paths, methods, request formats, and cross-origin access.

| Purpose | Path |
| --- | --- |
| OIDC discovery | `/.well-known/openid-configuration` |
| OAuth authorization-server metadata | `/.well-known/oauth-authorization-server` |
| Signing public keys | `/jwks` |
| Authorization | `/oauth2/authorize` |
| Token exchange and refresh | `/oauth2/token` |
| UserInfo | `/oauth2/userinfo` |
| Token revocation | `/oauth2/revoke` |
| Token introspection | `/oauth2/introspect` |
| RP-initiated logout | `/oauth2/end-session` |

The OAuth metadata location at `/.well-known/oauth-authorization-server/api/auth` is relative to the public origin. The separate JWT `/token` operation is not an application login interface and remains closed.

SPA protocol requests use the exact Origin associated with a registered callback. This does not grant cross-origin access to Loginflare account or administrator APIs. A third-party application's Origin must not be added to the account system's `trustedOrigins` merely to make CORS requests succeed. Discovery and public keys do not require a user session.

Login and consent entry pages default to `/en-us/`; a user may switch to `/zh-cn/`. The signed OAuth query must survive language switches, registration, email verification, and recovery unchanged. Expired authorization transactions restart from the application.

The Loginflare sign-in page accepts either an email address or username with the same password, verification, Turnstile, and suspension requirements. Both methods resume the signed authorization request. Usernames are editable login identifiers, separate from display names; applications must use the OIDC `sub` claim as the stable account identifier.

## Native lifetimes and lifecycle semantics

The exact pinned provider source uses the following defaults. These are upper token lifetimes, not a promise that a credential remains usable for that entire period.

| Credential | Default |
| --- | --- |
| Authorization code | 600 seconds |
| Access token | 3,600 seconds |
| ID Token | 36,000 seconds |
| Refresh token | 2,592,000 seconds |
| Refresh replay allowance | 0 seconds |

Refresh tokens rotate. Clients must save the new refresh token and serialize concurrent renewal attempts rather than reuse a previously consumed token. The examples use the standard SDKs for protocol processing.

Disabling an application uses the provider's disabled flag. It is not a bulk deletion of its credentials; restoring the application can make otherwise valid, unexpired credentials usable again. Rotating a Web client's secret replaces its client-authentication secret without revoking every already-issued token. Update the application's protected server configuration after rotation.

The native revocation and introspection endpoints require confidential client authentication in this pinned version. The SPA example therefore does not claim to revoke its tokens by calling those endpoints without a secret.

Native refresh-token revocation also deletes its associated access token. Repeating a revocation for an already revoked or absent token can return an error in this pinned provider. The Web example revokes access before refresh and always clears its local session; if remote revocation fails, it explicitly reports that local logout completed but remote revocation was not confirmed.

Application logout and Loginflare logout are separate operations:

- Local application logout clears that application's local session or in-memory tokens. The server Web example additionally requests revocation of its own credentials using its client secret. It reports revocation failure rather than claiming success.
- Central logout sends the user to the native `end_session_endpoint` with an ID Token hint and a registered post-logout URL. The provider handles confirmation and terminates the applicable Loginflare session. Native `offline_access` refresh authorization survives ordinary central logout and can obtain new tokens while the account and grant remain eligible.
- This iteration does not notify every other application to clear its own session. Each application owns its session lifetime and should not infer current account status from an old ID Token alone.

Native logout confirmation pages send only an Origin referrer, never protocol queries; their form policy permits the exact registered post-logout destination's Origin while retaining the provider's signed-cookie confirmation checks.

Signing keys use the provider's D1 model; JWT private-key encryption remains enabled. Routine redeployments must preserve the database, issuer, and authentication secret. Automatic signing-key rotation is not enabled by the current JWT configuration.

## Account security events

Ordinary logout and an explicit security revocation have different meanings. Loginflare applies the following policy in addition to native OAuth behavior:

| Action | OAuth grant effect |
| --- | --- |
| Normal sign-out or RP-initiated logout | Retains native offline refresh authorization; it is not an account security revocation |
| Revoke a selected session | Permanently revokes grants originating from that session |
| Revoke other sessions or change password | Revokes grants from other sessions, including offline grants whose original session already ended; grants from the current session remain |
| Password reset | Revokes all of the user's OAuth grants |
| Administrator revokes all user sessions | Revokes all of the user's OAuth grants |
| Suspend account | Revokes all of the user's OAuth grants and rejects further issuance and UserInfo access |
| Restore account | Allows new sign-in and authorization; previously revoked grants remain revoked |

The small `oauthGrantPolicy` table records each native grant's original session across refresh rotations and normal logout. Supported Better Auth lifecycle hooks first mark `session.oauthRevokedAt`; a D1 trigger revokes its existing grants in the same statement, and insertion guards reject a first grant during the gap before native session deletion. D1 constraints also prevent a concurrent refresh from inserting a usable successor after revocation. The provider's claims extension checks current email verification and suspension state during issuance and UserInfo. This policy does not replace authorization-code processing, refresh rotation, or token signatures.

An external application may keep a separate session or a previously verified ID Token. Those local artifacts do not disappear automatically when Loginflare revokes credentials. Applications must choose their own session expiry and revalidation behavior; this release does not implement coordinated global logout.

## Standard-client examples

The examples are independent applications under this repository, not additional production services or packages. They use root development dependencies pinned to `openid-client` 6.8.8 and `oidc-client-ts` 3.5.0.

| Example | Local URL | Callback | Post-logout callback |
| --- | --- | --- | --- |
| Server Web | `https://web.localhost:5181` | `/callback` | `/logout-callback` |
| SPA | `https://spa.localhost:5182` | `/callback` | `/logout-callback` |

1. Start Loginflare, sign in as an administrator, and create a Server Web application with `https://web.localhost:5181/callback` and `https://web.localhost:5181/logout-callback`. Create a SPA application using the equivalent `https://spa.localhost:5182` URLs. Allow all four scopes for the examples.
2. Copy each example's `.env.example` to `.env`. Fill in the application IDs and the Web application's once-shown client secret. `.env` files are ignored by Git. Never put a client secret in a `VITE_` variable. The issuer defaults to `http://localhost:5173/api/auth`.
3. Generate local certificates with the command below. OpenSSL must be installed; the script also detects the copy bundled with Git for Windows. If necessary, set `LOGINFLARE_OPENSSL` to an installed executable. It writes only `work/example-tls/key.pem` and `cert.pem`, which are ignored, and does not modify system trust or DNS.

```powershell
pnpm example:tls
pnpm example:web
pnpm example:spa
```

Run the Web and SPA commands in separate terminals. Open the URLs from the table. The generated certificate covers both names and lasts 30 days; accept its local browser warning, or supply a development certificate already trusted by your environment through `LOGINFLARE_TLS_KEY` / `LOGINFLARE_TLS_CERT`. To regenerate the example files, use `pnpm example:tls --force`. Do not add the generated key or certificate to Git.

The servers bind only to `127.0.0.1`. Browsers with standard `.localhost` handling resolve these names locally. If a DNS proxy overrides that handling, configure your browser's development-only resolver to map `web.localhost` and `spa.localhost` to `127.0.0.1`; the automated browser test supplies these exact Chromium resolver rules. The repository does not modify the system hosts file, install a root CA, or create a tunnel. Certificate exceptions in tests apply only to the local test browser context.

The Web example keeps its client secret, tokens, and sessions in the Node process. It validates state, nonce, issuer, audience, and ID Token signatures through `openid-client`; it fetches UserInfo with the expected subject. An opaque HttpOnly, Secure, SameSite=Lax cookie identifies the local application session. Forms enforce Origin and a session-bound CSRF value. Tokens refresh on requests when less than one minute remains. The process loses its sessions on restart; it is not a production application-session store.

The SPA stores the SDK user and tokens in memory. The SDK's short-lived authorization transaction uses `sessionStorage` to survive a redirect; a separate boolean remembers whether to restart top-level authorization after reload. No token is stored in localStorage or sessionStorage. Renewal uses the SDK's refresh-token path while the page remains open. Clearing local state does not prove server-side token revocation.

The examples display profile claims but never print access tokens, refresh tokens, client secrets, or complete callback URLs. Their errors intentionally omit raw SDK exceptions, which can contain protocol data.

## Validation

The Workers tests cover protocol behavior and the separate security-event policy. Browser tests exercise application management, localized consent, and the real Web/SPA examples, including refresh, local logout, central logout, and SPA memory-only storage. Existing account/theme/mobile checks remain part of the suite.

A build or SDK typecheck alone does not establish interoperability. Run `pnpm test`, `pnpm test:e2e`, and `pnpm build` for local validation. Tests use local D1 and simulated mail; they do not authorize remote resources, real email delivery, tunnels, or deployment.

References: [Better Auth OAuth provider](https://better-auth.com/docs/plugins/oauth-provider), [openid-client](https://github.com/panva/openid-client), [oidc-client-ts](https://authts.github.io/oidc-client-ts/).
