import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker, { pollAuditLogs } from '../examples/management-worker/src/index';
import { connectManagement, ManagementApiError, managementResource, type LoginApplicationInput } from '../examples/management-worker/src/client';
import type { ManagementWorkerBindings } from '../examples/management-worker/worker-configuration';

const configuration: ManagementWorkerBindings = {
    AUTH_ISSUER: 'https://identity.example.test/api/auth', MACHINE_CLIENT_ID: 'automation-client', MACHINE_CLIENT_SECRET: 'isolated-automation-secret',
};
const machineToken = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhdXRvbWF0aW9uLWNsaWVudCJ9.test-signature';
const roleId = '44f0b21f-366c-4a6b-a42c-9c834a1d0948';
const application: LoginApplicationInput = {
    name: 'Automated SPA', type: 'spa', redirectUris: ['https://application.example.test/callback'],
    postLogoutRedirectUris: ['https://application.example.test/'], scopes: ['openid', 'profile'],
};
let requests: Request[] = [];
let issuedScope = '';
let tokenOverride: Record<string, unknown> = {};
let apiResponse: Response | undefined;
let apiFault = false;
beforeEach(() => {
    requests = []; issuedScope = ''; tokenOverride = {}; apiResponse = undefined; apiFault = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init); requests.push(request);
        expect(request.redirect).toBe('manual'); expect(request.headers.get('cookie')).toBeNull();
        if (request.url === `${configuration.AUTH_ISSUER}/oauth2/token`) {
            expect(request.method).toBe('POST');
            expect(request.headers.get('authorization')).toBe(`Basic ${btoa(`${configuration.MACHINE_CLIENT_ID}:${configuration.MACHINE_CLIENT_SECRET}`)}`);
            const form = new URLSearchParams(await request.text());
            expect(form.get('grant_type')).toBe('client_credentials'); expect(form.get('resource')).toBe(managementResource);
            issuedScope = form.get('scope')!;
            return Response.json({ access_token: machineToken, token_type: 'Bearer', expires_in: 300, scope: issuedScope, ...tokenOverride });
        }
        if (!request.url.startsWith('https://identity.example.test/api/management/v1/')) throw new Error('Unexpected network destination');
        expect(request.headers.get('authorization')).toBe(`Bearer ${machineToken}`);
        if (apiFault) throw new Error('Simulated lost management response');
        if (apiResponse) return apiResponse;
        if (request.method === 'POST' && request.url.endsWith('/applications')) return Response.json({ clientId: 'created-login-client', name: 'Automated SPA', type: 'spa' }, { status: 201 });
        if (request.method === 'PUT' && request.url.endsWith('/roles')) return Response.json({ status: true });
        return Response.json({ items: [{ id: 'audit-example', event: 'machine.token.issued', outcome: 'success', createdAt: new Date().toISOString() }], pageInfo: { nextCursor: null, previousCursor: null } });
    });
});
afterEach(() => vi.unstubAllGlobals());

it('runs scheduled audit polling with only its read permission and no public side-effect trigger', async () => {
    const result = await pollAuditLogs(configuration);
    expect(result).toEqual({ count: 1, hasMore: false });
    expect(issuedScope).toBe('management:audit:read');
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
        ['POST', '/api/auth/oauth2/token'], ['GET', '/api/management/v1/audit-logs'],
    ]);
    const count = requests.length;
    expect((await worker.fetch(new Request('https://automation.example.test/run', { method: 'POST' }))).status).toBe(404);
    expect((await worker.fetch(new Request('https://automation.example.test/health'))).status).toBe(200);
    expect(requests).toHaveLength(count);
});

it('creates a login application with explicit application-write permission and returns the one-time secret to its caller', async () => {
    const client = await connectManagement(configuration, ['management:applications:write']);
    apiResponse = Response.json({ clientId: 'created-web-client', name: 'Server Web', type: 'web', clientSecret: 'isolated-new-client-secret' }, { status: 201 });
    const result = await client.createLoginApplication({ ...application, name: 'Server Web', type: 'web' });
    expect(result).toMatchObject({ clientId: 'created-web-client', clientSecret: 'isolated-new-client-secret' });
    expect(issuedScope).toBe('management:applications:write');
    expect(await requests[1]!.json()).toEqual({ ...application, name: 'Server Web', type: 'web' });
});

it('replaces only the specified user business role set with the required permission', async () => {
    const client = await connectManagement(configuration, ['management:role-assignments:write']);
    await client.replaceUserRoles('user/with+special-character', [roleId]);
    expect(requests[1]!.url).toContain('/users/user%2Fwith%2Bspecial-character/roles');
    expect(await requests[1]!.json()).toEqual({ roleIds: [roleId] });
});

