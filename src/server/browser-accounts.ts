import { Hono } from 'hono';
import { parse, parseSigned, serialize, serializeSigned } from 'hono/utils/cookie';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { z } from 'zod';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import type { Env } from './config';
import { createAuth } from './auth';
import { databaseRateLimit } from './rate-limit';
import { locales, localizedPath } from '../shared/locales';

const lifetime = 600_000;
const rememberedLifetime = 30 * 24 * 60 * 60_000;
export const maximumBrowserAccounts = 5;
const uuid = z.string().uuid();
const accountHeader = 'X-Loginflare-Account';
const flowHeader = 'X-Loginflare-Flow';
const transientNames = ['two_factor', 'dont_remember', 'social_flow', 'security_proof', 'state', 'oauth_state'];
const loginPaths = new Set(['/api/auth/sign-in/email', '/api/auth/sign-in/username']);
const authenticationPaths = new Set([...loginPaths, '/api/auth/social/start', '/api/auth/two-factor/verify-totp', '/api/auth/two-factor/verify-backup-code']);
const anonymousAuthPaths = new Set(['/api/auth/sign-up/email', '/api/auth/send-verification-email', '/api/auth/verify-email', '/api/auth/reset-password', '/api/auth/emails/recovery/start', '/api/auth/emails/recovery/verify', '/api/auth/error']);
function names(env: Env) {
    const prefix = env.APP_ENV === 'development' ? '' : '__Secure-';
    return { browser: `${prefix}loginflare.browser`, session: `${prefix}better-auth.session_token`, native: `${prefix}better-auth.` };
}
const attributes = (env: Env) => ({ path: '/', httpOnly: true, secure: env.APP_ENV !== 'development', sameSite: 'Lax' as const });
function replaceRequestCookie(headers: Headers, cookie: string) {
    const pair = cookie.split(';', 1)[0]!;
    const name = pair.slice(0, pair.indexOf('='));
    const other = (headers.get('cookie') ?? '').split(';').map((value) => value.trim())
        .filter((value) => value && value.split('=', 1)[0] !== name);
    headers.set('cookie', [...other, pair].join('; '));
}
async function digest(value: string) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function browserHash(env: Env, headers: Headers) {
    const value = (await parseSigned(headers.get('cookie') ?? '', env.BETTER_AUTH_SECRET, names(env).browser))[names(env).browser];
    return typeof value === 'string' ? digest(value) : null;
}
export interface BrowserFlow {
    id: string; browserHash: string; kind: 'login' | 'add' | 'reauth' | 'oauth';
    accountId: string | null; targetUserId: string | null; originSessionId: string | null;
    userId: string | null; sessionId: string | null; status: 'pending' | 'authenticated' | 'selected';
    locale: 'en-US' | 'zh-CN'; oauthQuery: string; upstreamState: string | null; expiresAt: number;
}
interface AccountRow {
    id: string; userId: string; sessionId: string | null; token: string | null; sessionExpiresAt: string | null;
    name: string; email: string; image: string | null; role: string | null; banned: number | null; emailVerified: number; lastUsedAt: string; expiresAt: number; rememberMe: number;
}
export interface BrowserAccountSummary {
    id: string; user: { id: string; name: string; email: string; image: string | null; role: string | null };
    status: 'active' | 'signed-out'; lastUsedAt: string;
}
async function accountRows(env: Env, headers: Headers): Promise<AccountRow[]> {
    const hash = await browserHash(env, headers);
    if (!hash) return [];
    return (await env.DB.prepare(`SELECT a."id", a."userId", a."sessionId", a."lastUsedAt", a."expiresAt", a."rememberMe", u."name", u."email", u."image", u."role", u."banned", u."emailVerified",
        s."token", s."expiresAt" AS "sessionExpiresAt" FROM "browserAccount" a JOIN "user" u ON u."id" = a."userId"
        LEFT JOIN "session" s ON s."id" = a."sessionId" WHERE a."browserHash" = ? AND (a."expiresAt" > ? OR s."expiresAt" > ?)
        ORDER BY a."lastUsedAt" DESC, a."id" LIMIT 10`).bind(hash, Date.now(), new Date().toISOString()).all<AccountRow>()).results;
}
async function activeRows(env: Env, headers: Headers, includeUnavailable = false) {
    const cookies = await parseSigned(headers.get('cookie') ?? '', env.BETTER_AUTH_SECRET);
    const sessionName = names(env).session;
    return (await accountRows(env, headers)).filter((row) => row.token && (includeUnavailable || (!row.banned && row.emailVerified))
        && row.sessionExpiresAt! > new Date().toISOString()
        && cookies[`${sessionName}_multi-${row.token.toLowerCase()}`] === row.token);
}
export async function browserAccounts(env: Env, headers: Headers): Promise<BrowserAccountSummary[]> {
    const active = new Set((await activeRows(env, headers)).map((row) => row.id));
    return (await accountRows(env, headers)).filter((row) => row.expiresAt > Date.now() || active.has(row.id)).map((row) => ({ id: row.id,
        user: { id: row.userId, name: row.name, email: row.email, image: row.image, role: row.role },
        status: active.has(row.id) ? 'active' : 'signed-out', lastUsedAt: row.lastUsedAt }));
}
export async function readBrowserFlow(env: Env, headers: Headers): Promise<BrowserFlow | null> {
    const id = headers.get(flowHeader);
    if (!id || !uuid.safeParse(id).success) return null;
    const hash = await browserHash(env, headers);
    if (!hash) return null;
    return env.DB.prepare('SELECT * FROM "browserAuthFlow" WHERE "id" = ? AND "browserHash" = ? AND "expiresAt" > ?')
        .bind(id, hash, Date.now()).first<BrowserFlow>();
}
export async function bindBrowserFlowAccount(env: Env, headers: Headers, accountId: string) {
    const flow = await readBrowserFlow(env, headers);
    const row = (await activeRows(env, headers)).find((item) => item.id === accountId);
    if (!flow || !row || (flow.accountId && flow.accountId !== accountId)) throw new APIError('UNAUTHORIZED', { code: 'BROWSER_ACCOUNT_UNAVAILABLE' });
    await env.DB.prepare(`UPDATE "browserAuthFlow" SET "accountId" = ?, "userId" = ?, "sessionId" = ?, "status" = 'selected'
        WHERE "id" = ? AND "browserHash" = ? AND "expiresAt" > ?`).bind(row.id, row.userId, row.sessionId, flow.id, flow.browserHash, Date.now()).run();
}

