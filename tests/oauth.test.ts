import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/server/index';
import { addVerifiedEmail, cookies, harness, origin, password, recoveryToken, session } from './helpers';

const issuer = `${origin}/api/auth`;
const callback = 'https://client.example.test/callback';
const appOrigin = new URL(callback).origin;
const scopes = ['openid', 'profile', 'email', 'offline_access'];
type Harness = ReturnType<typeof harness>;
interface Application {
    clientId: string;
    name: string;
    type: 'web' | 'spa';
    redirectUris: string[];
    postLogoutRedirectUris: string[];
    scopes: string[];
    disabled: boolean;
}
interface Registered {
    application: Application;
    clientSecret?: string;
}
interface Tokens {
    access_token: string;
    refresh_token: string;
    id_token: string;
    token_type: string;
    expires_in: number;
}

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url === `${issuer}/jwks` && request.method === 'GET') {
            const ctx = createExecutionContext();
            const response = await app.fetch(request, harness().bindings, ctx);
            await waitOnExecutionContext(ctx);
            return response;
        }
        if (request.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify' || request.method !== 'POST') {
            throw new Error('Unexpected outbound request in an isolated OAuth integration test');
        }
        return Response.json({ success: true });
    });
});

afterEach(async () => {
    vi.unstubAllGlobals();
    await reset();
});

async function protocol(client: Harness, path: string, options: {
    form?: Record<string, string>;
    cookie?: string;
    headers?: Record<string, string>;
    method?: string;
} = {}) {
    const headers = new Headers({ 'CF-Connecting-IP': '192.0.2.20', ...options.headers });
    if (options.cookie) headers.set('Cookie', options.cookie);
    if (options.form) headers.set('Content-Type', 'application/x-www-form-urlencoded');
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request(new URL(path, origin), {
        method: options.method ?? (options.form ? 'POST' : 'GET'),
        headers,
        body: options.form ? new URLSearchParams(options.form).toString() : undefined,
        redirect: 'manual',
    }), client.bindings, ctx);
    await waitOnExecutionContext(ctx);
    return response;
}

