import { Hono } from 'hono';
import { APIError } from 'better-auth/api';
import { z } from 'zod';
import { createAuth } from './auth';
import type { Env } from './config';
import { PaginationError, pageBoundary, pageResult, readPageInput } from './pagination';
import { databaseRateLimit } from './rate-limit';

const scopes = ['openid', 'profile', 'email', 'offline_access'] as const;
const redirectUri = z.string().max(2048).refine((value) => {
    try {
        const url = new URL(value);
        return !url.username && !url.password && !url.hash && !value.includes('*')
            && url.protocol === 'https:';
    } catch {
        return false;
    }
});
const editable = z.object({
    name: z.string().trim().min(1).max(100),
    redirectUris: z.array(redirectUri).min(1).max(10),
    postLogoutRedirectUris: z.array(redirectUri).min(1).max(10),
    scopes: z.array(z.enum(scopes)).min(1).max(4).refine((values) => values.includes('openid') && new Set(values).size === values.length),
});
const createInput = editable.extend({ type: z.enum(['web', 'spa']) }).strict();
const updateInput = editable.partial().extend({ disabled: z.boolean().optional() }).strict().refine((value) => Object.keys(value).length > 0);

type Auth = ReturnType<typeof createAuth>;
type NativeClient = Awaited<ReturnType<Auth['api']['getOAuthClient']>>;

function application(client: NativeClient) {
    return {
        clientId: client.client_id,
        name: client.client_name ?? client.client_id,
        type: client.token_endpoint_auth_method === 'none' ? 'spa' : 'web',
        redirectUris: client.redirect_uris,
        postLogoutRedirectUris: client.post_logout_redirect_uris ?? [],
        scopes: client.scope?.split(' ').filter(Boolean) ?? [],
        disabled: client.disabled ?? false,
    };
}

export const applications = new Hono<{ Bindings: Env; Variables: { auth: Auth } }>();
applications.onError((error, c) => {
    if (error instanceof PaginationError) return c.json({ code: error.code }, 400);
    if (error instanceof APIError && error.statusCode < 500) {
        const status = error.statusCode === 404 ? 404 : error.statusCode === 401 ? 401 : error.statusCode === 403 ? 403 : 400;
        return c.json({ code: status === 404 ? 'APPLICATION_NOT_FOUND' : status === 403 ? 'FORBIDDEN' : 'INVALID_INPUT' }, status);
    }
    throw error;
});

applications.use('*', async (c, next) => {
    if (!['GET', 'POST', 'PATCH'].includes(c.req.method)) return c.json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    if (c.req.method !== 'GET' && c.req.header('origin') !== c.env.AUTH_URL) return c.json({ code: 'INVALID_ORIGIN' }, 403);
    const auth = createAuth(c.env);
    const identity = await auth.api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
    if (!identity) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (identity.user.banned || !identity.user.emailVerified || identity.user.role !== 'admin') return c.json({ code: 'FORBIDDEN' }, 403);
    c.set('auth', auth);
    if (c.req.method !== 'GET' && c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') return c.json({ code: 'INVALID_INPUT' }, 400);
    await next();
});

applications.get('/', async (c) => {
    const rate = await databaseRateLimit(c.env.DB).consume(`loginflare:list:applications:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`, { window: 60, max: 100 });
    if (!rate.allowed) { c.header('Retry-After', String(rate.retryAfter)); return c.json({ code: 'TOO_MANY_REQUESTS' }, 429); }
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'applications', 'loginflare', ['clientId', 'name']);
    const boundary = pageBoundary(input, 'clientId');
    const filter = input.lookupField ? ` AND "${input.lookupField}" = ?` : '';
    const clients = await c.env.DB.prepare(`SELECT "clientId", "name", "tokenEndpointAuthMethod", "disabled", "createdAt" FROM "oauthClient" WHERE "referenceId" = ?${filter}${boundary.sql} ORDER BY "createdAt" ${boundary.order}, "clientId" ${boundary.order} LIMIT ?`)
        .bind('loginflare', ...(input.lookupValue ? [input.lookupValue] : []), ...boundary.values, input.limit + 1)
        .all<{ clientId: string; name: string | null; tokenEndpointAuthMethod: string; disabled: number | null; createdAt: string }>();
    const items = clients.results.map((client) => ({ clientId: client.clientId, name: client.name ?? client.clientId, type: client.tokenEndpointAuthMethod === 'none' ? 'spa' : 'web', disabled: !!client.disabled, createdAt: client.createdAt }));
    return c.json({ ...await pageResult(items, input, c.env.BETTER_AUTH_SECRET, (item) => ({ createdAt: item.createdAt, id: item.clientId })), issuer: `${c.env.AUTH_URL}/api/auth` });
});