/** A request-local cookie view; the browser's shared cookie jar never selects a tab's identity. */
export async function resolveBrowserRequest(request: Request, env: Env): Promise<Request> {
    const headers = new Headers(request.headers);
    const cookies = parse(headers.get('cookie') ?? '');
    const cookieNames = names(env);
    const flow = await readBrowserFlow(env, headers);
    if (headers.has(flowHeader) && !flow) throw new APIError('UNAUTHORIZED', { code: 'BROWSER_FLOW_EXPIRED' });
    const rows = await activeRows(env, headers, true);
    const validTokens = new Set(rows.map((item) => item.token));
    const signed = await parseSigned(headers.get('cookie') ?? '', env.BETTER_AUTH_SECRET);
    for (const name of Object.keys(cookies)) if (name.startsWith(`${cookieNames.session}_multi-`) && !validTokens.has(typeof signed[name] === 'string' ? signed[name] : null)) delete cookies[name];
    const selected = headers.get(accountHeader);
    if (flow?.status !== 'pending' && flow?.accountId && selected && flow.accountId !== selected) throw new APIError('UNAUTHORIZED', { code: 'BROWSER_ACCOUNT_UNAVAILABLE' });
    let row = selected ? rows.find((item) => item.id === selected) : undefined;
    if (selected && !row && !(flow && flow.accountId === selected && flow.kind === 'reauth')) {
        throw new APIError('UNAUTHORIZED', { code: 'BROWSER_ACCOUNT_UNAVAILABLE' });
    }
    const path = new URL(request.url).pathname;
    if (flow) {
        if (flow.status !== 'pending' && flow.accountId) row = rows.find((item) => item.id === flow.accountId);
        else if (flow.kind === 'reauth' && flow.originSessionId && !loginPaths.has(path)
            && !cookies[`${cookieNames.native}two_factor_flow-${flow.id}`]) row = rows.find((item) => item.sessionId === flow.originSessionId);
        else row = undefined;
        for (const name of transientNames) {
            const key = cookieNames.native + name;
            delete cookies[key];
            const scoped = cookies[`${key}_flow-${flow.id}`];
            if (scoped) cookies[key] = scoped;
        }
    } else if (!selected) {
        // Native authorize needs an eligible session before its selectAccount hook.
        if (rows.length === 1 || path === '/api/auth/oauth2/authorize') row = rows[0];
    }
    delete cookies[cookieNames.session];
    delete cookies[`${cookieNames.native}session_data`];
    if (!flow) delete cookies[`${cookieNames.native}dont_remember`];
    if (row?.token) {
        cookies[cookieNames.session] = cookies[`${cookieNames.session}_multi-${row.token.toLowerCase()}`]!;
        if (!selected) headers.set(accountHeader, row.id);
        const rememberCookie = `${cookieNames.native}dont_remember`;
        if (row.rememberMe === 0) {
            const signedCookie = await serializeSigned(rememberCookie, 'true', env.BETTER_AUTH_SECRET, attributes(env));
            cookies[rememberCookie] = parse(signedCookie.split(';', 1)[0]!)[rememberCookie]!;
        } else delete cookies[rememberCookie];
    }
    headers.set('cookie', Object.entries(cookies).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; '));
    return new Request(request, { headers });
}

export function browserSessionPlugin(env: Env): BetterAuthPlugin {
    return { id: 'loginflare-browser-accounts',
        init() { return { options: { databaseHooks: { session: { create: { async before(session, ctx) {
            if (!ctx?.headers) return;
            const flow = await readBrowserFlow(env, ctx.headers);
            if (!flow) {
                if (ctx.headers.has(flowHeader)) throw new APIError('BAD_REQUEST', { code: 'BROWSER_FLOW_EXPIRED' });
                return;
            }
            if (flow.targetUserId && flow.targetUserId !== session.userId) throw new APIError('FORBIDDEN', { code: 'BROWSER_WRONG_ACCOUNT' });
            if (flow.status !== 'pending') {
                if (ctx.context.session?.user.id === session.userId && !['/sign-in/email', '/sign-in/username', '/callback/:id', '/social/verify-email'].includes(ctx.path ?? '')) return;
                throw new APIError('BAD_REQUEST', { code: 'BROWSER_FLOW_EXPIRED' });
            }
            await env.DB.prepare('UPDATE "browserAuthFlow" SET "userId" = ? WHERE "id" = ? AND "status" = ? AND "expiresAt" > ?')
                .bind(session.userId, flow.id, 'pending', Date.now()).run();
        } } } } } }; },
        hooks: { after: [{ matcher: () => true, handler: createAuthMiddleware(async (ctx) => {
            const next = ctx.context.newSession;
            if (!next || !ctx.headers) return;
            const hash = await browserHash(env, ctx.headers);
            if (!hash) return;
            const flow = await readBrowserFlow(env, ctx.headers);
            // /social/finish sets newSession again to resume the provider; it is
            // not a new authentication and must not re-consume the flow.
            const existing = await env.DB.prepare('SELECT "id", "sessionId" FROM "browserAccount" WHERE "browserHash" = ? AND "userId" = ?')
                .bind(hash, next.user.id).first<{ id: string; sessionId: string | null }>();
            if (existing?.sessionId === next.session.id) return;
            try {
                if ((!flow && ctx.headers.has(flowHeader)) || (flow && flow.status !== 'pending' && ctx.context.session?.user.id !== next.user.id)) throw new APIError('BAD_REQUEST', { code: 'BROWSER_FLOW_EXPIRED' });
                const proof = await parseSigned(ctx.headers.get('cookie') ?? '', env.BETTER_AUTH_SECRET);
                const tokens = Object.entries(proof).flatMap(([key, value]) => key.startsWith(`${names(env).session}_multi-`) && typeof value === 'string' ? [value] : []);
                const primary = ctx.context.responseHeaders?.getSetCookie().find((cookie) => cookie.startsWith(`${ctx.context.authCookies.sessionToken.name}=`) && !/Max-Age=0/i.test(cookie));
                const rememberMe = !primary || /Max-Age=|Expires=/i.test(primary);
                await registerSession(env, hash, next.user.id, next.session.id, flow?.status === 'pending' ? flow : null, existing?.id, tokens, rememberMe);
                if (flow && flow.status !== 'pending') await env.DB.prepare('UPDATE "browserAuthFlow" SET "sessionId" = ? WHERE "id" = ?').bind(next.session.id, flow.id).run();
            } catch (error) {
                await ctx.context.internalAdapter.deleteSession(next.session.token);
                ctx.context.setNewSession(null);
                // Never deliver the credentials of a rejected sixth account.
                ctx.context.responseHeaders?.delete('set-cookie');
                throw error;
            }
        }) }] },
    };
}
async function registerSession(env: Env, hash: string, userId: string, sessionId: string, flow: BrowserFlow | null, existingId?: string, provenTokens: string[] = [], rememberMe = true) {
    const id = existingId ?? crypto.randomUUID(), now = new Date().toISOString();
    await env.DB.batch([
        env.DB.prepare(`UPDATE "browserAccount" SET "slot" = NULL, "sessionId" = NULL WHERE "browserHash" = ?
            AND ("sessionId" IS NULL OR NOT EXISTS (SELECT 1 FROM "session" s WHERE s."id" = "browserAccount"."sessionId" AND s."expiresAt" > ?))`).bind(hash, now),
        ...(flow ? [env.DB.prepare(`UPDATE "browserAccount" SET "slot" = NULL, "sessionId" = NULL WHERE "browserHash" = ? AND "lastUsedAt" < ?
            AND "sessionId" IN (SELECT "id" FROM "session" WHERE "token" NOT IN (SELECT value FROM json_each(?)))`)
            .bind(hash, new Date(flow.expiresAt - lifetime).toISOString(), JSON.stringify(provenTokens))] : []),
        env.DB.prepare(`DELETE FROM "browserAccount" WHERE "id" IN (SELECT a."id" FROM "browserAccount" a WHERE a."browserHash" = ? AND a."slot" IS NULL AND a."userId" <> ?
            ORDER BY a."lastUsedAt" DESC, a."id" LIMIT -1 OFFSET max(0, 9 - (SELECT COUNT(*) FROM "browserAccount" WHERE "browserHash" = ? AND "slot" IS NOT NULL AND "userId" <> ?)))`).bind(hash, userId, hash, userId),
        env.DB.prepare(`INSERT INTO "browserAccount" ("id", "browserHash", "userId", "sessionId", "slot", "lastUsedAt", "expiresAt", "rememberMe")
            SELECT ?, ?, ?, ?, coalesce((SELECT "slot" FROM "browserAccount" WHERE "id" = ?),
                (SELECT value FROM json_each('[0,1,2,3,4]') WHERE value NOT IN (SELECT "slot" FROM "browserAccount" WHERE "browserHash" = ? AND "slot" IS NOT NULL) LIMIT 1)), ?, ?, ?
            WHERE ${flow ? `EXISTS (SELECT 1 FROM "browserAuthFlow" WHERE "id" = ? AND "browserHash" = ? AND "status" = 'pending' AND "expiresAt" > ?)` : '1'}
            ON CONFLICT ("browserHash", "userId") DO UPDATE SET "sessionId" = excluded."sessionId", "slot" = excluded."slot", "lastUsedAt" = excluded."lastUsedAt", "expiresAt" = excluded."expiresAt", "rememberMe" = excluded."rememberMe"`)
            .bind(id, hash, userId, sessionId, id, hash, now, Date.now() + rememberedLifetime, Number(rememberMe), ...(flow ? [flow.id, hash, Date.now()] : [])),
        ...(flow ? [env.DB.prepare(`UPDATE "browserAuthFlow" SET "status" = 'authenticated',
            "accountId" = (SELECT "id" FROM "browserAccount" WHERE "browserHash" = ? AND "userId" = ?), "sessionId" = ?, "userId" = ?
            WHERE "id" = ? AND "status" = 'pending' AND "expiresAt" > ? AND EXISTS (SELECT 1 FROM "browserAccount" WHERE "browserHash" = ? AND "userId" = ? AND "sessionId" = ? AND "slot" IS NOT NULL)`)
            .bind(hash, userId, sessionId, userId, flow.id, Date.now(), hash, userId, sessionId)] : []),
    ]);
    const registered = await env.DB.prepare('SELECT "slot" FROM "browserAccount" WHERE "browserHash" = ? AND "userId" = ? AND "sessionId" = ?').bind(hash, userId, sessionId).first<{ slot: number | null }>();
    if (!registered || registered.slot === null) {
        if (existingId) await env.DB.prepare('UPDATE "browserAccount" SET "sessionId" = NULL WHERE "browserHash" = ? AND "userId" = ? AND "sessionId" = ?').bind(hash, userId, sessionId).run();
        else await env.DB.prepare('DELETE FROM "browserAccount" WHERE "browserHash" = ? AND "userId" = ? AND "sessionId" = ?').bind(hash, userId, sessionId).run();
        throw new APIError('BAD_REQUEST', { code: registered ? 'BROWSER_ACCOUNT_LIMIT' : 'BROWSER_FLOW_EXPIRED' });
    }
}

export const browserRoutes = new Hono<{ Bindings: Env }>();
browserRoutes.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.header('origin') !== c.env.AUTH_URL) return c.json({ code: 'INVALID_ORIGIN' }, 403);
    const quota = await databaseRateLimit(c.env.DB).consume(`browser:${c.req.header('cf-connecting-ip') ?? 'unknown'}`, { window: 60, max: 100 });
    if (!quota.allowed) return c.json({ code: 'TOO_MANY_REQUESTS' }, 429);
    await next();
});
async function jsonBody(request: Request) {
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new APIError('BAD_REQUEST', { code: 'INVALID_INPUT' });
    return request.clone().json().catch(() => { throw new APIError('BAD_REQUEST', { code: 'INVALID_INPUT' }); });
}
browserRoutes.get('/accounts', async (c) => c.json({ accounts: await browserAccounts(c.env, c.req.raw.headers), maximumAccounts: maximumBrowserAccounts }));
browserRoutes.post('/accounts/select', async (c) => {
    const body = z.object({ accountId: uuid, oauth_query: z.string().optional() }).strict().safeParse(await jsonBody(c.req.raw));
    if (!body.success) return c.json({ code: 'INVALID_INPUT' }, 400);
    const row = (await activeRows(c.env, c.req.raw.headers)).find((item) => item.id === body.data.accountId);
    if (!row) return c.json({ code: 'BROWSER_ACCOUNT_UNAVAILABLE' }, 401);
    const headers = new Headers(c.req.raw.headers); headers.set(accountHeader, row.id);
    const flow = await readBrowserFlow(c.env, headers);
    if (flow?.kind === 'oauth') await bindBrowserFlowAccount(c.env, headers, row.id);
    else {
        if (flow) {
            await c.env.DB.prepare('DELETE FROM "browserAuthFlow" WHERE "id" = ? AND "browserHash" = ?').bind(flow.id, flow.browserHash).run();
            for (const name of transientNames) c.header('Set-Cookie', serialize(`${names(c.env).native}${name}_flow-${flow.id}`, '', { ...attributes(c.env), maxAge: 0 }), { append: true });
        }
        headers.delete(flowHeader);
    }
    const resolved = await resolveBrowserRequest(new Request(c.req.raw, { headers }), c.env);
    const identity = await createAuth(c.env).api.getSession({ headers: resolved.headers });
    if (!identity) return c.json({ code: 'BROWSER_ACCOUNT_UNAVAILABLE' }, 401);
    await c.env.DB.prepare('UPDATE "browserAccount" SET "lastUsedAt" = ?, "expiresAt" = ? WHERE "id" = ?').bind(new Date().toISOString(), Date.now() + rememberedLifetime, row.id).run();
    return c.json({ identity: { ...identity, browserAccountId: row.id }, accountId: row.id });
});
async function revokeBrowserAccounts(env: Env, headers: Headers, accountId?: string) {
    const hash = await browserHash(env, headers);
    if (!hash) return;
    const rows = (await accountRows(env, headers)).filter((row) => !accountId || row.id === accountId);
    await env.DB.batch([
        env.DB.prepare(`DELETE FROM "browserAuthFlow" WHERE "browserHash" = ? ${accountId ? 'AND ("accountId" = ? OR "originSessionId" = ?)' : ''}`)
            .bind(hash, ...(accountId ? [accountId, rows[0]?.sessionId ?? ''] : [])),
    ]);
    const auth = createAuth(env), cookieNames = names(env);
    for (const row of rows) {
        if (!row.token) continue;
        // Native deletion hooks revoke online access and preserve the existing
        // offline-consent policy. Only this account's cookies reach signOut.
        const cookie = await serializeSigned(cookieNames.session, row.token, env.BETTER_AUTH_SECRET, attributes(env));
        const scopedHeaders = new Headers({ origin: env.AUTH_URL, cookie: `${names(env).browser}=${encodeURIComponent(parse(headers.get('cookie') ?? '')[names(env).browser] ?? '')}; ${cookie.split(';', 1)[0]}` });
        const requestId = headers.get('X-Loginflare-Request-ID');
        if (requestId) scopedHeaders.set('X-Loginflare-Request-ID', requestId);
        await auth.api.signOut({ headers: scopedHeaders });
    }
    await env.DB.prepare(`UPDATE "browserAccount" SET "sessionId" = NULL, "slot" = NULL WHERE "browserHash" = ? ${accountId ? 'AND "id" = ?' : ''}`).bind(hash, ...(accountId ? [accountId] : [])).run();
}
export async function signOutBrowserAccount(env: Env, headers: Headers) {
    const accountId = headers.get(accountHeader);
    if (!accountId) return null;
    const row = (await accountRows(env, headers)).find((item) => item.id === accountId);
    if (!row) throw new APIError('UNAUTHORIZED', { code: 'BROWSER_ACCOUNT_UNAVAILABLE' });
    await revokeBrowserAccounts(env, headers, row.id);
    const response = Response.json({ success: true });
    if (row.token) response.headers.append('Set-Cookie', serialize(`${names(env).session}_multi-${row.token.toLowerCase()}`, '', { ...attributes(env), maxAge: 0 }));
    response.headers.append('Set-Cookie', serialize(names(env).session, '', { ...attributes(env), maxAge: 0 }));
    return response;
}
browserRoutes.post('/accounts/:id/sign-out', async (c) => {
    const row = (await accountRows(c.env, c.req.raw.headers)).find((item) => item.id === c.req.param('id'));
    if (!row) return c.json({ code: 'BROWSER_ACCOUNT_UNAVAILABLE' }, 401);
    await revokeBrowserAccounts(c.env, c.req.raw.headers, row.id);
    if (row.token) c.header('Set-Cookie', serialize(`${names(c.env).session}_multi-${row.token.toLowerCase()}`, '', { ...attributes(c.env), maxAge: 0 }), { append: true });
    return c.json({ status: true });
});
browserRoutes.post('/accounts/sign-out-all', async (c) => {
    const rows = await accountRows(c.env, c.req.raw.headers);
    await revokeBrowserAccounts(c.env, c.req.raw.headers);
    for (const row of rows) if (row.token) c.header('Set-Cookie', serialize(`${names(c.env).session}_multi-${row.token.toLowerCase()}`, '', { ...attributes(c.env), maxAge: 0 }), { append: true });
    c.header('Set-Cookie', serialize(names(c.env).session, '', { ...attributes(c.env), maxAge: 0 }), { append: true });
    return c.json({ status: true });
});
browserRoutes.delete('/accounts/:id', async (c) => {
    const hash = await browserHash(c.env, c.req.raw.headers);
    if (!hash) return c.json({ code: 'BROWSER_ACCOUNT_UNAVAILABLE' }, 401);
    if ((await activeRows(c.env, c.req.raw.headers)).some((row) => row.id === c.req.param('id'))) return c.json({ code: 'BROWSER_ACCOUNT_STILL_ACTIVE' }, 409);
    await c.env.DB.prepare('DELETE FROM "browserAccount" WHERE "id" = ? AND "browserHash" = ?').bind(c.req.param('id'), hash).run();
    return c.json({ status: true });
});
browserRoutes.post('/auth-flows', async (c) => {
    const body = z.object({ kind: z.enum(['login', 'add', 'reauth', 'oauth']), accountId: uuid.optional(), locale: z.enum(locales), oauth_query: z.string().max(12000).optional() }).strict()
        .refine((value) => value.kind !== 'reauth' || !!value.accountId)
        .refine((value) => value.kind !== 'oauth' || !!value.oauth_query).safeParse(await jsonBody(c.req.raw));
    if (!body.success) return c.json({ code: 'INVALID_INPUT' }, 400);
    let headers = c.req.raw.headers, hash = await browserHash(c.env, headers);
    if (!hash) {
        const cookie = await serializeSigned(names(c.env).browser, crypto.randomUUID() + crypto.randomUUID(), c.env.BETTER_AUTH_SECRET, { ...attributes(c.env), maxAge: rememberedLifetime / 1000 });
        c.header('Set-Cookie', cookie, { append: true });
        headers = new Headers(headers); replaceRequestCookie(headers, cookie);
        hash = await browserHash(c.env, headers);
    }
    const { kind, accountId, locale, oauth_query: oauthQuery = '' } = body.data;
    if (oauthQuery && !await verifyOAuthQueryParams(oauthQuery, (await createAuth(c.env).$context).secret)) return c.json({ code: 'INVALID_OAUTH_QUERY' }, 400);
    const accounts = await accountRows(c.env, headers);
    const target = accountId ? accounts.find((row) => row.id === accountId) : undefined;
    if (accountId && !target) return c.json({ code: 'BROWSER_ACCOUNT_UNAVAILABLE' }, 401);
    const origin = (await activeRows(c.env, headers)).find((row) => row.id === headers.get(accountHeader));
    const count = await c.env.DB.prepare('SELECT COUNT(*) AS count FROM "browserAuthFlow" WHERE "browserHash" = ? AND "status" = ? AND "expiresAt" > ?').bind(hash, 'pending', Date.now()).first<number>('count');
    if ((count ?? 0) >= 5) return c.json({ code: 'TOO_MANY_REQUESTS' }, 429);
    const id = crypto.randomUUID();
    const created = await c.env.DB.prepare(`INSERT INTO "browserAuthFlow" ("id", "browserHash", "kind", "accountId", "targetUserId", "originSessionId", "locale", "oauthQuery", "expiresAt")
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM "browserAuthFlow" WHERE "browserHash" = ? AND "status" = 'pending' AND "expiresAt" > ?) < 5 RETURNING "id"`)
        .bind(id, hash, kind, kind === 'reauth' ? target?.id ?? null : null, kind === 'reauth' ? target?.userId ?? null : null,
            kind === 'reauth' && origin?.userId !== target?.userId ? null : origin?.sessionId ?? null, locale, oauthQuery, Date.now() + lifetime, hash, Date.now()).first();
    if (!created) return c.json({ code: 'TOO_MANY_REQUESTS' }, 429);
    return c.json({ flowId: id });
});
browserRoutes.get('/auth-flows/:id', async (c) => {
    const headers = new Headers(c.req.raw.headers); headers.set(flowHeader, c.req.param('id'));
    const flow = await readBrowserFlow(c.env, headers);
    return flow ? c.json({ flowId: flow.id, status: flow.status, accountId: flow.accountId }) : c.json({ code: 'BROWSER_FLOW_EXPIRED' }, 401);
});
browserRoutes.delete('/auth-flows/:id', async (c) => {
    const hash = await browserHash(c.env, c.req.raw.headers);
    if (!hash) return c.json({ code: 'BROWSER_FLOW_EXPIRED' }, 401);
    const removed = await c.env.DB.prepare('DELETE FROM "browserAuthFlow" WHERE "id" = ? AND "browserHash" = ? RETURNING "id"').bind(c.req.param('id'), hash).first();
    if (!removed) return c.json({ code: 'BROWSER_FLOW_EXPIRED' }, 401);
    for (const name of transientNames) c.header('Set-Cookie', serialize(`${names(c.env).native}${name}_flow-${c.req.param('id')}`, '', { ...attributes(c.env), maxAge: 0 }), { append: true });
    return c.json({ status: true });
});