async function register(client: Harness, adminCookie: string, type: 'web' | 'spa' = 'spa'): Promise<Registered> {
    const response = await client.request('/api/admin/applications', {
        cookie: adminCookie,
        body: { name: 'Integration application', type, redirectUris: [callback], postLogoutRedirectUris: [`${appOrigin}/`], scopes },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const registered = await response.json<Registered>();
    expect(registered.application.clientId).toBeTruthy();
    if (type === 'web') expect(registered.clientSecret).toBeTruthy();
    else expect(registered.clientSecret).toBeUndefined();
    return registered;
}

async function fixture(type: 'web' | 'spa' = 'spa') {
    const client = harness();
    const adminCookie = await client.administrator();
    const registered = await register(client, adminCookie, type);
    await client.verify();
    const cookie = await client.signin();
    return { client, adminCookie, registered, cookie };
}

function base64url(value: Uint8Array) {
    return btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64url(value: string) {
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
}

async function authorizationParameters(registered: Registered, overrides: Record<string, string> = {}) {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const query = new URLSearchParams({
        client_id: registered.application.clientId,
        redirect_uri: callback,
        response_type: 'code',
        response_mode: 'query',
        scope: scopes.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'CaseSensitive-State_123',
        nonce: 'CaseSensitive-Nonce_456',
        ...overrides,
    });
    return { verifier, query };
}

async function redirectUrl(response: Response) {
    const location = response.headers.get('location');
    if (location) return new URL(location, origin);
    const body = await response.clone().json<{ url?: string; redirect_uri?: string }>();
    expect(body.url ?? body.redirect_uri, await response.clone().text()).toBeTruthy();
    return new URL((body.url ?? body.redirect_uri)!, origin);
}

async function authorize(client: Harness, registered: Registered, cookie: string, overrides: Record<string, string> = {}) {
    const request = await authorizationParameters(registered, overrides);
    const response = await protocol(client, `/api/auth/oauth2/authorize?${request.query}`, { cookie });
    expect([200, 302]).toContain(response.status);
    let location = await redirectUrl(response);
    if (location.origin === origin && location.pathname.endsWith('/consent')) {
        const approved = await client.request('/api/auth/oauth2/consent', {
            cookie, body: { accept: true, oauth_query: location.search.slice(1) },
        });
        expect(approved.status, await approved.clone().text()).toBe(200);
        location = await redirectUrl(approved);
    }
    expect(location.origin).toBe(appOrigin);
    expect(location.pathname).toBe('/callback');
    expect(location.searchParams.get('state')).toBe(request.query.get('state'));
    expect(location.searchParams.get('error'), location.href).toBeNull();
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();
    return { ...request, code: code! };
}

function authentication(registered: Registered): Record<string, string> {
    return registered.clientSecret
        ? { Authorization: `Basic ${btoa(`${encodeURIComponent(registered.application.clientId)}:${encodeURIComponent(registered.clientSecret)}`)}` }
        : { Origin: appOrigin };
}

async function exchange(client: Harness, registered: Registered, code: string, verifier: string) {
    return protocol(client, '/api/auth/oauth2/token', {
        headers: authentication(registered),
        form: { grant_type: 'authorization_code', client_id: registered.application.clientId, redirect_uri: callback, code, code_verifier: verifier },
    });
}

async function tokensFor(client: Harness, registered: Registered, cookie: string) {
    const { code, verifier } = await authorize(client, registered, cookie);
    const response = await exchange(client, registered, code, verifier);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json<Tokens>();
}

async function refresh(client: Harness, registered: Registered, token: string) {
    return protocol(client, '/api/auth/oauth2/token', {
        headers: authentication(registered),
        form: { grant_type: 'refresh_token', client_id: registered.application.clientId, refresh_token: token },
    });
}

async function userInfo(client: Harness, token: string) {
    return protocol(client, '/api/auth/oauth2/userinfo', { headers: { Authorization: `Bearer ${token}` } });
}

describe('OAuth/OIDC protocol in the Workers runtime', () => {
    it.each(['web', 'spa'] as const)('completes %s PKCE login and verifies an RS256 ID token against discovery/JWKS', async (type) => {
        const { client, registered, cookie } = await fixture(type);
        const discoveryResponse = await protocol(client, '/api/auth/.well-known/openid-configuration');
        expect(discoveryResponse.status).toBe(200);
        const discovery = await discoveryResponse.json<Record<string, unknown>>();
        expect(discovery).toMatchObject({ issuer, authorization_endpoint: `${issuer}/oauth2/authorize`, token_endpoint: `${issuer}/oauth2/token`, jwks_uri: `${issuer}/jwks` });
        expect(discovery.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
        expect(discovery.grant_types_supported).not.toContain('client_credentials');
        const tokens = await tokensFor(client, registered, cookie);
        expect(tokens.token_type.toLowerCase()).toBe('bearer');
        expect(tokens.access_token.split('.')).toHaveLength(1);
        expect(tokens.refresh_token).toBeTruthy();
        const [encodedHeader, encodedClaims, encodedSignature] = tokens.id_token.split('.');
        const header = JSON.parse(new TextDecoder().decode(decodeBase64url(encodedHeader))) as { alg: string; kid: string };
        const claims = JSON.parse(new TextDecoder().decode(decodeBase64url(encodedClaims))) as Record<string, unknown>;
        expect(header.alg).toBe('RS256');
        const jwks = await (await protocol(client, '/api/auth/jwks')).json<{ keys: (JsonWebKey & { kid: string })[] }>();
        const jwk = jwks.keys.find((key) => key.kid === header.kid)!;
        expect(jwk).toBeTruthy();
        expect(jwk.d).toBeUndefined();
        const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
        expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeBase64url(encodedSignature), new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`))).toBe(true);
        expect(claims).toMatchObject({ iss: issuer, aud: registered.application.clientId, nonce: 'CaseSensitive-Nonce_456' });
        expect(Number(claims.exp)).toBeGreaterThan(Date.now() / 1000);
        expect(claims.role).toBeUndefined();
        const profile = await userInfo(client, tokens.access_token);
        expect(profile.status, await profile.clone().text()).toBe(200);
        expect(await profile.json()).toMatchObject({ sub: claims.sub, email: 'person@example.test', email_verified: true, name: 'Test Person' });
    });

    it('asks for first consent, propagates denial and requires consent for additional scopes', async () => {
        const { client, registered, cookie } = await fixture();
        const initial = await authorizationParameters(registered, { scope: 'openid' });
        const response = await protocol(client, `/api/auth/oauth2/authorize?${initial.query}`, { cookie });
        const consent = await redirectUrl(response);
        expect(consent.pathname).toBe('/en-us/consent');
        const context = await client.request(`/api/oauth/consent?${new URLSearchParams({ oauth_query: consent.search.slice(1) })}`, { cookie });
        expect(context.status, await context.clone().text()).toBe(200);
        expect(await context.json()).toMatchObject({ client: { clientId: registered.application.clientId, name: registered.application.name }, scopes: ['openid'] });
        const denied = await client.request('/api/auth/oauth2/consent', { cookie, body: { accept: false, oauth_query: consent.search.slice(1) } });
        expect((await redirectUrl(denied)).searchParams.get('error')).toBe('access_denied');
        await authorize(client, registered, cookie, { scope: 'openid' });
        const repeated = await authorizationParameters(registered, { scope: 'openid' });
        expect((await redirectUrl(await protocol(client, `/api/auth/oauth2/authorize?${repeated.query}`, { cookie }))).origin).toBe(appOrigin);
        const expanded = await authorizationParameters(registered);
        expect((await redirectUrl(await protocol(client, `/api/auth/oauth2/authorize?${expanded.query}`, { cookie }))).pathname).toBe('/en-us/consent');
    });

    it.each(['email', 'username'] as const)('preserves signed %s login context and rejects modified consent context', async (method) => {
        const { client, registered, cookie } = await fixture();
        if (method === 'username') expect((await client.request('/api/auth/update-user', { cookie, body: { username: 'oauth_person' } })).status).toBe(200);
        const initial = await authorizationParameters(registered);
        const response = await protocol(client, `/api/auth/oauth2/authorize?${initial.query}`);
        const login = await redirectUrl(response);
        expect(login.pathname).toBe('/en-us/login');
        expect(login.searchParams.get('state')).toBe('CaseSensitive-State_123');
        expect(login.searchParams.get('sig')).toBeTruthy();
        const original = login.search.slice(1);
        login.searchParams.set('scope', 'openid profile email arbitrary');
        const tampered = await client.request('/api/auth/oauth2/consent', { cookie, body: { accept: true, oauth_query: login.search.slice(1) } });
        expect(tampered.ok).toBe(false);
        const identifier = method === 'username' ? { username: 'OAUTH_PERSON' } : { email: 'person@example.test' };
        const signedIn = await client.request(`/api/auth/sign-in/${method}`, { body: { ...identifier, password, oauth_query: original } });
        expect(signedIn.status, await signedIn.clone().text()).toBe(200);
        expect((await redirectUrl(signedIn)).pathname).toBe('/en-us/consent');
    });

    it.each(['web', 'spa'] as const)('requires PKCE S256 and exact redirect URIs for %s clients', async (type) => {
        const { client, registered, cookie } = await fixture(type);
        const rejectedRequests: Record<string, string>[] = [
            { code_challenge: '', code_challenge_method: '' },
            { code_challenge_method: 'plain' },
            { response_mode: 'fragment' },
            { response_mode: 'form_post' },
            { redirect_uri: `${callback}/unregistered` },
            { redirect_uri: 'https://attacker.invalid/callback' },
        ];
        for (const overrides of rejectedRequests) {
            const request = await authorizationParameters(registered, overrides);
            const response = await protocol(client, `/api/auth/oauth2/authorize?${request.query}`, { cookie });
            if (response.status < 400) {
                const target = await redirectUrl(response);
                expect(target.searchParams.has('code')).toBe(false);
                expect(target.origin).not.toBe('https://attacker.invalid');
                expect(target.pathname).not.toMatch(/\/consent$/);
            }
        }
        const authorized = await authorize(client, registered, cookie);
        const denied = await exchange(client, registered, authorized.code, 'incorrect-verifier-that-is-at-least-forty-three-characters-long');
        expect(denied.ok).toBe(false);
    });

    it('rejects a confidential client using an incorrect secret or no client authentication', async () => {
        const { client, registered, cookie } = await fixture('web');
        const authorized = await authorize(client, registered, cookie);
        for (const clientSecret of ['incorrect-secret', undefined]) {
            const denied = await exchange(client, { ...registered, clientSecret }, authorized.code, authorized.verifier);
            expect(denied.ok).toBe(false);
        }
        const accepted = await exchange(client, registered, authorized.code, authorized.verifier);
        expect(accepted.status, await accepted.clone().text()).toBe(200);
    });

    it('consumes an authorization code at most once under concurrent D1 exchange', async () => {
        const { client, registered, cookie } = await fixture();
        const authorized = await authorize(client, registered, cookie);
        const responses = await Promise.all(Array.from({ length: 3 }, () => exchange(client, registered, authorized.code, authorized.verifier)));
        // Native replay cleanup can also revoke the winning request's grant while it is minting.
        expect(responses.filter((response) => response.ok).length).toBeLessThanOrEqual(1);
        const replay = await exchange(client, registered, authorized.code, authorized.verifier);
        expect(replay.ok).toBe(false);
    });

    it('rejects an expired authorization code and refresh token', async () => {
        const { client, registered, cookie } = await fixture();
        const authorized = await authorize(client, registered, cookie);
        await env.DB.prepare('UPDATE "verification" SET "expiresAt" = ?').bind(new Date(Date.now() - 60_000).toISOString()).run();
        expect((await exchange(client, registered, authorized.code, authorized.verifier)).ok).toBe(false);
        const tokens = await tokensFor(client, registered, cookie);
        await env.DB.prepare('UPDATE "oauthRefreshToken" SET "expiresAt" = ?').bind(new Date(Date.now() - 60_000).toISOString()).run();
        expect((await refresh(client, registered, tokens.refresh_token)).ok).toBe(false);
    });

    it('rotates refresh tokens, rejects replay, and supports standard revocation', async () => {
        const { client, registered, cookie } = await fixture('web');
        const tokens = await tokensFor(client, registered, cookie);
        const renewed = await refresh(client, registered, tokens.refresh_token);
        expect(renewed.status, await renewed.clone().text()).toBe(200);
        const rotated = await renewed.json<Tokens>();
        expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
        expect((await refresh(client, registered, tokens.refresh_token)).ok).toBe(false);
        const current = await tokensFor(client, registered, cookie);
        const revoked = await protocol(client, '/api/auth/oauth2/revoke', {
            headers: authentication(registered),
            form: { client_id: registered.application.clientId, token: current.refresh_token, token_type_hint: 'refresh_token' },
        });
        expect(revoked.status, await revoked.clone().text()).toBe(200);
        expect((await refresh(client, registered, current.refresh_token)).ok).toBe(false);
    });

    it('ends the browser session while preserving explicitly consented offline renewal after ordinary signout', async () => {
        const { client, registered, cookie } = await fixture();
        const tokens = await tokensFor(client, registered, cookie);
        expect((await userInfo(client, tokens.access_token)).ok).toBe(true);
        expect((await client.request('/api/auth/sign-out', { cookie, body: {} })).status).toBe(200);
        expect((await userInfo(client, tokens.access_token)).ok).toBe(false);
        const renewed = await refresh(client, registered, tokens.refresh_token);
        expect(renewed.status, await renewed.clone().text()).toBe(200);
        expect((await userInfo(client, (await renewed.json<Tokens>()).access_token)).ok).toBe(true);
    });

    it.each(['revoke-session', 'revoke-other-sessions', 'change-password', 'reset-password'] as const)
    ('invalidates credentials linked to sessions ended by %s', async (operation) => {
        const { client, registered, cookie } = await fixture();
        const linked = (await session(client, cookie))!;
        const tokens = await tokensFor(client, registered, cookie);
        const other = await client.signin();
        if (operation === 'reset-password') {
            await addVerifiedEmail(client, cookie, 'recovery@example.test');
            const token = await recoveryToken(client, 'person@example.test', 'recovery@example.test');
            expect((await client.request('/api/auth/reset-password', { body: { token, newPassword: 'Changed-integration-password-643!' } })).status).toBe(200);
            expect(await session(client, cookie)).toBeNull();
            expect(await session(client, other)).toBeNull();
        } else {
            const body = operation === 'revoke-session' ? { token: linked.session.token }
                : operation === 'change-password' ? { currentPassword: password, newPassword: 'Changed-integration-password-643!', revokeOtherSessions: true } : {};
            expect((await client.request(`/api/auth/${operation}`, { cookie: other, body })).status).toBe(200);
        }
        expect((await userInfo(client, tokens.access_token)).ok).toBe(false);
        expect((await refresh(client, registered, tokens.refresh_token)).ok).toBe(false);
    });

    it('keeps the current application grant when changing a password while revoking other grants', async () => {
        const { client, registered, cookie } = await fixture();
        const current = await tokensFor(client, registered, cookie);
        const otherCookie = await client.signin();
        const other = await tokensFor(client, registered, otherCookie);
        const response = await client.request('/api/auth/change-password', {
            cookie, body: { currentPassword: password, newPassword: 'Changed-integration-password-643!', revokeOtherSessions: true },
        });
        expect(response.status, await response.clone().text()).toBe(200);
        expect((await refresh(client, registered, current.refresh_token)).ok).toBe(true);
        expect((await refresh(client, registered, other.refresh_token)).ok).toBe(false);
    });

    it.each(['reset-password', 'admin/revoke-user-sessions'] as const)('revokes already-offline grants on %s even with no user browser session', async (operation) => {
        const { client, registered, cookie, adminCookie } = await fixture();
        const identity = (await session(client, cookie))!;
        const tokens = await tokensFor(client, registered, cookie);
        await client.request('/api/auth/sign-out', { cookie, body: {} });
        const renewed = await refresh(client, registered, tokens.refresh_token);
        expect(renewed.status, await renewed.clone().text()).toBe(200);
        const offline = await renewed.json<Tokens>();
        if (operation === 'reset-password') {
            const token = await recoveryToken(client);
            expect((await client.request('/api/auth/reset-password', { body: { token, newPassword: 'Changed-integration-password-643!' } })).status).toBe(200);
        } else {
            expect((await client.request('/api/auth/admin/revoke-user-sessions', { cookie: adminCookie, body: { userId: identity.user.id } })).status).toBe(200);
        }
        expect((await userInfo(client, offline.access_token)).ok).toBe(false);
        expect((await refresh(client, registered, offline.refresh_token)).ok).toBe(false);
    });

    it('supports RP-initiated logout with a signed ID token and an exact registered return URL', async () => {
        const { client, registered, cookie } = await fixture('web');
        const tokens = await tokensFor(client, registered, cookie);
        const response = await protocol(client, `/api/auth/oauth2/end-session?${new URLSearchParams({ id_token_hint: tokens.id_token, post_logout_redirect_uri: `${appOrigin}/`, state: 'CaseSensitive-Logout-State' })}`, {
            cookie, headers: { Accept: 'text/html' },
        });
        expect([200, 302]).toContain(response.status);
        const target = await redirectUrl(response);
        expect(target.origin).toBe(appOrigin);
        expect(target.pathname).toBe('/');
        expect(target.searchParams.get('state')).toBe('CaseSensitive-Logout-State');
        expect(await session(client, cookie)).toBeNull();
        expect((await userInfo(client, tokens.access_token)).ok).toBe(false);
        const renewed = await refresh(client, registered, tokens.refresh_token);
        expect(renewed.status, await renewed.clone().text()).toBe(200);
    });

    it('requires the native signed confirmation cookie for logout without an ID token', async () => {
        const { client, registered, cookie } = await fixture();
        const unauthorized = await protocol(client, '/api/auth/oauth2/end-session/confirm', { cookie, form: { action: 'confirm' }, headers: { Origin: origin, Accept: 'text/html' } });
        expect(unauthorized.ok).toBe(false);
        expect(await session(client, cookie)).not.toBeNull();
        const unregistered = await protocol(client, `/api/auth/oauth2/end-session?${new URLSearchParams({ client_id: registered.application.clientId, post_logout_redirect_uri: 'https://unregistered.invalid/logout' })}`, { cookie, headers: { Accept: 'text/html' } });
        expect(unregistered.headers.get('content-security-policy')).not.toContain('unregistered.invalid');
        const confirmation = await protocol(client, `/api/auth/oauth2/end-session?${new URLSearchParams({ client_id: registered.application.clientId, post_logout_redirect_uri: `${appOrigin}/` })}`, { cookie, headers: { Accept: 'text/html' } });
        expect(confirmation.status, await confirmation.clone().text()).toBe(200);
        expect(confirmation.headers.get('referrer-policy')).toBe('strict-origin');
        expect(confirmation.headers.get('content-security-policy')).toContain(`form-action 'self' ${appOrigin}`);
        expect(confirmation.headers.get('content-security-policy')).toContain("default-src 'none'");
        expect(await confirmation.text()).toContain('data-oidc-logout-confirmation');
        expect(await session(client, cookie)).not.toBeNull();
        const response = await protocol(client, '/api/auth/oauth2/end-session/confirm', {
            cookie: `${cookie}; ${cookies(confirmation)}`, form: { action: 'confirm' }, headers: { Origin: origin, Accept: 'text/html' },
        });
        expect([200, 302]).toContain(response.status);
        expect((await redirectUrl(response)).origin).toBe(appOrigin);
        expect(await session(client, cookie)).toBeNull();
    });

    it('ban and restore never resurrect OAuth tokens from the revoked session', async () => {
        const { client, registered, cookie, adminCookie } = await fixture();
        const identity = (await session(client, cookie))!;
        const tokens = await tokensFor(client, registered, cookie);
        expect((await client.request('/api/auth/admin/ban-user', { cookie: adminCookie, body: { userId: identity.user.id } })).status).toBe(200);
        expect((await userInfo(client, tokens.access_token)).ok).toBe(false);
        expect((await refresh(client, registered, tokens.refresh_token)).ok).toBe(false);
        expect((await client.request('/api/auth/admin/unban-user', { cookie: adminCookie, body: { userId: identity.user.id } })).status).toBe(200);
        expect((await userInfo(client, tokens.access_token)).ok).toBe(false);
        expect((await refresh(client, registered, tokens.refresh_token)).ok).toBe(false);
        const fresh = await client.signin();
        expect((await tokensFor(client, registered, fresh)).access_token).toBeTruthy();
    });
});

describe('application management and protocol boundaries', () => {
    it('shares applications between administrators while keeping secrets write-only', async () => {
        const { client, registered, adminCookie } = await fixture('web');
        const secondAdmin = await client.administrator('second-admin@example.test');
        const detail = await client.request(`/api/admin/applications/${registered.application.clientId}`, { cookie: secondAdmin });
        expect(detail.status, await detail.clone().text()).toBe(200);
        const serialized = await detail.text();
        expect(serialized).not.toContain(registered.clientSecret!);
        expect(serialized).not.toMatch(/client_secret|clientSecret|secretHash/);
        const listed = await client.request('/api/admin/applications', { cookie: secondAdmin });
        expect(await listed.json()).toMatchObject({ items: [{ clientId: registered.application.clientId }] });
        const rotated = await client.request(`/api/admin/applications/${registered.application.clientId}/rotate-secret`, { cookie: adminCookie, body: {} });
        expect(rotated.status, await rotated.clone().text()).toBe(200);
        const replacement = await rotated.json<{ clientSecret: string }>();
        expect(replacement.clientSecret).toBeTruthy();
        expect(replacement.clientSecret).not.toBe(registered.clientSecret);
        const updated = await client.request(`/api/admin/applications/${registered.application.clientId}`, { cookie: secondAdmin, method: 'PATCH', body: { name: 'Renamed application', disabled: true } });
        expect(updated.status, await updated.clone().text()).toBe(200);
        expect(await updated.json()).toMatchObject({ application: { name: 'Renamed application', disabled: true } });
    });

    it('denies ordinary-user management and immutable or unsafe client settings', async () => {
        const { client, registered, adminCookie, cookie } = await fixture();
        for (const options of [
            { path: '/api/admin/applications' },
            { path: `/api/admin/applications/${registered.application.clientId}` },
            { path: '/api/admin/applications', body: { name: 'Forbidden', type: 'spa', redirectUris: [callback], postLogoutRedirectUris: [], scopes } },
            { path: `/api/admin/applications/${registered.application.clientId}`, method: 'PATCH', body: { disabled: true } },
            { path: `/api/admin/applications/${registered.application.clientId}/rotate-secret`, body: {} },
        ]) {
            const response = await client.request(options.path, { ...options, cookie });
            expect(response.status).toBe(403);
        }
        for (const body of [{ type: 'web' }, { skipConsent: true }, { role: 'admin' }, { redirectUris: ['https://*.example.test/callback'] }, { redirectUris: ['http://example.test/callback'] }, { scopes: ['openid', 'admin'] }]) {
            const response = await client.request(`/api/admin/applications/${registered.application.clientId}`, { cookie: adminCookie, method: 'PATCH', body });
            expect(response.status).toBe(400);
        }
    });

    it.each([
        { path: '/api/auth/.well-known/openid-configuration', headStatus: 200 },
        { path: '/api/auth/.well-known/oauth-authorization-server', headStatus: 200 },
        { path: '/.well-known/oauth-authorization-server/api/auth', headStatus: 200 },
        // The native JWT plugin exposes GET only; its HEAD error still needs CORS.
        { path: '/api/auth/jwks', headStatus: 404 },
    ])('preserves public CORS on discovery and signing-key responses at $path', async ({ path, headStatus }) => {
        const client = harness();
        for (const method of ['GET', 'HEAD']) {
            const response = await protocol(client, path, { method, headers: { Origin: appOrigin } });
            expect(response.status).toBe(method === 'HEAD' ? headStatus : 200);
            expect(response.headers.get('access-control-allow-origin')).toBe('*');
            expect(response.headers.get('access-control-allow-credentials')).toBeNull();
            if (method === 'HEAD') expect(await response.text()).toBe('');
        }
    });

    it('preserves registered SPA CORS on successful token and UserInfo responses', async () => {
        const { client, registered, cookie } = await fixture();
        const { code, verifier } = await authorize(client, registered, cookie);
        const response = await exchange(client, registered, code, verifier);
        expect(response.status, await response.clone().text()).toBe(200);
        expect(response.headers.get('access-control-allow-origin')).toBe(appOrigin);
        expect(response.headers.get('vary')?.split(',').map((value) => value.trim())).toContain('Origin');
        expect(response.headers.get('access-control-allow-credentials')).toBeNull();
        const tokens = await response.json<Tokens>();
        for (const method of ['GET', 'POST']) {
            const profile = await protocol(client, '/api/auth/oauth2/userinfo', {
                method, headers: { Origin: appOrigin, Authorization: `Bearer ${tokens.access_token}` },
                ...(method === 'POST' ? { form: {} } : {}),
            });
            expect(profile.status, await profile.clone().text()).toBe(200);
            expect(profile.headers.get('access-control-allow-origin')).toBe(appOrigin);
            expect(profile.headers.get('vary')?.split(',').map((value) => value.trim())).toContain('Origin');
            expect(profile.headers.get('access-control-allow-credentials')).toBeNull();
            expect(profile.headers.get('access-control-expose-headers')).toBe('WWW-Authenticate');
            expect(await profile.json()).toMatchObject({ email: 'person@example.test', email_verified: true });
        }
    });

    it('does not grant protocol CORS to a confidential Web application origin', async () => {
        const { client } = await fixture('web');
        for (const method of ['GET', 'POST']) {
            const response = await protocol(client, '/api/auth/oauth2/userinfo', {
                method, headers: { Origin: appOrigin, Authorization: 'Bearer invalid' },
                ...(method === 'POST' ? { form: {} } : {}),
            });
            expect(response.status).toBe(403);
            expect(response.headers.get('access-control-allow-origin')).toBeNull();
        }
    });

    it('limits protocol CORS to registered application origins without granting account or admin access', async () => {
        const { client, registered, cookie, adminCookie } = await fixture();
        const preflight = await protocol(client, '/api/auth/oauth2/token', { method: 'OPTIONS', headers: { Origin: appOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
        expect(preflight.ok).toBe(true);
        expect(preflight.headers.get('access-control-allow-origin')).toBe(appOrigin);
        expect(preflight.headers.get('access-control-allow-credentials')).not.toBe('true');
        const foreign = await protocol(client, '/api/auth/oauth2/token', { method: 'OPTIONS', headers: { Origin: 'https://attacker.invalid', 'Access-Control-Request-Method': 'POST' } });
        expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
        for (const options of [
            { headers: { Origin: 'https://attacker.invalid' } },
            { headers: { Origin: appOrigin }, cookie },
        ]) {
            const denied = await protocol(client, '/api/auth/oauth2/token', { ...options, form: { grant_type: 'refresh_token', client_id: registered.application.clientId, refresh_token: 'invalid' } });
            expect(denied.status).toBe(403);
            expect(denied.headers.get('access-control-allow-origin')).toBeNull();
        }
        const account = await client.request('/api/auth/update-user', { cookie, body: { name: 'Cross origin' }, headers: { Origin: appOrigin } });
        expect(account.status).toBe(403);
        const management = await client.request(`/api/admin/applications/${registered.application.clientId}`, { cookie: adminCookie, method: 'PATCH', body: { name: 'Cross origin' }, headers: { Origin: appOrigin } });
        expect(management.status).toBe(403);
    });

    it.each(['token', 'oauth2/register', 'oauth2/create-client', 'oauth2/delete-client', 'oauth2/update-client', 'oauth2/client/rotate-secret', 'admin/oauth2/create-client', 'admin/oauth2/update-client', 'oauth2/delete-consent', 'device/code'])('does not publicly expose unused or native management endpoint %s', async (endpoint) => {
        const client = harness();
        const response = await client.request(`/api/auth/${endpoint}`, { body: {} });
        expect([403, 404, 405]).toContain(response.status);
    });

    it('does not log client secrets, authorization codes, tokens or complete OAuth URLs', async () => {
        const recorder = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const { client, registered, cookie } = await fixture('web');
            const authorization = await authorize(client, registered, cookie);
            const response = await exchange(client, registered, authorization.code, authorization.verifier);
            expect(response.status, await response.clone().text()).toBe(200);
            const tokens = await response.json<Tokens>();
            await userInfo(client, tokens.access_token);
            const logs = recorder.mock.calls.map((args) => args.join(' ')).join('\n');
            expect(logs).toContain('http_request');
            for (const secret of [registered.clientSecret!, authorization.code, authorization.verifier, tokens.access_token, tokens.refresh_token, tokens.id_token, authorization.query.toString()]) {
                expect(logs).not.toContain(secret);
            }
        } finally {
            recorder.mockRestore();
        }
    });
});
