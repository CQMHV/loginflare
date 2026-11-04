import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decodeJwt } from 'jose';
import app from '../src/server/index';
import { harness, origin, session } from './helpers';
import { interceptSql } from './sql-race';

const audience = 'https://access-races.example.test', callback = 'https://client.example.test/callback';
type Client = ReturnType<typeof harness>;
interface Tokens { access_token: string; refresh_token: string }
beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Request(input, init).url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected network');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

async function created<T>(client: Client, cookie: string, path: string, body: Record<string, unknown>): Promise<T> {
    const response = await client.request(`/api/admin/access${path}`, { cookie, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return response.json<T>();
}
async function fixture() {
    const client = harness(), administrator = await client.administrator();
    await client.verify('reader@example.test');
    const cookie = await client.signin('reader@example.test'), userId = (await session(client, cookie))!.user.id;
    const resource = await created<{ id: string }>(client, administrator, '/resources', { name: 'Race API', identifier: audience, description: 'Resource description', accessTokenTtl: 120 });
    const permission = await created<{ id: string }>(client, administrator, `/resources/${resource.id}/permissions`, { name: 'Read', scope: 'races:read', description: 'Permission description' });
    const role = await created<{ id: string }>(client, administrator, '/roles', { name: 'Reader', description: 'Role description', permissionIds: [permission.id] });
    expect((await client.request(`/api/admin/access/users/${userId}/roles`, { cookie: administrator, method: 'PUT', body: { roleIds: [role.id] } })).status).toBe(200);
    const registered = await client.request('/api/developer/applications', { cookie, body: { name: 'Race client', type: 'web', redirectUris: [callback], postLogoutRedirectUris: ['https://client.example.test/'], scopes: ['openid', 'profile', 'offline_access'] } });
    expect(registered.status, await registered.clone().text()).toBe(201);
    const result = await registered.json<{ application: { clientId: string }; clientSecret: string }>(), clientId = result.application.clientId;
    expect((await client.request(`/api/admin/access/resources/${resource.id}/applications`, { cookie: administrator, body: { clientId } })).status).toBe(201);
    return { client, administrator, cookie, userId, resource, permission, role, clientId, authorization: `Basic ${btoa(`${clientId}:${result.clientSecret}`)}` };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function protocol(f: Fixture, path: string, form?: Record<string, string>) {
    const context = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}/api/auth${path}`, { method: form ? 'POST' : 'GET',
        headers: form ? { Authorization: f.authorization, 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '192.0.2.40' } : { Cookie: f.cookie, 'CF-Connecting-IP': '192.0.2.40' },
        body: form ? new URLSearchParams(form).toString() : undefined,
    }), f.client.bindings, context);
    await waitOnExecutionContext(context);
    return response;
}
async function code(f: Fixture) {
    const verifier = 'v'.repeat(43), hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...hash)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const response = await protocol(f, `/oauth2/authorize?${new URLSearchParams({ client_id: f.clientId, redirect_uri: callback, response_type: 'code', scope: 'openid profile offline_access races:read', resource: audience, code_challenge: challenge, code_challenge_method: 'S256' })}`);
    expect(response.status).toBe(302);
    let location = new URL(response.headers.get('location')!, origin);
    if (location.pathname.endsWith('/consent')) {
        const consent = await f.client.request('/api/auth/oauth2/consent', { cookie: f.cookie, body: { accept: true, oauth_query: location.search.slice(1) } });
        expect(consent.status, await consent.clone().text()).toBe(200);
        location = new URL((await consent.json<{ url: string }>()).url);
    }
    expect(location.searchParams.get('error'), location.href).toBeNull();
    expect(location.searchParams.get('code')).toBeTruthy();
    return { code: location.searchParams.get('code')!, verifier };
}
async function exchange(f: Fixture, authorization: Awaited<ReturnType<typeof code>>) {
    return protocol(f, '/oauth2/token', { grant_type: 'authorization_code', client_id: f.clientId, redirect_uri: callback, code: authorization.code, code_verifier: authorization.verifier, resource: audience });
}
async function issue(f: Fixture) {
    const response = await exchange(f, await code(f));
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json<Tokens>();
}
async function active(f: Fixture, token: string) {
    const response = await protocol(f, '/oauth2/introspect', { token, token_type_hint: 'access_token' });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json<{ active: boolean }>()).active;
}
async function patch(f: Fixture, path: string, body: Record<string, unknown>) {
    const response = await f.client.request(`/api/admin/access${path}`, { cookie: f.administrator, method: 'PATCH', body });
    expect(response.status, await response.clone().text()).toBe(200);
}

it('preserves omitted role permissions, descriptions and resource token lifetime on name-only updates', async () => {
    const f = await fixture(), tokens = await issue(f);
    await patch(f, `/roles/${f.role.id}`, { name: 'Renamed reader' });
    await patch(f, `/resources/${f.resource.id}`, { name: 'Renamed API' });
    await patch(f, `/permissions/${f.permission.id}`, { name: 'Renamed permission' });
    const role = await f.client.request(`/api/admin/access/roles/${f.role.id}`, { cookie: f.administrator });
    expect(await role.json()).toMatchObject({ name: 'Renamed reader', description: 'Role description', permissionIds: [f.permission.id] });
    const resource = await f.client.request(`/api/admin/access/resources/${f.resource.id}`, { cookie: f.administrator });
    expect(await resource.json()).toMatchObject({ name: 'Renamed API', description: 'Resource description', accessTokenTtl: 120, permissions: [expect.objectContaining({ name: 'Renamed permission', description: 'Permission description' })] });
    expect(await active(f, tokens.access_token)).toBe(true);
});

it('does not revoke live or pending grants when the existing role and user-role selections are saved unchanged', async () => {
    const f = await fixture(), tokens = await issue(f), pending = await code(f);
    await patch(f, `/roles/${f.role.id}`, { permissionIds: [f.permission.id] });
    expect((await f.client.request(`/api/admin/access/users/${f.userId}/roles`, { cookie: f.administrator, method: 'PUT', body: { roleIds: [f.role.id] } })).status).toBe(200);
    expect(await active(f, tokens.access_token)).toBe(true);
    const exchanged = await exchange(f, pending);
    expect(exchanged.status, await exchanged.clone().text()).toBe(200);
    const refreshed = await protocol(f, '/oauth2/token', { grant_type: 'refresh_token', client_id: f.clientId, refresh_token: tokens.refresh_token, resource: audience });
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
});

it.each(['role-permission', 'permission-record', 'user-role', 'resource'] as const)('does not resurrect a live JWT or pending code after restoring revoked %s access', async (kind) => {
    const f = await fixture(), tokens = await issue(f), pending = await code(f);
    if (kind === 'role-permission') {
        await patch(f, `/roles/${f.role.id}`, { permissionIds: [] });
        await patch(f, `/roles/${f.role.id}`, { permissionIds: [f.permission.id] });
    } else if (kind === 'permission-record') {
        expect((await f.client.request(`/api/admin/access/permissions/${f.permission.id}`, { cookie: f.administrator, method: 'DELETE' })).status).toBe(200);
        const replacement = await created<{ id: string }>(f.client, f.administrator, `/resources/${f.resource.id}/permissions`, { name: 'Replacement', scope: 'races:read' });
        await patch(f, `/roles/${f.role.id}`, { permissionIds: [replacement.id] });
    } else if (kind === 'user-role') {
        for (const roleIds of [[], [f.role.id]]) expect((await f.client.request(`/api/admin/access/users/${f.userId}/roles`, { cookie: f.administrator, method: 'PUT', body: { roleIds } })).status).toBe(200);
    } else {
        await patch(f, `/resources/${f.resource.id}`, { disabled: true });
        await patch(f, `/resources/${f.resource.id}`, { disabled: false });
    }
    const claim = decodeJwt(tokens.access_token);
    expect(await env.DB.prepare('SELECT "revokedAt" FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = ?').bind(claim.lf_grant).first('revokedAt')).not.toBeNull();
    expect(await active(f, tokens.access_token)).toBe(false);
    expect((await exchange(f, pending)).status).toBeGreaterThanOrEqual(400);
    const refreshed = await protocol(f, '/oauth2/token', { grant_type: 'refresh_token', client_id: f.clientId, refresh_token: tokens.refresh_token, resource: audience });
    expect(refreshed.status).toBeGreaterThanOrEqual(400);
    const newTokens = await issue(f);
    expect(await active(f, newTokens.access_token)).toBe(true);
});

it('rechecks administrator authority inside the write transaction after its HTTP authorization was revoked', async () => {
    const f = await fixture(), administrator = (await session(f.client, f.administrator))!;
    let revoked = false;
    const race = interceptSql(f.client.bindings.DB, /^\s*INSERT INTO "apiAccessWrite"/i, async () => {
        revoked = true;
        await env.DB.prepare('UPDATE "user" SET "role" = \'user\' WHERE "id" = ?').bind(administrator.user.id).run();
    });
    const database = race.proxy;
    const context = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}/api/admin/access/resources`, {
        method: 'POST', headers: { Origin: origin, Cookie: f.administrator, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Rejected racing write', identifier: 'https://racing-write.example.test' }),
    }), { ...f.client.bindings, DB: database }, context);
    await waitOnExecutionContext(context);
    expect(revoked).toBe(true);
    expect(race.invoked()).toBe(true);
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "oauthResource" WHERE "identifier" = ?').bind('https://racing-write.example.test').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "apiAccessWrite"').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "auditLog" WHERE "event" = \'access.resource.created\' AND "outcome" = \'success\'').first('n')).toBe(1);
});

it('preserves a capability added after the developer scope lookup but before the native client update', async () => {
    const f = await fixture();
    let inserted = false;
    const race = interceptSql(f.client.bindings.DB, /^SELECT p\."scope" FROM "apiPermission" p JOIN "oauthResource"/, async () => {
        inserted = true;
        await created(f.client, f.administrator, `/resources/${f.resource.id}/permissions`, { name: 'Write granted concurrently', scope: 'races:write' });
    }, true);
    const database = race.proxy;
    const context = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}/api/developer/applications/${f.clientId}`, {
        method: 'PATCH', headers: { Origin: origin, Cookie: f.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated by developer', scopes: ['openid', 'profile', 'offline_access'] }),
    }), { ...f.client.bindings, DB: database }, context);
    await waitOnExecutionContext(context);
    expect(inserted).toBe(true);
    expect(race.invoked()).toBe(true);
    expect(response.status, await response.clone().text()).toBe(200);
    const scopes = JSON.parse((await env.DB.prepare('SELECT "scopes" FROM "oauthClient" WHERE "clientId" = ?').bind(f.clientId).first<string>('scopes'))!);
    expect(scopes).toEqual(expect.arrayContaining(['openid', 'profile', 'offline_access', 'races:read', 'races:write']));
});
