import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { createAuth } from './auth';
import { ConfigurationError, validateConfig, type Env } from './config';
import { isLocale } from '../shared/locales';
import { applications } from './applications';
import { consent, oauth, protocolRoutes } from './oauth';

const routes: Record<string, readonly string[]> = {
    '/sign-up/email': ['POST'],
    '/sign-in/email': ['POST'],
    '/sign-in/username': ['POST'],
    '/sign-out': ['POST'],
    '/send-verification-email': ['POST'],
    '/verify-email': ['GET'],
    '/reset-password': ['POST'],
    '/get-session': ['GET'],
    '/error': ['GET'],
    '/update-user': ['POST'],
    '/change-password': ['POST'],
    '/list-sessions': ['GET'],
    '/revoke-session': ['POST'],
    '/revoke-other-sessions': ['POST'],
    '/admin/list-users': ['GET'],
    '/admin/get-user': ['GET'],
    '/admin/ban-user': ['POST'],
    '/admin/unban-user': ['POST'],
    '/admin/revoke-user-sessions': ['POST'],
    '/emails': ['GET'],
    '/emails/add': ['POST'],
    '/emails/resend': ['POST'],
    '/emails/verify': ['POST'],
    '/emails/set-primary': ['POST'],
    '/emails/remove': ['POST'],
    '/emails/recovery/start': ['POST'],
    '/emails/recovery/verify': ['POST'],
};

const fields: Record<string, readonly string[]> = {
    '/sign-up/email': ['name', 'username', 'email', 'password', 'locale', 'callbackURL'],
    '/sign-in/email': ['email', 'password', 'rememberMe', 'callbackURL', 'oauth_query'],
    '/sign-in/username': ['username', 'password', 'rememberMe', 'callbackURL', 'oauth_query'],
    '/sign-out': [],
    '/send-verification-email': ['email', 'callbackURL'],
    '/reset-password': ['newPassword', 'token'],
    '/update-user': ['name', 'username', 'locale'],
    '/change-password': ['currentPassword', 'newPassword', 'revokeOtherSessions'],
    '/revoke-session': ['token'],
    '/revoke-other-sessions': [],
    '/admin/ban-user': ['userId', 'banReason'],
    '/admin/unban-user': ['userId'],
    '/admin/revoke-user-sessions': ['userId'],
    '/emails/add': ['email', 'password'],
    '/emails/resend': ['emailId', 'password'],
    '/emails/verify': ['challengeId', 'code'],
    '/emails/set-primary': ['emailId', 'password'],
    '/emails/remove': ['emailId', 'password'],
    '/emails/recovery/start': ['identifier', 'email'],
    '/emails/recovery/verify': ['challengeId', 'code'],
};

const privatePaths = new Set(['/update-user', '/change-password', '/list-sessions', '/revoke-session', '/revoke-other-sessions',
    '/emails', '/emails/add', '/emails/resend', '/emails/verify', '/emails/set-primary', '/emails/remove']);
const app = new Hono<{ Bindings: Env }>();

function logPath(path: string): string {
    if (path === '/api/health' || path === '/api/config') return path;
    if (path.startsWith('/api/auth/reset-password/')) return '/api/auth/reset-password/:token';
    const endpoint = path.slice('/api/auth'.length);
    return path.startsWith('/api/auth/') && Object.hasOwn(routes, endpoint) ? `/api/auth${endpoint}` : '/api/unknown';
}

const contentSecurityPolicy = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'", 'https://challenges.cloudflare.com'],
    frameSrc: ['https://challenges.cloudflare.com'],
    formAction: ["'self'"],
    baseUri: ["'none'"],
    frameAncestors: ["'none'"],
};
const headers = {
    referrerPolicy: 'no-referrer',
    xFrameOptions: 'DENY',
} as const;
const productionHeaders = secureHeaders({ ...headers, contentSecurityPolicy });
// Native logout uses a browser form and its own document CSP. Send only the
// origin as Referer so a same-origin form keeps a usable Origin header.
const logoutHeaders = secureHeaders({ ...headers, referrerPolicy: 'strict-origin' });
const developmentHeaders = secureHeaders({
    ...headers,
    contentSecurityPolicy: {
        ...contentSecurityPolicy,
        scriptSrc: [...contentSecurityPolicy.scriptSrc, "'unsafe-inline'"],
        connectSrc: [...contentSecurityPolicy.connectSrc, 'ws://localhost:5173'],
    },
});
app.use('*', (c, next) => {
    if (c.req.path === '/api/auth/oauth2/end-session' || c.req.path === '/api/auth/oauth2/end-session/confirm') return logoutHeaders(c, next);
    return (c.env.APP_ENV === 'development' ? developmentHeaders : productionHeaders)(c, next);
});

