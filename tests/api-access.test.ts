import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import app from '../src/server/index';
import { cookies, harness, origin, password, recoveryToken, session } from './helpers';
import { authenticatorCode } from './totp';
import { createWorkerApi } from '../examples/worker-api/src/index';

const issuer = `${origin}/api/auth`, audience = 'https://orders.example.test', callback = 'https://client.example.test/callback';
type Client = ReturnType<typeof harness>;
interface Resource { id: string; identifier: string; name: string; disabled: boolean }
interface Permission { id: string; scope: string }
interface Role { id: string }
interface Tokens { access_token: string; refresh_token: string; id_token: string; scope: string }
beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.startsWith(`${issuer}/`) && ['/api/auth/jwks', '/api/auth/oauth2/introspect'].includes(new URL(request.url).pathname)) {
            const ctx = createExecutionContext(), response = await app.fetch(request, harness().bindings, ctx);
            await waitOnExecutionContext(ctx); return response;
        }
        if (request.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected external access');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
async function protocol(client: Client, path: string, form?: Record<string, string>, cookie?: string, headers: Record<string, string> = {}) {
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}${path}`, { method: form ? 'POST' : 'GET', headers: { 'CF-Connecting-IP': '192.0.2.22', ...(cookie ? { Cookie: cookie } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers }, body: form ? new URLSearchParams(form).toString() : undefined }), client.bindings, ctx);
    await waitOnExecutionContext(ctx); return response;
}
async function created<T>(client: Client, cookie: string, path: string, body: Record<string, unknown>): Promise<T> {
    const response = await client.request(`/api/admin/access${path}`, { cookie, body });
    expect(response.status, await response.clone().text()).toBe(201); return response.json<T>();
}
async function fixture() {
    const client = harness(), adminCookie = await client.administrator();
    await client.verify('reader@example.test');
    const cookie = await client.signin('reader@example.test'), userId = (await session(client, cookie))!.user.id;
    const resource = await created<Resource>(client, adminCookie, '/resources', { name: 'Orders API', identifier: audience });
    const read = await created<Permission>(client, adminCookie, `/resources/${resource.id}/permissions`, { name: 'Read orders', scope: 'orders:read', description: 'View your orders' });
    const write = await created<Permission>(client, adminCookie, `/resources/${resource.id}/permissions`, { name: 'Write orders', scope: 'orders:write' });
    const role = await created<Role>(client, adminCookie, '/roles', { name: 'Reader', permissionIds: [read.id] });
    expect((await client.request(`/api/admin/access/users/${userId}/roles`, { cookie: adminCookie, method: 'PUT', body: { roleIds: [role.id] } })).status).toBe(200);
    const registration = await client.request('/api/developer/applications', { cookie, body: { name: 'Orders client', type: 'web', redirectUris: [callback], postLogoutRedirectUris: ['https://client.example.test/'], scopes: ['openid', 'profile', 'email', 'offline_access'] } });
    expect(registration.status, await registration.clone().text()).toBe(201);
    const registered = await registration.json<{ application: { clientId: string }; clientSecret: string }>();
    const clientId = registered.application.clientId;
    expect((await client.request(`/api/admin/access/resources/${resource.id}/applications`, { cookie: adminCookie, body: { clientId } })).status).toBe(201);
    const authentication = { Authorization: `Basic ${btoa(`${clientId}:${registered.clientSecret}`)}` };
    return { client, adminCookie, cookie, userId, resource, read, write, role, clientId, authentication, clientSecret: registered.clientSecret };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function location(response: Response) {
    return new URL(response.headers.get('location') ?? (await response.clone().json<{ url: string }>()).url, origin);
}
async function authorize(f: Fixture, scope = 'openid profile email offline_access orders:read', overrides: Record<string, string> = {}) {
    const verifier = 'q'.repeat(43);
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const query = new URLSearchParams({ client_id: f.clientId, redirect_uri: callback, response_type: 'code', scope, resource: audience, state: 'resource-state', nonce: 'resource-nonce', code_challenge: challenge, code_challenge_method: 'S256', ...overrides });
    const response = await protocol(f.client, `/api/auth/oauth2/authorize?${query}`, undefined, f.cookie);
    expect([200, 302], await response.clone().text()).toContain(response.status);
    let redirect = await location(response);
    if (redirect.origin === origin && redirect.pathname.endsWith('/consent')) {
        const detail = await f.client.request(`/api/oauth/consent?${new URLSearchParams({ oauth_query: redirect.search.slice(1) })}`, { cookie: f.cookie });
        expect(detail.status, await detail.clone().text()).toBe(200);
        expect(await detail.json()).toMatchObject({ resource: { name: 'Orders API', identifier: audience }, permissions: expect.arrayContaining([expect.objectContaining({ name: 'Read orders', scope: 'orders:read' })]) });
        const accepted = await f.client.request('/api/auth/oauth2/consent', { cookie: f.cookie, body: { accept: true, oauth_query: redirect.search.slice(1) } });
        expect(accepted.status, await accepted.clone().text()).toBe(200); redirect = await location(accepted);
    }
    expect(redirect.searchParams.get('error'), redirect.href).toBeNull();
    expect(redirect.searchParams.get('code'), redirect.href).toBeTruthy();
    return { code: redirect.searchParams.get('code')!, verifier };
}
async function issue(f: Fixture) {
    const { code, verifier } = await authorize(f);
    const response = await protocol(f.client, '/api/auth/oauth2/token', { grant_type: 'authorization_code', client_id: f.clientId, redirect_uri: callback, code, code_verifier: verifier, resource: audience }, undefined, f.authentication);
    expect(response.status, await response.clone().text()).toBe(200); return response.json<Tokens>();
}
async function introspect(f: Fixture, token: string) {
    const response = await protocol(f.client, '/api/auth/oauth2/introspect', { token, token_type_hint: 'access_token' }, undefined, f.authentication);
    expect(response.status, await response.clone().text()).toBe(200); return response.json<Record<string, unknown>>();
}

it('issues audience-bound native JWTs and runs the Workers/Hono example against real introspection', async () => {
    const f = await fixture(), tokens = await issue(f);
    expect(decodeProtectedHeader(tokens.access_token)).toMatchObject({ alg: 'RS256', typ: 'at+jwt' });
    const jwks = await (await protocol(f.client, '/api/auth/jwks')).json<Parameters<typeof createLocalJWKSet>[0]>();
    const verified = await jwtVerify(tokens.access_token, createLocalJWKSet(jwks), { issuer, audience, algorithms: ['RS256'] });
    expect(verified.payload).toMatchObject({ sub: f.userId, client_id: f.clientId, lf_grant: expect.any(String) });
    expect(String(verified.payload.scope).split(' ')).toContain('orders:read');
    expect(String(verified.payload.scope).split(' ')).not.toContain('orders:write');
    expect(decodeJwt(tokens.id_token)).toMatchObject({ sub: f.userId, aud: f.clientId });
    expect(await introspect(f, tokens.access_token)).toMatchObject({ active: true, sub: f.userId });
    const api = createWorkerApi();
    const settings = { AUTH_ISSUER: issuer, API_RESOURCE: audience, INTROSPECTION_CLIENT_ID: f.clientId, INTROSPECTION_CLIENT_SECRET: f.clientSecret };
    const read = await api.request('/orders', { headers: { Authorization: `Bearer ${tokens.access_token}` } }, settings);
    expect(read.status, await read.clone().text()).toBe(200);
    expect((await api.request('/orders', { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}` } }, settings)).status).toBe(403);
    expect((await api.request('/orders', { headers: { Authorization: `Bearer ${tokens.id_token}` } }, settings)).status).toBe(401);
    expect((await api.request('/orders', { headers: { Authorization: `Bearer ${tokens.access_token}` } }, { ...settings, API_RESOURCE: 'https://other.example.test' })).status).toBe(401);
    await f.client.request(`/api/admin/access/users/${f.userId}/roles`, { cookie: f.adminCookie, method: 'PUT', body: { roleIds: [] } });
    expect(await introspect(f, tokens.access_token)).toEqual({ active: false });
    expect((await api.request('/orders', { headers: { Authorization: `Bearer ${tokens.access_token}` } }, settings)).status).toBe(401);
});

