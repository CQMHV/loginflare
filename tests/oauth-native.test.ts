import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAuth } from '../src/server/auth';
import { cookies, harness, origin, password, recoveryToken, session } from './helpers';

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected outbound request');
        return Response.json({ success: true });
    });
});

afterEach(async () => {
    vi.unstubAllGlobals();
    await reset();
});

async function nativeFixture() {
    const client = harness();
    const administrator = await client.administrator();
    await client.verify();
    const cookie = await client.signin();
    const identity = (await session(client, cookie))!;
    const auth = createAuth(client.bindings);
    const registered = await auth.api.adminCreateOAuthClient({
        headers: new Headers({ Cookie: administrator, Origin: origin }),
        body: {
            client_name: 'Native security gate',
            redirect_uris: ['https://client.example.test/callback'],
            post_logout_redirect_uris: ['https://client.example.test/'],
            scope: 'openid profile email offline_access',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            application_type: 'web',
            require_pkce: true,
            skip_consent: false,
            enable_end_session: true,
        },
    });
    const verifier = 'a-repeatable-native-test-verifier-at-least-43-characters';
    const challengeBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...challengeBytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const query = new URLSearchParams({ client_id: registered.client_id, redirect_uri: 'https://client.example.test/callback', scope: 'openid profile email offline_access', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'Native-State', nonce: 'Native-Nonce' });
    const requested = await auth.handler(new Request(`${origin}/api/auth/oauth2/authorize?${query}`, { headers: { Cookie: cookie } }));
    expect(requested.status, await requested.clone().text()).toBe(302);
    const consent = new URL(requested.headers.get('location')!, origin);
    expect(consent.pathname).toBe('/en-us/consent');
    const accepted = await auth.handler(new Request(`${origin}/api/auth/oauth2/consent`, {
        method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accept: true, oauth_query: consent.search.slice(1) }),
    }));
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const authorization = await accepted.json<{ url: string }>();
    const code = new URL(authorization.url).searchParams.get('code')!;
    async function token(form: Record<string, string>) {
        return createAuth(client.bindings).handler(new Request(`${origin}/api/auth/oauth2/token`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: registered.client_id, ...form }).toString(),
        }));
    }
    const issued = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'https://client.example.test/callback' });
    expect(issued.status, await issued.clone().text()).toBe(200);
    const tokens = await issued.json<{ refresh_token: string; access_token: string }>();
    expect(tokens.refresh_token).toBeTruthy();
    async function issueAnotherGrant(activeCookie = cookie) {
        const response = await auth.handler(new Request(`${origin}/api/auth/oauth2/authorize?${query}`, { headers: { Cookie: activeCookie } }));
        expect(response.status, await response.clone().text()).toBe(302);
        const code = new URL(response.headers.get('location')!).searchParams.get('code')!;
        expect(code).toBeTruthy();
        return token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'https://client.example.test/callback' });
    }
    return { client, administrator, cookie, identity, auth, registered, token, tokens, issueAnotherGrant };
}

it.each(['sign-out', 'ban-user'] as const)('applies the explicit account policy after %s', async (operation) => {
    const { client, administrator, cookie, identity, auth, token, tokens } = await nativeFixture();
    const invalidated = operation === 'sign-out'
        ? await client.request('/api/auth/sign-out', { cookie, body: {} })
        : await client.request('/api/auth/admin/ban-user', { cookie: administrator, body: { userId: identity.user.id } });
    expect(invalidated.status, await invalidated.clone().text()).toBe(200);
    expect(await session(client, cookie)).toBeNull();
    const renewed = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    const renewedBody = await renewed.clone().json<{ access_token?: string; refresh_token?: string; error?: string }>();
    const profile = renewedBody.access_token ? await auth.handler(new Request(`${origin}/api/auth/oauth2/userinfo`, { headers: { Authorization: `Bearer ${renewedBody.access_token}` } })) : null;
    if (operation === 'sign-out') {
        expect(renewed.status, await renewed.clone().text()).toBe(200);
        expect(profile?.status).toBe(200);
    } else {
        expect(renewed.ok).toBe(false);
        expect(renewedBody.access_token).toBeUndefined();
        expect((await client.request('/api/auth/admin/unban-user', { cookie: administrator, body: { userId: identity.user.id } })).status).toBe(200);
        expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).ok).toBe(false);
    }
});

