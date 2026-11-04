import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/server/index';
import { harness, origin, session } from './helpers';
import { applicationPrivileges } from '../src/server/application-policy';
import { applicationCreateSchema, applicationFieldErrors } from '../src/shared/application-validation';
import { interceptSql } from './sql-race';

const developerPath = '/api/developer/applications';
const settings = { name: 'Developer website', type: 'web', redirectUris: ['https://developer.example.test/callback'], postLogoutRedirectUris: ['https://developer.example.test/'], scopes: ['openid', 'profile', 'email'] };
interface Application { clientId: string; name: string; ownerId: string | null; owner?: { id: string; name: string; email: string } | null; ownerDisabled: boolean; adminSuspended: boolean; disabled: boolean; type: 'web' | 'spa' }
interface Registered { application: Application; clientSecret?: string; issuer: string }
type Client = ReturnType<typeof harness>;

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Request(input, init).url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected external request');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

async function developer(client: Client, email = 'developer@example.test') {
    await client.verify(email);
    const cookie = await client.signin(email);
    return { cookie, identity: (await session(client, cookie))! };
}
async function create(client: Client, cookie: string, type: 'web' | 'spa' = 'web') {
    const response = await client.request(developerPath, { cookie, body: { ...settings, type } });
    expect(response.status, await response.clone().text()).toBe(201);
    return response.json<Registered>();
}
async function detail(client: Client, cookie: string, clientId: string) {
    return client.request(`${developerPath}/${clientId}`, { cookie });
}

it('lets a verified developer create and manage Web/SPA registrations without disclosing stored secrets', async () => {
    const client = harness(), owner = await developer(client);
    const web = await create(client, owner.cookie), spa = await create(client, owner.cookie, 'spa');
    expect(web.application).toMatchObject({ ownerId: owner.identity.user.id, ownerDisabled: false, adminSuspended: false, disabled: false });
    expect(web.clientSecret).toBeTruthy(); expect(spa.clientSecret).toBeUndefined();
    const stored = await env.DB.prepare('SELECT "clientSecret", "ownerId", "managementUserId", "managementSessionId" FROM "oauthClient" WHERE "clientId" = ?').bind(web.application.clientId).first();
    expect(stored).toMatchObject({ ownerId: owner.identity.user.id, managementUserId: owner.identity.user.id, managementSessionId: owner.identity.session.id });
    expect(stored!.clientSecret).not.toBe(web.clientSecret);
    const read = await detail(client, owner.cookie, web.application.clientId);
    expect(read.status).toBe(200); expect(await read.json()).not.toHaveProperty('clientSecret');
    const list = await client.request(developerPath, { cookie: owner.cookie });
    const listed = await list.json<{ items: Application[] }>();
    expect(listed.items).toHaveLength(2); expect(JSON.stringify(listed)).not.toContain(web.clientSecret!);
    const changed = await client.request(`${developerPath}/${web.application.clientId}`, { cookie: owner.cookie, method: 'PATCH', body: { name: 'Renamed developer site', disabled: true } });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect((await changed.json<Registered>()).application).toMatchObject({ name: 'Renamed developer site', ownerDisabled: true, adminSuspended: false, disabled: true });
    expect((await client.request(`${developerPath}/${web.application.clientId}`, { cookie: owner.cookie, method: 'PATCH', body: { disabled: false } })).status).toBe(200);
    const rotated = await client.request(`${developerPath}/${web.application.clientId}/rotate-secret`, { cookie: owner.cookie, body: {} });
    expect(rotated.status, await rotated.clone().text()).toBe(200);
    expect((await rotated.json<{ clientSecret: string }>()).clientSecret).not.toBe(web.clientSecret);
    expect((await client.request(`${developerPath}/${spa.application.clientId}/rotate-secret`, { cookie: owner.cookie, body: {} })).status).toBe(400);
    expect((await client.request('/api/admin/applications', { cookie: owner.cookie })).status).toBe(403);
    for (const path of ['/api/auth/oauth2/create-client', '/api/auth/admin/oauth2/create-client', '/api/auth/oauth2/client/rotate-secret', '/api/auth/oauth2/register']) {
        expect((await client.request(path, { cookie: owner.cookie, body: {} })).status).toBe(404);
    }
});

