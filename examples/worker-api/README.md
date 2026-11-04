# Workers / Hono protected API

[Access-control guide](../../docs/access-control.md) · [中文说明](../../docs/access-control.zh-CN.md)

This independent Worker demonstrates resource access-token verification and endpoint permissions. It uses Hono and JOSE from the root lockfile and accepts Loginflare's signed resource access tokens. GET `/orders` requires `orders:read`; POST `/orders` requires `orders:write` and returns `persisted: false`. It is an authorization example, not an order database.

Configure the resource, permissions, user roles and application links using the guide. Create a separate confidential server Web client for introspection and link it to the same resource. The API can then check tokens issued to linked Web or SPA clients without disclosing its own secret to them.

From the repository root:

```powershell
Copy-Item examples/worker-api/.dev.vars.example examples/worker-api/.dev.vars
# Edit the ignored .dev.vars with your issuer and the API client's credentials.
node examples/worker-api/generate-types.mjs
pnpm exec tsc -p examples/worker-api/tsconfig.json --noEmit
pnpm exec wrangler dev --config examples/worker-api/wrangler.jsonc --port 5183
```

| Setting | Meaning |
| --- | --- |
| `AUTH_ISSUER` | Exact Loginflare issuer, such as `https://identity.example.com/api/auth`; loopback HTTP is accepted for local testing |
| `API_RESOURCE` | Exact HTTPS resource identifier, such as `https://api.example.com` |
| `INTROSPECTION_CLIENT_ID` | Separate resource-linked confidential client used by this API |
| `INTROSPECTION_CLIENT_SECRET` | That client's secret; local ignored `.dev.vars`, or a Worker secret when deployed |

For a deployment, set the non-secret values in the example's `wrangler.jsonc`, configure the secret with the operator's Cloudflare tooling, and generate types again after changes. The repository does not deploy this example or provision resources automatically. The generated binding declarations are ignored; `generate-types.mjs` wraps them as a module so this independent Worker's types do not merge into Loginflare's bindings.

Obtain a token through a registered application's normal authorization-code + PKCE flow with `resource=https://api.example.com` and `scope=openid orders:read`. Keep existing state, nonce, consent and MFA checks. A token issued for ordinary identity/UserInfo access or an ID Token cannot access this API.

```powershell
$apiToken = Read-Host 'Resource access token'
Invoke-RestMethod http://localhost:5183/orders -Headers @{ Authorization = "Bearer $apiToken" }
```

The API validates the RS256 signature, `at+jwt` type, issuer, audience, expiry, subject and issuing client, then performs authenticated introspection on every request. Public keys alone are cached for five minutes; unknown-key refresh is limited to once per thirty seconds. Requests use a five-second timeout, reject redirects and bound response bodies. Tokens, secrets and cookies are never logged or placed in browser storage by this example. The API does not forward browser cookies and does not enable cross-origin requests; use a same-origin reverse proxy or configure an exact Origin allowlist in an application that needs browser CORS.

Response codes are `401 invalid_token` for unusable credentials, `403 insufficient_scope` for an endpoint permission missing from an otherwise valid token, and `503 authorization_unavailable` when validation cannot complete. Loginflare permission changes and revocations are checked live, while an alternative implementation doing only offline JWT validation would keep accepting an otherwise valid JWT until expiry. The API still owns object-level and tenant-specific business rules.

Run the isolated example tests with `pnpm exec vitest run tests/worker-api.test.ts`. They simulate only the configured JWKS/introspection endpoints and use generated local signing keys; no real account or remote API is contacted.
