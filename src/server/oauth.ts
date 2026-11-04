import { Hono } from 'hono';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { createAuth } from './auth';
import type { Env } from './config';
import { advanceBrowserOAuthFlow, browserAccounts, browserOAuthQueryMatches, consumeBrowserFlow, readBrowserFlow, resolveBrowserRequest } from './browser-accounts';

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
    '/oauth2/continue': ['POST'],
    '/oauth2/end-session': ['GET', 'POST'],
    '/oauth2/end-session/confirm': ['POST'],
};
const browserProtocol = new Set(['/oauth2/token', '/oauth2/userinfo', '/oauth2/revoke', '/oauth2/introspect']);
const authorizationFields = new Set(['client_id', 'redirect_uri', 'response_type', 'response_mode', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method', 'prompt', 'max_age', 'login_hint', 'ui_locales', 'acr_values']);
const allowedScopes = new Set(['openid', 'profile', 'email', 'offline_access']);

async function validAccountSelection(env: Env, headers: Headers, query: string, required = false): Promise<boolean> {
    const flow = await readBrowserFlow(env, headers);
    if (!flow) return !required && (await browserAccounts(env, headers)).filter((account) => account.status === 'active').length <= 1;
    if (!flow.oauthQuery || !flow.accountId || flow.accountId !== headers.get('X-Loginflare-Account')) return false;
    return browserOAuthQueryMatches(env, headers, query);
}

async function claimAuthorization(env: Env, headers: Headers): Promise<string | null> {
    const flow = await readBrowserFlow(env, headers);
    if (!flow) return null;
    const id = `browser-oauth:${flow.id}`, now = new Date().toISOString();
    const result = await env.DB.prepare(`INSERT OR IGNORE INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM "browserAuthFlow" WHERE "id" = ? AND "expiresAt" > ?)`)
        .bind(id, id, flow.id, new Date(flow.expiresAt).toISOString(), now, now, flow.id, Date.now()).run();
    return result.meta.changes === 1 ? id : '';
}

async function finishesAuthorization(response: Response, origin: string): Promise<boolean> {
    const location = response.headers.get('location');
    if (location) {
        const target = new URL(location, origin);
        return target.searchParams.has('code') || target.searchParams.has('error');
    }
    if (!response.headers.get('content-type')?.includes('application/json')) return false;
    const payload: unknown = await response.clone().json();
    if (!payload || typeof payload !== 'object' || !('url' in payload) || typeof payload.url !== 'string') return false;
    const target = new URL(payload.url, origin);
    return target.searchParams.has('code') || target.searchParams.has('error');
}

function withoutCurrentSession(request: Request, cookieName: string): Request {
    const headers = new Headers(request.headers);
    headers.set('cookie', (headers.get('cookie') ?? '').split(';').filter((part) => part.trim().split('=', 1)[0] !== cookieName).join(';'));
    return new Request(request, { headers });
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

async function hash(value: string): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function logoutAccountPage(accounts: Awaited<ReturnType<typeof browserAccounts>>, chinese: boolean, confirmationId: string, origin: string): string {
    const title = chinese ? '选择要退出的账号' : 'Choose an account to sign out';
    const action = chinese ? '退出' : 'Sign out';
    const items = accounts.filter((account) => account.status === 'active').map((account) => {
        const name = account.user.name || account.user.email;
        let image = '';
        if (account.user.image) {
            try {
                const source = new URL(account.user.image, origin);
                if (source.origin === origin && source.pathname.startsWith('/avatars/')) image = `<img src="${escapeHtml(source.pathname)}" alt="">`;
            } catch { /* A missing or unavailable avatar uses the person symbol. */ }
        }
        return `<button class="account" type="submit" name="accountId" value="${escapeHtml(account.id)}" aria-label="${escapeHtml(`${action}: ${account.user.email}`)}"><span class="avatar">${image || '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg>'}</span><span class="identity"><strong>${escapeHtml(name)}</strong>${account.user.name ? `<span>${escapeHtml(account.user.email)}</span>` : ''}</span><span class="action">${action}</span></button>`;
    }).join('');
    return `<!doctype html><html lang="${chinese ? 'zh-CN' : 'en-US'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>:root{color-scheme:light dark;--surface:#fff8f4;--text:#30261f;--muted:#6e5d51;--line:#dcc3b3;--accent:#8e4f26;--hover:#f3e3d8}@media(prefers-color-scheme:dark){:root{--surface:#1b120b;--text:#f7e0d1;--muted:#dac2b2;--line:#574438;--accent:#ffb98d;--hover:#34251b}}*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--text);font:16px/1.5 system-ui,sans-serif}main{max-width:480px;margin:12vh auto;padding:32px;border:1px solid var(--line);border-radius:28px}h1{margin:0 0 24px;font-size:26px;font-weight:500}form{display:grid;gap:8px}.account{display:flex;align-items:center;gap:16px;width:100%;padding:16px 12px;background:none;border:0;border-radius:16px;color:inherit;font:inherit;text-align:left;cursor:pointer}.account:hover{background:var(--hover)}.account:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.avatar{display:grid;place-items:center;flex:0 0 44px;height:44px;border-radius:50%;overflow:hidden;background:var(--hover);color:var(--accent);font-size:20px}.avatar img{width:100%;height:100%;object-fit:cover}.identity{display:flex;flex:1;flex-direction:column;min-width:0;overflow-wrap:anywhere}.identity strong{font-weight:500}.identity>span{font-size:14px;color:var(--muted)}.action{flex:0 0 auto;color:var(--accent);font-size:14px}@media(max-width:520px){main{margin:32px 16px;padding:24px 16px}.account{gap:12px}.action{font-size:12px}}</style><main><h1>${title}</h1><form method="post" data-oidc-logout-confirmation action="/api/auth/oauth2/end-session/confirm"><input type="hidden" name="action" value="confirm"><input type="hidden" name="confirmationId" value="${confirmationId}">${items}</form></main></html>`;
}

export const oauth = new Hono<{ Bindings: Env }>();

async function allowedBrowserOrigin(env: Env, origin: string): Promise<boolean> {
    const match = await env.DB.prepare(`SELECT 1 FROM "oauthClientUri" u JOIN "oauthClient" c ON c."clientId" = u."clientId"
        WHERE u."kind" = 'redirect-origin' AND u."value" = ? AND c."referenceId" = 'loginflare'
        AND c."tokenEndpointAuthMethod" = 'none' AND COALESCE(c."disabled", 0) = 0 LIMIT 1`).bind(origin).first();
    return !!match;
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
    let jsonBody: Record<string, unknown> | undefined;
    if (c.req.method === 'POST') {
        const mediaType = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
        if (path === '/oauth2/consent' || path === '/oauth2/continue') {
            if (origin !== c.env.AUTH_URL) return c.json({ code: 'INVALID_ORIGIN' }, 403);
            if (mediaType !== 'application/json') return c.json({ code: 'INVALID_INPUT' }, 400);
            const body: unknown = await c.req.raw.clone().json().catch(() => null);
            const allowed = path === '/oauth2/consent' ? ['accept', 'oauth_query'] : ['selected', 'oauth_query'];
            if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) return c.json({ code: 'INVALID_INPUT' }, 400);
            jsonBody = body as Record<string, unknown>;
            if (path === '/oauth2/continue' && jsonBody.selected !== true) return c.json({ code: 'INVALID_INPUT' }, 400);
        } else {
            if (mediaType !== 'application/x-www-form-urlencoded') return c.json({ error: 'invalid_request' }, 400);
            form = new URLSearchParams(await c.req.raw.clone().text());
            if (form.has('resource') || form.has('claims')) return c.json({ error: 'invalid_request' }, 400);
        }
    }
    if (path === '/oauth2/authorize') {
        if ([...form.keys()].some((key) => !authorizationFields.has(key) || form.getAll(key).length !== 1)
            || (form.has('response_mode') && form.get('response_mode') !== 'query')
            || (form.get('prompt')?.split(' ').some((value) => !['login', 'consent', 'none', 'select_account'].includes(value)))) return c.json({ error: 'invalid_request' }, 400);
    }
    const auth = createAuth(c.env);
    if (jsonBody) {
        const signed = jsonBody.oauth_query;
        if (typeof signed !== 'string' || !await verifyOAuthQueryParams(signed, (await auth.$context).secret)
            || !await validAccountSelection(c.env, c.req.raw.headers, signed, path === '/oauth2/continue')) return c.json({ code: 'INVALID_OAUTH_QUERY' }, 400);
    }
    if (['/oauth2/authorize', '/oauth2/consent', '/oauth2/continue'].includes(path)) {
        const identity = await auth.api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
        if (identity && (identity.user.banned || !identity.user.emailVerified)) return c.json({ error: 'access_denied' }, 403);
    }
    let request = c.req.raw;
    let logoutChoices: Awaited<ReturnType<typeof browserAccounts>> | undefined;
    const sessionCookie = (await auth.$context).authCookies.sessionToken.name;
    const confirmationCookie = `${sessionCookie}.oauth_logout_confirmation`;
    let confirmationId: string | undefined;
    if (path === '/oauth2/end-session') {
        const hint = form.get('id_token_hint');
        const accounts = await browserAccounts(c.env, request.headers);
        const ambiguous = accounts.filter((account) => account.status === 'active').length > 1 && !request.headers.has('X-Loginflare-Account');
        // Let the native verifier resolve a signed hint's exact sid. A different
        // default browser cookie must never turn "log out A" into "log out B".
        if (hint || ambiguous) request = withoutCurrentSession(request, sessionCookie);
        if (!hint && ambiguous) logoutChoices = accounts;
    }
    if (path === '/oauth2/end-session/confirm' && form.has('accountId')) {
        if (origin !== c.env.AUTH_URL || form.getAll('accountId').length !== 1
            || form.getAll('confirmationId').length !== 1 || !/^[a-f0-9-]{36}$/.test(form.get('confirmationId') ?? '')
            || [...form.keys()].some((key) => !['accountId', 'confirmationId', 'action'].includes(key))) return c.json({ code: 'INVALID_INPUT' }, 400);
        const accountId = form.get('accountId')!;
        confirmationId = form.get('confirmationId')!;
        const accounts = await browserAccounts(c.env, request.headers);
        if (!accounts.some((account) => account.id === accountId && account.status === 'active')) return c.json({ code: 'UNAUTHORIZED' }, 401);
        const headers = new Headers(request.headers);
        const scopedName = `${confirmationCookie}_${confirmationId}`;
        const scoped = (headers.get('cookie') ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${scopedName}=`));
        if (!scoped) return c.json({ code: 'INVALID_OAUTH_QUERY' }, 400);
        const signedValue = scoped.slice(scopedName.length + 1);
        const consumed = await c.env.DB.prepare('DELETE FROM "verification" WHERE "identifier" = ? AND "value" = ? AND "expiresAt" > ? RETURNING "id"')
            .bind(`browser-logout:${confirmationId}`, await hash(signedValue), new Date().toISOString()).first();
        if (!consumed) return c.json({ code: 'INVALID_OAUTH_QUERY' }, 400);
        headers.set('cookie', `${(headers.get('cookie') ?? '').split(';').filter((part) => !part.trim().startsWith(`${confirmationCookie}=`)).join(';')}; ${confirmationCookie}=${signedValue}`);
        headers.set('X-Loginflare-Account', accountId);
        request = await resolveBrowserRequest(new Request(request, { headers }), c.env);
    }
    // Serialize continuations of this browser transaction before the provider
    // creates a code. Replaying a signed query must not issue a second code.
    const authorizationClaim = jsonBody ? await claimAuthorization(c.env, request.headers) : null;
    if (authorizationClaim === '') return c.json({ code: 'INVALID_OAUTH_QUERY' }, 400);
    let response: Response;
    try {
        response = await auth.handler(request);
        await advanceBrowserOAuthFlow(c.env, request.headers, response);
        if (authorizationClaim && await finishesAuthorization(response, c.env.AUTH_URL)) {
            if (!await consumeBrowserFlow(c.env, request.headers)) return c.json({ code: 'INVALID_OAUTH_QUERY' }, 400);
        } else if (authorizationClaim) await c.env.DB.prepare('DELETE FROM "verification" WHERE "id" = ?').bind(authorizationClaim).run();
    } catch (error) {
        if (authorizationClaim) await c.env.DB.prepare('DELETE FROM "verification" WHERE "id" = ?').bind(authorizationClaim).run();
        throw error;
    }
    if (response.status >= 500) return c.json({ error: 'server_error' }, 503);
    if (path === '/oauth2/end-session' && response.ok && response.headers.get('content-type')?.includes('text/html')) {
        if (logoutChoices) {
            const originalCookies = response.headers.getSetCookie();
            const signed = originalCookies.find((value) => value.startsWith(`${confirmationCookie}=`));
            if (!signed) return c.json({ error: 'server_error' }, 503);
            confirmationId = crypto.randomUUID();
            const signedValue = signed.split(';', 1)[0]!.slice(confirmationCookie.length + 1);
            const now = new Date().toISOString();
            await c.env.DB.prepare('INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)')
                .bind(crypto.randomUUID(), `browser-logout:${confirmationId}`, await hash(signedValue), new Date(Date.now() + 300_000).toISOString(), now, now).run();
            response.headers.delete('set-cookie');
            for (const cookie of originalCookies) response.headers.append('set-cookie', cookie.startsWith(`${confirmationCookie}=`)
                ? `${confirmationCookie}_${confirmationId}${cookie.slice(confirmationCookie.length)}` : cookie);
            const chinese = form.get('ui_locales')?.split(' ').some((value) => /^zh(?:-|$)/i.test(value))
                || c.req.header('accept-language')?.toLowerCase().startsWith('zh');
            response = new Response(logoutAccountPage(logoutChoices, !!chinese, confirmationId, c.env.AUTH_URL), { status: response.status, headers: response.headers });
            response.headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
        }
        const redirect = form.get('post_logout_redirect_uri') ?? query.get('post_logout_redirect_uri');
        if (redirect) {
            const match = await c.env.DB.prepare(`SELECT 1 FROM "oauthClientUri" u JOIN "oauthClient" c ON c."clientId" = u."clientId"
                WHERE u."kind" = 'post-logout-uri' AND u."value" = ? AND c."referenceId" = 'loginflare'
                AND COALESCE(c."disabled", 0) = 0 LIMIT 1`).bind(redirect).first();
            if (match) {
                // Chromium applies form-action to the redirect following POST.
                // The provider still validates the client-specific URI and signed confirmation cookie.
                response.headers.set('Content-Security-Policy', `default-src 'none'; ${logoutChoices ? "style-src 'unsafe-inline'; img-src 'self'; " : ''}form-action 'self' ${new URL(redirect).origin}; base-uri 'none'; frame-ancestors 'none'`);
            }
        }
    }
    if (path === '/oauth2/end-session/confirm' && confirmationId) response.headers.append('set-cookie', `${confirmationCookie}_${confirmationId}=; Path=/api/auth/oauth2/end-session/confirm; HttpOnly; SameSite=Lax; Max-Age=0${c.env.APP_ENV !== 'development' ? '; Secure' : ''}`);
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
    if (!await validAccountSelection(c.env, c.req.raw.headers, query)) return c.json({ code: 'INVALID_OAUTH_QUERY' }, 400);
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
