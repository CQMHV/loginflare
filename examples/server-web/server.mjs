import { createServer } from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as oidc from 'openid-client';
import { readExampleTls } from '../setup-tls.mjs';

// Local integration example: tokens and application sessions live only in this process.
const origin = 'https://web.localhost:5181';
const issuer = new URL(process.env.LOGINFLARE_ISSUER || 'http://localhost:5173/api/auth');
const clientId = process.env.LOGINFLARE_CLIENT_ID;
const clientSecret = process.env.LOGINFLARE_CLIENT_SECRET;
if (!clientId || !clientSecret || clientId.startsWith('replace-') || clientSecret.startsWith('replace-')) {
    throw new Error('Set LOGINFLARE_CLIENT_ID and LOGINFLARE_CLIENT_SECRET in examples/server-web/.env.');
}
const localIssuer = issuer.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname);
if (issuer.protocol !== 'https:' && !localIssuer) throw new Error('The issuer must use HTTPS or loopback HTTP.');
const config = await oidc.discovery(issuer, clientId, {
    token_endpoint_auth_method: 'client_secret_basic',
    id_token_signed_response_alg: 'RS256',
}, oidc.ClientSecretBasic(clientSecret), localIssuer ? { execute: [oidc.allowInsecureRequests] } : undefined);
oidc.enableNonRepudiationChecks(config);

/**
 * @typedef {object} AppSession
 * @property {string} id
 * @property {string} csrf
 * @property {number} expiresAt
 * @property {string} [subject]
 * @property {import('openid-client').TokenEndpointResponse} [tokens]
 * @property {number} [accessExpiresAt]
 * @property {Promise<void>} [refreshing]
 * @property {{verifier: string, state: string, nonce: string, expiresAt: number}} [authorization]
 * @property {string} [logoutState]
 * @property {boolean} [revocationUnconfirmed]
 */
/** @type {Map<string, AppSession>} */
const sessions = new Map();
const cookieName = 'loginflare_web_example';
const random = () => randomBytes(32).toString('base64url');
/** @param {unknown} value */
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
/** @param {unknown} a @param {unknown} b */
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** @param {import('node:http').ServerResponse} response @returns {AppSession} */
function newSession(response) {
    const session = { id: random(), csrf: random(), expiresAt: Date.now() + 8 * 60 * 60 * 1000 };
    sessions.set(session.id, session);
    response.setHeader('Set-Cookie', `${cookieName}=${session.id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`);
    return session;
}

/** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
function sessionFor(request, response) {
    const id = request.headers.cookie?.split('; ').find((cookie) => cookie.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const session = id ? sessions.get(id) : undefined;
    if (session && session.expiresAt > Date.now()) return session;
    if (id) sessions.delete(id);
    return newSession(response);
}

/** @param {import('node:http').ServerResponse} response @param {string | URL} destination */
function redirect(response, destination) {
    response.writeHead(303, { Location: String(destination) });
    response.end();
}

