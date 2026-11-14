import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import * as oidc from 'openid-client';
import { timingSafeEqual } from 'node:crypto';
import type { ServerWebBindings } from '../worker-configuration';

interface Data {
    csrf: string; subject?: string; tokens?: oidc.TokenEndpointResponse;
    accessExpiresAt?: number; logoutState?: string; revocationUnconfirmed?: boolean;
    authorization?: { verifier: string; state: string; nonce: string; expiresAt: number };
}
interface Session { id: string; data: Data; expiresAt: number; version: number; refreshingAt: number | null }
const cookieName = '__Host-loginflare_web';
const random = () => crypto.randomUUID() + crypto.randomUUID();
const encoder = new TextEncoder();
const equal = (left: string | null, right: string) => left !== null && encoder.encode(left).length === encoder.encode(right).length
    && timingSafeEqual(encoder.encode(left), encoder.encode(right));
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hex = (bytes: Uint8Array) => [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
const digest = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
async function key(env: ServerWebBindings) {
    if (!/^[0-9a-f]{64}$/.test(env.LOGINFLARE_SESSION_KEY)) throw new Error('Configure session encryption key');
    return crypto.subtle.importKey('raw', Uint8Array.from(env.LOGINFLARE_SESSION_KEY.match(/../g)!, (v) => parseInt(v, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env: ServerWebBindings, id: string, data: Data) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, await key(env), encoder.encode(JSON.stringify(data))));
    return hex(iv) + hex(bytes);
}
async function load(env: ServerWebBindings, id: string): Promise<Session | null> {
    const row = await env.SESSIONS.prepare('SELECT * FROM appSession WHERE id = ? AND expiresAt > ?').bind(id, Date.now()).first<{ data: string; expiresAt: number; version: number; refreshingAt: number | null }>();
    if (!row) return null;
    const bytes = Uint8Array.from(row.data.match(/../g)!, (v) => parseInt(v, 16));
    const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(id) }, await key(env), bytes.slice(12));
    return { ...row, id, data: JSON.parse(new TextDecoder().decode(decoded)) };
}
async function save(env: ServerWebBindings, session: Session) {
    const result = await env.SESSIONS.prepare('UPDATE appSession SET data = ?, version = version + 1, refreshingAt = NULL WHERE id = ? AND version = ?')
        .bind(await seal(env, session.id, session.data), session.id, session.version).run();
    if (!result.meta.changes) throw new Error('Session changed');
    session.version++;
    session.refreshingAt = null;
}
async function configuration(env: ServerWebBindings) {
    const issuer = new URL(env.LOGINFLARE_ISSUER), origin = new URL(env.LOGINFLARE_ORIGIN);
    const local = issuer.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname);
    if ((!local && issuer.protocol !== 'https:') || issuer.username || issuer.password || issuer.search || issuer.hash
        || origin.protocol !== 'https:' || origin.origin !== env.LOGINFLARE_ORIGIN || !env.LOGINFLARE_CLIENT_SECRET) throw new Error('Invalid application configuration');
    const config = await oidc.discovery(issuer, env.LOGINFLARE_CLIENT_ID, { token_endpoint_auth_method: 'client_secret_basic', id_token_signed_response_alg: 'RS256' },
        oidc.ClientSecretBasic(env.LOGINFLARE_CLIENT_SECRET), { timeout: 5, [oidc.customFetch]: async (input, init) => {
            const response = await fetch(input, { ...init, body: init.body instanceof Uint8Array ? new Uint8Array(init.body).buffer : init.body,
                redirect: 'manual', signal: AbortSignal.timeout(5000) });
            const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
            let size = 0;
            if (reader) while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > 65536) { await reader.cancel(); throw new Error('Issuer response too large'); }
                chunks.push(value);
            }
            const body = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
            return new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, headers: response.headers });
        }, ...(local ? { execute: [oidc.allowInsecureRequests] } : {}) });
    oidc.enableNonRepudiationChecks(config);
    return config;
}
function acceptTokens(data: Data, tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers) {
    const subject = tokens.claims()?.sub ?? data.subject;
    if (!subject || data.subject && subject !== data.subject) throw new Error('Invalid subject');
    data.subject = subject;
    data.tokens = { ...data.tokens, ...tokens };
    data.accessExpiresAt = Date.now() + (tokens.expires_in ?? 0) * 1000;
}
export async function refreshSession(env: ServerWebBindings, session: Session, renew: (token: string) => Promise<oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers>): Promise<Session> {
    if (!session.data.tokens?.refresh_token) throw new Error('Sign in again');
    const claimed = await env.SESSIONS.prepare('UPDATE appSession SET refreshingAt = ? WHERE id = ? AND version = ? AND refreshingAt IS NULL RETURNING id')
        .bind(Date.now(), session.id, session.version).first();
    if (!claimed) {
        for (let attempt = 0; attempt < 30; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            const current = await load(env, session.id);
            if (!current) throw new Error('Sign in again');
            if (current.refreshingAt === null && current.version > session.version) return current;
            // A crashed request might have consumed the token. Never reclaim it.
            if (current.refreshingAt !== null && Date.now() - current.refreshingAt > 60_000) {
                await env.SESSIONS.prepare('DELETE FROM appSession WHERE id = ? AND refreshingAt = ?').bind(current.id, current.refreshingAt).run();
                break;
            }
        }
        throw new Error('Refresh pending; retry the page');
    }
    try {
        acceptTokens(session.data, await renew(session.data.tokens.refresh_token));
        await save(env, session);
        return session;
    } catch {
        await env.SESSIONS.prepare('DELETE FROM appSession WHERE id = ? AND version = ?').bind(session.id, session.version).run();
        throw new Error('Refresh unconfirmed; sign in again');
    }
}

