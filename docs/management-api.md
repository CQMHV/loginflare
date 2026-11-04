# Machine identities and the Management API

[简体中文](management-api.zh-CN.md) · [API access control](access-control.md) · [OAuth integration](oauth.md)

Loginflare separates machine identities from people and browser sessions. An administrator creates a machine application and machine roles, assigns the required permissions, and gives the automation its client ID and one-time secret. The automation obtains a short-lived OAuth access token with `client_credentials`; it does not sign in as an administrator or reuse a browser cookie.

The versioned API is `/api/management/v1`. Its public contract is `GET /api/management/v1/openapi.json`, an OpenAPI 3.1 document with request fields, response schemas, endpoint scopes, pagination and errors. The document contains no instance data or credentials. Other management endpoints require a current machine access token with the exact management audience.

## Create a least-privilege machine

1. Open **Administration → Machine roles** and create a role with only the required permissions. For the scheduled example, choose `management:audit:read`.
2. Open **Administration → Machine applications**, create an application and save its one-time client secret in the automation's private configuration.
3. Assign the role to that machine application. A new application has no permissions until assigned.
4. Configure the issuer, client ID and secret on the server. A SPA, browser script or mobile client cannot keep a machine secret.

Machine roles are distinct from user business roles and Loginflare's console `admin` role. They can contain management scopes and registered business API permissions. Role changes maintain the server-owned client-credentials ceiling and allowed resources. An application cannot broaden its ceiling by changing the token request. The same machine must request one resource per token; a business resource token cannot authorize a call to the Management API.

The human administrator-only controls are under `/api/admin/machines`: application creation/detail/editing, role assignment, secret rotation and token revocation; machine role creation/editing/deletion; and permission discovery. These use the current selected browser account with normal administrator checks. Neither the public Management API nor developer-owned login applications can create or edit machine authority.

## Obtain a management token

Use the configured issuer's native token endpoint with `client_secret_basic` authentication and form-encoded parameters:

```text
POST https://identity.example.com/api/auth/oauth2/token
Authorization: Basic <form-encoded client-id:client-secret, then Base64>
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
resource=urn:loginflare:management
scope=management:audit:read
```

This returns `access_token`, `token_type: Bearer`, `expires_in` of at most 300 seconds, and the granted `scope`. It does not issue an ID Token or refresh token. Obtain a new token with the machine's current credentials when needed. Request the smallest scope set for each job; read and write are separate permissions.

The token is an RS256 access JWT with `typ: at+jwt`, issuer `${AUTH_URL}/api/auth`, `sub` equal to the machine client ID, `lf_principal: machine` and a server-issued machine generation. Loginflare verifies its signature, exact audience, lifetime, current application status, assigned permission ceiling and generation on each management request. Browser sessions, human-user tokens, ID Tokens and a token for another API do not authenticate the management caller.

The fixed `urn:loginflare:management` resource is installed by migration. Resource management cannot rename, disable, delete or relink it to grant machine authority. There is no dynamic client registration, administrator impersonation or machine self-grant endpoint.

## Permissions and operations

All paths in this table are relative to `/api/management/v1`:

| Scope | Operations |
| --- | --- |
| `management:users:read` | `GET /users`, `GET /users/:userId` |
| `management:users:write` | `PATCH /users/:userId` with `name` and/or `banned`; `POST /users/:userId/revoke-sessions` with `{}` |
| `management:applications:read` | `GET /applications`, `GET /applications/:clientId` |
| `management:applications:write` | `POST /applications`, `PATCH /applications/:clientId`, `POST /applications/:clientId/rotate-secret` |
| `management:resources:read` | Read resources, resource permissions, permission lists and allowed-application lists |
| `management:resources:write` | Create/update/delete business resources and permissions; link/unlink allowed login applications |
| `management:roles:read` | `GET /roles`, `GET /roles/:id` for user business roles |
| `management:roles:write` | Create/update/delete user business roles |
| `management:role-assignments:read` | `GET /users/:userId/roles` |
| `management:role-assignments:write` | `PUT /users/:userId/roles` with `{ "roleIds": [...] }` |
| `management:audit:read` | `GET /audit-logs`, `GET /audit-logs/:id` |

