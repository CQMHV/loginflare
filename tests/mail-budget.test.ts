import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reserveMail } from '../src/server/mail-budget';
import { sendEmailCode } from '../src/server/mail';
import { harness, mailCode, password } from './helpers';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

it('shares recipient windows across casing and concurrent sources without charging rejected reservations', async () => {
    const now = Date.now();
    const results = await Promise.all(Array.from({ length: 9 }, (_, i) => reserveMail(env.DB, i % 2 ? 'Shared@Example.test' : ' shared@example.test ', now)));
    expect(results.filter((item) => item.allowed)).toHaveLength(3);
    const rows = await env.DB.prepare('SELECT count FROM rateLimit WHERE key LIKE \'mail:%\'').all<{ count: number }>();
    expect(rows.results).toHaveLength(4);
    expect(rows.results.every((row) => row.count === 3)).toBe(true);
    expect(await reserveMail(env.DB, 'shared@example.test', now + 60_000)).toEqual({ allowed: true, retryAfter: 0 });
});

it('enforces a recipient day budget after minute windows have expired', async () => {
    const now = Date.now();
    for (let i = 0; i < 20; i++) expect((await reserveMail(env.DB, 'day@example.test', now + i * 60_001)).allowed).toBe(true);
    const denied = await reserveMail(env.DB, 'day@example.test', now + 20 * 60_001);
    expect(denied.allowed).toBe(false); expect(denied.retryAfter).toBeGreaterThan(80_000);
    expect((await reserveMail(env.DB, 'day@example.test', now + 86_400_000)).allowed).toBe(true);
});

it('reserves the last instance slot atomically across recipients', async () => {
    const now = Date.now();
    await reserveMail(env.DB, 'seed@example.test', now);
    await env.DB.prepare('UPDATE rateLimit SET count = 299 WHERE key = ?').bind('mail:instance:minute').run();
    const results = await Promise.all(['a@example.test', 'b@example.test'].map((email) => reserveMail(env.DB, email, now)));
    expect(results.filter((item) => item.allowed)).toHaveLength(1);
    expect(await env.DB.prepare('SELECT count FROM rateLimit WHERE key = ?').bind('mail:instance:day').first<number>('count')).toBe(2);
});

it('enforces the instance day budget and resets it only after the day window', async () => {
    const now = Date.now();
    await reserveMail(env.DB, 'seed@example.test', now);
    await env.DB.prepare('UPDATE rateLimit SET count = 10000 WHERE key = ?').bind('mail:instance:day').run();
    expect(await reserveMail(env.DB, 'other@example.test', now + 60_001)).toEqual({ allowed: false, retryAfter: 86340 });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM rateLimit').first('n')).toBe(4);
    expect((await reserveMail(env.DB, 'other@example.test', now + 86_400_000)).allowed).toBe(true);
});

it('retains the previously issued email proof when a resend is denied', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ success: true }));
    const client = harness(); await client.verify(); const cookie = await client.signin();
    const added = await client.request('/api/auth/emails/add', { cookie, body: { email: 'proof@example.test', password } });
    expect(added.status).toBe(200);
    const proof = await added.json<{ emailId: string; challengeId: string }>(), code = mailCode(client.messages.at(-1));
    await reserveMail(env.DB, 'proof@example.test'); await reserveMail(env.DB, 'proof@example.test');
    const count = client.messages.length;
    const denied = await client.request('/api/auth/emails/resend', { cookie, body: { emailId: proof.emailId, password } });
    expect(denied.status).toBe(429); expect(Number(denied.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(client.messages).toHaveLength(count);
    const verified = await client.request('/api/auth/emails/verify', { cookie, body: { challengeId: proof.challengeId, code } });
    expect(verified.status).toBe(200);
});

it('shares native and auxiliary delivery budgets for the same recipient', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ success: true }));
    const client = harness(); await client.signup();
    await sendEmailCode(client.bindings, { email: 'person@example.test', name: 'Fixture' }, '123456', 'verify', async () => {});
    await sendEmailCode(client.bindings, { email: 'person@example.test', name: 'Fixture' }, '123456', 'recovery', async () => {});
    const response = await client.request('/api/auth/send-verification-email', { body: { email: 'person@example.test' }, headers: { 'CF-Connecting-IP': '192.0.2.99' } });
    expect(response.status).toBe(200); expect(client.messages).toHaveLength(3);
});

it('does not change a challenge or call the provider when its recipient budget is exhausted', async () => {
    const client = harness(), email = 'blocked@example.test';
    for (let i = 0; i < 3; i++) await reserveMail(env.DB, email);
    const prepare = vi.fn(async () => {});
    await expect(sendEmailCode(client.bindings, { email, name: 'Fixture' }, '123456', 'verify', prepare)).rejects.toMatchObject({ statusCode: 429 });
    expect(prepare).not.toHaveBeenCalled(); expect(client.messages).toHaveLength(0);
});

it('suppresses native verification delivery across independent sources with the same opaque response', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ success: true }));
    const client = harness(); await client.signup();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
        const response = await client.request('/api/auth/send-verification-email', { body: { email: 'person@example.test' }, headers: { 'CF-Connecting-IP': `192.0.2.${30 + i}` } });
        statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200]); expect(client.messages).toHaveLength(3);
    const unknown = await client.request('/api/auth/send-verification-email', { body: { email: 'unknown@example.test' } });
    expect(unknown.status).toBe(200);
});

it('normalizes native rate-limit waiting headers at the HTTP boundary', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ success: true }));
    const client = harness();
    for (let i = 0; i < 3; i++) await client.request('/api/auth/send-verification-email', { body: { email: 'unknown@example.test' } });
    const response = await client.request('/api/auth/send-verification-email', { body: { email: 'unknown@example.test' } });
    expect(response.status).toBe(429); expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
});
