import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { createAuth } from '../src/server/auth';
import { harness, origin } from './helpers';

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        if (new Request(input).url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected network request');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

it('rotates expired signing keys while retaining old public keys for the grace period', async () => {
    const client = harness();
    await client.verify();
    const cookie = await client.signin();
    const auth = createAuth(client.bindings);
    const issue = () => auth.api.getToken({ headers: new Headers({ Cookie: cookie }) });
    const original = await issue();
    const oldId = decodeProtectedHeader(original.token).kid!;
    const old = await env.DB.prepare('SELECT * FROM jwks WHERE id = ?').bind(oldId).first<{ expiresAt: string; privateKey: string }>();
    expect(new Date(old!.expiresAt).getTime()).toBeGreaterThan(Date.now() + 89 * 86400_000);
    expect(old!.privateKey).not.toContain('PRIVATE KEY');
    await env.DB.prepare('UPDATE jwks SET expiresAt = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), oldId).run();
    const successors = await Promise.all([issue(), issue()]);
    const publicKeys = await (await client.request('/api/auth/jwks', { method: 'GET' })).json<{ keys: JsonWebKey[] }>();
    const verifier = createLocalJWKSet(publicKeys);
    for (const { token } of [original, ...successors]) {
        await expect(jwtVerify(token, verifier, { issuer: `${origin}/api/auth` })).resolves.toBeDefined();
    }
    expect(successors.every(({ token }) => decodeProtectedHeader(token).kid !== oldId)).toBe(true);
    await env.DB.prepare('UPDATE jwks SET expiresAt = ? WHERE id = ?').bind(new Date(Date.now() - 49 * 3600_000).toISOString(), oldId).run();
    const afterGrace = await (await client.request('/api/auth/jwks', { method: 'GET' })).json<{ keys: { kid: string }[] }>();
    expect(afterGrace.keys.some(({ kid }) => kid === oldId)).toBe(false);
});
