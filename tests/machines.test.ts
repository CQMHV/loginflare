import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import app from '../src/server/index';
import { harness, origin, password, session } from './helpers';
import { managementResource, managementScopes } from '../src/shared/machines';

const issuer = `${origin}/api/auth`, audience = 'https://machine-orders.example.test';
type Client = ReturnType<typeof harness>;
interface Machine { clientId: string; name: string; disabled: boolean; roleIds: string[]; clientSecret: string }
interface Role { id: string; name: string; permissionIds: string[]; managementScopes: string[] }
interface Tokens { access_token: string; token_type: string; expires_in: number; scope: string; refresh_token?: string; id_token?: string }

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url === `${issuer}/jwks`) {
            const context = createExecutionContext(), response = await app.fetch(request, harness().bindings, context);
            await waitOnExecutionContext(context); return response;
        }
        if (request.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected network');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

async function created<T>(client: Client, cookie: string, path: string, body: Record<string, unknown>): Promise<T> {
    const response = await client.request(path, { cookie, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return response.json<T>();
}
async function fixture() {
    const client = harness(), cookie = await client.administrator();
    const resource = await created<{ id: string }>(client, cookie, '/api/admin/access/resources', { name: 'Machine Orders API', identifier: audience });
    const permission = await created<{ id: string }>(client, cookie, `/api/admin/access/resources/${resource.id}/permissions`, { name: 'Read machine orders', scope: 'machine-orders:read' });
    const role = await created<Role>(client, cookie, '/api/admin/machines/roles', {
        name: 'Orders service', description: 'Independent machine role', permissionIds: [permission.id], managementScopes: ['management:users:read'],
    });
    const before = await Promise.all(['user', 'session'].map((table) => env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<number>('n')));
    const machine = await created<Machine>(client, cookie, '/api/admin/machines/applications', { name: 'Orders automation' });
    const after = await Promise.all(['user', 'session'].map((table) => env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<number>('n')));
    expect(after).toEqual(before);
    const assignment = await client.request(`/api/admin/machines/applications/${machine.clientId}/roles`, { cookie, method: 'PUT', body: { roleIds: [role.id] } });
    expect(assignment.status, await assignment.clone().text()).toBe(200);
    return { client, cookie, resource, permission, role, machine };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function protocol(f: Fixture, endpoint: string, form?: Record<string, string>, secret = f.machine.clientSecret, clientId = f.machine.clientId) {
    const context = createExecutionContext();
    const response = await app.fetch(new Request(`${issuer}${endpoint}`, {
        method: form ? 'POST' : 'GET', headers: { 'CF-Connecting-IP': '192.0.2.57', ...(form ? {
            'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`,
        } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined,
    }), f.client.bindings, context);
    await waitOnExecutionContext(context); return response;
}
async function issue(f: Fixture, resource = audience, scope = 'machine-orders:read'): Promise<Tokens> {
    const response = await protocol(f, '/oauth2/token', { grant_type: 'client_credentials', client_id: f.machine.clientId, resource, scope });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json<Tokens>();
}
async function introspect(f: Fixture, token: string) {
    const response = await protocol(f, '/oauth2/introspect', { token, token_type_hint: 'access_token' });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json<Record<string, unknown>>();
}
async function management(f: Fixture, path: string, token?: string, options: { body?: Record<string, unknown>; method?: string; cookie?: string } = {}) {
    const context = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}/api/management/v1${path}`, {
        method: options.method ?? (options.body ? 'POST' : 'GET'), headers: {
            'CF-Connecting-IP': '192.0.2.58', ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        }, body: options.body ? JSON.stringify(options.body) : undefined,
    }), f.client.bindings, context);
    await waitOnExecutionContext(context); return response;
}
async function patch(f: Fixture, path: string, body: Record<string, unknown>) {
    const response = await f.client.request(`/api/admin/machines${path}`, { cookie: f.cookie, method: 'PATCH', body });
    expect(response.status, await response.clone().text()).toBe(200);
}

it('issues native machine JWTs without user sessions, identity claims or refresh tokens and audits the machine principal', async () => {
    const f = await fixture();
    // A machine subject remains a client even if a user has an identical ID.
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT INTO "user" ("id", "name", "email", "emailVerified", "role", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, \'user\', ?, ?)')
        .bind(f.machine.clientId, 'Unrelated human', 'collision@example.test', now, now).run();
    const before = await Promise.all(['user', 'session'].map((table) => env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<number>('n')));
    const tokens = await issue(f);
    expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'machine-orders:read' });
    expect(tokens.refresh_token).toBeUndefined(); expect(tokens.id_token).toBeUndefined();
    expect(tokens.expires_in).toBeGreaterThan(0); expect(tokens.expires_in).toBeLessThanOrEqual(300);
    expect(decodeProtectedHeader(tokens.access_token)).toMatchObject({ typ: 'at+jwt', alg: 'RS256' });
    const jwks = await (await protocol(f, '/jwks')).json<Parameters<typeof createLocalJWKSet>[0]>();
    const { payload } = await jwtVerify(tokens.access_token, createLocalJWKSet(jwks), { issuer, audience, algorithms: ['RS256'] });
    expect(payload).toMatchObject({ sub: f.machine.clientId, client_id: f.machine.clientId, lf_principal: 'machine', lf_machine_version: expect.any(Number) });
    expect(payload.sid).toBeUndefined(); expect(payload.email).toBeUndefined(); expect(payload.name).toBeUndefined();
    expect(await introspect(f, tokens.access_token)).toMatchObject({ active: true, sub: f.machine.clientId, lf_principal: 'machine' });
    const after = await Promise.all(['user', 'session'].map((table) => env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<number>('n')));
    expect(after).toEqual(before);
    const events = (await env.DB.prepare('SELECT * FROM "auditLog" WHERE "event" = \'machine.token_issued\'').all()).results;
    expect(events).toEqual([expect.objectContaining({ actorClientId: f.machine.clientId, actorUserId: null, targetUserId: null, clientId: f.machine.clientId, outcome: 'success' })]);
    expect(JSON.stringify(events)).not.toContain(tokens.access_token); expect(JSON.stringify(events)).not.toContain(f.machine.clientSecret);
});

it('never returns stored machine secrets and restricts machine administration to verified administrators', async () => {
    const f = await fixture();
    await f.client.verify('member@example.test'); const member = await f.client.signin('member@example.test');
    expect((await f.client.request('/api/admin/machines/applications')).status).toBe(401);
    expect((await f.client.request('/api/admin/machines/applications', { cookie: member })).status).toBe(403);
    const detail = await f.client.request(`/api/admin/machines/applications/${f.machine.clientId}`, { cookie: f.cookie });
    expect(detail.status).toBe(200); expect(await detail.clone().json()).toMatchObject({ clientId: f.machine.clientId, roleIds: [f.role.id] });
    const list = await f.client.request('/api/admin/machines/applications', { cookie: f.cookie });
    const content = `${await detail.text()} ${await list.text()}`;
    expect(content).not.toContain(f.machine.clientSecret); expect(content).not.toContain('clientSecret');
    const impersonation = await f.client.request('/api/admin/machines/applications', { cookie: member, body: { name: 'Forbidden client', administrator: true } });
    expect(impersonation.status).toBe(403);
});

it('rejects invalid credentials, delegated identity scopes, foreign resources, refresh grants and user-interface access', async () => {
    const f = await fixture();
    const incorrect = await protocol(f, '/oauth2/token', { grant_type: 'client_credentials', client_id: f.machine.clientId, resource: audience, scope: 'machine-orders:read' }, 'wrong-machine-secret');
    expect(incorrect.status).toBeGreaterThanOrEqual(400);
    for (const override of [{ scope: 'openid' }, { scope: 'offline_access' }, { resource: 'https://unlinked.example.test' }, { scope: 'orders:unassigned' }]) {
        const response = await protocol(f, '/oauth2/token', { grant_type: 'client_credentials', client_id: f.machine.clientId, resource: audience, scope: 'machine-orders:read', ...override });
        expect(response.status, await response.clone().text()).toBeGreaterThanOrEqual(400);
    }
    const refresh = await protocol(f, '/oauth2/token', { grant_type: 'refresh_token', client_id: f.machine.clientId, refresh_token: 'not-a-refresh-token' });
    expect(refresh.status).toBeGreaterThanOrEqual(400);
    const tokens = await issue(f);
    const denied = await f.client.request('/api/admin/users', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    expect([401, 403]).toContain(denied.status);
    const userInfoContext = createExecutionContext();
    const userInfo = await app.fetch(new Request(`${issuer}/oauth2/userinfo`, { headers: { Authorization: `Bearer ${tokens.access_token}` } }), f.client.bindings, userInfoContext);
    await waitOnExecutionContext(userInfoContext);
    expect(userInfo.status).toBeGreaterThanOrEqual(400);
    const browserSession = await f.client.request('/api/auth/get-session', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    expect(await browserSession.json()).toBeNull();
});

it.each(['disabled', 'role-permission', 'role-assignment', 'resource'] as const)('permanently invalidates the previous machine token generation after %s is restored', async (kind) => {
    const f = await fixture(), old = await issue(f), version = decodeJwt(old.access_token).lf_machine_version;
    if (kind === 'disabled') {
        await patch(f, `/applications/${f.machine.clientId}`, { disabled: true });
        expect((await protocol(f, '/oauth2/token', { grant_type: 'client_credentials', resource: audience, scope: 'machine-orders:read' })).status).toBeGreaterThanOrEqual(400);
        await patch(f, `/applications/${f.machine.clientId}`, { disabled: false });
    } else if (kind === 'role-permission') {
        await patch(f, `/roles/${f.role.id}`, { permissionIds: [] });
        await patch(f, `/roles/${f.role.id}`, { permissionIds: [f.permission.id] });
    } else if (kind === 'role-assignment') {
        for (const roleIds of [[], [f.role.id]]) {
            const result = await f.client.request(`/api/admin/machines/applications/${f.machine.clientId}/roles`, { cookie: f.cookie, method: 'PUT', body: { roleIds } });
            expect(result.status, await result.clone().text()).toBe(200);
        }
    } else {
        for (const disabled of [true, false]) expect((await f.client.request(`/api/admin/access/resources/${f.resource.id}`, { cookie: f.cookie, method: 'PATCH', body: { disabled } })).status).toBe(200);
    }
    expect(await introspect(f, old.access_token)).toEqual({ active: false });
    const current = await issue(f);
    expect(Number(decodeJwt(current.access_token).lf_machine_version)).toBeGreaterThan(Number(version));
    expect(await introspect(f, current.access_token)).toMatchObject({ active: true });
});

it('rotates machine secrets immediately and revokes issued tokens while preserving identity and assigned roles', async () => {
    const f = await fixture(), old = await issue(f), originalSecret = f.machine.clientSecret;
    const rotation = await f.client.request(`/api/admin/machines/applications/${f.machine.clientId}/rotate-secret`, { cookie: f.cookie, body: {} });
    expect(rotation.status, await rotation.clone().text()).toBe(200);
    const rotated = await rotation.json<{ clientSecret: string }>();
    expect(rotated.clientSecret).toBeTruthy(); expect(rotated.clientSecret).not.toBe(originalSecret);
    expect((await protocol(f, '/oauth2/token', { grant_type: 'client_credentials', client_id: f.machine.clientId, resource: audience, scope: 'machine-orders:read' }, originalSecret)).status).toBeGreaterThanOrEqual(400);
    f.machine.clientSecret = rotated.clientSecret;
    expect(await introspect(f, old.access_token)).toEqual({ active: false });
    expect(await introspect(f, (await issue(f)).access_token)).toMatchObject({ active: true, sub: f.machine.clientId });
    expect(JSON.stringify((await env.DB.prepare('SELECT * FROM "auditLog"').all()).results)).not.toContain(rotated.clientSecret);
});

it('keeps unchanged role assignments and name-only edits from revoking valid tokens or clearing permissions', async () => {
    const f = await fixture(), tokens = await issue(f), version = decodeJwt(tokens.access_token).lf_machine_version;
    await patch(f, `/roles/${f.role.id}`, { name: 'Renamed service role' });
    await patch(f, `/applications/${f.machine.clientId}`, { name: 'Renamed automation' });
    const assignment = await f.client.request(`/api/admin/machines/applications/${f.machine.clientId}/roles`, { cookie: f.cookie, method: 'PUT', body: { roleIds: [f.role.id] } });
    expect(assignment.status).toBe(200);
    const role = await f.client.request(`/api/admin/machines/roles/${f.role.id}`, { cookie: f.cookie });
    expect(await role.json()).toMatchObject({ description: 'Independent machine role', permissionIds: [f.permission.id], managementScopes: ['management:users:read'] });
    expect(await introspect(f, tokens.access_token)).toMatchObject({ active: true, lf_machine_version: version });
});

it('requires both a management audience and the token scope instead of browser cookies or the machine wider role capabilities', async () => {
    const f = await fixture();
    const business = await issue(f), reader = await issue(f, managementResource, 'management:users:read');
    expect((await management(f, '/users')).status).toBe(401);
    expect((await management(f, '/users', undefined, { cookie: f.cookie })).status).toBe(401);
    expect((await management(f, '/users', business.access_token)).status).toBe(401);
    const users = await management(f, '/users?limit=2', reader.access_token);
    expect(users.status, await users.clone().text()).toBe(200);
    expect(await users.json()).toMatchObject({ items: expect.any(Array), pageInfo: expect.any(Object) });
    expect((await management(f, '/resources', reader.access_token)).status).toBe(403);
    await f.client.verify('managed@example.test');
    const userId = await env.DB.prepare('SELECT "id" FROM "user" WHERE "email" = ?').bind('managed@example.test').first<string>('id');
    expect((await management(f, `/users/${userId}`, reader.access_token, { method: 'PATCH', body: { name: 'Denied write' } })).status).toBe(403);
    await patch(f, `/roles/${f.role.id}`, { managementScopes: ['management:users:read', 'management:users:write'] });
    const writer = await issue(f, managementResource, 'management:users:write');
    expect((await management(f, '/users', writer.access_token)).status).toBe(403);
    const updated = await management(f, `/users/${userId}`, writer.access_token, { method: 'PATCH', body: { name: 'Updated by machine' } });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await env.DB.prepare('SELECT "name" FROM "user" WHERE "id" = ?').bind(userId).first('name')).toBe('Updated by machine');
    const administrator = (await session(f.client, f.cookie))!.user.id;
    expect((await management(f, `/users/${administrator}`, writer.access_token, { method: 'PATCH', body: { banned: true } })).status).toBe(403);
    const events = (await env.DB.prepare('SELECT "actorUserId", "actorClientId", "targetUserId", "outcome" FROM "auditLog" WHERE "actorClientId" = ? AND "targetUserId" = ?').bind(f.machine.clientId, userId).all()).results;
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ actorUserId: null, actorClientId: f.machine.clientId, targetUserId: userId, outcome: 'success' })]));
});

it('keeps machine roles distinct from human business roles and protects the reserved management resource', async () => {
    const f = await fixture();
    const human = await created<{ id: string }>(f.client, f.cookie, '/api/admin/access/roles', { name: 'Human reader', permissionIds: [f.permission.id] });
    const incompatible = await f.client.request(`/api/admin/machines/applications/${f.machine.clientId}/roles`, { cookie: f.cookie, method: 'PUT', body: { roleIds: [human.id] } });
    expect(incompatible.status).toBeGreaterThanOrEqual(400);
    const administrator = (await session(f.client, f.cookie))!.user.id;
    const humanAssignment = await f.client.request(`/api/admin/access/users/${administrator}/roles`, { cookie: f.cookie, method: 'PUT', body: { roleIds: [f.role.id] } });
    expect(humanAssignment.status).toBeGreaterThanOrEqual(400);
    const protectedResource = await f.client.request('/api/admin/access/resources/loginflare-management', { cookie: f.cookie, method: 'PATCH', body: { disabled: true } });
    expect(protectedResource.status).toBeGreaterThanOrEqual(400);
    const reserved = await f.client.request(`/api/admin/access/resources/${f.resource.id}/permissions`, { cookie: f.cookie, body: { name: 'Forbidden management permission', scope: 'management:users:write' } });
    expect(reserved.status).toBeGreaterThanOrEqual(400);
    expect(await introspect(f, (await issue(f)).access_token)).toMatchObject({ active: true });
});

it('manages resource permissions, application links and human role assignments through scoped service writes', async () => {
    const f = await fixture();
    await patch(f, `/roles/${f.role.id}`, { managementScopes: [...managementScopes] });
    const token = (await issue(f, managementResource, managementScopes.join(' '))).access_token;
    await f.client.verify('managed-role@example.test');
    const userId = await env.DB.prepare('SELECT "id" FROM "user" WHERE "email" = ?').bind('managed-role@example.test').first<string>('id');
    const resourceResponse = await management(f, '/resources', token, { body: { name: 'Service-created API', identifier: 'https://service-created.example.test', description: 'Created by a service', accessTokenTtl: 120 } });
    expect(resourceResponse.status, await resourceResponse.clone().text()).toBe(201);
    const resource = await resourceResponse.json<{ id: string }>();
    const permissionResponse = await management(f, `/resources/${resource.id}/permissions`, token, { body: { name: 'Read service data', scope: 'service-created:read', description: 'Read-only service data' } });
    expect(permissionResponse.status, await permissionResponse.clone().text()).toBe(201);
    const permission = await permissionResponse.json<{ id: string }>();
    const roleResponse = await management(f, '/roles', token, { body: { name: 'Service-assigned reader', permissionIds: [permission.id], description: 'A human business role' } });
    expect(roleResponse.status, await roleResponse.clone().text()).toBe(201);
    const role = await roleResponse.json<{ id: string }>();
    const assignment = await management(f, `/users/${userId}/roles`, token, { method: 'PUT', body: { roleIds: [role.id] } });
    expect(assignment.status, await assignment.clone().text()).toBe(200);
    const detail = await management(f, `/users/${userId}/roles`, token);
    expect(await detail.json()).toMatchObject({ roles: [expect.objectContaining({ id: role.id })] });
    expect((await management(f, `/permissions/${permission.id}`, token, { method: 'PATCH', body: { name: 'Renamed service permission' } })).status).toBe(200);
    expect((await management(f, `/roles/${role.id}`, token, { method: 'PATCH', body: { name: 'Renamed human reader' } })).status).toBe(200);
    expect((await management(f, `/resources/${resource.id}`, token, { method: 'PATCH', body: { name: 'Renamed service API' } })).status).toBe(200);
    const resourceDetail = await management(f, `/resources/${resource.id}`, token);
    expect(await resourceDetail.json()).toMatchObject({ name: 'Renamed service API', accessTokenTtl: 120, description: 'Created by a service', permissions: [expect.objectContaining({ id: permission.id, name: 'Renamed service permission', description: 'Read-only service data' })] });
    const registered = await f.client.request('/api/admin/applications', { cookie: f.cookie, body: { name: 'Linked human app', type: 'spa', redirectUris: ['https://service-link.example.test/callback'], postLogoutRedirectUris: ['https://service-link.example.test/'], scopes: ['openid'] } });
    expect(registered.status).toBe(201);
    const clientId = (await registered.json<{ application: { clientId: string } }>()).application.clientId;
    const link = await management(f, `/resources/${resource.id}/applications`, token, { body: { clientId } });
    expect(link.status, await link.clone().text()).toBe(201);
    expect(JSON.parse((await env.DB.prepare('SELECT "scopes" FROM "oauthClient" WHERE "clientId" = ?').bind(clientId).first<string>('scopes'))!)).toContain('service-created:read');
    const unlink = await management(f, `/resources/${resource.id}/applications/${clientId}`, token, { method: 'DELETE' });
    expect(unlink.status, await unlink.clone().text()).toBe(200);
    expect(JSON.parse((await env.DB.prepare('SELECT "scopes" FROM "oauthClient" WHERE "clientId" = ?').bind(clientId).first<string>('scopes'))!)).not.toContain('service-created:read');
    for (const path of [`/roles/${role.id}`, `/permissions/${permission.id}`, `/resources/${resource.id}`]) {
        const deleted = await management(f, path, token, { method: 'DELETE' });
        expect(deleted.status, await deleted.clone().text()).toBe(200);
    }
    const records = (await env.DB.prepare('SELECT "actorClientId", "actorUserId", "event" FROM "auditLog" WHERE "actorClientId" = ? AND "outcome" = \'success\'').bind(f.machine.clientId).all()).results;
    expect(records.length).toBeGreaterThan(8);
    expect(records.every((record) => record.actorUserId === null)).toBe(true);
});

it('creates and edits service-owned Web applications with native callback metadata and immediately compatible rotated secrets', async () => {
    const f = await fixture();
    await patch(f, `/roles/${f.role.id}`, { managementScopes: ['management:applications:read', 'management:applications:write', 'management:resources:write'] });
    const token = (await issue(f, managementResource, 'management:applications:read management:applications:write management:resources:write')).access_token;
    const business = await issue(f);
    const createdResponse = await management(f, '/applications', token, { body: {
        name: 'Service Web app', type: 'web', redirectUris: ['https://service-app.example.test/callback'], postLogoutRedirectUris: ['https://service-app.example.test/'], scopes: ['openid', 'profile'],
    } });
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
    const createdApp = await createdResponse.json<{ clientId: string; clientSecret: string }>();
    expect(createdApp.clientSecret).toBeTruthy();
    const linked = await management(f, `/resources/${f.resource.id}/applications`, token, { body: { clientId: createdApp.clientId } });
    expect(linked.status, await linked.clone().text()).toBe(201);
    const native = await f.client.request(`/api/admin/applications/${createdApp.clientId}`, { cookie: f.cookie });
    expect(native.status, await native.clone().text()).toBe(200);
    expect(await native.json()).toMatchObject({ application: { clientId: createdApp.clientId, name: 'Service Web app', type: 'web', ownerId: null, redirectUris: ['https://service-app.example.test/callback'], apiScopes: ['machine-orders:read'] } });
    const introspected = await protocol(f, '/oauth2/introspect', { token: business.access_token }, createdApp.clientSecret, createdApp.clientId);
    expect(introspected.status, await introspected.clone().text()).toBe(200);
    expect(await introspected.json()).toMatchObject({ active: true, sub: f.machine.clientId });
    const update = await management(f, `/applications/${createdApp.clientId}`, token, { method: 'PATCH', body: {
        name: 'Edited service app', redirectUris: ['https://edited-service-app.example.test/auth/callback'], postLogoutRedirectUris: ['https://edited-service-app.example.test/bye'], scopes: ['openid'],
    } });
    expect(update.status, await update.clone().text()).toBe(200);
    const uris = (await env.DB.prepare('SELECT "kind", "value" FROM "oauthClientUri" WHERE "clientId" = ?').bind(createdApp.clientId).all()).results;
    expect(uris).toEqual(expect.arrayContaining([{ kind: 'redirect-origin', value: 'https://edited-service-app.example.test' }, { kind: 'post-logout-uri', value: 'https://edited-service-app.example.test/bye' }]));
    expect(uris).not.toContainEqual({ kind: 'redirect-origin', value: 'https://service-app.example.test' });
    const query = new URLSearchParams({ client_id: createdApp.clientId, redirect_uri: 'https://edited-service-app.example.test/auth/callback', response_type: 'code', scope: 'openid', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
    const authorize = await protocol(f, `/oauth2/authorize?${query}`);
    expect(authorize.status).toBe(302);
    expect(new URL(authorize.headers.get('location')!, origin).pathname).toBe('/en-us/login');
    const rotated = await management(f, `/applications/${createdApp.clientId}/rotate-secret`, token, { body: {} });
    expect(rotated.status, await rotated.clone().text()).toBe(200);
    const replacement = await rotated.json<{ clientSecret: string }>();
    expect(replacement.clientSecret).not.toBe(createdApp.clientSecret);
    expect((await protocol(f, '/oauth2/introspect', { token: business.access_token }, createdApp.clientSecret, createdApp.clientId)).status).toBe(401);
    const compatible = await protocol(f, '/oauth2/introspect', { token: business.access_token }, replacement.clientSecret, createdApp.clientId);
    expect(compatible.status, await compatible.clone().text()).toBe(200);
    expect(await compatible.json()).toMatchObject({ active: true });
    const fetched = await management(f, `/applications/${createdApp.clientId}`, token);
    const content = await fetched.text();
    expect(content).not.toContain(createdApp.clientSecret); expect(content).not.toContain(replacement.clientSecret);
    expect((await management(f, `/applications/${f.machine.clientId}`, token)).status).toBe(404);
});

it('revokes human sessions and bans only ordinary users through the management API without revoking the machine itself', async () => {
    const f = await fixture();
    await patch(f, `/roles/${f.role.id}`, { managementScopes: ['management:users:read', 'management:users:write'] });
    const token = (await issue(f, managementResource, 'management:users:read management:users:write')).access_token;
    await f.client.verify('revoked-by-service@example.test');
    const firstCookie = await f.client.signin('revoked-by-service@example.test'), human = (await session(f.client, firstCookie))!;
    const revoked = await management(f, `/users/${human.user.id}/revoke-sessions`, token, { body: {} });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect(await session(f.client, firstCookie)).toBeNull();
    const secondCookie = await f.client.signin('revoked-by-service@example.test');
    const banned = await management(f, `/users/${human.user.id}`, token, { method: 'PATCH', body: { banned: true } });
    expect(banned.status, await banned.clone().text()).toBe(200);
    expect(await session(f.client, secondCookie)).toBeNull();
    const rejected = await f.client.request('/api/auth/sign-in/email', { body: { email: 'revoked-by-service@example.test', password } });
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect((await management(f, `/users/${human.user.id}`, token, { method: 'PATCH', body: { banned: false } })).status).toBe(200);
    expect(await session(f.client, secondCookie)).toBeNull();
    expect(await introspect(f, token)).toMatchObject({ active: true, lf_principal: 'machine' });
    const administrator = (await session(f.client, f.cookie))!.user.id;
    expect((await management(f, `/users/${administrator}/revoke-sessions`, token, { body: {} })).status).toBe(403);
    expect(await session(f.client, f.cookie)).not.toBeNull();
});

it('serves audit events with machine principals and binds service audit cursors to the authenticated machine', async () => {
    const f = await fixture();
    await patch(f, `/roles/${f.role.id}`, { managementScopes: ['management:audit:read'] });
    const token = (await issue(f, managementResource, 'management:audit:read')).access_token;
    await issue(f);
    const query = new URLSearchParams({ lookupField: 'actorClientId', lookupValue: f.machine.clientId, limit: '1' });
    const pageResponse = await management(f, `/audit-logs?${query}`, token, { cookie: f.cookie });
    expect(pageResponse.status, await pageResponse.clone().text()).toBe(200);
    const page = await pageResponse.json<{ items: { id: string; actorClientId: string; actorUserId: null }[]; pageInfo: { nextCursor: string } }>();
    expect(page.items).toEqual([expect.objectContaining({ actorClientId: f.machine.clientId, actorUserId: null })]);
    expect(page.pageInfo.nextCursor).toBeTruthy();
    const detail = await management(f, `/audit-logs/${page.items[0].id}`, token);
    expect(await detail.json()).toMatchObject({ actorClientId: f.machine.clientId, actorUserId: null });
    query.set('cursor', page.pageInfo.nextCursor);
    const humanCursor = await f.client.request(`/api/admin/audit-logs?${query}`, { cookie: f.cookie });
    expect(humanCursor.status).toBe(400);
    const another = await created<Machine>(f.client, f.cookie, '/api/admin/machines/applications', { name: 'Other audit reader' });
    expect((await f.client.request(`/api/admin/machines/applications/${another.clientId}/roles`, { cookie: f.cookie, method: 'PUT', body: { roleIds: [f.role.id] } })).status).toBe(200);
    const peer = { ...f, machine: another }, peerToken = (await issue(peer, managementResource, 'management:audit:read')).access_token;
    expect((await management(peer, `/audit-logs?${query}`, peerToken)).status).toBe(400);
    expect((await management(f, '/users', token)).status).toBe(403);
});

it('keeps role-derived machine resource links outside the generic application-link management surface', async () => {
    const f = await fixture();
    await patch(f, `/roles/${f.role.id}`, { managementScopes: ['management:resources:read', 'management:resources:write'] });
    const token = (await issue(f, managementResource, 'management:resources:read management:resources:write')).access_token;
    const business = await issue(f);
    const version = await env.DB.prepare('SELECT "version" FROM "machineApp" WHERE "clientId" = ?').bind(f.machine.clientId).first<number>('version');
    const path = `/resources/${f.resource.id}/applications`;
    const listed = await management(f, path, token);
    expect(listed.status, await listed.clone().text()).toBe(200);
    const page = await listed.json<{ items: { clientId: string }[] }>();
    expect(page.items.some((item) => item.clientId === f.machine.clientId)).toBe(false);
    expect((await management(f, path, token, { body: { clientId: f.machine.clientId } })).status).toBe(404);
    expect((await management(f, `${path}/${f.machine.clientId}`, token, { method: 'DELETE' })).status).toBe(404);
    expect(await env.DB.prepare('SELECT "version" FROM "machineApp" WHERE "clientId" = ?').bind(f.machine.clientId).first('version')).toBe(version);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "oauthClientResource" WHERE "clientId" = ? AND "resourceId" = ?').bind(f.machine.clientId, audience).first('n')).toBe(1);
    expect(await introspect(f, business.access_token)).toMatchObject({ active: true });
    expect(await introspect(f, (await issue(f)).access_token)).toMatchObject({ active: true });
});