it('rejects unlinked audiences, missing resources, foreign scopes and unassigned user permissions', async () => {
    const f = await fixture();
    const foreign = await created<Resource>(f.client, f.adminCookie, '/resources', { name: 'Other API', identifier: 'https://other.example.test' });
    await created(f.client, f.adminCookie, `/resources/${foreign.id}/permissions`, { name: 'Read other', scope: 'other:read' });
    const base = { client_id: f.clientId, redirect_uri: callback, response_type: 'code', scope: 'openid orders:read', resource: audience, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' };
    for (const overrides of [{ resource: 'https://unknown.example.test' }, { resource: 'https://other.example.test' }, { scope: 'openid other:read' }, { resource: '' }]) {
        const response = await protocol(f.client, `/api/auth/oauth2/authorize?${new URLSearchParams({ ...base, ...overrides })}`, undefined, f.cookie);
        expect(response.status, await response.clone().text()).toBe(400);
    }
    const response = await protocol(f.client, `/api/auth/oauth2/authorize?${new URLSearchParams({ ...base, scope: 'openid orders:write' })}`, undefined, f.cookie);
    const consent = await location(response);
    const denied = await f.client.request('/api/auth/oauth2/consent', { cookie: f.cookie, body: { accept: true, oauth_query: consent.search.slice(1) } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'API_ACCESS_DENIED' });
    expect(await env.DB.prepare('SELECT "actorUserId", "clientId", "reason" FROM "auditLog" WHERE "event" = \'oauth.authorization_denied\' ORDER BY "createdAt" DESC LIMIT 1').first()).toMatchObject({ actorUserId: f.userId, clientId: f.clientId, reason: 'API_ACCESS_DENIED' });
    const cancelled = await f.client.request('/api/auth/oauth2/consent', { cookie: f.cookie, body: { accept: false, oauth_query: consent.search.slice(1) } });
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    expect((await location(cancelled)).searchParams.get('error')).toBe('access_denied');
    expect(await env.DB.prepare('SELECT "outcome", "targetUserId" FROM "auditLog" WHERE "event" = \'oauth.consent_denied\' ORDER BY "createdAt" DESC LIMIT 1').first()).toMatchObject({ outcome: 'success', targetUserId: f.userId });
    expect((await session(f.client, f.cookie))!.user.role).toBe('user');
});

it('keeps identifiers immutable, scopes globally unique, and management administrator-only', async () => {
    const f = await fixture();
    expect((await f.client.request('/api/admin/access/resources', { cookie: f.cookie })).status).toBe(403);
    expect((await f.client.request('/api/admin/access/roles', { body: { name: 'Escalation', permissionIds: [f.write.id] }, cookie: f.cookie })).status).toBe(403);
    expect((await f.client.request(`/api/admin/access/users/${f.userId}/roles`, { method: 'PUT', cookie: f.cookie, body: { roleIds: [f.role.id] } })).status).toBe(403);
    for (const [path, body] of [[`/resources/${f.resource.id}`, { identifier: 'https://replacement.example.test' }], [`/permissions/${f.read.id}`, { scope: 'replacement:read' }]] as const) {
        expect((await f.client.request(`/api/admin/access${path}`, { cookie: f.adminCookie, method: 'PATCH', body })).status).toBe(400);
    }
    const duplicate = await f.client.request(`/api/admin/access/resources/${f.resource.id}/permissions`, { cookie: f.adminCookie, body: { name: 'Duplicate', scope: 'orders:read' } });
    expect(duplicate.status).toBe(409);
    const originDenied = await f.client.request('/api/admin/access/roles', { cookie: f.adminCookie, body: { name: 'Denied' }, headers: { Origin: 'https://evil.example.test' } });
    expect(originDenied.status).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "apiAccessWrite"').first('n')).toBe(0);
});

it('preserves administrator-granted API capabilities when a developer updates their application', async () => {
    const f = await fixture();
    const detail = await f.client.request(`/api/developer/applications/${f.clientId}`, { cookie: f.cookie });
    expect(await detail.json()).toMatchObject({ application: { scopes: expect.arrayContaining(['openid', 'profile', 'email', 'offline_access']), apiScopes: expect.arrayContaining(['orders:read', 'orders:write']) } });
    const updated = await f.client.request(`/api/developer/applications/${f.clientId}`, { cookie: f.cookie, method: 'PATCH', body: { name: 'Edited client', scopes: ['openid', 'profile', 'offline_access'] } });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const tokens = await authorize(f, 'openid profile offline_access orders:read');
    expect(tokens.code).toBeTruthy();
    const unlink = await f.client.request(`/api/admin/access/resources/${f.resource.id}/applications/${f.clientId}`, { cookie: f.adminCookie, method: 'DELETE' });
    expect(unlink.status, await unlink.clone().text()).toBe(200);
    const native = JSON.parse((await env.DB.prepare('SELECT "scopes" FROM "oauthClient" WHERE "clientId" = ?').bind(f.clientId).first<string>('scopes'))!);
    expect(native).not.toContain('orders:read'); expect(native).toContain('openid');
});

it.each(['role', 'permission', 'resource', 'application', 'consent', 'password'] as const)('rejects live introspection after %s access is revoked', async (kind) => {
    const f = await fixture(), tokens = await issue(f);
    let response: Response | undefined;
    if (kind === 'role') response = await f.client.request(`/api/admin/access/roles/${f.role.id}`, { cookie: f.adminCookie, method: 'PATCH', body: { permissionIds: [] } });
    if (kind === 'permission') response = await f.client.request(`/api/admin/access/permissions/${f.read.id}`, { cookie: f.adminCookie, method: 'DELETE' });
    if (kind === 'resource') response = await f.client.request(`/api/admin/access/resources/${f.resource.id}`, { cookie: f.adminCookie, method: 'PATCH', body: { disabled: true } });
    if (kind === 'application') response = await f.client.request(`/api/admin/access/resources/${f.resource.id}/applications/${f.clientId}`, { cookie: f.adminCookie, method: 'DELETE' });
    if (kind === 'consent') response = await f.client.request(`/api/account/applications/${f.clientId}/revoke`, { cookie: f.cookie, body: {} });
    if (kind === 'password') response = await f.client.request('/api/auth/reset-password', { body: { token: await recoveryToken(f.client, 'reader@example.test'), newPassword: 'Recovered-orders-password-934!' } });
    if (response) expect(response.status, await response.clone().text()).toBe(200);
    expect(await introspect(f, tokens.access_token)).toEqual({ active: false });
    const refreshed = await protocol(f.client, '/api/auth/oauth2/token', { grant_type: 'refresh_token', client_id: f.clientId, refresh_token: tokens.refresh_token, resource: audience }, undefined, f.authentication);
    expect(refreshed.status).toBeGreaterThanOrEqual(400);
});

it('rejects permissions removed between consent/code issuance and token exchange', async () => {
    const f = await fixture(), code = await authorize(f);
    const removed = await f.client.request(`/api/admin/access/users/${f.userId}/roles`, { cookie: f.adminCookie, method: 'PUT', body: { roleIds: [] } });
    expect(removed.status).toBe(200);
    const token = await protocol(f.client, '/api/auth/oauth2/token', { grant_type: 'authorization_code', client_id: f.clientId, redirect_uri: callback, code: code.code, code_verifier: code.verifier, resource: audience }, undefined, f.authentication);
    expect(token.status).toBeGreaterThanOrEqual(400);
    expect(await token.json()).not.toHaveProperty('access_token');
});

it('preserves the resource authorization through password sign-in and MFA without issuing an early code', async () => {
    const f = await fixture();
    const enabled = await f.client.request('/api/auth/two-factor/enable', { cookie: f.cookie, body: { password } });
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const enrollment = await enabled.json<{ totpURI: string }>();
    const confirmed = await f.client.request('/api/auth/two-factor/verify-totp', { cookie: f.cookie, body: { code: await authenticatorCode(enrollment.totpURI) } });
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    const verifier = 'm'.repeat(43), challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const query = new URLSearchParams({ client_id: f.clientId, redirect_uri: callback, response_type: 'code', scope: 'openid profile offline_access orders:read', resource: audience, code_challenge: challenge, code_challenge_method: 'S256' });
    const initial = await protocol(f.client, `/api/auth/oauth2/authorize?${query}`);
    const login = await location(initial);
    expect(login.pathname).toBe('/en-us/login');
    const signin = await f.client.request('/api/auth/sign-in/email', { body: { email: 'reader@example.test', password, oauth_query: login.search.slice(1) } });
    expect(signin.status, await signin.clone().text()).toBe(200);
    const pending = await signin.clone().json<{ twoFactorRedirect: boolean; browserFlowId: string }>();
    expect(pending.twoFactorRedirect).toBe(true);
    expect(await signin.clone().json()).not.toHaveProperty('url');
    const verified = await f.client.request('/api/auth/two-factor/verify-totp', { cookie: cookies(signin), headers: { 'X-Loginflare-Flow': pending.browserFlowId }, body: { code: await authenticatorCode(enrollment.totpURI), oauth_query: login.search.slice(1) } });
    expect(verified.status, await verified.clone().text()).toBe(200);
    const next = await location(verified), sessionCookies = `${cookies(signin)}; ${cookies(verified)}`;
    expect(next.pathname).toBe('/en-us/consent');
    const consent = await f.client.request('/api/auth/oauth2/consent', { cookie: sessionCookies, headers: { 'X-Loginflare-Flow': pending.browserFlowId }, body: { accept: true, oauth_query: next.search.slice(1) } });
    expect(consent.status, await consent.clone().text()).toBe(200);
    const target = await location(consent);
    const exchanged = await protocol(f.client, '/api/auth/oauth2/token', { grant_type: 'authorization_code', client_id: f.clientId, redirect_uri: callback, code: target.searchParams.get('code')!, code_verifier: verifier, resource: audience }, undefined, f.authentication);
    expect(exchanged.status, await exchanged.clone().text()).toBe(200);
    const tokens = await exchanged.json<Tokens>();
    expect(await introspect(f, tokens.access_token)).toMatchObject({ active: true, sub: f.userId });
});

it('persists RBAC changes and audit records atomically with bounded cursor queries', async () => {
    const f = await fixture();
    const log = await f.client.request('/api/admin/audit-logs?lookupField=event&lookupValue=access.user.roles.updated', { cookie: f.adminCookie });
    expect(await log.json()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ targetUserId: f.userId, outcome: 'success' })]) });
    const page = await f.client.request('/api/admin/access/permissions?limit=1', { cookie: f.adminCookie });
    const first = await page.json<{ items: Permission[]; pageInfo: { nextCursor: string } }>();
    expect(first.items).toHaveLength(1); expect(first.pageInfo.nextCursor).toBeTruthy();
    const second = await f.client.request(`/api/admin/access/permissions?${new URLSearchParams({ limit: '1', cursor: first.pageInfo.nextCursor })}`, { cookie: f.adminCookie });
    const next = await second.json<{ items: Permission[] }>();
    expect(next.items[0].id).not.toBe(first.items[0].id);
    const badCursor = await f.client.request(`/api/admin/access/roles?${new URLSearchParams({ cursor: first.pageInfo.nextCursor })}`, { cookie: f.adminCookie });
    expect(badCursor.status).toBe(400);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM "auditLog" WHERE "event" = \'access.role.created\'').first('n');
    const badRole = await f.client.request('/api/admin/access/roles', { cookie: f.adminCookie, body: { name: 'Bad', permissionIds: [crypto.randomUUID()] } });
    expect(badRole.status).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "auditLog" WHERE "event" = \'access.role.created\'').first('n')).toBe(count);
    const deleting = await f.client.request(`/api/admin/access/resources/${f.resource.id}`, { cookie: f.adminCookie, method: 'DELETE' });
    expect(deleting.status, await deleting.clone().text()).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "apiPermission"').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "apiRolePermission"').first('n')).toBe(0);
});
