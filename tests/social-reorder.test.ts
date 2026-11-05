import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/server/index';
import { defaultConnectionConfig, type SocialConnection } from '../src/shared/social';
import { harness, origin } from './helpers';
import { interceptSql } from './sql-race';

const settings = { name: 'Sortable provider', type: 'google', config: { ...defaultConnectionConfig('google'), clientId: 'reorder-client' }, clientSecret: 'test-only-reorder-secret', enabled: false, archived: false, revision: 0 };
beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Request(input, init).url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected network');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
async function admin() { const client = harness(); return { client, cookie: await client.administrator() }; }
async function create(client: ReturnType<typeof harness>, cookie: string, name = settings.name) {
    const response = await client.request('/api/admin/social-connections', { cookie, body: { ...settings, name } });
    expect(response.status, await response.clone().text()).toBe(201);
    return response.json<SocialConnection>();
}
async function list(client: ReturnType<typeof harness>, cookie: string) {
    const response = await client.request('/api/admin/social-connections', { cookie });
    expect(response.status).toBe(200);
    return (await response.json<{ connections: SocialConnection[] }>()).connections;
}
async function reorder(client: ReturnType<typeof harness>, cookie: string, order: string[], previousOrder: string[]) {
    return client.request('/api/admin/social-connections/reorder', { cookie, body: { order, previousOrder } });
}

it('restricts reordering to a verified active administrator and the exact Origin', async () => {
    const { client, cookie } = await admin(), row = await create(client, cookie);
    const body = { order: [row.id], previousOrder: [row.id] };
    expect((await client.request('/api/admin/social-connections/reorder', { body })).status).toBe(401);
    await client.verify('ordinary@example.test');
    const user = await client.signin('ordinary@example.test');
    expect((await client.request('/api/admin/social-connections/reorder', { cookie: user, body })).status).toBe(403);
    expect((await client.request('/api/admin/social-connections/reorder', { cookie, body, headers: { Origin: 'https://elsewhere.test' } })).status).toBe(403);
    expect((await reorder(client, cookie, body.order, body.previousOrder)).status).toBe(200);
});

it('appends new connections and saves edits without overwriting a subsequently changed order', async () => {
    const { client, cookie } = await admin();
    const first = await create(client, cookie, 'First'), second = await create(client, cookie, 'Second');
    expect([first.position, second.position]).toEqual([0, 1]);
    const response = await reorder(client, cookie, [second.id, first.id], [first.id, second.id]);
    expect(response.status, await response.clone().text()).toBe(200);
    const edited = await client.request(`/api/admin/social-connections/${first.id}`, { cookie, method: 'PATCH', body: { ...settings, name: 'First edited', revision: first.revision } });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(await edited.json<SocialConnection>()).toMatchObject({ name: 'First edited', position: 1 });
    const third = await create(client, cookie, 'Third');
    expect(third.position).toBe(2);
    expect((await list(client, cookie)).map((row) => row.id)).toEqual([second.id, first.id, third.id]);
    for (const method of ['POST', 'PATCH']) {
        const path = `/api/admin/social-connections${method === 'PATCH' ? `/${third.id}` : ''}`;
        expect((await client.request(path, { cookie, method, body: { ...settings, position: 0 } })).status).toBe(400);
    }
});