Resource, permission, business role and user-role paths use the same field rules as [access management](access-control.md#administrator-http-surface), under the versioned prefix. A role assignment replaces the complete user business-role set; an empty array removes those assignments. It never changes the user's console role or machine roles.

Machine user management cannot change passwords, MFA, primary email, verification flags or console roles. Administrator accounts are protected from machine profile/suspension changes and session revocation. There is no machine user-creation or account-deletion endpoint in this version.

Login applications are created using:

```json
{
    "name": "Automated SPA",
    "type": "spa",
    "redirectUris": ["https://app.example.com/callback"],
    "postLogoutRedirectUris": ["https://app.example.com/"],
    "scopes": ["openid", "profile"]
}
```

The response is a top-level application object with `clientId`; a Web application additionally returns its one-time `clientSecret`. List/detail reads do not reveal a secret. Application type and ownership are not editable. The machine API creates regular Web/SPA login applications; machine identities and their permissions remain administrator-controlled.

## Requests, pagination and failures

Send `Authorization: Bearer <access_token>` and JSON for POST/PATCH/PUT. Browser account selectors and cookies do not establish machine authority. This is a server-to-server API and does not enable browser cross-origin access.

Lists use `limit` (1–100, default 20) and opaque signed `cursor`, returning `{ items, pageInfo: { nextCursor, previousCursor } }`. Cursors bind the machine, list and exact lookup; retain the same filters and do not reuse a cursor from another identity. Supported exact lookup fields are listed in OpenAPI. Audit queries can distinguish human `actorUserId` and machine `actorClientId`.

| Status | Meaning |
| --- | --- |
| 400 | Invalid fields, unknown fields, malformed cursor or invalid operation; application validation can include `fieldErrors` |
| 401 | Missing, expired, revoked or otherwise invalid machine token; `WWW-Authenticate` reports `invalid_token` |
| 403 | The current token lacks the endpoint scope, or the operation targets protected authority; missing scope is reported as `insufficient_scope` |
| 404 / 409 | Missing target or conflicting state |
| 429 | Rate limit reached; respect `Retry-After` |
| 5xx | The request could not complete; access is not granted during validation failures |

Disabling a machine, explicit token revocation, secret rotation and permission-reducing changes invalidate its prior token generation. Restoring the application or adding permissions later does not revive those old tokens. Obtain a new token after an authorized configuration change. Write transactions recheck the current machine generation and permission so a concurrent revocation cannot be bypassed between the initial authentication and the database change.

Every management call has a request ID. Mutations record their machine actor atomically with their changes; reads and rejected requests have corresponding audit events. Logs do not store bearer tokens, client secrets, cookies or complete protocol URLs. Machine identities appear as `actorClientId`, without pretending to be a human administrator.

Do not retry an uncertain write automatically. A timeout or lost response may follow a committed change. Inspect current state before retrying application creation, secret rotation or another mutation; an application and a role assignment are separate operations, not one cross-request transaction.

## Scheduled Worker example

[examples/management-worker](../examples/management-worker/README.md) obtains a token inside each trusted invocation and reads the latest bounded audit page. Its default Cron task requests only `management:audit:read`; its public fetch handler exposes a read-only health response and has no operation trigger. Only summary counts are logged.

The exported client also implements login-application creation and user business-role replacement for trusted provisioning code. It uses generated bindings, bounded response bodies, timeouts and manual redirect handling. It stores no token or in-flight request globally and never automatically retries a write. Web application secrets are returned to the trusted caller for private storage, rather than written to logs or discarded by the scheduled task.

## Deployment

Apply `0021_machines.sql` and `0022_machine_audit.sql` before switching to this build. They add machine roles, permission projections, generation checks, the protected management resource and distinct audit actors. Existing user accounts and login clients remain separate; they are not automatically converted into machines. The main Worker needs no new binding or secret. Each automation has its own machine secret, managed separately from Loginflare's server secret.

Validate least-privilege reads/writes, ordinary-user token rejection, reserved-resource protection, generation revocation, concurrent changes, audit attribution and OpenAPI in an isolated environment. Automatic tests and example builds do not deploy services or change real accounts.
