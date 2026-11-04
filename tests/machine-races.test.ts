import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/server/index';
import { harness, origin, session } from './helpers';
import { managementResource } from '../src/shared/machines';
import { interceptSql } from './sql-race';

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected external request');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
async function fixture() {
    const client = harness(), administrator = await client.administrator();
    const roleResponse = await client.request('/api/admin/machines/roles', { cookie: administrator, body: {
        name: 'Provisioner', managementScopes: ['management:resources:write', 'management:applications:write', 'management:users:write', 'management:role-assignments:write'],
    } });
    expect(roleResponse.status).toBe(201); const role = await roleResponse.json<{ id: string }>();
    const created = await client.request('/api/admin/machines/applications', { cookie: administrator, body: { name: 'Provisioning service' } });
    expect(created.status, await created.clone().text()).toBe(201);
    const machine = await created.json<{ clientId: string; clientSecret: string }>();
    expect((await client.request(`/api/admin/machines/applications/${machine.clientId}/roles`, { cookie: administrator, method: 'PUT', body: { roleIds: [role.id] } })).status).toBe(200);
    const context = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}/api/auth/oauth2/token`, {
        method: 'POST', headers: { Authorization: `Basic ${btoa(`${machine.clientId}:${machine.clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', resource: managementResource }).toString(),
    }), client.bindings, context);
    await waitOnExecutionContext(context);
    expect(response.status, await response.clone().text()).toBe(200);
    return { client, administrator, role, machine, token: (await response.json<{ access_token: string }>()).access_token };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function racedRequest(f: Fixture, path: string, body: Record<string, unknown>, race: () => Promise<unknown>, method = 'POST') {
    let raced = false;
    const injection = interceptSql(f.client.bindings.DB, /^\s*INSERT INTO "machineWrite"/i, async () => { raced = true; await race(); });
    const database = injection.proxy;
    const context = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}/api/management/v1${path}`, {
        method, headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), { ...f.client.bindings, DB: database }, context);
    await waitOnExecutionContext(context); expect(raced).toBe(true); expect(injection.invoked()).toBe(true); return response;
}
it.each(['resources', 'applications'] as const)('rechecks machine authority atomically before %s creation and rolls back its success audit', async (kind) => {
    const f = await fixture();
    const response = await racedRequest(f, `/${kind}`, kind === 'resources'
        ? { name: 'Racing API', identifier: 'https://racing-api.example.test' }
        : { name: 'Racing login app', type: 'web', redirectUris: ['https://racing-app.example.test/callback'], postLogoutRedirectUris: ['https://racing-app.example.test/logout'], scopes: ['openid'] },
    () => env.DB.prepare('UPDATE "machineApp" SET "version" = "version" + 1 WHERE "clientId" = ?').bind(f.machine.clientId).run());
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "oauthResource" WHERE "name" = ?').bind('Racing API').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "oauthClient" WHERE "name" = ?').bind('Racing login app').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "machineWrite"').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "auditLog" WHERE "actorClientId" = ? AND "event" IN (\'access.resource.created\', \'management.application.created\') AND "outcome" = \'success\'').bind(f.machine.clientId).first('n')).toBe(0);
});
it('protects an account promoted to administrator between the HTTP check and the user write', async () => {
    const f = await fixture(); await f.client.verify('promoted@example.test');
    const userId = await env.DB.prepare('SELECT "id" FROM "user" WHERE "email" = ?').bind('promoted@example.test').first<string>('id');
    const response = await racedRequest(f, `/users/${userId}`, { banned: true },
        () => env.DB.prepare('UPDATE "user" SET "role" = \'admin\' WHERE "id" = ?').bind(userId).run(), 'PATCH');
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await env.DB.prepare('SELECT coalesce("banned", 0) AS n FROM "user" WHERE "id" = ?').bind(userId).first('n')).toBe(0);
});
it('atomically rejects machine administration after the human administrator loses the role', async () => {
    const f = await fixture(), identity = (await session(f.client, f.administrator))!;
    let raced = false;
    const injection = interceptSql(f.client.bindings.DB, /^\s*INSERT INTO "apiAccessWrite"/i, async () => {
        raced = true;
        await env.DB.prepare('UPDATE "user" SET "role" = \'user\' WHERE "id" = ?').bind(identity.user.id).run();
    });
    const database = injection.proxy;
    const context = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}/api/admin/machines/applications`, {
        method: 'POST', headers: { Origin: origin, Cookie: f.administrator, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Unapproved service' }),
    }), { ...f.client.bindings, DB: database }, context);
    await waitOnExecutionContext(context);
    expect(raced).toBe(true); expect(injection.invoked()).toBe(true);
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "oauthClient" WHERE "name" = ?').bind('Unapproved service').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "apiAccessWrite"').first('n')).toBe(0);
});