it.each(['revoke-other-sessions', 'admin-revoke', 'change-password', 'reset-password', 'ban-user'] as const)(
    'covers sessions beyond the native first page during %s without a refresh escaping', async (operation) => {
        const { client, administrator, cookie, identity, token, issueAnotherGrant } = await nativeFixture();
        const inserts = Array.from({ length: 260 }, (_, index) => env.DB.prepare(`INSERT INTO "session"
            ("id", "token", "userId", "expiresAt", "createdAt", "updatedAt")
            SELECT ?, ?, "userId", "expiresAt", "createdAt", "updatedAt" FROM "session" WHERE "id" = ?`)
            .bind(`bulk-session-${index}`, `bulk-token-${index}`, identity.session.id));
        await env.DB.batch(inserts);
        const lateCookie = await client.signin();
        const lateIdentity = (await session(client, lateCookie))!;
        const lateGrantResponse = await issueAnotherGrant(lateCookie);
        expect(lateGrantResponse.status, await lateGrantResponse.clone().text()).toBe(200);
        const lateTokens = await lateGrantResponse.json<{ refresh_token: string }>();
        const grant = await env.DB.prepare('SELECT "authorizationCodeId" FROM "oauthGrantPolicy" WHERE "originalSessionId" = ?')
            .bind(lateIdentity.session.id).first<{ authorizationCodeId: string }>();
        expect(grant).toBeTruthy();
        let resetToken: string | undefined;
        if (operation === 'reset-password') resetToken = await recoveryToken(client);
        const paused = pauseNextStatement(client.bindings.DB);
        client.bindings.DB = paused.binding;
        const rotating = token({ grant_type: 'refresh_token', refresh_token: lateTokens.refresh_token });
        let response: Response;
        try {
            await Promise.race([paused.reached, rotating.then(() => { throw new Error('Rotation missed the insertion boundary'); })]);
            if (operation === 'admin-revoke' || operation === 'ban-user') {
                response = await client.request(`/api/auth/admin/${operation === 'admin-revoke' ? 'revoke-user-sessions' : 'ban-user'}`, { cookie: administrator, body: { userId: identity.user.id } });
            } else if (operation === 'change-password') {
                response = await client.request('/api/auth/change-password', { cookie, body: { currentPassword: password, newPassword: 'Changed-bulk-password-602!', revokeOtherSessions: true } });
            } else if (operation === 'reset-password') {
                response = await client.request('/api/auth/reset-password', { body: { token: resetToken!, newPassword: 'Reset-bulk-password-602!' } });
            } else {
                response = await client.request('/api/auth/revoke-other-sessions', { cookie, body: {} });
            }
            expect(response.status, await response.clone().text()).toBe(200);
            const preserved = operation === 'revoke-other-sessions' || operation === 'change-password';
            expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "session" WHERE "userId" = ?').bind(identity.user.id).first('count')).toBe(preserved ? 1 : 0);
            expect(await env.DB.prepare('SELECT "revokedAt" FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = ?').bind(grant!.authorizationCodeId).first('revokedAt')).toBeTruthy();
            if (operation === 'revoke-other-sessions') expect(await session(client, cookie)).not.toBeNull();
            if (operation === 'change-password') expect(await session(client, cookies(response))).not.toBeNull();
        } finally { paused.resume(); }
        expect((await rotating).ok).toBe(false);
        expect(await session(client, lateCookie)).toBeNull();
    },
);

it('rejects token use and issuance from a suspended account even when token revocation is incomplete', async () => {
    const { identity, auth, token, tokens } = await nativeFixture();
    await env.DB.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?').bind(identity.user.id).run();
    // Simulate an incomplete revocation without disabling the independent eligibility checks.
    await env.DB.prepare('UPDATE "oauthAccessToken" SET "revoked" = NULL').run();
    await env.DB.prepare('UPDATE "oauthRefreshToken" SET "revoked" = NULL').run();
    const profile = await auth.handler(new Request(`${origin}/api/auth/oauth2/userinfo`, { headers: { Authorization: `Bearer ${tokens.access_token}` } }));
    expect(profile.ok).toBe(false);
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).ok).toBe(false);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "oauthGrantPolicy" WHERE "userId" = ? AND "revokedAt" IS NOT NULL').bind(identity.user.id).first('count')).toBe(1);
});

