import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createWorkerApi } from '../examples/worker-api/src/index';
import type { WorkerApiBindings } from '../examples/worker-api/worker-configuration';

const configuration: WorkerApiBindings = {
    AUTH_ISSUER: 'https://identity.example.test/api/auth', API_RESOURCE: 'https://api.example.test',
    INTROSPECTION_CLIENT_ID: 'api-reader', INTROSPECTION_CLIENT_SECRET: 'isolated-api-client-secret',
};
let privateKey: CryptoKey;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
let api: ReturnType<typeof createWorkerApi>;
let network: Request[] = [];
let introspectionOverride: Record<string, unknown> | undefined;
let networkFault: 'keys' | 'introspection' | 'redirect' | 'oversized' | undefined;
const claims = (): JWTPayload => ({
    iss: configuration.AUTH_ISSUER, aud: [configuration.API_RESOURCE, `${configuration.AUTH_ISSUER}/oauth2/userinfo`],
    sub: 'resource-user', client_id: 'browser-client', azp: 'browser-client', scope: 'openid orders:read',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: crypto.randomUUID(),
});
async function token(overrides: JWTPayload = {}, typ = 'at+jwt', key = privateKey) {
    return new SignJWT({ ...claims(), ...overrides }).setProtectedHeader({ alg: 'RS256', typ, kid: 'resource-key' }).sign(key);
}
async function orders(value?: string, method = 'GET', settings = configuration) {
    return api.request('/orders', { method, headers: value ? { Authorization: `Bearer ${value}` } : {} }, settings);
}
beforeAll(async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    privateKey = keys.privateKey;
    publicKey = { ...await exportJWK(keys.publicKey), kid: 'resource-key', alg: 'RS256', use: 'sig' };
});
beforeEach(() => {
    api = createWorkerApi(); network = []; introspectionOverride = undefined; networkFault = undefined;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init); network.push(request);
        if (request.url === `${configuration.AUTH_ISSUER}/jwks`) {
            if (networkFault === 'keys') throw new Error('Isolated unavailable JWKS');
            return Response.json({ keys: [publicKey] });
        }
        if (request.url === `${configuration.AUTH_ISSUER}/oauth2/introspect`) {
            expect(request.method).toBe('POST');
            expect(request.redirect).toBe('manual');
            expect(request.headers.get('authorization')).toBe(`Basic ${btoa(`${configuration.INTROSPECTION_CLIENT_ID}:${configuration.INTROSPECTION_CLIENT_SECRET}`)}`);
            expect(request.headers.get('cookie')).toBeNull();
            if (networkFault === 'introspection') throw new Error('Isolated unavailable introspection');
            if (networkFault === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example.test/' } });
            if (networkFault === 'oversized') return Response.json({ padding: 'x'.repeat(17_000) });
            const body = new URLSearchParams(await request.text());
            expect(body.get('token_type_hint')).toBe('access_token');
            return Response.json({ ...decodeJwt(body.get('token')!), active: true, token_type: 'Bearer', ...introspectionOverride });
        }
        throw new Error('Unexpected network destination');
    });
});
afterEach(() => vi.unstubAllGlobals());

it('accepts a resource access token after local verification and current authorization introspection', async () => {
    const response = await orders(await token());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ subject: 'resource-user', orders: [{ id: 'example-order' }] });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(network.map((request) => request.url)).toEqual([`${configuration.AUTH_ISSUER}/jwks`, `${configuration.AUTH_ISSUER}/oauth2/introspect`]);
});

it('caches only public keys and still introspects every API request', async () => {
    const value = await token();
    expect((await orders(value)).status).toBe(200);
    introspectionOverride = { active: false };
    expect((await orders(value)).status).toBe(401);
    expect(network.filter((request) => request.url.endsWith('/jwks'))).toHaveLength(1);
    expect(network.filter((request) => request.url.endsWith('/introspect'))).toHaveLength(2);
});

it('treats a resource identifier as an exact audience, including its trailing slash', async () => {
    const resource = `${configuration.API_RESOURCE}/`;
    expect((await orders(await token({ aud: resource }), 'GET', { ...configuration, API_RESOURCE: resource })).status).toBe(200);
    expect((await orders(await token({ aud: configuration.API_RESOURCE }), 'GET', { ...configuration, API_RESOURCE: resource })).status).toBe(401);
});

it('rejects missing, opaque and malformed credentials before fetching identity endpoints', async () => {
    for (const value of [undefined, 'opaque-value', 'not.a.jwt']) expect((await orders(value)).status).toBe(401);
    expect(network).toEqual([]);
});

it.each([
    ['issuer', { iss: 'https://untrusted.example.test/api/auth' }],
    ['audience', { aud: 'https://another-api.example.test' }],
    ['expiry', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ['subject', { sub: undefined }],
    ['client', { client_id: undefined }],
    ['scopes', { scope: undefined }],
    ['party', { azp: 'different-client' }],
    ['sender binding', { cnf: { jkt: 'unverified-sender-key' } }],
] as const)('rejects an access token with invalid %s without introspection', async (_name, overrides) => {
    expect((await orders(await token(overrides))).status).toBe(401);
    expect(network.some((request) => request.url.endsWith('/introspect'))).toBe(false);
});

it('rejects a signed identity token even when it contains business-looking claims', async () => {
    const response = await orders(await token({}, 'JWT'));
    expect(response.status).toBe(401);
    expect(network.some((request) => request.url.endsWith('/introspect'))).toBe(false);
});

it('rejects a forged access-token signature', async () => {
    const wrong = await generateKeyPair('RS256');
    expect((await orders(await token({}, 'at+jwt', wrong.privateKey))).status).toBe(401);
    expect(network.some((request) => request.url.endsWith('/introspect'))).toBe(false);
});

it.each([
    ['active', { active: false }], ['subject', { sub: 'another-user' }],
    ['client', { client_id: 'another-client' }], ['issuer', { iss: 'https://other.example.test' }],
    ['audience', { aud: 'https://other-api.example.test' }], ['expiry', { exp: 1 }],
    ['sender token type', { token_type: 'DPoP' }],
] as const)('rejects a current authorization response with invalid %s', async (_name, override) => {
    introspectionOverride = override;
    const response = await orders(await token());
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('invalid_token');
});

it('returns 403 for missing permissions and never upgrades scope from introspection', async () => {
    const value = await token();
    introspectionOverride = { scope: 'openid orders:read orders:write' };
    const denied = await orders(value, 'POST');
    expect(denied.status).toBe(403);
    expect(denied.headers.get('www-authenticate')).toContain('scope="orders:write"');
    expect((await orders(await token({ scope: 'orders:read orders:write' }), 'POST')).status).toBe(200);
});

it.each(['keys', 'introspection', 'redirect', 'oversized'] as const)('fails closed when authorization infrastructure returns %s', async (fault) => {
    networkFault = fault;
    const response = await orders(await token());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'authorization_unavailable' });
    expect(network.every((request) => new URL(request.url).origin === new URL(configuration.AUTH_ISSUER).origin)).toBe(true);
});

it('rejects insecure non-local configuration and leaves health checks public', async () => {
    const health = await api.request('/health', {}, configuration);
    expect(health.status).toBe(200); expect(network).toEqual([]);
    const response = await orders(await token(), 'GET', { ...configuration, AUTH_ISSUER: 'http://untrusted.example.test/api/auth' });
    expect(response.status).toBe(503); expect(network).toEqual([]);
});