it('isolates application lists, details, writes and signed cursors by owner, including instance applications', async () => {
    const client = harness(), adminCookie = await client.administrator(), a = await developer(client), b = await developer(client, 'other@example.test');
    const first = await create(client, a.cookie), second = await create(client, a.cookie, 'spa'), other = await create(client, b.cookie);
    const legacy = await client.request('/api/admin/applications', { cookie: adminCookie, body: settings });
    expect(legacy.status).toBe(201); expect((await legacy.clone().json<Registered>()).application.ownerId).toBeNull();
    for (const id of [first.application.clientId, (await legacy.json<Registered>()).application.clientId]) {
        expect((await detail(client, b.cookie, id)).status).toBe(404);
        expect((await client.request(`${developerPath}/${id}`, { cookie: b.cookie, method: 'PATCH', body: { name: 'Stolen' } })).status).toBe(404);
        expect((await client.request(`${developerPath}/${id}/rotate-secret`, { cookie: b.cookie, body: {} })).status).toBe(404);
    }
    const page = await (await client.request(`${developerPath}?limit=1`, { cookie: a.cookie })).json<{ items: Application[]; pageInfo: { nextCursor: string } }>();
    expect(page.items).toHaveLength(1); expect(page.pageInfo.nextCursor).toBeTruthy();
    expect((await client.request(`${developerPath}?limit=1&cursor=${page.pageInfo.nextCursor}`, { cookie: b.cookie })).status).toBe(400);
    expect((await client.request(`/api/admin/applications?cursor=${page.pageInfo.nextCursor}`, { cookie: adminCookie })).status).toBe(400);
    const filtered = await (await client.request(`${developerPath}?${new URLSearchParams({ lookupField: 'clientId', lookupValue: other.application.clientId })}`, { cookie: a.cookie })).json<{ items: Application[] }>();
    expect(filtered.items).toHaveLength(0);
    const all = await (await client.request('/api/admin/applications', { cookie: adminCookie })).json<{ items: Application[] }>();
    expect(all.items).toHaveLength(4);
    expect(all.items.map((item) => item.clientId)).toEqual(expect.arrayContaining([first.application.clientId, second.application.clientId, other.application.clientId]));
    for (const payload of [{ ownerId: b.identity.user.id }, { user_id: b.identity.user.id }, { reference_id: 'loginflare' }, { metadata: { ownerId: b.identity.user.id } }, { managementUserId: b.identity.user.id }, { adminSuspended: false }, { skip_consent: true }]) {
        expect((await client.request(developerPath, { cookie: a.cookie, body: { ...settings, ...payload } })).status).toBe(400);
        expect((await client.request(`${developerPath}/${first.application.clientId}`, { cookie: a.cookie, method: 'PATCH', body: payload })).status).toBe(400);
    }
});

it('exposes developer summaries only to administrators while preserving private owner lists and details', async () => {
    const client = harness(), adminCookie = await client.administrator(), owner = await developer(client), other = await developer(client, 'other@example.test');
    const registered = await create(client, owner.cookie), otherApplication = await create(client, other.cookie, 'spa');
    const instance = await (await client.request('/api/admin/applications', { cookie: adminCookie, body: settings })).json<Registered>();
    expect(registered.application).not.toHaveProperty('owner');
    expect(otherApplication.application).not.toHaveProperty('owner');
    expect(instance.application.owner).toBeNull();
    const expected = { id: owner.identity.user.id, name: owner.identity.user.name, email: owner.identity.user.email };
    const administration = await (await client.request('/api/admin/applications', { cookie: adminCookie })).json<{ items: Application[] }>();
    expect(administration.items.find((item) => item.clientId === registered.application.clientId)?.owner).toEqual(expected);
    expect(administration.items.find((item) => item.clientId === otherApplication.application.clientId)?.owner).toEqual({ id: other.identity.user.id, name: other.identity.user.name, email: other.identity.user.email });
    expect(administration.items.find((item) => item.clientId === instance.application.clientId)?.owner).toBeNull();
    const adminDetail = await (await client.request(`/api/admin/applications/${registered.application.clientId}`, { cookie: adminCookie })).json<Registered>();
    expect(adminDetail.application.owner).toEqual(expected);
    const privateList = await (await client.request(developerPath, { cookie: owner.cookie })).json<{ items: Application[] }>();
    expect(privateList.items).toHaveLength(1);
    expect(privateList.items[0]).not.toHaveProperty('owner');
    const privateDetail = await (await detail(client, owner.cookie, registered.application.clientId)).json<Registered>();
    expect(privateDetail.application).not.toHaveProperty('owner');
    expect((await detail(client, owner.cookie, otherApplication.application.clientId)).status).toBe(404);
    expect(JSON.stringify(privateList)).not.toContain(other.identity.user.email);
});