/** Pause an actual native D1 statement at the selected concurrency boundary. */
function pauseNextStatement(database: D1Database, sqlFragment = 'insert into "oauthrefreshtoken"') {
    let entered!: () => void;
    let resume!: () => void;
    let paused = false;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { resume = resolve; });
    function statementProxy(statement: D1PreparedStatement): D1PreparedStatement {
        return new Proxy(statement, { get(target, property) {
            if (property === 'bind') return (...values: unknown[]) => statementProxy(target.bind(...values));
            const value = Reflect.get(target, property);
            if (['all', 'run', 'raw', 'first'].includes(String(property)) && typeof value === 'function') {
                return async (...args: unknown[]) => {
                    if (!paused) {
                        paused = true;
                        entered();
                        await released;
                    }
                    return Reflect.apply(value, target, args);
                };
            }
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    }
    const binding = new Proxy(database, { get(target, property) {
        if (property === 'prepare') return (sql: string) => {
            const statement = target.prepare(sql);
            return sql.toLowerCase().includes(sqlFragment) ? statementProxy(statement) : statement;
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { binding, reached, resume };
}

it.each(['ban-user', 'revoke-session'] as const)('prevents an in-flight native refresh successor escaping %s', async (operation) => {
    const { client, administrator, cookie, identity, token, tokens } = await nativeFixture();
    const paused = pauseNextStatement(client.bindings.DB);
    client.bindings.DB = paused.binding;
    const rotating = token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    try {
        await Promise.race([paused.reached, rotating.then(() => { throw new Error('Native rotation completed before the intended insertion boundary'); })]);
        // The old refresh row has already been consumed, but its successor does not exist yet.
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "oauthRefreshToken" WHERE "revoked" IS NULL').first('count')).toBe(0);
        const response = operation === 'ban-user'
            ? await client.request('/api/auth/admin/ban-user', { cookie: administrator, body: { userId: identity.user.id } })
            : await client.request('/api/auth/revoke-session', { cookie, body: { token: identity.session.token } });
        expect(response.status, await response.clone().text()).toBe(200);
        if (operation === 'ban-user') {
            // Even a restore before the old request resumes cannot resurrect the old grant.
            expect((await client.request('/api/auth/admin/unban-user', { cookie: administrator, body: { userId: identity.user.id } })).status).toBe(200);
        }
    } finally {
        paused.resume();
    }
    expect((await rotating).ok).toBe(false);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "oauthRefreshToken" WHERE "revoked" IS NULL').first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "oauthAccessToken" WHERE "revoked" IS NULL').first('count')).toBe(0);
});

it('requires the original session when an in-flight authorization code first registers a grant', async () => {
    const { client, administrator, identity, issueAnotherGrant } = await nativeFixture();
    const paused = pauseNextStatement(client.bindings.DB);
    client.bindings.DB = paused.binding;
    const issuing = issueAnotherGrant();
    try {
        await Promise.race([paused.reached, issuing.then(() => { throw new Error('New grant completed before the intended insertion boundary'); })]);
        expect((await client.request('/api/auth/admin/ban-user', { cookie: administrator, body: { userId: identity.user.id } })).status).toBe(200);
        expect((await client.request('/api/auth/admin/unban-user', { cookie: administrator, body: { userId: identity.user.id } })).status).toBe(200);
    } finally {
        paused.resume();
    }
    expect((await issuing).ok).toBe(false);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "oauthGrantPolicy" WHERE "revokedAt" IS NULL').first('count')).toBe(0);
});

it.each(['revoke-session', 'ban-user'] as const)('blocks a first grant during the gap between %s and native session deletion', async (operation) => {
    const { client, administrator, cookie, identity, issueAnotherGrant } = await nativeFixture();
    const paused = pauseNextStatement(client.bindings.DB, 'delete from "session"');
    client.bindings.DB = paused.binding;
    const revoking = operation === 'ban-user'
        ? client.request('/api/auth/admin/ban-user', { cookie: administrator, body: { userId: identity.user.id } })
        : client.request('/api/auth/revoke-session', { cookie, body: { token: identity.session.token } });
    let issued: Response;
    try {
        await Promise.race([paused.reached, revoking.then(() => { throw new Error('Session revocation completed before the intended DELETE boundary'); })]);
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "session" WHERE "id" = ?').bind(identity.session.id).first('count')).toBe(1);
        // Existing grants have been revoked, but a second authorization code has never had a ledger row.
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "oauthGrantPolicy" WHERE "revokedAt" IS NULL').first('count')).toBe(0);
        if (operation === 'ban-user') {
            // Restore while the old session still exists, before native ban cleanup runs.
            expect((await client.request('/api/auth/admin/unban-user', { cookie: administrator, body: { userId: identity.user.id } })).status).toBe(200);
        }
        expect(await env.DB.prepare('SELECT "oauthRevokedAt" FROM "session" WHERE "id" = ?').bind(identity.session.id).first('oauthRevokedAt')).toBeTruthy();
        issued = await issueAnotherGrant();
    } finally {
        paused.resume();
    }
    expect((await revoking).status).toBe(200);
    expect(issued!.ok, 'A session being explicitly revoked must not register a new offline grant').toBe(false);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "oauthGrantPolicy" WHERE "revokedAt" IS NULL').first('count')).toBe(0);
});