it('persists a complete order including disabled and archived connections without invalidating authentication flows', async () => {
    const { client, cookie } = await admin();
    const rows = await Promise.all(['First', 'Second', 'Disabled', 'Archived'].map((name) => create(client, cookie, name)));
    await env.DB.prepare('UPDATE "socialConnection" SET "enabled" = 1 WHERE "id" IN (?, ?)').bind(rows[0]!.id, rows[1]!.id).run();
    await env.DB.prepare('UPDATE "socialConnection" SET "archived" = 1 WHERE "id" = ?').bind(rows[3]!.id).run();
    const started = await client.request('/api/auth/social/start', { body: { connectionId: rows[0]!.id, locale: 'en-US' } });
    expect(started.status, await started.clone().text()).toBe(200);
    const oldFlow = await env.DB.prepare('SELECT * FROM "socialFlow" WHERE "connectionId" = ?').bind(rows[0]!.id).first();
    expect(oldFlow).not.toBeNull();
    const oldRows = await env.DB.prepare('SELECT "id", "revision", "updatedAt" FROM "socialConnection" ORDER BY "id"').all();
    const previousOrder = (await list(client, cookie)).map((row) => row.id), order = [...previousOrder].reverse();
    const response = await reorder(client, cookie, order, previousOrder);
    expect(response.status, await response.clone().text()).toBe(200);
    const sorted = (await response.json<{ connections: SocialConnection[] }>()).connections;
    expect(sorted.map((row) => row.id)).toEqual(order);
    expect(sorted.map((row) => row.position)).toEqual([0, 1, 2, 3]);
    expect((await env.DB.prepare('SELECT "id", "revision", "updatedAt" FROM "socialConnection" ORDER BY "id"').all()).results).toEqual(oldRows.results);
    expect(await env.DB.prepare('SELECT * FROM "socialFlow" WHERE "connectionId" = ?').bind(rows[0]!.id).first()).toEqual(oldFlow);
    const publicResponse = await client.request('/api/social/providers');
    const providers = (await publicResponse.json<{ providers: { id: string }[] }>()).providers;
    expect(providers.map((row) => row.id)).toEqual(order.filter((id) => rows.slice(0, 2).some((row) => row.id === id)));
    expect((await list(client, cookie)).map((row) => row.id)).toEqual(order);
});

it('rejects malformed, partial and stale snapshots without changing any position', async () => {
    const { client, cookie } = await admin();
    await create(client, cookie, 'First'); await create(client, cookie, 'Second');
    const before = await list(client, cookie), previousOrder = before.map((row) => row.id);
    const malformed = [
        { order: [], previousOrder: [] },
        { order: [previousOrder[0], previousOrder[0]], previousOrder },
        { order: previousOrder, previousOrder: [previousOrder[0], previousOrder[0]] },
        { order: [crypto.randomUUID(), previousOrder[1]], previousOrder },
        { order: previousOrder, previousOrder, extra: true },
    ];
    for (const body of malformed) expect((await client.request('/api/admin/social-connections/reorder', { cookie, body })).status).toBe(400);
    const partial = [previousOrder[0]!];
    expect((await reorder(client, cookie, partial, partial)).status).toBe(409);
    expect((await reorder(client, cookie, previousOrder, [...previousOrder].reverse())).status).toBe(409);
    expect(await list(client, cookie)).toEqual(before);
    await create(client, cookie, 'Added elsewhere');
    expect((await reorder(client, cookie, [...previousOrder].reverse(), previousOrder)).status).toBe(409);
    expect((await list(client, cookie)).slice(0, 2)).toEqual(before);
});

it('commits only one of two concurrent reorder attempts from the same snapshot', async () => {
    const { client, cookie } = await admin();
    for (const name of ['First', 'Second', 'Third']) await create(client, cookie, name);
    const previousOrder = (await list(client, cookie)).map((row) => row.id);
    const orders = [[...previousOrder].reverse(), [previousOrder[1]!, previousOrder[2]!, previousOrder[0]!]];
    const responses = await Promise.all(orders.map((order) => reorder(client, cookie, order, previousOrder)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = responses.findIndex((response) => response.status === 200);
    const rows = await list(client, cookie);
    expect(rows.map((row) => row.id)).toEqual(orders[winner]);
    expect(rows.map((row) => row.position)).toEqual([0, 1, 2]);
});

it('rechecks the administrator session atomically before writing the order', async () => {
    const { client, cookie } = await admin();
    await create(client, cookie, 'First'); await create(client, cookie, 'Second');
    const before = await list(client, cookie), previousOrder = before.map((row) => row.id);
    let revoked = false;
    const injection = interceptSql(env.DB, /^WITH currentOrder/, async () => {
        await env.DB.prepare('DELETE FROM "session"').run(); revoked = true;
    });
    const database = injection.proxy;
    const context = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}/api/admin/social-connections/reorder`, {
        method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: [...previousOrder].reverse(), previousOrder }),
    }), { ...client.bindings, DB: database }, context);
    await waitOnExecutionContext(context);
    expect(revoked).toBe(true); expect(response.status).toBe(401);
    expect(injection.invoked()).toBe(true);
    expect(await env.DB.prepare('SELECT "id", "position" FROM "socialConnection" ORDER BY "position", "id"').all().then((result) => result.results))
        .toEqual(before.map(({ id, position }) => ({ id, position })));
});
