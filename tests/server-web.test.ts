import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker, { refreshSession } from '../examples/server-web/src/index';
import type { ServerWebBindings } from '../examples/server-web/worker-configuration';
import type { TokenEndpointResponse, TokenEndpointResponseHelpers } from 'openid-client';

const bindings: ServerWebBindings = {
    SESSIONS: env.DB, LOGINFLARE_SESSION_KEY: 'a'.repeat(64),
    LOGINFLARE_ORIGIN: 'https://app.example.test', LOGINFLARE_ISSUER: 'https://auth.example.test/api/auth',
    LOGINFLARE_CLIENT_ID: 'fixture', LOGINFLARE_CLIENT_SECRET: 'fixture-secret',
};
beforeEach(() => env.DB.prepare('CREATE TABLE appSession (id TEXT PRIMARY KEY, data TEXT NOT NULL, expiresAt INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0, refreshingAt INTEGER)').run());
afterEach(() => reset());
async function fixture() {
    const response = await worker.fetch(new Request(bindings.LOGINFLARE_ORIGIN), bindings);
    const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
    const row = (await env.DB.prepare('SELECT id, expiresAt, version, refreshingAt FROM appSession').first<{ id: string; expiresAt: number; version: number; refreshingAt: number | null }>())!;
    return { cookie, session: { ...row, data: { csrf: 'fixture-csrf', subject: 'person', tokens: { token_type: 'bearer' as const, access_token: 'old-access', refresh_token: 'old-refresh' } } } };
}
const renewed = () => Object.defineProperty({ token_type: 'bearer', access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 300 }, 'claims', {
    value: () => ({ iss: bindings.LOGINFLARE_ISSUER, sub: 'person', aud: 'fixture', exp: Date.now() / 1000 + 300, iat: Date.now() / 1000 }),
}) as TokenEndpointResponse & TokenEndpointResponseHelpers;

it('persists anonymous sessions across requests without exposing the session database id', async () => {
    const { cookie, session } = await fixture();
    expect(cookie).not.toContain(session.id);
    const response = await worker.fetch(new Request(bindings.LOGINFLARE_ORIGIN, { headers: { Cookie: cookie } }), { ...bindings });
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toBeNull();
});
it('coordinates rotating refresh across independent callers and encrypts persisted tokens', async () => {
    const { session } = await fixture();
    const renew = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return renewed(); });
    const results = await Promise.all([refreshSession(bindings, structuredClone(session), renew), refreshSession({ ...bindings }, structuredClone(session), renew)]);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(results.every((item) => item.data.tokens?.refresh_token === 'new-refresh')).toBe(true);
    const stored = await env.DB.prepare('SELECT data FROM appSession').first<string>('data');
    expect(stored).not.toContain('new-refresh');
    expect(stored).not.toContain('new-access');
});
it('discards uncertain refreshes and never reclaims a crashed refresh token', async () => {
    const { session } = await fixture();
    await expect(refreshSession(bindings, structuredClone(session), async () => { throw new Error('Response lost'); })).rejects.toThrow('unconfirmed');
    expect(await env.DB.prepare('SELECT id FROM appSession').first()).toBeNull();
    const second = await fixture();
    await env.DB.prepare('UPDATE appSession SET refreshingAt = ?').bind(Date.now() - 61_000).run();
    const renew = vi.fn(async () => renewed());
    await expect(refreshSession(bindings, second.session, renew)).rejects.toThrow();
    expect(renew).not.toHaveBeenCalled();
});
it('does not resurrect a session revoked while refresh is in flight', async () => {
    const { session } = await fixture();
    await expect(refreshSession(bindings, session, async () => {
        await env.DB.prepare('DELETE FROM appSession').run();
        return renewed();
    })).rejects.toThrow('unconfirmed');
    expect(await env.DB.prepare('SELECT id FROM appSession').first()).toBeNull();
});
it('keeps local logout usable when issuer discovery or profile validation fails', async () => {
    const { session, cookie } = await fixture();
    await refreshSession(bindings, session, async () => renewed());
    vi.stubGlobal('fetch', async () => { throw new Error('Issuer unavailable'); });
    try {
        const response = await worker.fetch(new Request(bindings.LOGINFLARE_ORIGIN, { headers: { Cookie: cookie } }), bindings);
        expect(response.status).toBe(400);
        expect(await response.text()).toContain('Sign out of this app and Loginflare');
        const result = await worker.fetch(new Request(bindings.LOGINFLARE_ORIGIN + '/logout', {
            method: 'POST', headers: { Cookie: cookie, Origin: bindings.LOGINFLARE_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'csrf=fixture-csrf',
        }), bindings);
        expect(result.status).toBe(303);
        const next = await worker.fetch(new Request(bindings.LOGINFLARE_ORIGIN, { headers: { Cookie: result.headers.get('Set-Cookie')!.split(';')[0] } }), bindings);
        expect(await next.text()).toContain('Remote token revocation could not be confirmed.');
    } finally { vi.unstubAllGlobals(); }
});
it('rejects wrong origins and CSRF before contacting the issuer', async () => {
    const { cookie } = await fixture();
    const response = await worker.fetch(new Request(bindings.LOGINFLARE_ORIGIN + '/login', {
        method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.test', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'csrf=wrong',
    }), bindings);
    expect(response.status).toBe(403);
});

it('accepts a legitimate same-origin logout form without a provider session', async () => {
    const response = await worker.fetch(new Request(bindings.LOGINFLARE_ORIGIN), bindings);
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin');
    const csrf = /name="csrf" value="([^"]+)"/.exec(await response.text())![1];
    const result = await worker.fetch(new Request(bindings.LOGINFLARE_ORIGIN + '/logout', {
        method: 'POST', headers: { Cookie: response.headers.get('Set-Cookie')!.split(';')[0],
            Origin: bindings.LOGINFLARE_ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }),
    }), bindings);
    expect(result.status).toBe(303);
    expect(result.headers.get('Location')).toBe('/');
});
