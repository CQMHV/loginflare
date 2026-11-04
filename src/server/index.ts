import { Hono } from 'hono';
import { APIError } from 'better-auth/api';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { createAuth } from './auth';
import { ConfigurationError, validateConfig, type Env } from './config';
import { isLocale } from '../shared/locales';
import { applications, developerApplications } from './applications';
import { accountApplications } from './account-applications';
import { consent, oauth, protocolRoutes } from './oauth';
import { management } from './management';
import { maintainDatabase } from './maintenance';
import { avatars } from './avatars';
import { maximumImageBytes } from '../shared/image-limits';
import { branding } from './branding';
import { publicBranding, readBranding } from './branding-settings';
import { socialConnections, connection } from './social-connections';
import { databaseRateLimit } from './rate-limit';
import { browserRequest, browserRoutes, signOutBrowserAccount } from './browser-accounts';

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
    '/verify-password': ['POST'],
    '/change-password': ['POST'],
    '/revoke-session': ['POST'],
    '/revoke-other-sessions': ['POST'],
    '/two-factor/enable': ['POST'],
    '/two-factor/disable': ['POST'],
    '/two-factor/verify-totp': ['POST'],
    '/two-factor/verify-backup-code': ['POST'],
    '/two-factor/generate-backup-codes': ['POST'],
    '/social/start': ['POST'],
    '/social/flow': ['GET'],
    '/social/email': ['POST'],
    '/social/verify-email': ['POST'],
    '/social/finish': ['POST'],
    '/social/avatar-source': ['GET'],
    '/social/security': ['GET'],
    '/social/unlink': ['POST'],
    '/social/set-password': ['POST'],
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
    '/verify-password': ['password'],
    '/change-password': ['currentPassword', 'newPassword', 'revokeOtherSessions'],
    '/revoke-session': ['token'],
    '/revoke-other-sessions': [],
    '/two-factor/enable': ['password'],
    '/two-factor/disable': ['password'],
    '/two-factor/verify-totp': ['code', 'oauth_query'],
    '/two-factor/verify-backup-code': ['code', 'oauth_query'],
    '/two-factor/generate-backup-codes': ['password'],
    '/social/start': ['connectionId', 'locale', 'purpose', 'action', 'oauth_query', 'password'],
    '/social/email': ['email'],
    '/social/verify-email': ['code'],
    '/social/finish': [],
    '/social/unlink': ['accountId', 'password'],
    '/social/set-password': ['newPassword'],
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

const privatePaths = new Set(['/update-user', '/verify-password', '/change-password', '/revoke-session', '/revoke-other-sessions',
    '/emails', '/emails/add', '/emails/resend', '/emails/verify', '/emails/set-primary', '/emails/remove',
    '/two-factor/enable', '/two-factor/disable', '/two-factor/generate-backup-codes',
    '/social/security', '/social/unlink', '/social/set-password', '/social/avatar-source']);
const app = new Hono<{ Bindings: Env }>();