/** Boundary used by every browser API, including uploads and native auth. */
export async function browserRequest(request: Request, env: Env, next: (request: Request) => Promise<Response>): Promise<Response> {
    const url = new URL(request.url), cookieNames = names(env);
    const connectorTest = /^\/api\/admin\/social-connections\/[a-f0-9-]{36}\/test$/.test(url.pathname);
    const socialStart = url.pathname === '/api/auth/social/start' || connectorTest;
    if (!url.pathname.startsWith('/api/')) return next(request);
    if (url.pathname === '/api/management/v1' || url.pathname.startsWith('/api/management/v1/')) return next(request);
    if (anonymousAuthPaths.has(url.pathname) || ['/api/health', '/api/config', '/api/branding', '/api/social/providers', '/api/auth/jwks', '/api/auth/.well-known/openid-configuration', '/api/auth/.well-known/oauth-authorization-server', '/api/auth/oauth2/token', '/api/auth/oauth2/userinfo', '/api/auth/oauth2/introspect', '/api/auth/oauth2/revoke'].includes(url.pathname)) return next(request);
    const headers = new Headers(request.headers);
    const extraCookies: string[] = [];
    try {
        let authenticationInput: Record<string, unknown> = {};
        if (request.method === 'POST' && (authenticationPaths.has(url.pathname) || connectorTest)) {
            if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return Response.json({ code: 'INVALID_INPUT' }, { status: 400 });
            const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
            let length = 0;
            if (reader) while (true) {
                const { done, value } = await reader.read(); if (done) break;
                length += value.byteLength;
                if (length > 16_384) { await reader.cancel(); return Response.json({ code: 'PAYLOAD_TOO_LARGE' }, { status: 413 }); }
                chunks.push(value);
            }
            const bytes = new Uint8Array(length); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            let parsed: unknown;
            try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { return Response.json({ code: 'INVALID_INPUT' }, { status: 400 }); }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Response.json({ code: 'INVALID_INPUT' }, { status: 400 });
            authenticationInput = parsed as Record<string, unknown>;
            request = new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
        }
        if (request.method === 'POST' && (loginPaths.has(url.pathname) || socialStart) && request.headers.get('origin') !== env.AUTH_URL) return Response.json({ code: 'INVALID_ORIGIN' }, { status: 403 });
        if (!headers.has(flowHeader) && uuid.safeParse(url.searchParams.get('flow')).success) headers.set(flowHeader, url.searchParams.get('flow')!);
        if (/^\/api\/auth\/callback\//.test(url.pathname) && !headers.has(flowHeader)) {
            const hash = await browserHash(env, headers);
            const flow = hash ? await env.DB.prepare('SELECT "id" FROM "browserAuthFlow" WHERE "browserHash" = ? AND "upstreamState" = ? AND "expiresAt" > ?')
                .bind(hash, url.searchParams.get('state') ?? '', Date.now()).first<{ id: string }>() : null;
            if (flow) headers.set(flowHeader, flow.id);
        }
        if (!headers.has(flowHeader) && url.pathname.startsWith('/api/auth/two-factor/verify-')) {
            const flowIds = Object.keys(parse(headers.get('cookie') ?? '')).flatMap((key) => key.startsWith(`${cookieNames.native}two_factor_flow-`) ? [key.slice(`${cookieNames.native}two_factor_flow-`.length)] : []);
            const live: string[] = [];
            for (const id of flowIds) {
                const candidate = new Headers(headers); candidate.set(flowHeader, id);
                if (await readBrowserFlow(env, candidate)) live.push(id);
            }
            if (live.length === 1) headers.set(flowHeader, live[0]!);
        }
        if (!headers.has(flowHeader) && url.pathname.startsWith('/api/auth/social/') && url.pathname !== '/api/auth/social/start') {
            const flowIds = Object.keys(parse(headers.get('cookie') ?? '')).flatMap((key) => key.startsWith(`${cookieNames.native}social_flow_flow-`) ? [key.slice(`${cookieNames.native}social_flow_flow-`.length)] : []);
            const live: string[] = [];
            for (const id of flowIds) {
                const candidate = new Headers(headers); candidate.set(flowHeader, id);
                if (await readBrowserFlow(env, candidate)) live.push(id);
            }
            if (live.length === 1) headers.set(flowHeader, live[0]!);
        }
        if (request.method === 'POST' && (loginPaths.has(url.pathname) || socialStart) && !headers.has(flowHeader)) {
            let hash = await browserHash(env, headers);
            if (!hash) {
                const cookie = await serializeSigned(cookieNames.browser, crypto.randomUUID() + crypto.randomUUID(), env.BETTER_AUTH_SECRET, { ...attributes(env), maxAge: rememberedLifetime / 1000 });
                extraCookies.push(cookie); replaceRequestCookie(headers, cookie); hash = await browserHash(env, headers);
            }
            const id = crypto.randomUUID();
            const body = authenticationInput;
            const actor = (await activeRows(env, headers)).find((row) => row.id === headers.get(accountHeader)) ?? (await activeRows(env, headers))[0];
            const sensitive = connectorTest || (body.purpose && body.purpose !== 'login');
            const oauthQuery = typeof body.oauth_query === 'string' ? body.oauth_query : '';
            if (oauthQuery && !await verifyOAuthQueryParams(oauthQuery, env.BETTER_AUTH_SECRET)) return Response.json({ code: 'INVALID_OAUTH_QUERY' }, { status: 400 });
            const inserted = await env.DB.prepare(`INSERT INTO "browserAuthFlow" ("id", "browserHash", "kind", "locale", "accountId", "targetUserId", "originSessionId", "oauthQuery", "expiresAt")
                SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM "browserAuthFlow" WHERE "browserHash" = ? AND "status" = 'pending' AND "expiresAt" > ?) < 5 RETURNING "id"`)
                .bind(id, hash, sensitive ? 'reauth' : 'login', body.locale === 'zh-CN' ? 'zh-CN' : 'en-US', sensitive ? actor?.id ?? null : null, sensitive ? actor?.userId ?? null : null, sensitive ? actor?.sessionId ?? null : null, oauthQuery, Date.now() + lifetime, hash, Date.now()).first();
            if (!inserted) return Response.json({ code: 'TOO_MANY_REQUESTS' }, { status: 429 });
            headers.set(flowHeader, id);
        }
        const flow = await readBrowserFlow(env, headers);
        if (/^\/api\/auth\/callback\//.test(url.pathname) && !flow) {
            const hash = await browserHash(env, headers);
            const expired = hash ? await env.DB.prepare('SELECT "locale" FROM "browserAuthFlow" WHERE "browserHash" = ? AND ("id" = ? OR "upstreamState" = ?) LIMIT 1')
                .bind(hash, headers.get(flowHeader) ?? '', url.searchParams.get('state') ?? '').first<{ locale: 'en-US' | 'zh-CN' }>() : null;
            const locale = expired?.locale ?? ((request.headers.get('accept-language') ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US');
            return new Response(null, { status: 302, headers: { Location: `${env.AUTH_URL}${localizedPath(locale, 'social/complete')}?error=BROWSER_FLOW_EXPIRED`, 'Cache-Control': 'no-store' } });
        }
        if (headers.has(flowHeader) && !flow && !url.pathname.startsWith('/api/browser/')) return Response.json({ code: 'BROWSER_FLOW_EXPIRED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
        const socialChallenge = flow?.upstreamState && url.pathname.startsWith('/api/auth/two-factor/verify-');
        if (request.method === 'POST' && authenticationPaths.has(url.pathname)
            && (socialChallenge ? authenticationInput.oauth_query !== undefined
                : !await browserOAuthQueryMatches(env, headers, authenticationInput.oauth_query))) return Response.json({ code: 'INVALID_OAUTH_QUERY' }, { status: 400 });
        if (flow?.status === 'authenticated' && /^\/api\/auth\/two-factor\/verify-(totp|backup-code)$/.test(url.pathname)) {
            const user = await env.DB.prepare('SELECT "twoFactorEnabled" FROM "user" WHERE "id" = ?').bind(flow.userId).first<{ twoFactorEnabled: number }>();
            if (user?.twoFactorEnabled) return Response.json({ code: 'BROWSER_FLOW_EXPIRED' }, { status: 401 });
        }
        // Registry operations must retain the original cookie view and must
        // remain usable after the selected account expires.
        const resolved = url.pathname.startsWith('/api/browser/') ? new Request(request, { headers }) : await resolveBrowserRequest(new Request(request, { headers }), env);
        let response = await next(resolved);
        if (flow && (authenticationPaths.has(url.pathname) || url.pathname === '/api/auth/social/finish')) await advanceBrowserOAuthFlow(env, resolved.headers, response);
        const out = new Headers(response.headers);
        const cookies = out.getSetCookie(); out.delete('set-cookie');
        const sessionOnly = cookies.some((cookie) => cookie.startsWith(`${cookieNames.session}=`) && !/Max-Age=|Expires=/i.test(cookie));
        const primary = [...cookies].reverse().find((cookie) => cookie.startsWith(`${cookieNames.session}=`) && !/Max-Age=0/i.test(cookie));
        const renewedToken = primary ? (await parseSigned(primary.split(';', 1)[0]!, env.BETTER_AUTH_SECRET, cookieNames.session))[cookieNames.session] : null;
        const renewedName = typeof renewedToken === 'string' ? `${cookieNames.session}_multi-${renewedToken.toLowerCase()}` : '';
        for (let cookie of cookies) {
            if (!flow && cookie.startsWith(`${cookieNames.native}dont_remember=`)) continue;
            if (renewedName && cookie.startsWith(`${renewedName}=`)) continue;
            if (sessionOnly && cookie.startsWith(`${cookieNames.session}_multi-`) && !/Max-Age=0/i.test(cookie)) cookie = cookie.replace(/;\s*(Max-Age|Expires)=[^;]*/gi, '');
            if (flow) for (const name of transientNames) {
                const canonical = cookieNames.native + name;
                if (cookie.startsWith(`${canonical}=`)) cookie = cookie.replace(`${canonical}=`, `${canonical}_flow-${flow.id}=`);
            }
            out.append('set-cookie', cookie);
        }
        if (renewedName && primary) {
            out.append('set-cookie', primary.replace(`${cookieNames.session}=`, `${renewedName}=`));
            const hash = await browserHash(env, resolved.headers);
            if (hash) await env.DB.prepare('UPDATE "browserAccount" SET "expiresAt" = ? WHERE "browserHash" = ? AND "sessionId" IN (SELECT "id" FROM "session" WHERE "token" = ?)')
                .bind(Date.now() + rememberedLifetime, hash, renewedToken).run();
        }
        for (const cookie of extraCookies) out.append('set-cookie', cookie);
        if (cookies.some((cookie) => cookie.startsWith(`${cookieNames.session}=`) && !/Max-Age=0/i.test(cookie))) {
            const browserCookie = parse(headers.get('cookie') ?? '')[cookieNames.browser];
            if (browserCookie) out.append('set-cookie', serialize(cookieNames.browser, browserCookie, { ...attributes(env), maxAge: rememberedLifetime / 1000 }));
        }
        const location = out.get('location');
        if (flow && location) {
            const destination = new URL(location, env.AUTH_URL);
            if (destination.origin === env.AUTH_URL && /\/(social\/complete|two-factor)$/.test(destination.pathname)) {
                destination.searchParams.set('flow', flow.id); out.set('location', destination.toString());
            }
        }
        if ((url.pathname.startsWith('/api/auth/') || connectorTest) && response.headers.get('content-type')?.includes('application/json') && (flow || url.pathname === '/api/auth/get-session') && response.ok) {
            const payload: unknown = await response.json();
            if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
                if (flow && socialStart && 'url' in payload && typeof payload.url === 'string') {
                    const state = new URL(payload.url).searchParams.get('state');
                    if (state) await env.DB.prepare('UPDATE "browserAuthFlow" SET "upstreamState" = ? WHERE "id" = ?').bind(state, flow.id).run();
                }
                const completed = flow ? await env.DB.prepare('SELECT "accountId" FROM "browserAuthFlow" WHERE "id" = ? AND "status" = ?').bind(flow.id, 'authenticated').first<{ accountId: string }>() : null;
                const accountId = completed?.accountId ?? resolved.headers.get(accountHeader);
                const proofOperation = flow && ['/api/auth/social/unlink', '/api/auth/social/set-password', '/api/auth/emails/add', '/api/auth/emails/resend', '/api/auth/emails/set-primary', '/api/auth/emails/remove', '/api/auth/two-factor/enable', '/api/auth/two-factor/disable', '/api/auth/two-factor/generate-backup-codes'].includes(url.pathname);
                if (proofOperation) {
                    await env.DB.prepare('DELETE FROM "browserAuthFlow" WHERE "id" = ? AND "browserHash" = ?').bind(flow.id, flow.browserHash).run();
                    for (const name of transientNames) out.append('Set-Cookie', serialize(`${cookieNames.native}${name}_flow-${flow.id}`, '', { ...attributes(env), maxAge: 0 }));
                }
                if (flow && 'url' in payload && typeof payload.url === 'string') {
                    const target = new URL(payload.url, env.AUTH_URL);
                    if (target.origin !== env.AUTH_URL && (target.searchParams.has('code') || target.searchParams.has('error')) && await readBrowserFlow(env, resolved.headers)) {
                        const completionHeaders = new Headers(resolved.headers);
                        if (accountId) completionHeaders.set(accountHeader, accountId);
                        await consumeBrowserFlow(env, completionHeaders);
                    }
                }
                response = Response.json({ ...payload, ...(accountId ? { browserAccountId: accountId } : {}), ...(flow ? { browserFlowId: flow.id } : {}), ...(proofOperation ? { browserFlowComplete: true } : {}) }, { status: response.status, headers: out });
            } else response = Response.json(payload, { status: response.status, headers: out });
        } else response = new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
        return response;
    } catch (error) {
        if (error instanceof APIError) return Response.json({ code: error.body?.code ?? 'BROWSER_ACCOUNT_UNAVAILABLE' }, { status: error.statusCode, headers: { 'Cache-Control': 'no-store' } });
        throw error;
    }
}

/** Finish a selected authorization without accepting a reusable browser flag. */
export async function consumeBrowserFlow(env: Env, headers: Headers): Promise<boolean> {
    const flow = await readBrowserFlow(env, headers);
    if (!flow || !flow.accountId || flow.accountId !== headers.get(accountHeader)) return false;
    const result = await env.DB.prepare('DELETE FROM "browserAuthFlow" WHERE "id" = ? AND "browserHash" = ? AND "accountId" = ? AND "sessionId" = ? AND "expiresAt" > ?')
        .bind(flow.id, flow.browserHash, flow.accountId, flow.sessionId, Date.now()).run();
    return result.meta.changes === 1;
}

/** Stable key sorting preserves the order of repeated provider-declared names. */
export function sameBrowserOAuthQuery(expected: string, candidate: string): boolean {
    const original = new URLSearchParams(expected), current = new URLSearchParams(candidate);
    original.sort(); current.sort();
    return original.toString() === current.toString();
}

/** An independently valid signature does not authorize changing this transaction. */
export async function browserOAuthQueryMatches(env: Env, headers: Headers, candidate: unknown): Promise<boolean> {
    const flow = await readBrowserFlow(env, headers);
    if (!flow) return !headers.has(flowHeader) && (candidate === undefined || candidate === ''
        || (typeof candidate === 'string' && await verifyOAuthQueryParams(candidate, env.BETTER_AUTH_SECRET)));
    if (!flow.oauthQuery) return candidate === undefined || candidate === '';
    return typeof candidate === 'string' && sameBrowserOAuthQuery(flow.oauthQuery, candidate)
        && await verifyOAuthQueryParams(candidate, env.BETTER_AUTH_SECRET);
}

/** Advance only to a signed continuation emitted by the native provider itself. */
export async function advanceBrowserOAuthFlow(env: Env, headers: Headers, nativeResponse: Response): Promise<void> {
    const flow = await readBrowserFlow(env, headers);
    if (!flow?.oauthQuery || nativeResponse.status >= 400) return;
    let location = nativeResponse.headers.get('location');
    if (!location && nativeResponse.body && nativeResponse.headers.get('content-type')?.includes('application/json')) {
        const payload: unknown = await nativeResponse.clone().json();
        if (payload && typeof payload === 'object' && 'url' in payload && typeof payload.url === 'string') location = payload.url;
    }
    if (!location) return;
    const target = new URL(location, env.AUTH_URL);
    if (target.origin !== env.AUTH_URL || !/^\/(en-us|zh-cn)\/(login|select-account|consent)$/.test(target.pathname)) return;
    const query = target.search.slice(1);
    if (!await verifyOAuthQueryParams(query, env.BETTER_AUTH_SECRET)) throw new APIError('BAD_REQUEST', { code: 'INVALID_OAUTH_QUERY' });
    const authenticateSelectedAccount = target.pathname.endsWith('/login') && flow.status !== 'pending';
    const advanced = await env.DB.prepare(`UPDATE "browserAuthFlow" SET "oauthQuery" = ?,
        "status" = CASE WHEN ? THEN 'pending' ELSE "status" END,
        "targetUserId" = CASE WHEN ? THEN "userId" ELSE "targetUserId" END,
        "originSessionId" = CASE WHEN ? THEN "sessionId" ELSE "originSessionId" END
        WHERE "id" = ? AND "browserHash" = ? AND "oauthQuery" = ? AND "expiresAt" > ?`)
        .bind(query, Number(authenticateSelectedAccount), Number(authenticateSelectedAccount), Number(authenticateSelectedAccount), flow.id, flow.browserHash, flow.oauthQuery, Date.now()).run();
    if (advanced.meta.changes !== 1) throw new APIError('BAD_REQUEST', { code: 'INVALID_OAUTH_QUERY' });
}
