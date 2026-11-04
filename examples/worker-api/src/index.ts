import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { WorkerApiBindings } from '../worker-configuration';

interface Principal { subject: string; clientId: string; scopes: Set<string> }
type ApiEnv = { Bindings: WorkerApiBindings; Variables: { principal: Principal } };
type KeyCache = { issuer: string; keys: JSONWebKeySet; loadedAt: number };
class AuthorizationError extends Error {
    constructor(readonly status: 401 | 503) { super(status === 401 ? 'invalid_token' : 'authorization_unavailable'); }
}

function configuredUrl(value: string, local = false): URL {
    const url = new URL(value);
    const loopback = local && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.search || url.hash || value !== value.trim()) throw new Error('Invalid API configuration');
    return url;
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel();
        throw new AuthorizationError(503);
    }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) { await reader.cancel(); throw new AuthorizationError(503); }
        chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new AuthorizationError(503); }
}
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function audienceIncludes(value: unknown, resource: string): boolean {
    return value === resource || Array.isArray(value) && value.length <= 10 && value.every((item) => typeof item === 'string') && value.includes(resource);
}
function basicCredentials(clientId: string, clientSecret: string): string {
    // RFC 6749 section 2.3.1 applies form encoding before Base64.
    const encoded = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
    return `Basic ${btoa(encoded)}`;
}

/** No credentials or in-flight I/O are retained between requests. Only public keys are cached. */
export function createWorkerApi() {
    let cache: KeyCache | undefined;
    async function keys(issuer: string, force = false) {
        const now = Date.now();
        if (cache?.issuer === issuer && now - cache.loadedAt < (force ? 30_000 : 300_000)) return cache.keys;
        let payload: unknown;
        try { payload = await boundedJson(await fetch(`${issuer}/jwks`, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } }), 65_536); }
        catch { throw new AuthorizationError(503); }
        if (!record(payload) || !Array.isArray(payload.keys) || payload.keys.length > 20 || !payload.keys.every((key) => record(key) && key.kty === 'RSA' && typeof key.n === 'string' && typeof key.e === 'string' && !('d' in key))) throw new AuthorizationError(503);
        const value: JSONWebKeySet = { keys: payload.keys };
        cache = { issuer, keys: value, loadedAt: now };
        return value;
    }
    async function verify(token: string, env: WorkerApiBindings): Promise<Principal> {
        const issuer = env.AUTH_ISSUER, resource = env.API_RESOURCE;
        configuredUrl(issuer, true); configuredUrl(resource);
        if (issuer.endsWith('/')) throw new Error('The issuer must not end with a slash');
        if (!env.INTROSPECTION_CLIENT_ID || !env.INTROSPECTION_CLIENT_SECRET || env.INTROSPECTION_CLIENT_ID.startsWith('replace-') || env.INTROSPECTION_CLIENT_SECRET.startsWith('replace-')) throw new Error('Configure the API introspection client');
        try {
            const header = decodeProtectedHeader(token);
            if (header.alg !== 'RS256' || header.typ !== 'at+jwt' || typeof header.kid !== 'string' || !header.kid) throw new Error('Invalid access-token header');
        } catch { throw new AuthorizationError(401); }
        const options = { issuer, audience: resource, algorithms: ['RS256'], typ: 'at+jwt', requiredClaims: ['sub', 'client_id', 'scope', 'iat', 'exp', 'jti'] };
        let payload: JWTPayload;
        try { ({ payload } = await jwtVerify(token, createLocalJWKSet(await keys(issuer)), options)); }
        catch (error) {
            if (error instanceof AuthorizationError) throw error;
            if (record(error) && error.code === 'ERR_JWKS_NO_MATCHING_KEY') {
                try { ({ payload } = await jwtVerify(token, createLocalJWKSet(await keys(issuer, true)), options)); }
                catch (retried) { if (retried instanceof AuthorizationError) throw retried; throw new AuthorizationError(401); }
            } else throw new AuthorizationError(401);
        }
        if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.client_id !== 'string' || !payload.client_id || typeof payload.scope !== 'string'
            || payload.azp !== undefined && payload.azp !== payload.client_id || payload.cnf !== undefined || !audienceIncludes(payload.aud, resource)) throw new AuthorizationError(401);
        let active: unknown;
        try {
            active = await boundedJson(await fetch(`${issuer}/oauth2/introspect`, {
                method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
                headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicCredentials(env.INTROSPECTION_CLIENT_ID, env.INTROSPECTION_CLIENT_SECRET) },
                body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
            }), 16_384);
        } catch { throw new AuthorizationError(503); }
        if (!record(active) || active.active !== true || active.sub !== payload.sub || active.client_id !== payload.client_id || active.iss !== issuer
            || active.token_type !== 'Bearer' || active.cnf !== undefined || typeof active.exp !== 'number' || active.exp <= Date.now() / 1000 || !audienceIncludes(active.aud, resource) || typeof active.scope !== 'string') throw new AuthorizationError(401);
        const signedScopes = new Set(payload.scope.split(' ').filter(Boolean));
        const scopes = new Set(active.scope.split(' ').filter((scope) => scope && signedScopes.has(scope)));
        return { subject: payload.sub, clientId: payload.client_id, scopes };
    }
    function authorize(scope: string): MiddlewareHandler<ApiEnv> {
        return async (c, next) => {
            const header = c.req.header('authorization');
            if (!header || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/i.test(header) || header.length > 16_384) {
                c.header('WWW-Authenticate', 'Bearer realm="orders-api", error="invalid_token"');
                return c.json({ error: 'invalid_token' }, 401);
            }
            try {
                const principal = await verify(header.slice(7), c.env);
                if (!principal.scopes.has(scope)) {
                    c.header('WWW-Authenticate', `Bearer realm="orders-api", error="insufficient_scope", scope="${scope}"`);
                    return c.json({ error: 'insufficient_scope' }, 403);
                }
                c.set('principal', principal);
            } catch (error) {
                const status = error instanceof AuthorizationError ? error.status : 503;
                if (status === 401) c.header('WWW-Authenticate', 'Bearer realm="orders-api", error="invalid_token"');
                return c.json({ error: status === 401 ? 'invalid_token' : 'authorization_unavailable' }, status);
            }
            await next();
        };
    }
    const api = new Hono<ApiEnv>();
    api.use('*', async (c, next) => { await next(); c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff'); });
    api.get('/health', (c) => c.json({ status: 'ok' }));
    api.get('/orders', authorize('orders:read'), (c) => c.json({ subject: c.var.principal.subject, orders: [{ id: 'example-order', status: 'demonstration' }] }));
    api.post('/orders', authorize('orders:write'), bodyLimit({ maxSize: 1024 }), (c) => c.json({ subject: c.var.principal.subject, accepted: true, persisted: false }));
    api.notFound((c) => c.json({ error: 'not_found' }, 404));
    return api;
}

export default createWorkerApi();
