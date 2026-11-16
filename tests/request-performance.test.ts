import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/server/index';
import { requestSource } from '../src/server/request-budget';
import { harness, origin } from './helpers';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); vi.stubGlobal('fetch', async () => Response.json({ success: true })); });
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

function observe(database: D1Database) {
    const queries: string[] = [];
    return { queries, database: new Proxy(database, { get(target, key) {
        if (key === 'prepare') return (sql: string) => { queries.push(sql); return target.prepare(sql); };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } }) };
}

it('rejects a coarse-limit hit before installation, session, or application SQL', async () => {
    const client = harness(), meter = observe(env.DB), limit = vi.fn(async () => ({ success: false }));
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request(origin + '/api/readiness'), { ...client.bindings, DB: meter.database, REQUEST_LIMITER: { limit } }, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('60'); expect(meter.queries).toHaveLength(0);
    const health = await app.fetch(new Request(origin + '/api/health'), { ...client.bindings, DB: meter.database, REQUEST_LIMITER: { limit } }, ctx);
    expect(health.status).toBe(200); expect(limit).toHaveBeenCalledTimes(1);
    for (const path of ['/api/health', '/assets/logo.svg', '/favicon.svg']) {
        const response = await app.fetch(new Request(origin + path, { method: 'POST' }), { ...client.bindings, APP_ENV: 'staging', DB: meter.database, REQUEST_LIMITER: { limit } }, ctx);
        expect(response.status).toBe(429);
    }
    expect(meter.queries).toHaveLength(0);
});

it('fails closed if the coarse limiter is unavailable', async () => {
    const client = harness(), meter = observe(env.DB), ctx = createExecutionContext();
    const response = await app.fetch(new Request(origin + '/api/config'), { ...client.bindings, DB: meter.database, REQUEST_LIMITER: { async limit() { throw new Error('Unavailable'); } } }, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503); expect(meter.queries).toHaveLength(0);
});

it('groups IPv6 aliases and rotating suffixes without merging independent networks or IPv4 sources', () => {
    expect(requestSource('2001:DB8::1')).toBe(requestSource('2001:0db8:0000:0000::abcd'));
    expect(requestSource('2001:db8:1::1')).not.toBe(requestSource('2001:db8:2::1'));
    expect(requestSource('::ffff:192.0.2.1')).toBe(requestSource('192.0.2.1'));
    expect(requestSource('192.0.2.1')).not.toBe(requestSource('192.0.2.2'));
});

it('reads a session once per request and continues to observe immediate suspension and revocation', async () => {
    const client = harness(); await client.verify(); const cookie = await client.signin();
    const meter = observe(env.DB); client.bindings.DB = meter.database;
    const current = await client.request('/api/auth/get-session', { cookie });
    expect(current.status).toBe(200); expect(await current.json()).toHaveProperty('user.email', 'person@example.test');
    expect(meter.queries.filter((sql) => /from\s+"?session"?\s/i.test(sql))).toHaveLength(1);
    await env.DB.prepare('UPDATE user SET banned = 1').run();
    const banned = await client.request('/api/auth/get-session', { cookie });
    expect(banned.status).toBe(403); expect(await banned.json()).toEqual({ code: 'USER_BANNED' });
    await env.DB.prepare('UPDATE user SET banned = 0').run();
    await env.DB.prepare('DELETE FROM session').run();
    expect(await (await client.request('/api/auth/get-session', { cookie })).json()).toBeNull();
});

it('reuses the account registry snapshot and avoids delivery scans for login-flow bookkeeping', async () => {
    const client = harness(); await client.verify(); const cookie = await client.signin();
    const meter = observe(env.DB); client.bindings.DB = meter.database;
    const accounts = await client.request('/api/browser/accounts', { cookie });
    expect(accounts.status).toBe(200);
    expect(meter.queries.filter((sql) => /FROM "browserAccount" a/.test(sql))).toHaveLength(1);
    meter.queries.length = 0;
    expect((await client.request('/api/browser/auth-flows', { cookie, body: { kind: 'login', locale: 'en-US' } })).status).toBe(200);
    expect(meter.queries.filter((sql) => /webhookDelivery|maintenanceCursor/.test(sql))).toHaveLength(0);
    meter.queries.length = 0;
    expect((await client.request('/api/auth/update-user', { cookie, body: { name: 'Updated fixture' } })).status).toBe(200);
    expect(meter.queries.some((sql) => /webhookDelivery/.test(sql))).toBe(true);
});