it('keeps administrator suspension independent from owner disable and freezes developer writes', async () => {
    const client = harness(), adminCookie = await client.administrator(), owner = await developer(client), registered = await create(client, owner.cookie);
    const ownerUrl = `${developerPath}/${registered.application.clientId}`, adminUrl = `/api/admin/applications/${registered.application.clientId}`;
    expect((await client.request(ownerUrl, { cookie: owner.cookie, method: 'PATCH', body: { disabled: true } })).status).toBe(200);
    const suspended = await client.request(adminUrl, { cookie: adminCookie, method: 'PATCH', body: { disabled: true } });
    expect(suspended.status, await suspended.clone().text()).toBe(200);
    expect((await suspended.json<Registered>()).application).toMatchObject({ ownerDisabled: true, adminSuspended: true, disabled: true });
    for (const [path, body, method] of [[ownerUrl, { disabled: false }, 'PATCH'], [ownerUrl, { name: 'Frozen edit' }, 'PATCH'], [`${ownerUrl}/rotate-secret`, {}, 'POST']] as const) {
        const response = await client.request(path, { cookie: owner.cookie, body, method });
        expect(response.status).toBe(403); expect(await response.json()).toEqual({ code: 'APPLICATION_SUSPENDED' });
    }
    await expect(applicationPrivileges(client.bindings, { userId: owner.identity.user.id, sessionId: owner.identity.session.id, administrator: false }, registered.application.clientId, true)).rejects.toMatchObject({ statusCode: 403, body: { code: 'APPLICATION_SUSPENDED' } });
    expect((await detail(client, owner.cookie, registered.application.clientId)).status).toBe(200);
    const restored = await client.request(adminUrl, { cookie: adminCookie, method: 'PATCH', body: { disabled: false } });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect((await restored.json<Registered>()).application).toMatchObject({ adminSuspended: false, ownerDisabled: true, disabled: true });
    const enabled = await client.request(ownerUrl, { cookie: owner.cookie, method: 'PATCH', body: { disabled: false } });
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    expect((await enabled.json<Registered>()).application).toMatchObject({ ownerDisabled: false, disabled: false });
});

it('requires an active verified session and rejects foreign origins or unsupported registration fields', async () => {
    const client = harness(), owner = await developer(client);
    expect((await client.request(developerPath)).status).toBe(401);
    expect((await client.request(developerPath, { cookie: owner.cookie, body: settings, headers: { Origin: 'https://foreign.example.test' } })).status).toBe(403);
    await env.DB.prepare('UPDATE "user" SET "emailVerified" = 0 WHERE "id" = ?').bind(owner.identity.user.id).run();
    expect((await client.request(developerPath, { cookie: owner.cookie })).status).toBe(403);
    await env.DB.prepare('UPDATE "user" SET "emailVerified" = 1, "banned" = 1 WHERE "id" = ?').bind(owner.identity.user.id).run();
    expect([401, 403]).toContain((await client.request(developerPath, { cookie: owner.cookie, body: settings })).status);
});

