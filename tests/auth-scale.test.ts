import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAuth } from '../src/server/auth';
import { databaseRateLimit } from '../src/server/rate-limit';
import { consumeEmailQuota } from '../src/server/email-operations';
import { harness } from './helpers';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

it('admits exactly the persistent limit under concurrency and does not extend denied windows', async () => {
    const limiter = databaseRateLimit(env.DB);
    const key = 'parallel-authentication';
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const outcomes = await Promise.all(Array.from({ length: 30 }, () => limiter.consume(key, { max: 5, window: 60 })));
    expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(5);
    expect(outcomes.filter((outcome) => !outcome.allowed)).toHaveLength(25);
    const before = await env.DB.prepare('SELECT "count", "lastRequest", "expiresAt" FROM "rateLimit" WHERE "key" = ?').bind(key).first();
    vi.spyOn(Date, 'now').mockReturnValue(now + 59_000);
    expect(await limiter.consume(key, { max: 5, window: 60 })).toEqual({ allowed: false, retryAfter: 1 });
    expect(await env.DB.prepare('SELECT "count", "lastRequest", "expiresAt" FROM "rateLimit" WHERE "key" = ?').bind(key).first()).toEqual(before);
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    expect(await limiter.consume(key, { max: 5, window: 60 })).toEqual({ allowed: true, retryAfter: null });
    expect(await env.DB.prepare('SELECT "count", "lastRequest", "expiresAt" FROM "rateLimit" WHERE "key" = ?').bind(key).first())
        .toEqual({ count: 1, lastRequest: now + 60_000, expiresAt: now + 120_000 });
});

it('keeps the account mail quota on a fixed window with explicit cleanup expiry', async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect((await consumeEmailQuota(env.DB, 'manage:account'))?.count).toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(now + 59_000);
    for (const count of [2, 3, 4]) expect((await consumeEmailQuota(env.DB, 'manage:account'))?.count).toBe(count);
    expect(await env.DB.prepare('SELECT "lastRequest", "expiresAt" FROM "rateLimit" WHERE "key" = ?').bind('emails:manage:account').first())
        .toEqual({ lastRequest: now, expiresAt: now + 60_000 });
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    expect((await consumeEmailQuota(env.DB, 'manage:account'))?.count).toBe(1);
});

it('fails closed on persistent limiter errors', async () => {
    const client = harness();
    client.bindings.DB = new Proxy(env.DB, { get(target, property) {
        if (property === 'prepare') return (sql: string) => {
            if (sql.includes('INSERT INTO "rateLimit"')) throw new Error('Unavailable rate-limit storage');
            return target.prepare(sql);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    const response = await client.request('/api/auth/get-session');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('Unavailable rate-limit storage');
});

it('skips runtime schema introspection while retaining an explicit schema gate', async () => {
    const statements: string[] = [];
    const client = harness();
    client.bindings.DB = new Proxy(env.DB, { get(target, property) {
        if (property === 'prepare') return (sql: string) => { statements.push(sql); return target.prepare(sql); };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    const auth = createAuth(client.bindings);
    expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
    expect(statements.some((sql) => /sqlite_(schema|master)|pragma_table_info|PRAGMA /i.test(sql))).toBe(false);
    const context = await auth.$context;
    expect(context.checkSchema).toBeUndefined();
    expect(context.explicitSchemaCheck).toBeTypeOf('function');
    await context.explicitSchemaCheck!();
    expect(statements.some((sql) => /sqlite_(schema|master)|pragma_table_info|PRAGMA /i.test(sql))).toBe(true);
});

it.each(['table', 'column'] as const)('rejects an explicit schema gate with a missing %s', async (missing) => {
    if (missing === 'table') await env.DB.prepare('DROP TABLE "session"').run();
    else await env.DB.prepare('ALTER TABLE "user" DROP COLUMN "locale"').run();
    const context = await createAuth(harness().bindings).$context;
    await expect(context.explicitSchemaCheck!()).rejects.toThrow();
});
