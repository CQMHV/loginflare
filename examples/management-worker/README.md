# Scheduled management client

[Management API](../../docs/management-api.md) · [中文文档](../../docs/management-api.zh-CN.md)

This independent Worker demonstrates machine-to-machine access to `/api/management/v1`. Its default Cron job obtains a native `client_credentials` token for `urn:loginflare:management`, requesting only `management:audit:read`, then reads at most 100 current audit events and logs only the count and whether another page exists. It does not export the entire history or promise exactly-once processing.

The public Worker handler provides GET `/health`. Other paths return 404 and cannot trigger an automation or expose its credentials. The default task performs no management writes. The trusted `connectManagement` client also supports creating Web/SPA login applications and replacing user business-role assignments; choose their additional scopes only in a job that needs them.

## Configure and run locally

Create a machine role with `management:audit:read`, create a machine application, save its once-shown secret, and assign the role. From the repository root:

```powershell
Copy-Item examples/management-worker/.dev.vars.example examples/management-worker/.dev.vars
# Edit the ignored file with this instance's issuer and machine credentials.
node examples/management-worker/generate-types.mjs
pnpm exec tsc -p examples/management-worker/tsconfig.json --noEmit
pnpm exec wrangler dev --config examples/management-worker/wrangler.jsonc --port 5184 --test-scheduled
```

In another terminal, a local scheduled test can be invoked with `Invoke-WebRequest http://localhost:5184/__scheduled`. This endpoint belongs to Wrangler's local scheduled-event simulation; it is not implemented by the deployed Worker's public handler. It calls the issuer configured in the local ignored file, so use an isolated local Loginflare instance and test machine credentials.

| Setting | Purpose |
| --- | --- |
| `AUTH_ISSUER` | Exact Loginflare issuer ending in `/api/auth`; HTTPS, or loopback HTTP for local development |
| `MACHINE_CLIENT_ID` | Administrator-created machine application ID |
| `MACHINE_CLIENT_SECRET` | Machine client secret; ignored local file or deployed Worker secret |

For deployment, configure the non-secret values in this example's `wrangler.jsonc` and put the secret into the selected Worker's secret storage with the operator's Cloudflare tooling. Its Cron is every fifteen minutes. Nothing in this repository deploys this Worker or creates a machine application automatically. The generated binding file is ignored; its generator module-isolates this independent Worker's types from the main application.

## Trusted provisioning code

Import the client inside a trusted scheduled or queue invocation. The following creates a SPA, which has no client secret, then replaces a known user's business-role set:

```ts
import { connectManagement } from './client';

const management = await connectManagement(env, [
    'management:applications:write',
    'management:role-assignments:write',
]);
const application = await management.createLoginApplication({
    name: 'Automated SPA',
    type: 'spa',
    redirectUris: ['https://app.example.com/callback'],
    postLogoutRedirectUris: ['https://app.example.com/'],
    scopes: ['openid', 'profile'],
});
await management.replaceUserRoles(targetUserId, desiredBusinessRoleIds);
```

Those two requests are not one transaction. `replaceUserRoles` replaces all business roles for that user; it does not append or change console administrator privileges. Permission discovery, role lookup or reading existing applications needs the corresponding read scopes in the token and machine role.

For `type: 'web'`, `createLoginApplication` returns the one-time `clientSecret` to its trusted caller. Store it privately before continuing; do not log the result or create a Web application in the default polling task. The example deliberately has no automatic write retries. A `ManagementApiError` with `writeMayHaveCompleted: true` means a timeout, response loss or invalid successful response could follow an actual committed change. Inspect state before retrying, especially for creation or secret rotation.

The client bounds token responses to 16 KiB and management responses to 256 KiB, uses five-second timeouts and rejects redirects. Tokens are held only in the current invocation, expire within five minutes, and are never refreshed or persisted; a new invocation requests a new token. Cookies and browser account selectors are not forwarded. Logged failures contain stable error codes, not response bodies, secrets or tokens.

Run isolated checks with `pnpm exec vitest run tests/management-worker.test.ts`. These mock only the configured Loginflare endpoints and do not contact real accounts or Cloudflare resources.