function logPath(path: string): string {
    if (['/api/browser/accounts', '/api/browser/accounts/select', '/api/browser/accounts/sign-out-all', '/api/browser/auth-flows'].includes(path)) return path;
    if (/^\/api\/browser\/accounts\/[^/]+\/sign-out$/.test(path)) return '/api/browser/accounts/:id/sign-out';
    if (/^\/api\/browser\/accounts\/[^/]+$/.test(path)) return '/api/browser/accounts/:id';
    if (/^\/api\/browser\/auth-flows\/[^/]+$/.test(path)) return '/api/browser/auth-flows/:id';
    if (/^\/api\/auth\/callback\/[^/]+$/.test(path)) return '/api/auth/callback/:id';
    if (path === '/api/social/providers' || path === '/api/admin/social-connections' || path === '/api/admin/social-connections/icon') return path;
    if (/^\/api\/admin\/social-connections\/[^/]+$/.test(path)) return '/api/admin/social-connections/:id';
    if (['/api/health', '/api/config', '/api/branding', '/api/admin/branding', '/api/admin/branding/logo'].includes(path)) return path;
    if (path === '/api/admin/users' || path === '/api/account/sessions' || path === '/api/account/applications') return path;
    if (/^\/api\/account\/applications\/[^/]+\/revoke$/.test(path)) return '/api/account/applications/:clientId/revoke';
    if (path === '/api/account/avatar') return path;
    if (/^\/api\/(admin|developer)\/applications$/.test(path)) return path;
    if (/^\/api\/(admin|developer)\/applications\/[^/]+\/rotate-secret$/.test(path)) return path.replace(/\/applications\/[^/]+\/rotate-secret$/, '/applications/:clientId/rotate-secret');
    if (/^\/api\/(admin|developer)\/applications\/[^/]+$/.test(path)) return path.replace(/\/applications\/[^/]+$/, '/applications/:clientId');
    if (path === '/api/oauth/consent') return path;
    if (path.startsWith('/api/auth/') && Object.hasOwn(protocolRoutes, path.slice('/api/auth'.length))) return path;
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
const avatarHeaders = secureHeaders({ ...headers, crossOriginResourcePolicy: 'cross-origin', contentSecurityPolicy: { defaultSrc: ["'none'"], sandbox: [] } });
const brandingHeaders = secureHeaders({ ...headers, contentSecurityPolicy: { defaultSrc: ["'none'"], styleSrc: ["'unsafe-inline'"], sandbox: [] } });
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
    if (/^\/(branding\/logos|social\/icons)\/[^/]+$/.test(c.req.path)) return brandingHeaders(c, next);
    if (/^\/avatars\/[^/]+$/.test(c.req.path)) return avatarHeaders(c, next);
    if (c.req.path === '/api/auth/oauth2/end-session' || c.req.path === '/api/auth/oauth2/end-session/confirm') return logoutHeaders(c, next);
    return (c.env.APP_ENV === 'development' ? developmentHeaders : productionHeaders)(c, next);
});

app.use('/api/*', async (c, next) => {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Request-ID', requestId);
    if (c.env.APP_ENV === 'development' || c.res.status >= 500 || crypto.getRandomValues(new Uint32Array(1))[0]! < 0x1_0000_0000 * 0.01) {
        console.log(JSON.stringify({ event: 'http_request', requestId, method: c.req.method, path: logPath(c.req.path), status: c.res.status, durationMs: Date.now() - started }));
    }
});
app.use('/api/*', (c, next) => {
    const imageUpload = c.req.method === 'POST' && ['/api/account/avatar', '/api/admin/branding/logo', '/api/admin/social-connections/icon'].includes(c.req.path);
    return bodyLimit({
        maxSize: imageUpload ? maximumImageBytes : 16_384,
        onError: (c) => c.json({ code: imageUpload ? 'IMAGE_UPLOAD_TOO_LARGE' : 'PAYLOAD_TOO_LARGE' }, 413),
    })(c, next);
});

app.get('/api/health', (c) => c.json({ status: 'ok' }));
app.get('/api/config', (c) => {
    validateConfig(c.env);
    return c.json({ turnstileSiteKey: c.env.TURNSTILE_SITE_KEY });
});

