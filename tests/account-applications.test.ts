import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/server/index';
import { harness, origin, session } from './helpers';
import { maintainDatabase } from '../src/server/maintenance';

const path = '/api/account/applications';
const callback = 'https://application.example.test/callback';
const scopes = ['openid', 'profile', 'email', 'offline_access'];
const verifier = 'an-isolated-application-pkce-verifier-at-least-43-characters';
type Client = ReturnType<typeof harness>;
interface AuthorizedApplication { clientId: string; name: string; scopes: string[]; authorizedAt: string; disabled: boolean }
interface Page { items: AuthorizedApplication[]; pageInfo: { nextCursor: string | null; previousCursor: string | null } }
interface Tokens { access_token: string; refresh_token: string }

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url === `${origin}/api/auth/jwks`) {
            const ctx = createExecutionContext();
            const response = await app.fetch(request, harness().bindings, ctx);
            await waitOnExecutionContext(ctx);
            return response;
        }
        if (request.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected external request');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

async function fixture() {
    const client = harness(), admin = await client.administrator();
    await client.verify();
    const cookie = await client.signin(), identity = (await session(client, cookie))!;
    const created = await client.request('/api/admin/applications', { cookie: admin, body: { name: 'Authorized application', type: 'spa', redirectUris: [callback], postLogoutRedirectUris: ['https://application.example.test/'], scopes } });
    expect(created.status, await created.clone().text()).toBe(201);
    const { application } = await created.json<{ application: { clientId: string } }>();
    return { client, admin, cookie, identity, clientId: application.clientId };
}
async function protocol(client: Client, route: string, cookie?: string, form?: Record<string, string>, token?: string) {
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request(new URL(route, origin), { method: form ? 'POST' : 'GET',
        headers: { Origin: 'https://application.example.test', 'CF-Connecting-IP': '192.0.2.30', ...(cookie ? { Cookie: cookie } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: form ? new URLSearchParams(form).toString() : undefined, redirect: 'manual' }), client.bindings, ctx);
    await waitOnExecutionContext(ctx);
    return response;
}
async function authorize(client: Client, clientId: string, cookie: string, approve = true) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code', scope: scopes.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state: 'State', nonce: 'Nonce' });
    const response = await protocol(client, `/api/auth/oauth2/authorize?${query}`, cookie);
    expect(response.status, await response.clone().text()).toBe(302);
    let location = new URL(response.headers.get('location')!, origin);
    const consent = location.pathname.endsWith('/consent');
    if (consent && approve) {
        const accepted = await client.request('/api/auth/oauth2/consent', { cookie, body: { accept: true, oauth_query: location.search.slice(1) } });
        expect(accepted.status, await accepted.clone().text()).toBe(200);
        location = new URL((await accepted.json<{ url: string }>()).url);
    }
    return { code: location.searchParams.get('code'), consent };
}
function exchange(client: Client, clientId: string, code: string) {
    return protocol(client, '/api/auth/oauth2/token', undefined, { grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback, code, code_verifier: verifier });
}
async function issue(client: Client, clientId: string, cookie: string) {
    const { code } = await authorize(client, clientId, cookie);
    const response = await exchange(client, clientId, code!);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json<Tokens>();
}
function consent(userId: string | null, clientId: string, id: string, values = ['openid'], date = new Date().toISOString()) {
    return env.DB.prepare('INSERT INTO "oauthConsent" ("id", "userId", "clientId", "scopes", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, userId, clientId, JSON.stringify(values), date, date).run();
}

/** Pause the native write after it has consumed a code or rotated refresh token. */
function pauseTokenInsert(database: D1Database) {
    let entered!: () => void, resume!: () => void, paused = false;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { resume = resolve; });
    function wrap(statement: D1PreparedStatement): D1PreparedStatement {
        return new Proxy(statement, { get(target, property) {
            if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
            const value = Reflect.get(target, property);
            if (typeof value === 'function' && ['all', 'run', 'first', 'raw'].includes(String(property))) return async (...args: unknown[]) => {
                if (!paused) { paused = true; entered(); await released; }
                return Reflect.apply(value, target, args);
            };
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    }
    const binding = new Proxy(database, { get(target, property) {
        if (property === 'prepare') return (sql: string) => {
            const statement = target.prepare(sql);
            return sql.toLowerCase().includes('insert into "oauthrefreshtoken"') ? wrap(statement) : statement;
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { binding, reached, resume };
}

it('lists effective consent once with unioned scopes, without secrets, created-only clients or foreign consent', async () => {
    const { client, admin, cookie, identity, clientId } = await fixture();
    expect((await (await client.request(path, { cookie })).json<Page>()).items).toEqual([]);
    const authorizedAt = '2026-01-02T03:04:05.678Z';
    await consent(identity.user.id, clientId, 'first', ['openid', 'email'], '2026-01-01T00:00:00.000Z');
    await consent(identity.user.id, clientId, 'second', ['openid', 'profile'], authorizedAt);
    await consent(null, clientId, 'no-user');
    await client.verify('other@example.test');
    const other = await client.signin('other@example.test'), otherIdentity = (await session(client, other))!;
    await consent(otherIdentity.user.id, clientId, 'foreign', ['offline_access']);
    const response = await client.request(path, { cookie }), page = await response.json<Page>();
    expect(response.status).toBe(200);
    expect(page.items).toEqual([{ clientId, name: 'Authorized application', scopes: ['email', 'openid', 'profile'], authorizedAt, disabled: false }]);
    expect(Object.keys(page.items[0]!).sort()).toEqual(['authorizedAt', 'clientId', 'disabled', 'name', 'scopes']);
    expect((await client.request(`/api/admin/applications/${clientId}`, { cookie: admin, method: 'PATCH', body: { disabled: true } })).status).toBe(200);
    expect((await (await client.request(path, { cookie })).json<Page>()).items[0]!.disabled).toBe(true);
    expect((await client.request(`${path}/${clientId}/revoke`, { cookie, body: {} })).status).toBe(200);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM "oauthConsent" WHERE "userId" = ?').bind(otherIdentity.user.id).first('n')).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM "oauthConsent" WHERE "userId" IS NULL').first('n')).toBe(1);
});

it('revokes only this user and app, blocks pending codes and refresh, and requires fresh consent before reauthorization', async () => {
    const { client, cookie, identity, clientId } = await fixture();
    const tokens = await issue(client, clientId, cookie), pending = await authorize(client, clientId, cookie);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM "oauthGrantPolicy" WHERE "userId" = ? AND "activatedAt" IS NULL').bind(identity.user.id).first('n')).toBe(1);
    const otherId = 'unrelated-client';
    await env.DB.prepare('INSERT INTO "oauthClient" ("id", "clientId", "redirectUris") VALUES (?, ?, ?)').bind(otherId, otherId, '["https://other.example.test/callback"]').run();
    await consent(identity.user.id, otherId, 'other-consent');
    const revoked = await client.request(`${path}/${clientId}/revoke`, { cookie, body: {} });
    expect(revoked.status, await revoked.clone().text()).toBe(200); expect(await revoked.json()).toEqual({ status: true });
    expect((await protocol(client, '/api/auth/oauth2/userinfo', undefined, undefined, tokens.access_token)).status).toBe(401);
    const refresh = await protocol(client, '/api/auth/oauth2/token', undefined, { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token });
    expect(refresh.status).toBe(400); expect((await refresh.json<{ error: string }>()).error).toBe('invalid_grant');
    expect((await exchange(client, clientId, pending.code!)).status).toBe(400);
    expect((await session(client, cookie))?.user.id).toBe(identity.user.id);
    expect((await (await client.request(path, { cookie })).json<Page>()).items.map((item) => item.clientId)).toEqual([otherId]);
    expect((await authorize(client, clientId, cookie, false)).consent).toBe(true);
    const renewed = await issue(client, clientId, cookie);
    expect((await protocol(client, '/api/auth/oauth2/userinfo', undefined, undefined, renewed.access_token)).status).toBe(200);
    expect((await exchange(client, clientId, pending.code!)).status).toBe(400);
});

it('retains revocation after a pending code was consumed, and rejects late code registration and token successors', async () => {
    const { client, cookie, identity, clientId } = await fixture();
    await authorize(client, clientId, cookie);
    const pending = await env.DB.prepare('SELECT * FROM "verification" WHERE CASE WHEN json_valid("value") THEN json_extract("value", \'$.type\') END = \'authorization_code\'').first<{ identifier: string; value: string }>();
    expect(pending).toBeTruthy();
    await env.DB.prepare('DELETE FROM "verification" WHERE "identifier" = ?').bind(pending!.identifier).run();
    expect((await client.request(`${path}/${clientId}/revoke`, { cookie, body: {} })).status).toBe(200);
    const date = new Date().toISOString(), expiry = new Date(Date.now() + 600_000).toISOString();
    await expect(env.DB.prepare('INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)')
        .bind('late-code', 'late-code', pending!.value, expiry, date, date).run()).rejects.toThrow('OAUTH_GRANT_UNAVAILABLE');
    for (const table of ['oauthAccessToken', 'oauthRefreshToken']) {
        await expect(env.DB.prepare(`INSERT INTO "${table}" ("id", "token", "clientId", "userId", "sessionId", "authorizationCodeId", "scopes", "createdAt", "expiresAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(`late:${table}`, `late:${table}`, clientId, identity.user.id, identity.session.id, pending!.identifier, '["openid"]', date, expiry).run()).rejects.toThrow('OAUTH_GRANT_UNAVAILABLE');
    }
    await authorize(client, clientId, cookie);
    expect(await env.DB.prepare('SELECT "revokedAt" FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = ?').bind(pending!.identifier).first('revokedAt')).toBeTruthy();
});

it.each(['authorization_code', 'refresh_token'] as const)('prevents an actual in-flight %s write from escaping revocation even after new consent', async (grantType) => {
    const { client, cookie, identity, clientId } = await fixture();
    const tokens = await issue(client, clientId, cookie);
    const pending = await authorize(client, clientId, cookie);
    const original = client.bindings.DB, paused = pauseTokenInsert(original);
    client.bindings.DB = paused.binding;
    const writing = grantType === 'authorization_code' ? exchange(client, clientId, pending.code!)
        : protocol(client, '/api/auth/oauth2/token', undefined, { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token });
    try {
        await Promise.race([paused.reached, writing.then(() => { throw new Error('Token request completed before the selected write boundary'); })]);
        expect((await client.request(`${path}/${clientId}/revoke`, { cookie, body: {} })).status).toBe(200);
        // Reconsenting can establish a new grant, never reactivate the paused one.
        expect((await authorize(client, clientId, cookie)).consent).toBe(true);
    } finally { paused.resume(); client.bindings.DB = original; }
    const response = await writing;
    expect(response.ok).toBe(false);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM "oauthAccessToken" WHERE "userId" = ? AND "clientId" = ? AND "revoked" IS NULL').bind(identity.user.id, clientId).first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM "oauthRefreshToken" WHERE "userId" = ? AND "clientId" = ? AND "revoked" IS NULL').bind(identity.user.id, clientId).first('n')).toBe(0);
    expect((await session(client, cookie))?.user.id).toBe(identity.user.id);
});

it('upgrades existing native consent, pending codes, issued offline grants and opaque verification values without a revocation gap', async () => {
    await reset();
    const migrationIndex = env.TEST_MIGRATIONS.findIndex((migration) => migration.name.startsWith('0017_'));
    const infrastructureMigrations = env.TEST_MIGRATIONS.slice(migrationIndex + 1);
    expect(migrationIndex).toBeGreaterThan(0);
    expect(infrastructureMigrations.length).toBeGreaterThan(0);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, migrationIndex));
    // The current HTTP harness needs the independent browser/access/audit tables;
    // the account-authorization data still predates migration 0017.
    await applyD1Migrations(env.DB, infrastructureMigrations);
    const { client, cookie, identity, clientId } = await fixture();
    const tokens = await issue(client, clientId, cookie);
    const pending = await authorize(client, clientId, cookie), later = await authorize(client, clientId, cookie);
    await consent(null, clientId, 'legacy-userless-consent');
    const now = new Date().toISOString(), expiry = new Date(Date.now() + 600_000).toISOString();
    await env.DB.prepare('INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)')
        .bind('opaque', 'opaque', 'opaque-value-that-is-not-json', expiry, now, now).run();
    await applyD1Migrations(env.DB, [env.TEST_MIGRATIONS[migrationIndex]]);
    const policies = await env.DB.prepare('SELECT "activatedAt", "gcAfter" FROM "oauthGrantPolicy" WHERE "userId" = ?').bind(identity.user.id).all<{ activatedAt: string | null; gcAfter: string }>();
    expect(policies.results.filter((policy) => policy.activatedAt === null)).toHaveLength(2);
    expect(policies.results.filter((policy) => policy.activatedAt !== null)).toHaveLength(1);
    expect(policies.results.every((policy) => Date.parse(policy.gcAfter) > Date.now())).toBe(true);
    expect((await (await client.request(path, { cookie })).json<Page>()).items).toHaveLength(1);
    expect(await env.DB.prepare('SELECT "value" FROM "verification" WHERE "id" = ?').bind('opaque').first('value')).toBe('opaque-value-that-is-not-json');
    expect((await exchange(client, clientId, pending.code!)).status).toBe(200);
    expect((await client.request(`${path}/${clientId}/revoke`, { cookie, body: {} })).status).toBe(200);
    expect((await exchange(client, clientId, later.code!)).status).toBe(400);
    expect((await protocol(client, '/api/auth/oauth2/token', undefined, { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token })).status).toBe(400);
    expect((await session(client, cookie))?.user.id).toBe(identity.user.id);
});

it('keeps first code activation tied to its session and retains pending policy until the code expires', async () => {
    const { client, cookie, identity, clientId } = await fixture();
    await authorize(client, clientId, cookie);
    const pending = await env.DB.prepare('SELECT "authorizationCodeId", "gcAfter" FROM "oauthGrantPolicy" WHERE "activatedAt" IS NULL').first<{ authorizationCodeId: string; gcAfter: string }>();
    expect(Date.parse(pending!.gcAfter)).toBeGreaterThan(Date.now());
    await maintainDatabase(client.bindings);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = ?').bind(pending!.authorizationCodeId).first('n')).toBe(1);
    expect((await client.request('/api/auth/sign-out', { cookie, body: {} })).status).toBe(200);
    await expect(env.DB.prepare('INSERT INTO "oauthAccessToken" ("id", "token", "clientId", "userId", "authorizationCodeId", "scopes", "createdAt", "expiresAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind('after-logout', 'after-logout', clientId, identity.user.id, pending!.authorizationCodeId, '["openid"]', new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()).run()).rejects.toThrow('OAUTH_GRANT_UNAVAILABLE');
});

it('uses user-bound signed pagination and an indexed bounded consent projection', async () => {
    const { client, cookie, identity, clientId } = await fixture();
    const date = '2026-01-01T00:00:00.000Z';
    for (let index = 0; index < 6; index++) {
        const id = `page-${index}`;
        await env.DB.prepare('INSERT INTO "oauthClient" ("id", "clientId", "name", "redirectUris") VALUES (?, ?, ?, ?)').bind(id, id, id, '["https://page.example.test/callback"]').run();
        await consent(identity.user.id, id, id, ['openid'], date);
    }
    const first = await (await client.request(`${path}?limit=2`, { cookie })).json<Page>();
    expect(first.items).toHaveLength(2); expect(first.pageInfo.nextCursor).toBeTruthy();
    const next = await (await client.request(`${path}?limit=2&cursor=${first.pageInfo.nextCursor}`, { cookie })).json<Page>();
    expect(next.items).toHaveLength(2); expect(next.items.map((item) => item.clientId)).not.toEqual(first.items.map((item) => item.clientId));
    const previous = await (await client.request(`${path}?limit=2&cursor=${next.pageInfo.previousCursor}`, { cookie })).json<Page>();
    expect(previous.items).toEqual(first.items);
    await client.verify('another@example.test');
    const other = await client.signin('another@example.test');
    expect((await client.request(`${path}?cursor=${first.pageInfo.nextCursor}`, { cookie: other })).status).toBe(400);
    expect((await client.request(`/api/developer/applications?cursor=${first.pageInfo.nextCursor}`, { cookie })).status).toBe(400);
    expect((await client.request(`${path}?limit=101`, { cookie })).status).toBe(400);
    const plan = await env.DB.prepare('EXPLAIN QUERY PLAN SELECT "clientId", "scopes", "createdAt" FROM "oauthAccountApplication" WHERE "userId" = ? AND ("createdAt", "clientId") < (?, ?) ORDER BY "createdAt" DESC, "clientId" DESC LIMIT 3').bind(identity.user.id, date, clientId).all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes('oauthAccountApplication_user_page_idx'))).toBe(true);
    expect(plan.results.some((row) => row.detail.includes('TEMP B-TREE') || row.detail.startsWith('SCAN '))).toBe(false);
});

it('requires active verified same-origin JSON requests and makes unknown or foreign revokes idempotent', async () => {
    const { client, cookie, identity, clientId } = await fixture();
    expect((await client.request(path)).status).toBe(401);
    expect((await client.request(`${path}/${clientId}/revoke`, { cookie, body: {}, headers: { Origin: 'https://foreign.example.test' } })).status).toBe(403);
    expect((await client.request(`${path}/${clientId}/revoke`, { cookie, body: { userId: 'other-user' } })).status).toBe(400);
    expect((await client.request(`${path}/${clientId}/revoke`, { cookie, method: 'POST' })).status).toBe(400);
    expect(await (await client.request(`${path}/unknown/revoke`, { cookie, body: {} })).json()).toEqual({ status: true });
    await env.DB.prepare('UPDATE "user" SET "emailVerified" = 0 WHERE "id" = ?').bind(identity.user.id).run();
    expect((await client.request(path, { cookie })).status).toBe(403);
    await env.DB.prepare('UPDATE "user" SET "emailVerified" = 1 WHERE "id" = ?').bind(identity.user.id).run();
    await env.DB.prepare('UPDATE "session" SET "oauthRevokedAt" = ? WHERE "id" = ?').bind(new Date().toISOString(), identity.session.id).run();
    expect((await client.request(`${path}/${clientId}/revoke`, { cookie, body: {} })).status).toBe(403);
});
