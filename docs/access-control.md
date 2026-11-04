# API resources, permissions, roles, and audit logs

[简体中文](access-control.zh-CN.md) · [Application integration](oauth.md) · [Architecture](architecture.md)

Loginflare issues resource-bound access tokens for business APIs using the existing authorization-code and refresh-token flows. Administrators manage API resources and permissions, group permissions into roles, assign those roles to users, and explicitly allow applications to request a resource. The user's consent is a separate requirement. A resource link or consent never creates a role assignment.

## Configure an API

For an Orders API:

1. Open **Administration → API resources** and create `Orders API` with identifier `https://api.example.com`.
2. Add permission scopes `orders:read` and `orders:write`, with readable display names.
3. Create a business role such as `Order reader` containing `orders:read`.
4. Open the intended user's administrator details and assign that business role.
5. In the API resource's application section, add the client ID of each application allowed to request it.
6. For live token introspection, create a separate server Web application for the API, store its client secret only on the API server, and link that application to the same resource. Its registered callbacks remain exact HTTPS URLs, even if this client is used only for introspection.

An identifier is an exact HTTPS URI without a query, fragment, or embedded credentials. It is the audience contract, not a URL Loginflare downloads. Changing identity requires creating a resource with another identifier; editing a display name keeps the existing audience. Permission scopes are stable identifiers and are distinct from editable display names and descriptions. The identity scopes `openid`, `profile`, `email`, and `offline_access` remain reserved.

Business roles are independent of Loginflare's built-in `admin` and `user` administration roles. A business role named `Administrator` does not allow entry to the Loginflare console. A Loginflare administrator needs a business permission assignment to use a protected business API as a user.

## Request a resource token

Keep using the application's OIDC SDK and authorization code with S256 PKCE. Add the resource and required business scopes to the authorization request:

```text
resource=https://api.example.com
scope=openid profile email offline_access orders:read
```

This version requests one business resource in a transaction. If `openid` is included, the native provider can also include its UserInfo endpoint in the token's audience. Resource servers must check for their exact audience rather than assuming `aud` is always a string.

For the existing `openid-client` server example, the corresponding additions are:

```ts
const resource = 'https://api.example.com';
const authorizationUrl = oidc.buildAuthorizationUrl(config, {
    ...authorizationParameters, // Keep existing state, nonce, redirect and PKCE.
    resource,
    scope: 'openid profile email offline_access orders:read',
});
const tokens = await oidc.authorizationCodeGrant(config, currentUrl, checks, { resource });
const renewed = await oidc.refreshTokenGrant(config, tokens.refresh_token!, { resource });
```

Persist rotated refresh tokens and serialize renewal as described in the [integration guide](oauth.md). The resource, scope, selected account, MFA and consent stay inside the same verified authorization flow. Applications cannot turn a resource identifier or role name into permission by submitting it to the token endpoint.

If any requested business permission is unavailable, the request is rejected rather than silently issuing a token with fewer permissions. Refresh cannot expand the original authorization's scopes or move it to another resource.

Use the resulting **access token** as `Authorization: Bearer …` when calling the API. An ID Token authenticates the user's sign-in to its client and is never an API bearer credential. Ordinary sign-in requests without a business resource retain the existing identity-token and UserInfo behavior.

## Validate in a Worker or Hono API

The runnable example is [examples/worker-api](../examples/worker-api/README.md). It uses the pinned Hono and JOSE dependencies already installed by this repository. It adds no database, queue, account store, or third-party service.

The example validates:

- RS256 signature against the configured issuer's JWKS and `typ: at+jwt`.
- Exact issuer, expected API audience, expiry, subject, issuing client and signed scopes.
- Current authorization through authenticated introspection on every request, with no cached positive authorization result.
- The endpoint's required permission: GET `/orders` requires `orders:read`, POST `/orders` requires `orders:write`.

Only resolved public signing keys are cached. Upstream redirects are rejected, JWKS and introspection bodies are bounded, requests time out, and cookies are never forwarded to Loginflare. Configuration owns the issuer and audience; a token cannot choose the URL used for validation. The example allows a loopback HTTP issuer for local development; deployed issuers use HTTPS.