app.route('/api/admin/applications', applications);
app.route('/api/browser', browserRoutes);
app.route('/api/developer/applications', developerApplications);
app.route('/api/account/applications', accountApplications);
app.route('/api', management);
app.route('/api/oauth', consent);
app.route('/', avatars);
app.route('/', branding);
app.route('/', socialConnections);
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
    const callbackId = /^\/callback\/([a-f0-9-]{36})$/.exec(path)?.[1];
    const methods = callbackId ? ['GET'] : routes[path];
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
    if (path === '/social/start' && body.purpose && body.purpose !== 'login') {
        const identity = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
        if (!identity) return c.json({ code: 'UNAUTHORIZED' }, 401);
        if (identity.user.banned || !identity.user.emailVerified || (body.purpose === 'test' && identity.user.role !== 'admin')) return c.json({ code: 'FORBIDDEN' }, 403);
    }
    const selectedId = callbackId ?? (path === '/social/start' && typeof body.connectionId === 'string' ? body.connectionId : undefined);
    if (selectedId) {
        const rate = await databaseRateLimit(c.env.DB).consume(`social:initialize:${c.req.header('cf-connecting-ip') ?? 'unknown'}`, { window: 60, max: 40 });
        if (!rate.allowed) return c.json({ code: 'TOO_MANY_REQUESTS' }, 429);
    }
    const selected = selectedId ? await connection(c.env, selectedId, !!callbackId || body.purpose === 'test') : null;
    if (selectedId && !selected) return c.json({ code: 'SOCIAL_CONNECTION_NOT_FOUND' }, 404);
    const auth = createAuth(c.env, delivery, (task) => c.executionCtx.waitUntil(task), selected ?? undefined);
    if (privatePaths.has(path) || path.startsWith('/admin/') || path === '/get-session') {
        const identity = await auth.api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
        if (!identity && path !== '/get-session') return c.json({ code: 'UNAUTHORIZED' }, 401);
        if (identity) {
            if (identity.user.banned) return c.json({ code: 'USER_BANNED' }, 403);
            if (path.startsWith('/admin/')) {
                if (identity.user.role !== 'admin') return c.json({ code: 'FORBIDDEN' }, 403);
                if (c.req.method === 'POST') {
                    if (typeof body.userId !== 'string') return c.json({ code: 'INVALID_INPUT' }, 400);
                    const target = await c.env.DB.prepare('SELECT "role" FROM "user" WHERE "id" = ?').bind(body.userId).first<{ role: string | null }>();
                    if (!target) return c.json({ code: 'USER_NOT_FOUND' }, 404);
                    if (target.role !== 'user') return c.json({ code: 'ADMIN_ACCOUNT_PROTECTED' }, 403);
                }
            }
        }
    }

    const response = (path === '/sign-out' ? await signOutBrowserAccount(c.env, c.req.raw.headers) : null) ?? await auth.handler(c.req.raw);
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
        || /^\/(en-us|zh-cn)\/(login|select-account|two-factor|social\/complete|signup|verify-email|verified|forgot-password|reset-password|consent|account|account\/emails|account\/security|account\/sessions|account\/applications|developer|developer\/applications|developer\/applications\/new|developer\/applications\/detail|admin|admin\/users|admin\/users\/detail|admin\/applications|admin\/applications\/detail|admin\/branding|admin\/social-connections)\/?$/.test(c.req.path);
    const asset = c.req.path.startsWith('/assets/') || c.req.path === '/favicon.svg'
        || (c.env.APP_ENV === 'development' && ['/node_modules/', '/@', '/src/'].some((prefix) => c.req.path.startsWith(prefix)));
    if (c.req.path !== '/' && !page && !asset) return c.text('Not found', 404);
    const response = await c.env.ASSETS.fetch(c.req.raw);
    const headers = new Headers(response.headers);
    if (headers.get('content-type')?.includes('text/html')) headers.set('Cache-Control', 'no-store');
    const document = new Response(response.body, { status: response.status, headers });
    if ((page || c.req.path === '/') && headers.get('content-type')?.includes('text/html')) {
        const value = publicBranding(await readBranding(c.env.DB));
        return new HTMLRewriter()
            .on('html', { element(element) { element.setAttribute('data-branding', JSON.stringify(value).replace(/[<>&]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)); } })
            .on('title', { element(element) { element.setInnerContent(value.name); } })
            .on('meta[name="description"]', { element(element) { element.setAttribute('content', value.name.replaceAll('&', '&amp;')); } })
            .on('link[rel="icon"]', { element(element) { element.setAttribute('href', value.logoUrl); } }).transform(document);
    }
    return document;
});
app.onError((error, c) => {
    if (error instanceof APIError) {
        if (error.statusCode >= 400 && error.statusCode < 500) return new Response(JSON.stringify({ code: error.body?.code ?? 'INVALID_INPUT' }), { status: error.statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    c.header('Cache-Control', 'no-store');
    const configuration = error instanceof ConfigurationError;
    console.error(JSON.stringify({ event: configuration ? 'configuration_error' : 'request_failed', ...(configuration ? { reason: error.message } : {}), path: logPath(c.req.path) }));
    return c.json({ code: configuration ? 'CONFIGURATION_ERROR' : 'REQUEST_FAILED' }, 503);
});

export default {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) => browserRequest(request, env, async (resolved) => app.fetch(resolved, env, ctx)),
    async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(maintainDatabase(env).then((result) => {
            console.log(JSON.stringify({ event: 'database_maintenance', ...result }));
        }).catch(() => {
            console.error(JSON.stringify({ event: 'database_maintenance_failed' }));
            throw new Error('Database maintenance failed');
        }));
    },
};