app.use('/api/*', async (c, next) => {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Request-ID', requestId);
    console.log(JSON.stringify({ event: 'http_request', requestId, method: c.req.method, path: logPath(c.req.path), status: c.res.status, durationMs: Date.now() - started }));
});
app.use('/api/*', bodyLimit({ maxSize: 16_384, onError: (c) => c.json({ code: 'PAYLOAD_TOO_LARGE' }, 413) }));

app.get('/api/health', (c) => c.json({ status: 'ok' }));
app.get('/api/config', (c) => {
    validateConfig(c.env);
    return c.json({ turnstileSiteKey: c.env.TURNSTILE_SITE_KEY });
});

app.route('/api/admin/applications', applications);
app.route('/api/oauth', consent);
app.all('/.well-known/oauth-authorization-server/api/auth', async (c) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Cache-Control', 'no-store');
    const response = await createAuth(c.env).handler(c.req.raw);
    return c.newResponse(response.body, response);
});
app.use('/api/auth/*', async (c, next) => {
    if (Object.hasOwn(protocolRoutes, c.req.path.slice('/api/auth'.length))) return oauth.fetch(c.req.raw, c.env, c.executionCtx);
    await next();
});

app.all('/api/auth/*', async (c) => {
    const path = c.req.path.slice('/api/auth'.length);
    const methods = routes[path];
    if (!methods) return c.json({ code: 'NOT_FOUND' }, 404);
    if (!methods.includes(c.req.method)) return c.json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    validateConfig(c.env);
    if (c.req.method === 'POST' && c.req.header('origin') !== c.env.AUTH_URL) return c.json({ code: 'INVALID_ORIGIN' }, 403);

    let body: Record<string, unknown> = {};
    if (c.req.method === 'POST') {
        if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return c.json({ code: 'INVALID_INPUT' }, 400);
        try {
            const parsed: unknown = await c.req.raw.clone().json();
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return c.json({ code: 'INVALID_INPUT' }, 400);
            body = parsed as Record<string, unknown>;
        } catch {
            return c.json({ code: 'INVALID_INPUT' }, 400);
        }
        if (Object.keys(body).some((key) => !fields[path]?.includes(key))) return c.json({ code: 'INVALID_INPUT' }, 400);
        if (body.locale !== undefined && !isLocale(body.locale)) return c.json({ code: 'INVALID_INPUT' }, 400);
        if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100)) return c.json({ code: 'INVALID_INPUT' }, 400);
        if (body.username !== undefined && typeof body.username !== 'string') return c.json({ code: 'INVALID_INPUT' }, 400);
        if (path === '/change-password' && body.revokeOtherSessions !== true) return c.json({ code: 'INVALID_INPUT' }, 400);
    }

    // Validate all user-controlled navigation values before the auth handler sees them.
    const url = new URL(c.req.url);
    if (path === '/admin/list-users') {
        const allowed = ['limit', 'offset', 'sortBy', 'sortDirection', 'filterField', 'filterOperator', 'filterValue'];
        if ([...url.searchParams.keys()].some((key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) return c.json({ code: 'INVALID_INPUT' }, 400);
        const limit = url.searchParams.get('limit');
        const offset = url.searchParams.get('offset');
        if (limit !== null && (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100)) return c.json({ code: 'INVALID_INPUT' }, 400);
        if (offset !== null && (!Number.isSafeInteger(Number(offset)) || Number(offset) < 0)) return c.json({ code: 'INVALID_INPUT' }, 400);
        const sort = url.searchParams.get('sortBy');
        const direction = url.searchParams.get('sortDirection');
        if (sort !== null && !['name', 'email', 'createdAt'].includes(sort)) return c.json({ code: 'INVALID_INPUT' }, 400);
        if (direction !== null && !['asc', 'desc'].includes(direction)) return c.json({ code: 'INVALID_INPUT' }, 400);
        const filtered = ['filterField', 'filterOperator', 'filterValue'].some((key) => url.searchParams.has(key));
        // D1 limits LIKE/GLOB patterns to 50 bytes. The v1 console supports
        // exact email lookup through Better Auth's native equality filter.
        if (filtered && (url.searchParams.get('filterField') !== 'email' || url.searchParams.get('filterOperator') !== 'eq' || !url.searchParams.get('filterValue'))) return c.json({ code: 'INVALID_INPUT' }, 400);
    }
    for (const value of [body.callbackURL, body.redirectTo, url.searchParams.get('callbackURL')]) {
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') return c.json({ code: 'INVALID_CALLBACK_URL' }, 400);
        try {
            const callback = new URL(value, c.env.AUTH_URL);
            if (callback.origin !== c.env.AUTH_URL || !/^\/(en-us|zh-cn)(\/[a-z0-9/-]*)?$/.test(callback.pathname)) return c.json({ code: 'INVALID_CALLBACK_URL' }, 400);
        } catch {
            return c.json({ code: 'INVALID_CALLBACK_URL' }, 400);
        }
    }

    const delivery = { failed: false };
    const auth = createAuth(c.env, delivery, (task) => c.executionCtx.waitUntil(task));
    if (privatePaths.has(path) || path.startsWith('/admin/') || path === '/get-session') {
        const identity = await auth.api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
        if (!identity && path !== '/get-session') return c.json({ code: 'UNAUTHORIZED' }, 401);
        if (identity) {
            const current = await c.env.DB.prepare('SELECT "banned", "role" FROM "user" WHERE "id" = ?').bind(identity.user.id).first<{ banned: number | null; role: string | null }>();
            if (!current || current.banned) return c.json({ code: 'USER_BANNED' }, 403);
            if (path.startsWith('/admin/')) {
                if (current.role !== 'admin') return c.json({ code: 'FORBIDDEN' }, 403);
                if (c.req.method === 'POST') {
                    if (typeof body.userId !== 'string') return c.json({ code: 'INVALID_INPUT' }, 400);
                    const target = await c.env.DB.prepare('SELECT "role" FROM "user" WHERE "id" = ?').bind(body.userId).first<{ role: string | null }>();
                    if (!target) return c.json({ code: 'USER_NOT_FOUND' }, 404);
                    if (target.role !== 'user') return c.json({ code: 'ADMIN_ACCOUNT_PROTECTED' }, 403);
                }
            }
        }
    }

    const response = await auth.handler(c.req.raw);
    if (delivery.failed) return c.json({ code: 'EMAIL_DELIVERY_FAILED' }, 503);
    if (response.status >= 500) {
        // A secondary reservation can win after the signup preflight. The
        // database rolls back signup; expose the same address-conflict result.
        if (path === '/sign-up/email' && typeof body.email === 'string') {
            const reserved = await c.env.DB.prepare('SELECT 1 FROM "userEmail" WHERE "email" = ?')
                .bind(body.email.toLowerCase()).first();
            if (reserved) return c.json({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' }, 400);
        }
        console.error(JSON.stringify({ event: 'auth_request_failed', path: logPath(c.req.path), status: response.status }));
        return c.json({ code: 'REQUEST_FAILED' }, 503);
    }
    return response;
});

app.all('/api/*', (c) => c.json({ code: 'NOT_FOUND' }, 404));
app.all('*', async (c) => {
    if (!['GET', 'HEAD'].includes(c.req.method)) return c.text('Method not allowed', 405);
    const page = /^\/(en-us|zh-cn)\/?$/.test(c.req.path)
        || /^\/(en-us|zh-cn)\/(login|signup|verify-email|verified|forgot-password|reset-password|consent|account|account\/emails|account\/security|account\/sessions|admin\/users|admin\/users\/detail|admin\/applications|admin\/applications\/new|admin\/applications\/detail)\/?$/.test(c.req.path);
    const asset = c.req.path.startsWith('/assets/') || c.req.path === '/favicon.svg'
        || (c.env.APP_ENV === 'development' && ['/node_modules/', '/@', '/src/'].some((prefix) => c.req.path.startsWith(prefix)));
    if (c.req.path !== '/' && !page && !asset) return c.text('Not found', 404);
    const response = await c.env.ASSETS.fetch(c.req.raw);
    const headers = new Headers(response.headers);
    if (headers.get('content-type')?.includes('text/html')) headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
});
app.onError((error, c) => {
    const configuration = error instanceof ConfigurationError;
    console.error(JSON.stringify({ event: configuration ? 'configuration_error' : 'request_failed', ...(configuration ? { reason: error.message } : {}), path: logPath(c.req.path) }));
    return c.json({ code: configuration ? 'CONFIGURATION_ERROR' : 'REQUEST_FAILED' }, 503);
});

export default app;