applications.post('/', async (c) => {
    const input = createInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: 'INVALID_INPUT' }, 400);
    const data = input.data;
    const client = await c.var.auth.api.adminCreateOAuthClient({
        headers: c.req.raw.headers,
        body: {
            client_name: data.name,
            redirect_uris: data.redirectUris,
            post_logout_redirect_uris: data.postLogoutRedirectUris,
            scope: data.scopes.join(' '),
            token_endpoint_auth_method: data.type === 'spa' ? 'none' : 'client_secret_basic',
            application_type: 'web',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            require_pkce: true,
            skip_consent: false,
            enable_end_session: true,
            metadata: { loginflareRedirectOrigins: [...new Set(data.redirectUris.map((uri) => new URL(uri).origin))] },
        },
    });
    return c.json({ application: application(client), clientSecret: client.client_secret, issuer: `${c.env.AUTH_URL}/api/auth` }, 201);
});

applications.get('/:clientId', async (c) => {
    const client = await c.var.auth.api.getOAuthClient({ headers: c.req.raw.headers, query: { client_id: c.req.param('clientId') } });
    return c.json({ application: application(client), issuer: `${c.env.AUTH_URL}/api/auth` });
});

applications.patch('/:clientId', async (c) => {
    const input = updateInput.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: 'INVALID_INPUT' }, 400);
    const data = input.data;
    let metadata: Record<string, unknown> = {};
    if (data.redirectUris !== undefined) {
        const existing = await c.env.DB.prepare('SELECT "metadata" FROM "oauthClient" WHERE "clientId" = ? AND "referenceId" = ?')
            .bind(c.req.param('clientId'), 'loginflare').first<{ metadata: string | null }>();
        if (!existing) return c.json({ code: 'APPLICATION_NOT_FOUND' }, 404);
        metadata = existing.metadata ? JSON.parse(existing.metadata) as Record<string, unknown> : {};
    }
    const client = await c.var.auth.api.adminUpdateOAuthClient({
        headers: c.req.raw.headers,
        body: {
            client_id: c.req.param('clientId'),
            update: {
                ...(data.name !== undefined ? { client_name: data.name } : {}),
                ...(data.redirectUris !== undefined ? { redirect_uris: data.redirectUris } : {}),
                ...(data.postLogoutRedirectUris !== undefined ? { post_logout_redirect_uris: data.postLogoutRedirectUris } : {}),
                ...(data.scopes !== undefined ? { scope: data.scopes.join(' ') } : {}),
                ...(data.disabled !== undefined ? { disabled: data.disabled } : {}),
                ...(data.redirectUris !== undefined ? { metadata: { ...metadata, loginflareRedirectOrigins: [...new Set(data.redirectUris.map((uri) => new URL(uri).origin))] } } : {}),
            },
        },
    });
    return c.json({ application: application(client), issuer: `${c.env.AUTH_URL}/api/auth` });
});

applications.post('/:clientId/rotate-secret', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return c.json({ code: 'INVALID_INPUT' }, 400);
    const client = await c.var.auth.api.rotateClientSecret({ headers: c.req.raw.headers, body: { client_id: c.req.param('clientId') } });
    return c.json({ clientSecret: client.client_secret });
});