it('returns stable field errors for create and update without exposing URI credentials or original validation messages', async () => {
    const client = harness(), owner = await developer(client), registered = await create(client, owner.cookie);
    const cases = [
        { patch: { name: '' }, errors: { name: 'APPLICATION_NAME_INVALID' } },
        { patch: { redirectUris: [] }, errors: { redirectUris: 'APPLICATION_REDIRECT_REQUIRED' } },
        { patch: { postLogoutRedirectUris: [] }, errors: { postLogoutRedirectUris: 'APPLICATION_LOGOUT_REDIRECT_REQUIRED' } },
        { patch: { redirectUris: ['http://app.example.test/callback'] }, errors: { redirectUris: 'APPLICATION_URI_HTTPS_REQUIRED' } },
        { patch: { redirectUris: ['https://localhost/callback'] }, errors: { redirectUris: 'APPLICATION_URI_LOOPBACK' } },
        { patch: { redirectUris: ['https://app.example.test/callback#'] }, errors: { redirectUris: 'APPLICATION_URI_INVALID' } },
        { patch: { postLogoutRedirectUris: ['https://developer:do-not-echo-credentials@app.example.test/logout'] }, errors: { postLogoutRedirectUris: 'APPLICATION_URI_INVALID' } },
        { patch: { scopes: ['profile'] }, errors: { scopes: 'APPLICATION_SCOPES_INVALID' } },
    ];
    for (const { patch, errors } of cases) {
        for (const [path, body, method] of [[developerPath, { ...settings, ...patch }, 'POST'], [`${developerPath}/${registered.application.clientId}`, patch, 'PATCH']] as const) {
            const response = await client.request(path, { cookie: owner.cookie, body, method });
            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({ code: 'INVALID_INPUT', fieldErrors: errors });
        }
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "oauthClient" WHERE "ownerId" = ?').bind(owner.identity.user.id).first('n')).toBe(1);
    expect(await env.DB.prepare('SELECT "name" FROM "oauthClient" WHERE "clientId" = ?').bind(registered.application.clientId).first('name')).toBe(settings.name);
});

it('keeps callback checks aligned across numeric loopback forms and valid exact HTTPS development callbacks', () => {
    for (const uri of ['https://localhost./cb', 'https://127.1/cb', 'https://2130706433/cb', 'https://0x7f000001/cb', 'https://[::1]/cb', 'https://[::ffff:127.0.0.1]/cb']) {
        const parsed = applicationCreateSchema.safeParse({ ...settings, redirectUris: [uri] });
        expect(parsed.success).toBe(false);
        if (!parsed.success) expect(applicationFieldErrors(parsed.error)).toEqual({ redirectUris: 'APPLICATION_URI_LOOPBACK' });
    }
    const uri = 'https://WEB.localhost:443/callback?next=%2Fhome';
    const parsed = applicationCreateSchema.safeParse({ ...settings, redirectUris: [uri] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.redirectUris).toEqual([uri]);
});

it('maps native protocol rejection identifiers without exposing legacy callback content', async () => {
    const client = harness(), owner = await developer(client), registered = await create(client, owner.cookie);
    const privateUri = 'https://localhost/callback?private=do-not-echo';
    await env.DB.prepare('UPDATE "oauthClient" SET "redirectUris" = ? WHERE "clientId" = ?').bind(JSON.stringify([privateUri]), registered.application.clientId).run();
    const invalidRedirect = await client.request(`${developerPath}/${registered.application.clientId}`, { cookie: owner.cookie, method: 'PATCH', body: { name: 'Refused edit' } });
    expect(invalidRedirect.status).toBe(400);
    expect(await invalidRedirect.json()).toEqual({ code: 'INVALID_INPUT', fieldErrors: { redirectUris: 'APPLICATION_URI_INVALID' } });
    await env.DB.prepare('UPDATE "oauthClient" SET "redirectUris" = ?, "scopes" = ? WHERE "clientId" = ?').bind(JSON.stringify(settings.redirectUris), JSON.stringify(['openid', 'unavailable_scope']), registered.application.clientId).run();
    const invalidScope = await client.request(`${developerPath}/${registered.application.clientId}`, { cookie: owner.cookie, method: 'PATCH', body: { name: 'Refused scope edit' } });
    expect(invalidScope.status).toBe(400);
    expect(await invalidScope.json()).toEqual({ code: 'INVALID_INPUT', fieldErrors: { scopes: 'APPLICATION_SCOPES_INVALID' } });
    expect(await env.DB.prepare('SELECT "name" FROM "oauthClient" WHERE "clientId" = ?').bind(registered.application.clientId).first('name')).toBe(settings.name);
});

it('enforces the per-developer limit atomically while leaving instance registrations independent', async () => {
    const client = harness(), owner = await developer(client), first = await create(client, owner.cookie, 'spa');
    const template = (await env.DB.prepare('SELECT * FROM "oauthClient" WHERE "clientId" = ?').bind(first.application.clientId).first<Record<string, unknown>>())!;
    const fields = Object.keys(template), columns = fields.map((field) => `"${field}"`).join(', '), placeholders = fields.map(() => '?').join(', ');
    for (let index = 0; index < 18; index++) {
        const copy = { ...template, id: crypto.randomUUID(), clientId: `quota-${index}` };
        await env.DB.prepare(`INSERT INTO "oauthClient" (${columns}) VALUES (${placeholders})`).bind(...fields.map((field) => copy[field as keyof typeof copy])).run();
    }
    const responses = await Promise.all([client.request(developerPath, { cookie: owner.cookie, body: settings }), client.request(developerPath, { cookie: owner.cookie, body: settings })]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 400]);
    expect(await responses.find((response) => response.status === 400)!.json()).toEqual({ code: 'APPLICATION_LIMIT' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "oauthClient" WHERE "ownerId" = ?').bind(owner.identity.user.id).first('n')).toBe(20);
});

it('uses owner-seeking indexes for ordering and exact-name lookup', async () => {
    for (const [extra, expected] of [['', 'oauthClient_ownerId_createdAt_clientId_idx'], [' AND "name" = ?', 'oauthClient_ownerId_name_createdAt_clientId_idx']]) {
        const result = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT "clientId", "name", "createdAt" FROM "oauthClient" WHERE "referenceId" = ? AND "ownerId" = ?${extra} ORDER BY "createdAt" DESC, "clientId" DESC LIMIT ?`)
            .bind('loginflare', 'owner', ...(extra ? ['name'] : []), 21).all<{ detail: string }>();
        expect(result.results.map((row) => row.detail).join(' ')).toContain(expected);
    }
});

function beforeClientWrite(database: D1Database, mutation: () => Promise<void>) {
    return interceptSql(database, /^\s*(?:insert into|update) ["`]?oauthClient["`]? /i, mutation);
}
async function racingRequest(client: Client, cookie: string, path: string, body: Record<string, unknown>, method: string, mutate: () => Promise<void>) {
    const database = beforeClientWrite(env.DB, mutate), context = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}${path}`, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { ...client.bindings, DB: database.proxy }, context);
    await waitOnExecutionContext(context);
    expect(database.invoked()).toBe(true);
    return response;
}

it('does not create an application when its owner is banned immediately before persistence', async () => {
    const client = harness(), owner = await developer(client);
    const response = await racingRequest(client, owner.cookie, developerPath, settings, 'POST', async () => { await env.DB.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?').bind(owner.identity.user.id).run(); });
    expect(response.status).toBe(403); expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "oauthClient"').first('n')).toBe(0);
});

it.each(['edit', 'rotate'] as const)('rejects %s after session revocation at the actual native write', async (operation) => {
    const client = harness(), owner = await developer(client), registered = await create(client, owner.cookie);
    const before = await env.DB.prepare('SELECT "name", "clientSecret" FROM "oauthClient" WHERE "clientId" = ?').bind(registered.application.clientId).first();
    const response = await racingRequest(client, owner.cookie, `${developerPath}/${registered.application.clientId}${operation === 'rotate' ? '/rotate-secret' : ''}`, operation === 'rotate' ? {} : { name: 'Forbidden race edit' }, operation === 'rotate' ? 'POST' : 'PATCH', async () => { await env.DB.prepare('DELETE FROM "session" WHERE "id" = ?').bind(owner.identity.session.id).run(); });
    expect(response.status).toBe(403);
    expect(await env.DB.prepare('SELECT "name", "clientSecret" FROM "oauthClient" WHERE "clientId" = ?').bind(registered.application.clientId).first()).toEqual(before);
});

it('rejects an administrator write after the actor loses the admin role', async () => {
    const client = harness(), adminCookie = await client.administrator(), identity = (await session(client, adminCookie))!;
    const registered = await (await client.request('/api/admin/applications', { cookie: adminCookie, body: settings })).json<Registered>();
    const response = await racingRequest(client, adminCookie, `/api/admin/applications/${registered.application.clientId}`, { name: 'Demoted edit' }, 'PATCH', async () => { await env.DB.prepare('UPDATE "user" SET "role" = ? WHERE "id" = ?').bind('user', identity.user.id).run(); });
    expect(response.status).toBe(403);
    expect(await env.DB.prepare('SELECT "name" FROM "oauthClient" WHERE "clientId" = ?').bind(registered.application.clientId).first('name')).toBe(settings.name);
});

it('lets an administrator suspension win a concurrent developer edit without losing the suspension flag', async () => {
    const client = harness(), adminCookie = await client.administrator(), owner = await developer(client), registered = await create(client, owner.cookie);
    const response = await racingRequest(client, owner.cookie, `${developerPath}/${registered.application.clientId}`, { name: 'Racing owner edit' }, 'PATCH', async () => {
        const suspended = await client.request(`/api/admin/applications/${registered.application.clientId}`, { cookie: adminCookie, body: { disabled: true }, method: 'PATCH' });
        expect(suspended.status, await suspended.clone().text()).toBe(200);
    });
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ code: 'APPLICATION_SUSPENDED' });
    expect(await env.DB.prepare('SELECT "name", "adminSuspended", "disabled" FROM "oauthClient" WHERE "clientId" = ?').bind(registered.application.clientId).first()).toEqual({ name: settings.name, adminSuspended: 1, disabled: 1 });
});
