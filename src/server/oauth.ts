import { Hono } from 'hono';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { createAuth } from './auth';
import type { Env } from './config';

export const protocolRoutes: Record<string, readonly string[]> = {
    '/.well-known/openid-configuration': ['GET', 'HEAD'],
    '/.well-known/oauth-authorization-server': ['GET', 'HEAD'],
    '/jwks': ['GET', 'HEAD'],
    '/oauth2/authorize': ['GET', 'POST'],
    '/oauth2/token': ['POST'],
    '/oauth2/userinfo': ['GET', 'POST'],
    '/oauth2/revoke': ['POST'],
    '/oauth2/introspect': ['POST'],
    '/oauth2/consent': ['POST'],
    '/oauth2/end-session': ['GET', 'POST'],
    '/oauth2/end-session/confirm': ['POST'],
};
const browserProtocol = new Set(['/oauth2/token', '/oauth2/userinfo', '/oauth2/revoke', '/oauth2/introspect']);
const authorizationFields = new Set(['client_id', 'redirect_uri', 'response_type', 'response_mode', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method', 'prompt', 'max_age', 'login_hint', 'ui_locales', 'acr_values']);
const allowedScopes = new Set(['openid', 'profile', 'email', 'offline_access']);

export const oauth = new Hono<{ Bindings: Env }>();

async function allowedBrowserOrigin(env: Env, origin: string): Promise<boolean> {
    const clients = await env.DB.prepare('SELECT "redirectUris" FROM "oauthClient" WHERE "tokenEndpointAuthMethod" = ? AND COALESCE("disabled", 0) = 0').bind('none').all<{ redirectUris: string }>();
    return clients.results.some((client) => (JSON.parse(client.redirectUris) as string[]).some((uri) => new URL(uri).origin === origin));
}

oauth.all('*', async (c) => {
    const path = c.req.path.slice('/api/auth'.length);
    const methods = protocolRoutes[path];
    if (!methods) return c.json({ code: 'NOT_FOUND' }, 404);
    const discovery = path.startsWith('/.well-known/') || path === '/jwks';
    const origin = c.req.header('origin');
    if (discovery) c.header('Access-Control-Allow-Origin', '*');
    else if (browserProtocol.has(path) && origin && origin !== c.env.AUTH_URL) {
        c.header('Vary', 'Origin');
        if (!await allowedBrowserOrigin(c.env, origin) || c.req.header('cookie')) return c.json({ error: 'invalid_request' }, 403);
        c.header('Access-Control-Allow-Origin', origin);
        c.header('Access-Control-Allow-Methods', methods.join(', '));
        c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        c.header('Access-Control-Expose-Headers', 'WWW-Authenticate');
    }
    if (c.req.method === 'OPTIONS') {
        if (!discovery && (!browserProtocol.has(path) || !origin)) return c.json({ code: 'METHOD_NOT_ALLOWED' }, 405);
        const requested = c.req.header('access-control-request-method');
        const requestHeaders = c.req.header('access-control-request-headers')?.toLowerCase().split(',').map((v) => v.trim()) ?? [];
        if (!requested || !methods.includes(requested) || requestHeaders.some((value) => !['content-type', 'authorization'].includes(value))) return c.json({ error: 'invalid_request' }, 403);
        return c.body(null, 204);
    }
    if (!methods.includes(c.req.method)) return c.json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    const query = new URL(c.req.url).searchParams;
    let form = query;
    if (c.req.method === 'POST') {
        const mediaType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
        if (path === '/oauth2/consent') {
            if (origin !== c.env.AUTH_URL) return c.json({ code: 'INVALID_ORIGIN' }, 403);
            if (mediaType !== 'application/json') return c.json({ code: 'INVALID_INPUT' }, 400);
            const body: unknown = await c.req.raw.clone().json().catch(() => null);
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['accept', 'oauth_query'].includes(key))) return c.json({ code: 'INVALID_INPUT' }, 400);
        } else {
            if (mediaType !== 'application/x-www-form-urlencoded') return c.json({ error: 'invalid_request' }, 400);
            form = new URLSearchParams(await c.req.raw.clone().text());
            if (form.has('resource') || form.has('claims')) return c.json({ error: 'invalid_request' }, 400);
        }
    }
    if (path === '/oauth2/authorize') {
        if ([...form.keys()].some((key) => !authorizationFields.has(key) || form.getAll(key).length !== 1)
            || (form.has('response_mode') && form.get('response_mode') !== 'query')
            || (form.get('prompt')?.split(' ').some((value) => !['login', 'consent', 'none'].includes(value)))) return c.json({ error: 'invalid_request' }, 400);
    }
    const auth = createAuth(c.env);
    if (['/oauth2/authorize', '/oauth2/consent'].includes(path)) {
        const identity = await auth.api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
        if (identity && (identity.user.banned || !identity.user.emailVerified)) return c.json({ error: 'access_denied' }, 403);
    }
    const response = await auth.handler(c.req.raw);
    if (response.status >= 500) return c.json({ error: 'server_error' }, 503);
    if (path === '/oauth2/end-session' && response.ok && response.headers.get('content-type')?.includes('text/html')) {
        const redirect = form.get('post_logout_redirect_uri') ?? query.get('post_logout_redirect_uri');
        if (redirect) {
            const clients = await c.env.DB.prepare('SELECT "postLogoutRedirectUris" FROM "oauthClient" WHERE COALESCE("disabled", 0) = 0')
                .all<{ postLogoutRedirectUris: string | null }>();
            if (clients.results.some((client) => (JSON.parse(client.postLogoutRedirectUris ?? '[]') as string[]).includes(redirect))) {
                // Chromium applies form-action to the redirect following POST.
                // The provider still validates the client-specific URI and signed confirmation cookie.
                response.headers.set('Content-Security-Policy', `default-src 'none'; form-action 'self' ${new URL(redirect).origin}; base-uri 'none'; frame-ancestors 'none'`);
            }
        }
    }
    // Merge the protocol headers prepared on this context into the native response.
    return c.newResponse(response.body, response);
});

