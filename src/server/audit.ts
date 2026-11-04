import { Hono, type MiddlewareHandler } from 'hono';
import { parseSigned } from 'hono/utils/cookie';
import { createAuthMiddleware, isAPIError } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { decodeJwt } from 'jose';
import type { Env } from './config';
import { createAuth } from './auth';
import { databaseRateLimit } from './rate-limit';
import { PaginationError, pageBoundary, pageResult, readPageInput } from './pagination';
import { browserAccounts } from './browser-accounts';

export const auditRetention = 90 * 24 * 60 * 60_000;
export const auditRequestHeader = 'X-Loginflare-Request-ID';
export interface AuditEvent {
    event: string;
    outcome: 'success' | 'failure';
    actorUserId?: string | null;
    targetUserId?: string | null;
    clientId?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    reason?: string | null;
    requestId?: string;
}
interface AuditRow extends AuditEvent {
    id: string; ipAddress: string | null; userAgent: string | null; createdAt: string;
}
const fields = '"id", "event", "outcome", "actorUserId", "targetUserId", "clientId", "targetType", "targetId", "reason", "requestId", "ipAddress", "userAgent", "createdAt"';
const text = (value: unknown, maximum = 255) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const code = (value: unknown) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(value) ? value : null;

/** Only allowlisted event fields are persisted; request bodies and credentials never enter this schema. */
export function auditStatement(env: Pick<Env, 'DB'>, event: AuditEvent, headers?: Headers): D1PreparedStatement {
    const now = Date.now();
    return env.DB.prepare(`INSERT INTO "auditLog" (${fields}, "expiresAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), code(event.event) ?? 'operation', event.outcome,
            text(event.actorUserId), text(event.targetUserId), text(event.clientId), code(event.targetType), text(event.targetId), code(event.reason),
            text(event.requestId ?? headers?.get(auditRequestHeader), 100) ?? crypto.randomUUID(),
            text(headers?.get('CF-Connecting-IP'), 64), text(headers?.get('User-Agent'), 512), new Date(now).toISOString(), now + auditRetention);
}
export async function writeAudit(env: Pick<Env, 'DB'>, event: AuditEvent, headers?: Headers): Promise<void> {
    await auditStatement(env, event, headers).run();
}

export const auditLogs = new Hono<{ Bindings: Env }>();
auditLogs.onError((error, c) => {
    if (error instanceof PaginationError) return c.json({ code: error.code }, 400);
    throw error;
});
auditLogs.use('*', async (c, next) => {
    if (c.req.method !== 'GET') return c.json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    const identity = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
    if (!identity) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (identity.user.role !== 'admin' || identity.user.banned || !identity.user.emailVerified) return c.json({ code: 'FORBIDDEN' }, 403);
    const rate = await databaseRateLimit(c.env.DB).consume(`loginflare:audit-read:${identity.user.id}`, { window: 60, max: 100 });
    if (!rate.allowed) { c.header('Retry-After', String(rate.retryAfter)); return c.json({ code: 'TOO_MANY_REQUESTS' }, 429); }
    await next();
});
auditLogs.get('/', async (c) => {
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'audit-logs', 'loginflare', ['event', 'outcome', 'actorUserId', 'targetUserId', 'clientId']);
    const boundary = pageBoundary(input, 'id');
    const filter = input.lookupField ? ` AND "${input.lookupField}" = ?` : '';
    const rows = await c.env.DB.prepare(`SELECT ${fields} FROM "auditLog" WHERE "expiresAt" > ?${filter}${boundary.sql}
        ORDER BY "createdAt" ${boundary.order}, "id" ${boundary.order} LIMIT ?`)
        .bind(Date.now(), ...(input.lookupValue ? [input.lookupValue] : []), ...boundary.values, input.limit + 1).all<AuditRow>();
    return c.json(await pageResult(rows.results, input, c.env.BETTER_AUTH_SECRET, (item) => ({ createdAt: item.createdAt, id: item.id })));
});
auditLogs.get('/:id', async (c) => {
    if (!/^[a-f0-9-]{36}$/.test(c.req.param('id')) || new URL(c.req.url).search) return c.json({ code: 'INVALID_INPUT' }, 400);
    const row = await c.env.DB.prepare(`SELECT ${fields} FROM "auditLog" WHERE "id" = ? AND "expiresAt" > ?`).bind(c.req.param('id'), Date.now()).first<AuditRow>();
    return row ? c.json(row) : c.json({ code: 'AUDIT_LOG_NOT_FOUND' }, 404);
});

async function responseBody(response: Response): Promise<Record<string, unknown> | null> {
    if (!response.headers.get('content-type')?.includes('application/json') || !response.body) return null;
    const reader = response.clone().body!.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength;
        if (length > 16_384) { void reader.cancel(); return null; }
        chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch { return null; }
}

/** Read only the request-local canonical session selected by the browser boundary. */
async function requestActor(env: Env, headers: Headers, browserOperation = false): Promise<string | null> {
    if (browserOperation) {
        // Browser registry endpoints retain every account's cookie. Their
        // shared canonical cookie is not this tab's selected identity.
        const active = (await browserAccounts(env, headers)).filter((account) => account.status === 'active');
        const selected = headers.get('X-Loginflare-Account');
        return (selected ? active.find((account) => account.id === selected) : active.length === 1 ? active[0] : null)?.user.id ?? null;
    }
    const name = `${env.APP_ENV === 'development' ? '' : '__Secure-'}better-auth.session_token`;
    const token = (await parseSigned(headers.get('cookie') ?? '', env.BETTER_AUTH_SECRET, name))[name];
    if (typeof token !== 'string') return null;
    return env.DB.prepare('SELECT "userId" FROM "session" WHERE "token" = ? AND "expiresAt" > ?')
        .bind(token, new Date().toISOString()).first<string>('userId');
}

const nativeEvents: Record<string, string> = {
    '/sign-up/email': 'user.registered', '/verify-email': 'email.verified', '/sign-in/email': 'authentication.sign_in', '/sign-in/username': 'authentication.sign_in',
    '/sign-out': 'authentication.sign_out', '/update-user': 'user.updated', '/change-password': 'password.changed', '/reset-password': 'password.reset',
    '/revoke-session': 'session.revoked', '/revoke-other-sessions': 'session.others_revoked',
    '/two-factor/enable': 'mfa.enrollment_started', '/two-factor/disable': 'mfa.disabled', '/two-factor/generate-backup-codes': 'mfa.recovery_codes_rotated',
    '/two-factor/verify-totp': 'mfa.verified', '/two-factor/verify-backup-code': 'mfa.verified',
    '/social/start': 'social.authentication_started', '/social/verify-email': 'social.email_verified', '/social/finish': 'social.authentication_completed',
    '/social/unlink': 'social.unlinked', '/social/set-password': 'password.created',
    '/emails/add': 'email.added', '/emails/resend': 'email.verification_sent', '/emails/verify': 'email.verified', '/emails/set-primary': 'email.primary_changed', '/emails/remove': 'email.removed',
    '/emails/recovery/start': 'password.recovery_started', '/emails/recovery/verify': 'password.recovery_verified',
    '/admin/ban-user': 'user.suspended', '/admin/unban-user': 'user.restored', '/admin/revoke-user-sessions': 'user.sessions_revoked',
    '/oauth2/authorize': 'oauth.authorization_started', '/oauth2/continue': 'oauth.account_selected',
    '/oauth2/token': 'oauth.token_issued', '/oauth2/consent': 'oauth.consent', '/oauth2/revoke': 'oauth.token_revoked',
    '/oauth2/end-session': 'oauth.end_session', '/oauth2/end-session/confirm': 'oauth.end_session',
};

/** Install last: MFA, registration limits and provider policy must finish before success is recorded. */
export function auditAuthentication(env: Env): BetterAuthPlugin {
    const matcher = (ctx: { path?: string }) => !!nativeEvents[ctx.path ?? ''] || ctx.path === '/callback/:id';
    return { id: 'loginflare-audit', hooks: { before: [{ matcher, handler: createAuthMiddleware(async (ctx) => {
        const actorUserId = ctx.headers && !ctx.path?.startsWith('/oauth2/') ? await requestActor(env, ctx.headers) : null;
        return { context: { loginflareAuditActor: actorUserId } };
    }) }], after: [{
        matcher,
        handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.headers) return;
            const path = ctx.path ?? '', returned: unknown = ctx.context.returned;
            const response = returned instanceof Response ? returned : null;
            const payload = response ? await responseBody(response) : returned && typeof returned === 'object' ? returned as Record<string, unknown> : null;
            const error = isAPIError(returned) ? returned : null;
            const location = (error?.headers ? new Headers(error.headers).get('location') : null) ?? response?.headers.get('location');
            let redirectError: string | null = null;
            if (location) { try { redirectError = code(new URL(location, env.AUTH_URL).searchParams.get('error')); } catch { /* Invalid navigation is reported by the provider. */ } }
            const failed = !!error && error.statusCode >= 400 || !!response && response.status >= 400 || !!redirectError;
            const challenge = !failed && payload?.twoFactorRedirect === true;
            let event = nativeEvents[path] ?? 'social.callback';
            if (challenge) event = 'authentication.challenge';
            if (path === '/oauth2/consent' && ctx.body?.accept === false && !failed) event = 'oauth.consent_denied';
            const next = !failed ? ctx.context.newSession : null;
            const beforeActor = text((ctx.context as Record<string, unknown>).loginflareAuditActor);
            let actorUserId = !path.startsWith('/oauth2/') ? next?.user.id ?? ctx.context.session?.user.id ?? beforeActor : null;
            const returnedUser = payload?.user && typeof payload.user === 'object' ? payload.user as Record<string, unknown> : null;
            const candidateTarget = path.startsWith('/admin/') ? text(ctx.body?.userId) : !failed && path === '/sign-up/email' ? text(returnedUser?.id) : actorUserId;
            let targetUserId = candidateTarget ? await env.DB.prepare('SELECT "id" FROM "user" WHERE "id" = ?').bind(candidateTarget).first<string>('id') : null;
            let clientId: string | null = null;
            if (path === '/oauth2/token' && !failed && payload) {
                // These are token responses produced by the provider itself, never caller-supplied JWTs.
                for (const value of [payload.access_token, payload.id_token]) {
                    if (typeof value !== 'string' || value.length > 16_384 || value.split('.').length !== 3) continue;
                    try {
                        const claims = decodeJwt(value);
                        clientId ??= text(claims.client_id) ?? (typeof claims.aud === 'string' ? text(claims.aud) : null);
                        if (text(claims.sub)) targetUserId = await env.DB.prepare('SELECT "id" FROM "user" WHERE "id" = ?').bind(claims.sub!).first<string>('id');
                    } catch { /* Opaque tokens do not contain audit identity claims. */ }
                }
            }
            if (path.startsWith('/oauth2/')) {
                const candidate = clientId ?? text(ctx.body?.client_id) ?? text(ctx.query?.client_id);
                clientId = candidate ? await env.DB.prepare('SELECT "clientId" FROM "oauthClient" WHERE "clientId" = ?').bind(candidate).first<string>('clientId') : null;
                if (!['/oauth2/token', '/oauth2/revoke'].includes(path)) targetUserId = ctx.context.session?.user.id ?? null;
            }
            if (['/sign-in/email', '/sign-in/username'].includes(path) && (failed || challenge)) { actorUserId = null; targetUserId = null; }
            const nativeError = redirectError ?? (error ? error.body?.code ?? error.body?.error : payload?.code ?? payload?.error);
            const entry: AuditEvent = { event, outcome: failed ? 'failure' : 'success', actorUserId, targetUserId, clientId,
                reason: failed ? code(nativeError) ?? (response ? `HTTP_${response.status}` : 'AUTHENTICATION_FAILED') : null,
                targetType: path.startsWith('/admin/') ? 'user' : path.startsWith('/oauth2/') ? 'application' : null,
                targetId: path.startsWith('/admin/') ? targetUserId : clientId };
            const completedMfaSignIn = path.startsWith('/two-factor/verify-') && !failed && next && !ctx.context.session;
            await env.DB.batch([auditStatement(env, entry, ctx.headers), ...(completedMfaSignIn
                ? [auditStatement(env, { ...entry, event: 'authentication.sign_in' }, ctx.headers)] : [])]);
        }),
    }] } };
}

function httpEvent(path: string, method: string): { event: string; targetType: string; targetId: string | null } | null {
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
    let match = /^\/api\/(admin|developer)\/applications(?:\/([^/]+))?(?:\/(rotate-secret))?$/.exec(path);
    if (match) return { event: match[3] ? 'application.secret_rotated' : method === 'POST' ? 'application.created' : 'application.updated', targetType: 'application', targetId: text(match[2]) };
    match = /^\/api\/admin\/social-connections(?:\/([^/]+))?(?:\/(test))?$/.exec(path);
    if (match) return { event: match[3] ? 'connector.test_started' : match[2] === 'icon' ? 'connector.icon_uploaded' : method === 'POST' ? 'connector.created' : method === 'DELETE' ? 'connector.deleted' : 'connector.updated', targetType: 'connector', targetId: text(match[2]) };
    if (path === '/api/admin/branding' || path === '/api/admin/branding/logo') return { event: method === 'POST' ? 'branding.logo_uploaded' : 'branding.updated', targetType: 'branding', targetId: null };
    if (path === '/api/account/avatar') return { event: method === 'DELETE' ? 'avatar.removed' : 'avatar.updated', targetType: 'user', targetId: null };
    match = /^\/api\/account\/applications\/([^/]+)\/revoke$/.exec(path);
    if (match) return { event: 'oauth.application_revoked', targetType: 'application', targetId: text(match[1]) };
    match = /^\/api\/browser\/accounts\/([^/]+)\/sign-out$/.exec(path);
    if (match) return { event: 'browser.account_signed_out', targetType: 'browser_account', targetId: text(match[1]) };
    if (path === '/api/browser/accounts/sign-out-all') return { event: 'browser.all_signed_out', targetType: 'browser', targetId: null };
    match = /^\/api\/browser\/accounts\/([^/]+)$/.exec(path);
    if (match && method === 'DELETE') return { event: 'browser.account_removed', targetType: 'browser_account', targetId: text(match[1]) };
    return null;
}

async function knownTarget(env: Env, headers: Headers, targetType: string, candidate: string | null): Promise<string | null> {
    if (!candidate) return null;
    if (targetType === 'application') return env.DB.prepare('SELECT "clientId" FROM "oauthClient" WHERE "clientId" = ?').bind(candidate).first<string>('clientId');
    if (targetType === 'connector') return env.DB.prepare('SELECT "id" FROM "socialConnection" WHERE "id" = ?').bind(candidate).first<string>('id');
    if (targetType === 'user') return env.DB.prepare('SELECT "id" FROM "user" WHERE "id" = ?').bind(candidate).first<string>('id');
    if (targetType === 'browser_account') return (await browserAccounts(env, headers)).find((account) => account.id === candidate)?.id ?? null;
    return null;
}

/** Independent audit observation for Loginflare-managed mutations outside the native auth endpoints. */
export const observeAudit: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    const selection = httpEvent(c.req.path, c.req.method);
    if (!selection) return next();
    const actorUserId = await requestActor(c.env, c.req.raw.headers, c.req.path.startsWith('/api/browser/'));
    const originalTarget = await knownTarget(c.env, c.req.raw.headers, selection.targetType, selection.targetId);
    await next();
    const failed = c.res.status >= 400;
    const payload = await responseBody(c.res);
    const application = payload?.application && typeof payload.application === 'object' ? payload.application as Record<string, unknown> : null;
    const candidate = text(application?.clientId) ?? text(payload?.clientId) ?? text(payload?.id) ?? (selection.targetType === 'user' ? actorUserId : null);
    const targetId = originalTarget ?? await knownTarget(c.env, c.req.raw.headers, selection.targetType, candidate);
    await writeAudit(c.env, { ...selection, targetId, actorUserId, targetUserId: selection.targetType === 'user' ? actorUserId : null,
        clientId: selection.targetType === 'application' ? targetId : null,
        outcome: failed ? 'failure' : 'success', reason: failed ? code(payload?.code) ?? `HTTP_${c.res.status}` : null }, c.req.raw.headers);
};