const app = new Hono<{ Bindings: ServerWebBindings }>();
app.use('*', bodyLimit({ maxSize: 8192 }));
app.all('*', async (c) => {
    c.header('Cache-Control', 'no-store');
    // Keep same-origin form POST Origin headers; never disclose callback queries.
    c.header('Referrer-Policy', 'strict-origin');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(c.env.LOGINFLARE_ISSUER).origin}; frame-ancestors 'none'; base-uri 'none'`);
    if (new URL(c.req.url).origin !== c.env.LOGINFLARE_ORIGIN) return c.text('Invalid origin', 400);
    const raw = c.req.header('Cookie')?.split(/;\s*/).find((part) => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    let session = raw ? await load(c.env, await digest(raw)) : null;
    async function create(data: Data = { csrf: random() }) {
        const value = random(), id = await digest(value), expiresAt = Date.now() + 8 * 3600_000;
        await c.env.SESSIONS.prepare('INSERT INTO appSession(id, data, expiresAt) VALUES (?, ?, ?)').bind(id, await seal(c.env, id, data), expiresAt).run();
        c.header('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`);
        return { id, data, expiresAt, version: 0, refreshingAt: null };
    }
    session ??= await create();
    const html = (content: string, failed = false) => {
        const button = (action: string, label: string) => `<form method="post" action="${action}"><input type="hidden" name="csrf" value="${escape(session!.data.csrf)}"><button>${label}</button></form>`;
        const logout = session!.data.tokens ? button('/logout', 'Sign out of this app') + button('/logout-center', 'Sign out of this app and Loginflare') : '';
        return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Loginflare Web application</title><main><h1>Server Web example</h1>${content}${failed ? button('/login', 'Sign in again') + logout : session!.data.tokens ? button('/refresh', 'Refresh tokens') + logout : button('/login', 'Sign in with Loginflare')}<p><a href="/">Reload account information</a></p></main></html>`, failed ? 400 : 200);
    };
    try {
        const path = c.req.path;
        if (!['GET', 'POST'].includes(c.req.method)) return c.text('Method not allowed', 405);
        if (c.req.method === 'POST') {
            if (c.req.header('Origin') !== c.env.LOGINFLARE_ORIGIN || !c.req.header('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return c.text('Invalid request', 403);
            const body = new URLSearchParams(await c.req.text());
            if (!equal(body.get('csrf'), session.data.csrf)) return c.text('Invalid request', 403);
        }
        if (c.req.method === 'POST' && path === '/login') {
            const config = await configuration(c.env);
            const pending = { verifier: oidc.randomPKCECodeVerifier(), state: oidc.randomState(), nonce: oidc.randomNonce(), expiresAt: Date.now() + 600_000 };
            session.data.authorization = pending;
            await save(c.env, session);
            return c.redirect(String(oidc.buildAuthorizationUrl(config, { redirect_uri: `${c.env.LOGINFLARE_ORIGIN}/callback`, scope: 'openid profile email offline_access',
                code_challenge: await oidc.calculatePKCECodeChallenge(pending.verifier), code_challenge_method: 'S256', state: pending.state, nonce: pending.nonce })), 303);
        }
        if (c.req.method === 'GET' && path === '/callback') {
            const pending = session.data.authorization;
            if (!pending || pending.expiresAt <= Date.now()) throw new Error('Expired authorization');
            const claimed = await c.env.SESSIONS.prepare('DELETE FROM appSession WHERE id = ? AND version = ? RETURNING id').bind(session.id, session.version).first();
            if (!claimed) throw new Error('Authorization already consumed');
            // The old transaction is consumed even when the user denied consent.
            // Render any retry form against a live replacement session and CSRF.
            session = await create();
            const config = await configuration(c.env);
            const tokens = await oidc.authorizationCodeGrant(config, new URL(c.req.url), { pkceCodeVerifier: pending.verifier, expectedState: pending.state, expectedNonce: pending.nonce, idTokenExpected: true });
            acceptTokens(session.data, tokens);
            await save(c.env, session);
            return c.redirect('/', 303);
        }
        if (c.req.method === 'POST' && ['/logout', '/logout-center'].includes(path)) {
            const tokens = session.data.tokens;
            await c.env.SESSIONS.prepare('DELETE FROM appSession WHERE id = ?').bind(session.id).run();
            session = await create();
            let confirmed = true;
            const config = tokens ? await configuration(c.env).catch(() => null) : null;
            for (const hint of ['access_token', 'refresh_token'] as const) if (tokens?.[hint]) {
                try { if (!config) throw new Error('Unavailable'); await oidc.tokenRevocation(config, tokens[hint], { token_type_hint: hint }); }
                catch { confirmed = false; }
            }
            session.data.revocationUnconfirmed = !confirmed;
            if (path === '/logout-center' && tokens?.id_token && config) {
                session.data.logoutState = oidc.randomState();
                await save(c.env, session);
                return c.redirect(String(oidc.buildEndSessionUrl(config, { id_token_hint: tokens.id_token, post_logout_redirect_uri: `${c.env.LOGINFLARE_ORIGIN}/logout-callback`, state: session.data.logoutState })), 303);
            }
            await save(c.env, session);
            return c.redirect('/', 303);
        }
        if (c.req.method === 'GET' && path === '/logout-callback') {
            if (!session.data.logoutState || !equal(c.req.query('state') ?? null, session.data.logoutState)) throw new Error('Invalid logout state');
            delete session.data.logoutState;
            await save(c.env, session);
            return c.redirect('/', 303);
        }
        if (path === '/' || c.req.method === 'POST' && path === '/refresh') {
            if (!session.data.tokens) return html(`<p>You are signed out of this application.</p>${session.data.revocationUnconfirmed ? '<p role="alert">Local sign-out is complete. Remote token revocation could not be confirmed.</p>' : ''}`);
            const config = await configuration(c.env);
            if (path === '/refresh' || (session.data.accessExpiresAt ?? 0) <= Date.now() + 60_000) session = await refreshSession(c.env, session, (token) => oidc.refreshTokenGrant(config, token));
            if (path === '/refresh') return c.redirect('/', 303);
            const profile = await oidc.fetchUserInfo(config, session.data.tokens!.access_token, session.data.subject!);
            return html(`<h2>Signed in</h2><pre>${escape(JSON.stringify(profile, null, 2))}</pre>`);
        }
        return c.text('Not found', 404);
    } catch { return html('<p role="alert">The identity request failed or expired. Sign in again to restart the flow.</p>', true); }
});
app.onError(() => new Response('Application unavailable', { status: 503, headers: { 'Cache-Control': 'no-store' } }));

export default {
    fetch: app.fetch,
    async scheduled(_event: ScheduledController, env: ServerWebBindings) {
        await env.SESSIONS.prepare('DELETE FROM appSession WHERE id IN (SELECT id FROM appSession WHERE expiresAt <= ? ORDER BY expiresAt LIMIT 500)').bind(Date.now()).run();
    },
};