export const consent = new Hono<{ Bindings: Env }>();
consent.get('/consent', async (c) => {
    const auth = createAuth(c.env);
    const identity = await auth.api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
    if (!identity) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (identity.user.banned || !identity.user.emailVerified) return c.json({ code: 'FORBIDDEN' }, 403);
    const query = c.req.query('oauth_query');
    if (!query || !await verifyOAuthQueryParams(query, (await auth.$context).secret)) return c.json({ code: 'INVALID_OAUTH_QUERY' }, 400);
    const parameters = new URLSearchParams(query);
    if (parameters.has('claims') || parameters.has('resource')) return c.json({ code: 'INVALID_OAUTH_QUERY' }, 400);
    const client = await c.env.DB.prepare('SELECT "clientId", "name", "scopes", "redirectUris" FROM "oauthClient" WHERE "clientId" = ? AND COALESCE("disabled", 0) = 0')
        .bind(parameters.get('client_id')).first<{ clientId: string; name: string; scopes: string; redirectUris: string }>();
    if (!client) return c.json({ code: 'APPLICATION_NOT_FOUND' }, 404);
    const scopes = parameters.get('scope')?.split(' ').filter(Boolean) ?? [];
    const permitted = JSON.parse(client.scopes) as string[];
    if (!scopes.length || scopes.some((value) => !allowedScopes.has(value) || !permitted.includes(value))
        || !(JSON.parse(client.redirectUris) as string[]).includes(parameters.get('redirect_uri') ?? '')) return c.json({ code: 'INVALID_OAUTH_QUERY' }, 400);
    return c.json({ client: { clientId: client.clientId, name: client.name }, scopes });
});