Missing, expired, revoked, wrongly signed, wrong-audience and otherwise unusable credentials receive `401 invalid_token`. A currently valid token missing the endpoint's scope receives `403 insufficient_scope`. An unavailable validation service receives `503 authorization_unavailable`; the example does not grant access during an outage. POST is a permission demonstration and does not persist an order.

### Current authorization and revocation

A JWT remains cryptographically verifiable until its expiry. Local signature checks alone cannot observe later role changes, resource restrictions, application suspension, account suspension or grant revocation. Resource access-token expiry bounds that offline acceptance window.

The example performs live introspection after local validation, so Loginflare's current resource, application, user permission and grant policy can reject a token before its JWT expiry. Use the API's separate confidential client credentials, keep them on the server, and link that client only to resources it serves. A public SPA must never receive that secret. There is no local positive introspection cache in this example.

Permission-reducing changes permanently revoke the affected API grants: removing user roles or role permissions, deleting permissions/resources, disabling a resource/application, and unlinking an application from a resource. Restoring a role or link does not reactivate those old JWTs or refresh tokens; start a fresh authorization to obtain access again. Unchanged role assignments do not revoke grants. Offline JWT signature verification still has the expiry window described above.

The API service still owns object-level rules. For example, `orders:read` can authorize reading orders in general, while the API must separately determine whether this user owns a particular order. Role management does not implement arbitrary row ownership, organizations or tenant isolation.

## Administrator HTTP surface

These same-origin JSON operations require an active, verified Loginflare administrator. Mutations require the exact Origin, accepted content type and schema, and use the selected browser account. Native provider resource-administration routes remain closed to direct HTTP access.

| Operation | Endpoint under `/api/admin/access` |
| --- | --- |
| List/create resources | `GET/POST /resources` |
| Read/update/delete a resource | `GET/PATCH/DELETE /resources/:id` |
| List permissions | `GET /permissions` |
| Create a resource permission | `POST /resources/:id/permissions` |
| Update/delete a permission | `PATCH/DELETE /permissions/:id` |
| List/link allowed applications | `GET/POST /resources/:id/applications` |
| Unlink an application | `DELETE /resources/:id/applications/:clientId` |
| List/create roles | `GET/POST /roles` |
| Read/update/delete a role | `GET/PATCH/DELETE /roles/:id` |
| Read/replace a user's business roles | `GET/PUT /users/:userId/roles` |

Paginated lists use the project's bounded, signed cursor contract. Submitted permission IDs and role IDs are validated by the server; a request cannot assign non-existent permissions or promote a user to console administrator. Deletion removes related assignments and must be confirmed in the console. User consent and an application's allowed resource are managed separately from business roles.

Resource access tokens default to a 300-second lifetime, configurable from 60 to 3600 seconds. Each resource and role can contain up to 100 permissions, a user can hold up to 100 business roles, and an instance can register up to 1000 business permissions.

## Audit logs

**Administration → Audit logs** provides a paginated event history and event details. Events record the operation, success/failure, actor and target identifiers, application, timestamp and request ID, with bounded client address and user-agent information where available. Authentication, MFA, authorization and security operations are distinct events; an unfinished first factor is not a successful completed sign-in.

`GET /api/admin/audit-logs` uses signed cursor pagination and exact lookup fields `event`, `outcome`, `actorUserId`, `targetUserId` and `clientId`; `GET /api/admin/audit-logs/:id` reads one event. Ordinary users and developer application ownership do not grant audit access. Access-management mutations and their audit rows are written together.

Audit logs retain events for 90 days and join the existing bounded scheduled cleanup. Records do not contain passwords, verification codes, cookie values, client secrets, bearer tokens or full OAuth/verification URLs. They remain separate from sampled Worker request diagnostics. This release stores events in the instance's D1 database and does not add webhook delivery, external log exports or a machine-authenticated management API.

## Upgrade and validate

Apply migrations `0019_api_access.sql` and `0020_audit_logs.sql` through the existing migration wrapper before switching to this build. Preserve the issuer, database and authentication secret. The main Worker reuses its existing bindings and scheduled cleanup.

Validate the intended application/resource links, least-privilege assignments, missing/wrong-audience tokens, MFA and consent continuation, refresh, role removal and live introspection, and audit access in an isolated environment. Automated tests do not authorize production traffic, real account changes or remote migration.
