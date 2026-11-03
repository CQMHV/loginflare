import { Hono, type Context } from 'hono';
import { APIError } from 'better-auth/api';
import { z } from 'zod';
import { createAuth } from './auth';
import type { Env } from './config';
import { PaginationError, pageBoundary, pageResult, readPageInput } from './pagination';
import { databaseRateLimit } from './rate-limit';
import { applicationPrivileges, type ApplicationManagement, type ApplicationOwnership } from './application-policy';

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
type Identity = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;
type ApplicationEnv = { Bindings: Env; Variables: { auth: Auth; identity: Identity; management: ApplicationManagement } };
interface OwnerSummaryFields extends ApplicationOwnership { ownerName?: string | null; ownerEmail?: string | null }
interface StoredApplication extends OwnerSummaryFields { metadata: string | null }

function application(client: NativeClient, ownership: ApplicationOwnership) {
    return {
        clientId: client.client_id,
        name: client.client_name ?? client.client_id,
        type: client.token_endpoint_auth_method === 'none' ? 'spa' : 'web',
        redirectUris: client.redirect_uris,
        postLogoutRedirectUris: client.post_logout_redirect_uris ?? [],
        scopes: client.scope?.split(' ').filter(Boolean) ?? [],
        disabled: client.disabled ?? false,
        ownerId: ownership.ownerId,
        ownerDisabled: !!ownership.ownerDisabled,
        adminSuspended: !!ownership.adminSuspended,
    };
}

