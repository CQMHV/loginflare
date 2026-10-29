import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harness, session } from './helpers';

interface Page<T> { items: T[]; pageInfo: { nextCursor: string | null; previousCursor: string | null }; hasOtherSessions?: boolean }
interface ListedUser { id: string; username: string; email: string; createdAt: string }
const date = '2025-01-01T00:00:00.000Z';
beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected external request');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

async function users(count: number) {
    await env.DB.batch(Array.from({ length: count }, (_, index) => {
        const number = String(index).padStart(3, '0');
        return env.DB.prepare('INSERT INTO "user" ("id", "name", "username", "email", "emailVerified", "createdAt", "updatedAt", "role") VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
            .bind(`fixture-user-${number}`, `Fixture ${number}`, `fixture_${number}`, `fixture-${number}@example.test`, date, date, 'user');
    }));
}
async function page<T>(client: ReturnType<typeof harness>, path: string, cookie: string): Promise<Page<T>> {
    const response = await client.request(path, { cookie });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json<Page<T>>();
    expect(result).not.toHaveProperty('total');
    return result;
}

describe('bounded account and application reads', () => {
    it('seeks all users beyond the native 100-row default with stable ties and reverse navigation', async () => {
        const client = harness();
        const admin = await client.administrator();
        await users(105);
        const first = await page<ListedUser>(client, '/api/admin/users', admin);
        expect(first.items).toHaveLength(20);
        expect(first.pageInfo.previousCursor).toBeNull();
        const second = await page<ListedUser>(client, `/api/admin/users?cursor=${first.pageInfo.nextCursor}`, admin);
        const previous = await page<ListedUser>(client, `/api/admin/users?cursor=${second.pageInfo.previousCursor}`, admin);
        expect(previous.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
        expect(previous.pageInfo.previousCursor).toBeNull();
        let result = first;
        const ids: string[] = [];
        for (let index = 0; index < 10; index++) {
            ids.push(...result.items.map((item) => item.id));
            if (!result.pageInfo.nextCursor) break;
            result = await page<ListedUser>(client, `/api/admin/users?cursor=${result.pageInfo.nextCursor}`, admin);
        }
        expect(ids).toHaveLength(106);
        expect(new Set(ids).size).toBe(106);
        expect(ids.slice(1)).toEqual([...ids.slice(1)].sort().reverse());
        for (const [field, value] of [['id', 'fixture-user-001'], ['username', 'FIXTURE_001'], ['email', 'FIXTURE-001@EXAMPLE.TEST']]) {
            const exact = await page<ListedUser>(client, `/api/admin/users?${new URLSearchParams({ lookupField: field!, lookupValue: value! })}`, admin);
            expect(exact.items.map((item) => item.id)).toEqual(['fixture-user-001']);
            expect(exact.pageInfo.nextCursor).toBeNull();
        }
    });

    it('rejects unbounded inputs, altered cursors, and cross-filter or cross-entity reuse', async () => {
        const client = harness();
        const admin = await client.administrator();
        await users(22);
        const first = await page<ListedUser>(client, '/api/admin/users', admin);
        for (const query of ['limit=101', 'limit=0', 'limit=1&limit=2', 'offset=20', 'lookupField=email', 'lookupValue=a', 'lookupField=name&lookupValue=a', 'sortBy=name']) {
            expect((await client.request(`/api/admin/users?${query}`, { cookie: admin })).status).toBe(400);
        }
        const cursor = first.pageInfo.nextCursor!;
        const changed = `${cursor[0] === 'A' ? 'B' : 'A'}${cursor.slice(1)}`;
        expect((await client.request(`/api/admin/users?cursor=${changed}`, { cookie: admin })).status).toBe(400);
        expect((await client.request(`/api/admin/users?${new URLSearchParams({ cursor, lookupField: 'email', lookupValue: 'fixture-001@example.test' })}`, { cookie: admin })).status).toBe(400);
        expect((await client.request(`/api/admin/applications?cursor=${cursor}`, { cookie: admin })).status).toBe(400);
        expect((await client.request('/api/admin/users')).status).toBe(401);
        await client.verify('ordinary@example.test');
        const ordinary = await client.signin('ordinary@example.test');
        expect((await client.request('/api/admin/users', { cookie: ordinary })).status).toBe(403);
    });

    it('paginates only the owner active sessions and binds cursor ownership', async () => {
        const client = harness();
        await client.verify();
        const cookie = await client.signin();
        const identity = (await session(client, cookie))!;
        await users(1);
        await env.DB.batch(Array.from({ length: 108 }, (_, index) => env.DB.prepare('INSERT INTO "session" ("id", "token", "userId", "createdAt", "updatedAt", "expiresAt") VALUES (?, ?, ?, ?, ?, ?)')
            .bind(`fixture-session-${String(index).padStart(3, '0')}`, `fixture-token-${index}`, index === 107 ? 'fixture-user-000' : identity.user.id, date, date, index >= 105 ? date : '2099-01-01T00:00:00.000Z')));
        const first = await page<{ id: string; token: string; userId: string }>(client, '/api/account/sessions?limit=1', cookie);
        expect(first.items).toHaveLength(1);
        expect(first.items[0]!.id).toBe(identity.session.id);
        expect(first.hasOtherSessions).toBe(true);
        let current = await page<{ id: string; token: string; userId: string }>(client, '/api/account/sessions?limit=100', cookie);
        const all = [...current.items];
        current = await page(client, `/api/account/sessions?limit=100&cursor=${current.pageInfo.nextCursor}`, cookie);
        all.push(...current.items);
        expect(all).toHaveLength(106);
        expect(all.every((item) => item.userId === identity.user.id && !!item.token)).toBe(true);
        expect(all.some((item) => item.id === 'fixture-session-105')).toBe(false);
        await client.verify('another@example.test');
        const another = await client.signin('another@example.test');
        expect((await client.request(`/api/account/sessions?cursor=${first.pageInfo.nextCursor}`, { cookie: another })).status).toBe(400);
        expect((await client.request('/api/account/sessions?lookupField=id&lookupValue=x', { cookie })).status).toBe(400);
    });

    it('returns bounded application summaries and exact indexed lookup without secrets', async () => {
        const client = harness();
        const admin = await client.administrator();
        await env.DB.batch(Array.from({ length: 105 }, (_, index) => env.DB.prepare('INSERT INTO "oauthClient" ("id", "clientId", "name", "referenceId", "clientSecret", "tokenEndpointAuthMethod", "redirectUris", "postLogoutRedirectUris", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(`fixture-app-${index}`, `client-${String(index).padStart(3, '0')}`, 'Repeated application', 'loginflare', 'must-not-leak', index % 2 ? 'none' : 'client_secret_basic', '[]', '[]', date, date)));
        const first = await page<{ clientId: string; name: string; createdAt: string }>(client, '/api/admin/applications?limit=100', admin);
        expect(first.items).toHaveLength(100);
        expect(first.items[0]!.clientId).toBe('client-104');
        expect(JSON.stringify(first)).not.toContain('must-not-leak');
        expect(first.items[0]).not.toHaveProperty('redirectUris');
        const last = await page(client, `/api/admin/applications?limit=100&cursor=${first.pageInfo.nextCursor}`, admin);
        expect(last.items).toHaveLength(5);
        const exact = await page(client, '/api/admin/applications?lookupField=clientId&lookupValue=client-001', admin);
        expect(exact.items).toHaveLength(1);
        const named = await page(client, '/api/admin/applications?lookupField=name&lookupValue=Repeated%20application', admin);
        expect(named.items).toHaveLength(20);
        expect(named.pageInfo.nextCursor).toBeTruthy();
    });

    it('synchronizes standard-parsed origins with native writes and keeps exact callback strings', async () => {
        const client = harness();
        const admin = await client.administrator();
        const redirect = 'https://EXAMPLE.test:443/callback?next=%2Fhome';
        const created = await client.request('/api/admin/applications', { cookie: admin, body: {
            name: 'Origin registry', type: 'spa', redirectUris: [redirect, 'https://example.test/another'], postLogoutRedirectUris: ['https://example.test/signed-out?exact=1'], scopes: ['openid'],
        } });
        expect(created.status, await created.clone().text()).toBe(201);
        const { application } = await created.json<{ application: { clientId: string; redirectUris: string[] } }>();
        expect(application.redirectUris[0]).toBe(redirect);
        const clientId = application.clientId;
        const metadata = JSON.parse((await env.DB.prepare('SELECT "metadata" FROM "oauthClient" WHERE "clientId" = ?').bind(clientId).first<string>('metadata'))!);
        expect(metadata.loginflareRedirectOrigins).toEqual(['https://example.test']);
        metadata.unrelated = { retained: true };
        await env.DB.prepare('UPDATE "oauthClient" SET "metadata" = ? WHERE "clientId" = ?').bind(JSON.stringify(metadata), clientId).run();
        const preflight = () => client.request('/api/auth/oauth2/token', { method: 'OPTIONS', headers: { Origin: 'https://example.test', 'Access-Control-Request-Method': 'POST' } });
        expect((await preflight()).status).toBe(204);
        const updated = await client.request(`/api/admin/applications/${clientId}`, { cookie: admin, method: 'PATCH', body: { redirectUris: ['https://new.example.test/callback'], postLogoutRedirectUris: ['https://new.example.test/signed-out'] } });
        expect(updated.status, await updated.clone().text()).toBe(200);
        expect((await preflight()).status).toBe(403);
        const stored = JSON.parse((await env.DB.prepare('SELECT "metadata" FROM "oauthClient" WHERE "clientId" = ?').bind(clientId).first<string>('metadata'))!);
        expect(stored).toEqual({ unrelated: { retained: true }, loginflareRedirectOrigins: ['https://new.example.test'] });
        const registry = await env.DB.prepare('SELECT "kind", "value" FROM "oauthClientUri" WHERE "clientId" = ? ORDER BY "kind"').bind(clientId).all();
        expect(registry.results).toEqual([{ kind: 'post-logout-uri', value: 'https://new.example.test/signed-out' }, { kind: 'redirect-origin', value: 'https://new.example.test' }]);
        await env.DB.prepare('DELETE FROM "oauthClient" WHERE "clientId" = ?').bind(clientId).run();
        expect(await env.DB.prepare('SELECT 1 FROM "oauthClientUri" WHERE "clientId" = ?').bind(clientId).first()).toBeNull();
    });

    it('uses the seek and URI indexes without sorting a user table', async () => {
        const plans = await env.DB.prepare('EXPLAIN QUERY PLAN SELECT "id", "createdAt" FROM "user" WHERE ("createdAt", "id") < (?, ?) ORDER BY "createdAt" DESC, "id" DESC LIMIT 21').bind(date, 'z').all<{ detail: string }>();
        expect(plans.results.some((row) => row.detail.includes('user_createdAt_id_idx'))).toBe(true);
        expect(plans.results.some((row) => row.detail.includes('TEMP B-TREE'))).toBe(false);
        const uri = await env.DB.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM "oauthClientUri" WHERE "kind" = ? AND "value" = ? LIMIT 1').bind('redirect-origin', 'https://example.test').all<{ detail: string }>();
        expect(uri.results.some((row) => row.detail.includes('SEARCH'))).toBe(true);
    });

    it('preserves session freshness and persistent list limits with Retry-After', async () => {
        const client = harness();
        const admin = await client.administrator();
        const identity = (await session(client, admin))!;
        await env.DB.prepare('UPDATE "session" SET "createdAt" = ? WHERE "id" = ?').bind(date, identity.session.id).run();
        const stale = await client.request('/api/account/sessions', { cookie: admin });
        expect(stale.status).toBe(403);
        expect(await stale.json()).toEqual({ code: 'SESSION_NOT_FRESH' });
        const now = Date.now();
        await env.DB.prepare('INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest", "expiresAt") VALUES (?, ?, ?, ?, ?)')
            .bind('management-rate-fixture', 'loginflare:list:/api/admin/users:192.0.2.10', 100, now, now + 60_000).run();
        const limited = await client.request('/api/admin/users', { cookie: admin, headers: { 'X-Forwarded-For': '203.0.113.99' } });
        expect(limited.status).toBe(429);
        expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    });

    it('backfills the URI registry from prepared native metadata and exact logout URLs', async () => {
        await reset();
        const index = env.TEST_MIGRATIONS.findIndex((migration) => migration.name.startsWith('0006'));
        expect(index).toBeGreaterThan(0);
        await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, index));
        await env.DB.prepare('INSERT INTO "oauthClient" ("id", "clientId", "referenceId", "redirectUris", "postLogoutRedirectUris", "metadata", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind('existing-client', 'existing-client', 'loginflare', '["https://EXAMPLE.test:443/callback"]', '["https://example.test/logout?exact=1"]', '{"loginflareRedirectOrigins":["https://example.test"],"unrelated":"retained"}', date, date).run();
        await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(index));
        const registry = await env.DB.prepare('SELECT "kind", "value" FROM "oauthClientUri" WHERE "clientId" = ? ORDER BY "kind"').bind('existing-client').all();
        expect(registry.results).toEqual([{ kind: 'post-logout-uri', value: 'https://example.test/logout?exact=1' }, { kind: 'redirect-origin', value: 'https://example.test' }]);
        expect(await env.DB.prepare('SELECT "redirectUris" FROM "oauthClient" WHERE "clientId" = ?').bind('existing-client').first('redirectUris')).toBe('["https://EXAMPLE.test:443/callback"]');
    });
});