/** @param {import('node:http').ServerResponse} response @param {AppSession} session @param {string} content @param {number} [status] */
function html(response, session, content, status = 200) {
    /** @param {string} action @param {string} label */
    const button = (action, label) => `<form method="post" action="${action}"><input type="hidden" name="csrf" value="${session.csrf}"><button>${label}</button></form>`;
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="en-US"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Loginflare — server Web example</title><style>body{font:16px system-ui;margin:3rem auto;padding:0 1.5rem;max-width:48rem;color:#201a15;background:#fff8f4}h1{font-size:2rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:1rem;background:#f4e5db;border-radius:1rem}form{display:inline-block;margin:.5rem .5rem .5rem 0}button{font:inherit;border:0;padding:.8rem 1.3rem;border-radius:2rem;color:#201a15;background:#f38020;cursor:pointer}a{color:#8c4100}p{line-height:1.5}</style><main><h1>Server Web example</h1><p>This independent application uses <code>openid-client</code>. Tokens stay on its server.</p>${content}<nav>${session.tokens ? button('/refresh', 'Refresh tokens') + button('/logout', 'Sign out of this app') + button('/logout-center', 'Sign out of this app and Loginflare') : button('/login', 'Sign in with Loginflare')}</nav><p><a href="/">Reload account information</a></p><p>Local demonstration only. Restarting this process clears its sessions.</p></main></html>`);
}

/** @param {import('node:http').IncomingMessage} request */
async function form(request) {
    if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new Error('Invalid form');
    let length = 0;
    const chunks = [];
    for await (const chunk of request) {
        length += chunk.length;
        if (length > 8192) throw new Error('Form too large');
        chunks.push(chunk);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** @param {AppSession} session @param {import('openid-client').TokenEndpointResponse & import('openid-client').TokenEndpointResponseHelpers} tokens */
function saveTokens(session, tokens) {
    const claims = tokens.claims();
    if (claims && session.subject && claims.sub !== session.subject) throw new Error('Subject changed');
    const subject = session.subject ?? claims?.sub;
    if (!subject) throw new Error('Missing identity');
    session.subject = subject;
    session.tokens = { ...session.tokens, ...tokens };
    session.accessExpiresAt = Date.now() + (tokens.expires_in ?? 0) * 1000;
}

/** @param {AppSession} session */
async function refresh(session) {
    if (!session.tokens?.refresh_token) throw new Error('No refresh token');
    // Serialize rotating refresh-token requests within this application's session.
    session.refreshing ??= oidc.refreshTokenGrant(config, session.tokens.refresh_token)
        .then((tokens) => saveTokens(session, tokens))
        .finally(() => { delete session.refreshing; });
    await session.refreshing;
}

/** @param {AppSession} session */
async function revoke(session) {
    let confirmed = true;
    // Revoke access first: revoking refresh also removes its associated access record.
    for (const hint of /** @type {const} */ (['access_token', 'refresh_token'])) {
        if (!session.tokens?.[hint]) continue;
        try {
            await oidc.tokenRevocation(config, session.tokens[hint], { token_type_hint: hint });
        } catch {
            confirmed = false;
        }
    }
    return confirmed;
}

const server = createServer(readExampleTls(), async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'strict-origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${issuer.origin}; frame-ancestors 'none'; base-uri 'none'`);
    if (request.headers.host !== new URL(origin).host) {
        response.writeHead(400).end();
        return;
    }
    const url = new URL(request.url || '/', origin);
    let session = sessionFor(request, response);
    try {
        if (request.method === 'POST') {
            const body = await form(request);
            if (request.headers.origin !== origin || !equal(body.get('csrf'), session.csrf)) {
                html(response, session, '<p>Invalid request. Reload the page and try again.</p>', 403);
                return;
            }
        }
        if (request.method === 'POST' && url.pathname === '/login') {
            const verifier = oidc.randomPKCECodeVerifier();
            const state = oidc.randomState();
            const nonce = oidc.randomNonce();
            session.authorization = { verifier, state, nonce, expiresAt: Date.now() + 10 * 60 * 1000 };
            redirect(response, oidc.buildAuthorizationUrl(config, {
                redirect_uri: `${origin}/callback`, scope: 'openid profile email offline_access',
                code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce,
            }));
            return;
        }
        if (request.method === 'GET' && url.pathname === '/callback') {
            const pending = session.authorization;
            delete session.authorization;
            if (!pending || pending.expiresAt <= Date.now()) throw new Error('Expired authorization');
            const tokens = await oidc.authorizationCodeGrant(config, url, {
                pkceCodeVerifier: pending.verifier, expectedState: pending.state,
                expectedNonce: pending.nonce, idTokenExpected: true,
            });
            sessions.delete(session.id);
            session = newSession(response);
            saveTokens(session, tokens);
            redirect(response, origin);
            return;
        }
        if (request.method === 'POST' && url.pathname === '/refresh') {
            await refresh(session);
            redirect(response, origin);
            return;
        }
        if (request.method === 'POST' && ['/logout', '/logout-center'].includes(url.pathname)) {
            const idToken = session.tokens?.id_token;
            // Local sign-out must succeed even if expired/revoked tokens cannot be revoked again.
            const revocationConfirmed = await revoke(session);
            sessions.delete(session.id);
            session = newSession(response);
            session.revocationUnconfirmed = !revocationConfirmed;
            if (url.pathname === '/logout-center' && idToken) {
                session.logoutState = oidc.randomState();
                redirect(response, oidc.buildEndSessionUrl(config, {
                    id_token_hint: idToken, post_logout_redirect_uri: `${origin}/logout-callback`, state: session.logoutState,
                }));
            } else redirect(response, origin);
            return;
        }
        if (request.method === 'GET' && url.pathname === '/logout-callback') {
            if (!equal(url.searchParams.get('state'), session.logoutState)) throw new Error('Invalid logout state');
            delete session.logoutState;
            redirect(response, origin);
            return;
        }
        if (request.method === 'GET' && url.pathname === '/') {
            if (!session.tokens) {
                html(response, session, `<p>You are signed out of this application.</p>${session.revocationUnconfirmed ? '<p role="alert">Local sign-out is complete. Remote token revocation could not be confirmed.</p>' : ''}`);
                return;
            }
            if ((session.accessExpiresAt ?? 0) <= Date.now() + 60_000) await refresh(session);
            if (!session.subject) throw new Error('Missing subject');
            const user = await oidc.fetchUserInfo(config, session.tokens.access_token, session.subject);
            html(response, session, `<h2>Signed in</h2><pre>${escape(JSON.stringify(user, null, 2))}</pre><p>Access tokens renew on requests when less than one minute remains. This page also checks UserInfo before displaying the account.</p>`);
            return;
        }
        html(response, session, '<p>Page not found.</p>', 404);
    } catch {
        // Never log the callback URL, library error object, authorization code or tokens.
        html(response, session, `<p role="alert">The identity request failed or expired. Sign in again to restart the flow.</p><form method="post" action="/login"><input type="hidden" name="csrf" value="${session.csrf}"><button>Sign in again</button></form>`, 400);
    }
});

const cleanup = setInterval(() => {
    for (const [id, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(id);
}, 60_000);
cleanup.unref();
server.listen(5181, '127.0.0.1', () => console.log(`Server Web example: ${origin}`));