function createApplications(administrator: boolean) {
    const applications = new Hono<ApplicationEnv>();
    const ownerSelection = administrator ? `, (SELECT "name" FROM "user" WHERE "id" = "oauthClient"."ownerId") AS "ownerName", (SELECT "email" FROM "user" WHERE "id" = "oauthClient"."ownerId") AS "ownerEmail"` : '';
    function ownerSummary(value: OwnerSummaryFields) {
        return administrator ? { owner: value.ownerId ? { id: value.ownerId, name: value.ownerName ?? '', email: value.ownerEmail ?? '' } : null } : {};
    }
    async function stored(c: Context<ApplicationEnv>, clientId: string): Promise<StoredApplication | null> {
        return c.env.DB.prepare(`SELECT "ownerId", "ownerDisabled", "adminSuspended", "metadata"${ownerSelection} FROM "oauthClient"
            WHERE "clientId" = ? AND "referenceId" = 'loginflare' AND (? = 1 OR "ownerId" = ?)`)
            .bind(clientId, Number(administrator), c.var.identity.user.id).first<StoredApplication>();
    }
    applications.onError((error, c) => {
        let cause: unknown = error;
        for (let depth = 0; depth < 6 && cause; depth++) {
            const message = cause instanceof Error ? cause.message : String(cause);
            if (message.includes('APPLICATION_LIMIT')) return c.json({ code: 'APPLICATION_LIMIT' }, 400);
            if (message.includes('APPLICATION_SUSPENDED')) return c.json({ code: 'APPLICATION_SUSPENDED' }, 403);
            if (message.includes('APPLICATION_ACCESS_REVOKED')) return c.json({ code: 'FORBIDDEN' }, 403);
            if (message.includes('APPLICATION_STATUS_CONFLICT') || message.includes('APPLICATION_OWNERSHIP_IMMUTABLE')) return c.json({ code: 'APPLICATION_CONFLICT' }, 409);
            cause = typeof cause === 'object' && 'cause' in cause ? cause.cause : undefined;
        }
        if (error instanceof PaginationError) return c.json({ code: error.code }, 400);
        if (error instanceof APIError && error.statusCode < 500) {
            const status = error.statusCode === 404 ? 404 : error.statusCode === 401 ? 401 : error.statusCode === 403 ? 403 : 400;
            return c.json({ code: status === 404 ? 'APPLICATION_NOT_FOUND' : status === 403 ? 'FORBIDDEN' : status === 401 ? 'UNAUTHORIZED' : 'INVALID_INPUT' }, status);
        }
        throw error;
    });

    applications.use('*', async (c, next) => {
        if (!['GET', 'POST', 'PATCH'].includes(c.req.method)) return c.json({ code: 'METHOD_NOT_ALLOWED' }, 405);
        if (c.req.method !== 'GET' && c.req.header('origin') !== c.env.AUTH_URL) return c.json({ code: 'INVALID_ORIGIN' }, 403);
        const auth = createAuth(c.env);
        const identity = await auth.api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
        if (!identity) return c.json({ code: 'UNAUTHORIZED' }, 401);
        if (identity.user.banned || !identity.user.emailVerified || (administrator && identity.user.role !== 'admin')) return c.json({ code: 'FORBIDDEN' }, 403);
        const management = { userId: identity.user.id, sessionId: identity.session.id, administrator };
        c.set('identity', identity); c.set('management', management);
        c.set('auth', createAuth(c.env, undefined, undefined, undefined, management));
        if (c.req.method !== 'GET' && c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') return c.json({ code: 'INVALID_INPUT' }, 400);
        if (c.req.method !== 'GET') {
            const limit = await databaseRateLimit(c.env.DB).consume(`loginflare:application-write:${identity.user.id}`, { window: 60, max: 30 });
            if (!limit.allowed) { c.header('Retry-After', String(limit.retryAfter)); return c.json({ code: 'TOO_MANY_REQUESTS' }, 429); }
        }
        await next();
    });

    applications.get('/', async (c) => {
        const rate = await databaseRateLimit(c.env.DB).consume(`loginflare:list:applications:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`, { window: 60, max: 100 });
        if (!rate.allowed) { c.header('Retry-After', String(rate.retryAfter)); return c.json({ code: 'TOO_MANY_REQUESTS' }, 429); }
        if (!await applicationPrivileges(c.env, c.var.management)) return c.json({ code: 'FORBIDDEN' }, 403);
        const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'applications', administrator ? 'loginflare' : `developer:${c.var.identity.user.id}`, ['clientId', 'name']);
        const boundary = pageBoundary(input, 'clientId');
        const filter = input.lookupField ? ` AND "${input.lookupField}" = ?` : '';
        const ownerFilter = administrator ? '' : ' AND "ownerId" = ?';
        const clients = await c.env.DB.prepare(`SELECT "clientId", "name", "tokenEndpointAuthMethod", "disabled", "createdAt", "ownerId", "ownerDisabled", "adminSuspended"${ownerSelection} FROM "oauthClient" WHERE "referenceId" = ?${ownerFilter}${filter}${boundary.sql} ORDER BY "createdAt" ${boundary.order}, "clientId" ${boundary.order} LIMIT ?`)
            .bind('loginflare', ...(administrator ? [] : [c.var.identity.user.id]), ...(input.lookupValue ? [input.lookupValue] : []), ...boundary.values, input.limit + 1)
            .all<OwnerSummaryFields & { clientId: string; name: string | null; tokenEndpointAuthMethod: string; disabled: number | null; createdAt: string }>();
        const items = clients.results.map((client) => ({ clientId: client.clientId, name: client.name ?? client.clientId, type: client.tokenEndpointAuthMethod === 'none' ? 'spa' : 'web', disabled: !!client.disabled, createdAt: client.createdAt, ownerId: client.ownerId, ownerDisabled: !!client.ownerDisabled, adminSuspended: !!client.adminSuspended, ...ownerSummary(client) }));
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
        const ownership = await stored(c, client.client_id);
        if (!ownership) return c.json({ code: 'APPLICATION_NOT_FOUND' }, 404);
        return c.json({ application: { ...application(client, ownership), ...ownerSummary(ownership) }, clientSecret: client.client_secret, issuer: `${c.env.AUTH_URL}/api/auth` }, 201);
    });

    applications.get('/:clientId', async (c) => {
        const ownership = await stored(c, c.req.param('clientId'));
        if (!ownership) return c.json({ code: 'APPLICATION_NOT_FOUND' }, 404);
        const client = await c.var.auth.api.getOAuthClient({ headers: c.req.raw.headers, query: { client_id: c.req.param('clientId') } });
        return c.json({ application: { ...application(client, ownership), ...ownerSummary(ownership) }, issuer: `${c.env.AUTH_URL}/api/auth` });
    });

    applications.patch('/:clientId', async (c) => {
        const input = updateInput.safeParse(await c.req.json().catch(() => null));
        if (!input.success) return c.json({ code: 'INVALID_INPUT' }, 400);
        const data = input.data;
        const ownership = await stored(c, c.req.param('clientId'));
        if (!ownership) return c.json({ code: 'APPLICATION_NOT_FOUND' }, 404);
        if (!administrator && ownership.adminSuspended) return c.json({ code: 'APPLICATION_SUSPENDED' }, 403);
        let metadata: Record<string, unknown> = {};
        if (data.redirectUris !== undefined) {
            metadata = ownership.metadata ? JSON.parse(ownership.metadata) as Record<string, unknown> : {};
        }
        const management = { ...c.var.management, ...(data.disabled !== undefined ? administrator ? { adminSuspended: data.disabled } : { ownerDisabled: data.disabled } : {}) };
        const auth = createAuth(c.env, undefined, undefined, undefined, management);
        const client = await auth.api.adminUpdateOAuthClient({
            headers: c.req.raw.headers,
            body: {
                client_id: c.req.param('clientId'),
                update: {
                    ...(data.name !== undefined ? { client_name: data.name } : {}),
                    ...(data.redirectUris !== undefined ? { redirect_uris: data.redirectUris } : {}),
                    ...(data.postLogoutRedirectUris !== undefined ? { post_logout_redirect_uris: data.postLogoutRedirectUris } : {}),
                    ...(data.scopes !== undefined ? { scope: data.scopes.join(' ') } : {}),
                    ...(data.disabled !== undefined ? { disabled: data.disabled || !!(administrator ? ownership.ownerDisabled : ownership.adminSuspended) } : {}),
                    ...(data.redirectUris !== undefined ? { metadata: { ...metadata, loginflareRedirectOrigins: [...new Set(data.redirectUris.map((uri) => new URL(uri).origin))] } } : {}),
                },
            },
        });
        const updated = await stored(c, client.client_id);
        if (!updated) return c.json({ code: 'APPLICATION_NOT_FOUND' }, 404);
        return c.json({ application: { ...application(client, updated), ...ownerSummary(updated) }, issuer: `${c.env.AUTH_URL}/api/auth` });
    });

    applications.post('/:clientId/rotate-secret', async (c) => {
        const body = await c.req.json().catch(() => null);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return c.json({ code: 'INVALID_INPUT' }, 400);
        const ownership = await stored(c, c.req.param('clientId'));
        if (!ownership) return c.json({ code: 'APPLICATION_NOT_FOUND' }, 404);
        if (!administrator && ownership.adminSuspended) return c.json({ code: 'APPLICATION_SUSPENDED' }, 403);
        const client = await c.var.auth.api.rotateClientSecret({ headers: c.req.raw.headers, body: { client_id: c.req.param('clientId') } });
        return c.json({ clientSecret: client.client_secret });
    });
    return applications;
}

export const applications = createApplications(true);
export const developerApplications = createApplications(false);