it('forwards only the requested audit page and preserves the signed cursor', async () => {
    const client = await connectManagement(configuration, ['management:audit:read']);
    await client.listAuditLogs({ limit: 1, cursor: 'signed.cursor-value' });
    const query = new URL(requests[1]!.url).searchParams;
    expect(query.get('cursor')).toBe('signed.cursor-value'); expect(query.get('limit')).toBe('1');
});

it('does not issue a write when its token was obtained with audit-only permission', async () => {
    const client = await connectManagement(configuration, ['management:audit:read']);
    await expect(client.createLoginApplication(application)).rejects.toMatchObject({ code: 'MISSING_SCOPE', status: 403 });
    await expect(client.replaceUserRoles('target-user', [roleId])).rejects.toMatchObject({ code: 'MISSING_SCOPE', status: 403 });
    expect(requests).toHaveLength(1);
});

it('rejects invalid application, role and page input without issuing an API request', async () => {
    const client = await connectManagement(configuration, ['management:applications:write', 'management:role-assignments:write', 'management:audit:read']);
    await expect(client.createLoginApplication({ ...application, redirectUris: ['http://untrusted.example.test/callback'] })).rejects.toMatchObject({ code: 'INVALID_APPLICATION' });
    await expect(client.replaceUserRoles('target-user', [roleId, roleId])).rejects.toMatchObject({ code: 'INVALID_ROLE_ASSIGNMENT' });
    await expect(client.replaceUserRoles('target-user', ['not-a-role-id'])).rejects.toMatchObject({ code: 'INVALID_ROLE_ASSIGNMENT' });
    await expect(client.listAuditLogs({ limit: 101 })).rejects.toMatchObject({ code: 'INVALID_PAGINATION' });
    expect(requests).toHaveLength(1);
});

it.each([
    ['extra scope', { scope: 'management:audit:read management:users:write' }],
    ['missing scope', { scope: '' }], ['excessive lifetime', { expires_in: 301 }], ['expired lifetime', { expires_in: 0 }],
    ['wrong type', { token_type: 'DPoP' }], ['opaque token', { access_token: 'opaque-token' }],
    ['refresh token', { refresh_token: 'unexpected-refresh' }], ['identity token', { id_token: 'unexpected-id-token' }],
] as const)('rejects a machine token response with %s', async (_name, override) => {
    tokenOverride = override;
    await expect(pollAuditLogs(configuration)).rejects.toMatchObject({ code: 'INVALID_TOKEN_RESPONSE' });
    expect(requests).toHaveLength(1);
});

it('uses a new token per invocation and does not reuse an expired run token', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now'); clock.mockReturnValue(now);
    try {
        const client = await connectManagement(configuration, ['management:audit:read']);
        clock.mockReturnValue(now + 300_001);
        await expect(client.listAuditLogs()).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
        expect(requests).toHaveLength(1);
        await pollAuditLogs(configuration);
        expect(requests.filter((request) => request.url.endsWith('/oauth2/token'))).toHaveLength(2);
    } finally { clock.mockRestore(); }
});

it('never retries a write whose response was lost and marks its outcome uncertain', async () => {
    const client = await connectManagement(configuration, ['management:applications:write']);
    apiFault = true;
    await expect(client.createLoginApplication(application)).rejects.toMatchObject({ code: 'MANAGEMENT_SERVICE_UNAVAILABLE', writeMayHaveCompleted: true });
    expect(requests.filter((request) => request.url.endsWith('/applications'))).toHaveLength(1);
});

it('keeps stable error codes without exposing a raw response description', async () => {
    const client = await connectManagement(configuration, ['management:applications:write']);
    apiResponse = Response.json({ code: 'FORBIDDEN', error_description: 'sensitive-description-that-must-not-be-an-error-message' }, { status: 403 });
    await expect(client.createLoginApplication(application)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403, message: 'FORBIDDEN', writeMayHaveCompleted: false });
});

it.each(['redirect', 'oversized', 'malformed'] as const)('rejects %s management responses without following or retrying', async (fault) => {
    const client = await connectManagement(configuration, ['management:audit:read']);
    apiResponse = fault === 'redirect' ? new Response(null, { status: 302, headers: { Location: 'https://untrusted.example.test' } })
        : fault === 'oversized' ? Response.json({ data: 'x'.repeat(262_145) }) : Response.json({ items: 'not-a-page' });
    await expect(client.listAuditLogs()).rejects.toBeInstanceOf(ManagementApiError);
    expect(requests).toHaveLength(2);
});

it('rejects insecure or placeholder configuration before sending credentials', async () => {
    for (const override of [{ AUTH_ISSUER: 'http://untrusted.example.test/api/auth' }, { AUTH_ISSUER: 'https://identity.example.test/api/auth?token=bad' }, { MACHINE_CLIENT_SECRET: 'replace-with-secret' }]) {
        await expect(pollAuditLogs({ ...configuration, ...override })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    }
    expect(requests).toEqual([]);
});
