import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { harness, password } from './helpers';
import { interceptSql } from './sql-race';

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async () => Response.json({ success: true }));
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

for (const method of ['email', 'username'] as const) {
    it.each(['network', 'timeout', 'http'] as const)(`classifies first ${method} sign-in verification failure (%s) and allows a later retry`, async (failure) => {
        const client = harness(); await client.verify();
        await env.DB.prepare('UPDATE "user" SET "username" = ? WHERE "email" = ?').bind('error_boundary', 'person@example.test').run();
        let attempts = 0;
        const sensitive = 'private-upstream-response-and-token';
        vi.stubGlobal('fetch', async () => {
            if (++attempts > 1) return Response.json({ success: true });
            if (failure === 'network') throw new TypeError(sensitive);
            if (failure === 'timeout') throw new DOMException(sensitive, 'TimeoutError');
            return Response.json({ message: sensitive }, { status: 503 });
        });
        const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const body = { ...(method === 'email' ? { email: 'person@example.test' } : { username: 'error_boundary' }), password };
            const response = await client.request('/api/auth/sign-in/' + method, { body });
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({ code: 'TURNSTILE_UNAVAILABLE' });
            expect(await env.DB.prepare('SELECT count(*) n FROM session').first('n')).toBe(0);
            const logged = logs.mock.calls.map((args) => args.join(' ')).join('\n');
            expect(logged).toContain('TURNSTILE_UNAVAILABLE');
            expect(logged).toContain(response.headers.get('X-Request-ID'));
            for (const value of [sensitive, password, 'test-captcha-token', env.TURNSTILE_SECRET_KEY, env.BETTER_AUTH_SECRET, 'person@example.test']) expect(logged).not.toContain(value);
            const retry = await client.request('/api/auth/sign-in/' + method, { body });
            expect(retry.status, await retry.clone().text()).toBe(200);
            expect(attempts).toBe(2);
            expect(await env.DB.prepare('SELECT count(*) n FROM session').first('n')).toBe(1);
        } finally { logs.mockRestore(); }
    });
}
it.each(['rejected', 'malformed'] as const)('preserves native verification denial for a %s provider response', async (kind) => {
    const client = harness(); await client.verify();
    vi.stubGlobal('fetch', async () => kind === 'rejected' ? Response.json({ success: false }) : new Response('not-json', { headers: { 'Content-Type': 'application/json' } }));
    const response = await client.request('/api/auth/sign-in/email', { body: { email: 'person@example.test', password } });
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: 'VERIFICATION_FAILED' });
    expect(await env.DB.prepare('SELECT count(*) n FROM session').first('n')).toBe(0);
});
it('classifies session storage failures separately without leaking their cause', async () => {
    const client = harness(); await client.verify();
    const sensitive = 'private-sql-and-parameters';
    const fault = interceptSql(env.DB, /insert into ["`]session["`]/i, async () => { throw new Error('D1_ERROR: ' + sensitive); });
    client.bindings.DB = fault.proxy;
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        const response = await client.request('/api/auth/sign-in/email', { body: { email: 'person@example.test', password } });
        expect(fault.invoked()).toBe(true); expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'REQUEST_FAILED' });
        const logged = logs.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(logged).toContain('DATABASE_ERROR'); expect(logged).not.toContain('TURNSTILE_UNAVAILABLE'); expect(logged).not.toContain(sensitive);
        expect(await env.DB.prepare('SELECT count(*) n FROM session').first('n')).toBe(0);
    } finally { logs.mockRestore(); }
});
