import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { addVerifiedEmail, harness, mailCode, origin, password, recoveryToken, session } from './helpers';
import worker from '../src/server/index';
import { sourcePng } from './fixtures/avatars';
import { defaultConnectionConfig, type ConnectionType, type SocialConnection } from '../src/shared/social';
import { authenticatorCode } from './totp';

vi.mock('node:dns/promises', () => ({ resolve4: async () => ['93.184.216.34'], resolve6: async () => [] }));
interface Profile { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }
let key: Awaited<ReturnType<typeof generateKeyPair>>;
const codes = new Map<string, { profile: Profile; nonce?: string; type: ConnectionType }>();
const access = new Map<string, Profile>();
let requests: string[] = [];
let tokenFault = '';

function browser(client = harness()) {
    const jar = new Map<string, string>();
    async function request(path: string, body?: Record<string, unknown>, method?: string) {
        const response = await client.request(path, { body, cookie: [...jar].map(([a, b]) => `${a}=${b}`).join('; '), method });
        for (const line of response.headers.getSetCookie()) {
            const [pair] = line.split(';'), index = pair!.indexOf('='), name = pair!.slice(0, index), value = pair!.slice(index + 1);
            if (/max-age=0/i.test(line) || !value) jar.delete(name); else jar.set(name, value);
        }
        return response;
    }
    return { client, jar, request, cookie: () => [...jar].map(([a, b]) => `${a}=${b}`).join('; ') };
}
async function admin() {
    const b = browser();
    await b.client.verify('admin@example.test');
    await env.DB.prepare('UPDATE "user" SET "role" = ? WHERE "email" = ?').bind('admin', 'admin@example.test').run();
    await b.request('/api/auth/sign-in/email', { email: 'admin@example.test', password });
    return b;
}
async function connector(b: ReturnType<typeof browser>, type: ConnectionType = 'oauth2', tenantId?: string) {
    const config = defaultConnectionConfig(type);
    Object.assign(config, { clientId: 'test-client', issuer: 'https://idp.example.com', discoveryUrl: 'https://idp.example.com/.well-known/openid-configuration',
        authorizationUrl: 'https://idp.example.com/authorize', tokenUrl: 'https://idp.example.com/token', userInfoUrl: 'https://idp.example.com/userinfo' });
    if (type === 'oauth2') config.fields.subject = 'sub';
    if (type === 'microsoft' && tenantId) config.tenantId = tenantId;
    const input = { name: `Test ${type}`, type, config, clientSecret: 'upstream-client-secret', enabled: false, archived: false, revision: 0 };
    const created = await b.request('/api/admin/social-connections', input);
    expect(created.status, await created.clone().text()).toBe(201);
    const row = await created.json<SocialConnection>();
    const result = await b.request(`/api/admin/social-connections/${row.id}`, { ...input, enabled: true }, 'PATCH');
    expect(result.status, await result.clone().text()).toBe(200);
    return result.json<SocialConnection>();
}
async function start(b: ReturnType<typeof browser>, row: SocialConnection, options: Record<string, unknown> = {}) {
    const result = await b.request('/api/auth/social/start', { connectionId: row.id, locale: 'en-US', ...options });
    expect(result.status, await result.clone().text()).toBe(200);
    return new URL((await result.json<{ url: string }>()).url);
}
async function callback(b: ReturnType<typeof browser>, row: SocialConnection, url: URL, profile: Profile) {
    const code = crypto.randomUUID();
    codes.set(code, { profile, nonce: url.searchParams.get('nonce') ?? undefined, type: row.type });
    return b.request(`/api/auth/callback/${row.id}?${new URLSearchParams({ state: url.searchParams.get('state')!, code })}`);
}
async function login(b: ReturnType<typeof browser>, row: SocialConnection, profile: Profile) {
    const response = await callback(b, row, await start(b, row), profile);
    expect(response.status, await response.clone().text()).toBe(302);
    expect(response.headers.get('location')).not.toContain('error=');
    return response;
}

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    key = await generateKeyPair('RS256', { extractable: true }); codes.clear(); access.clear(); requests = []; tokenFault = '';
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init), url = new URL(request.url);
        requests.push(url.href);
        if (url.hostname === 'challenges.cloudflare.com') return Response.json({ success: true });
        if (url.hostname === 'cdn.example.com') return new Response(Uint8Array.from(atob(sourcePng), (value) => value.charCodeAt(0)), { headers: { 'Content-Type': 'image/png' } });
        if (url.pathname.endsWith('openid-configuration')) return Response.json({ issuer: 'https://idp.example.com', authorization_endpoint: 'https://idp.example.com/authorize', token_endpoint: 'https://idp.example.com/token', userinfo_endpoint: 'https://idp.example.com/userinfo', jwks_uri: 'https://idp.example.com/jwks' });
        if (url.pathname.endsWith('/jwks') || url.pathname.endsWith('/jwks.json') || url.pathname.endsWith('/certs') || url.pathname.endsWith('/discovery/v2.0/keys')) return Response.json({ keys: [{ ...await exportJWK(key.publicKey), kid: 'test', use: 'sig', alg: 'RS256' }] });
        if (url.pathname.endsWith('/token') || url.pathname.endsWith('/access_token')) {
            const body = new URLSearchParams(await request.text()), code = body.get('code')!, issued = codes.get(code);
            if (!issued || !body.get('code_verifier')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
            if (['x', 'telegram'].includes(issued.type)) expect(request.headers.get('authorization')).toBe(`Basic ${btoa('test-client:upstream-client-secret')}`);
            codes.delete(code);
            const token = crypto.randomUUID(); access.set(token, issued.profile);
            let idToken = await new SignJWT({ ...issued.profile, ...(issued.type === 'microsoft' ? { oid: `oid-${issued.profile.sub}`, tid: '9188040d-6c67-4c5b-b112-36a304b66dad' } : {}), nonce: tokenFault === 'nonce' ? 'wrong' : issued.nonce }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
                .setIssuer(tokenFault === 'issuer' ? 'https://wrong.example.com' : issued.type === 'google' ? 'https://accounts.google.com' : issued.type === 'microsoft' ? 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0' : issued.type === 'telegram' ? 'https://oauth.telegram.org' : 'https://idp.example.com')
                .setAudience(tokenFault === 'audience' ? 'wrong' : 'test-client').setIssuedAt().setExpirationTime(tokenFault === 'expired' ? Math.floor(Date.now() / 1000) - 60 : '10m').sign(key.privateKey);
            if (tokenFault === 'signature') idToken = idToken.slice(0, -15) + 'xxxxxxxxxxxxxxx';
            if (tokenFault === 'missing') idToken = '';
            if (tokenFault === 'upstream') return new Response('Unavailable', { status: 503 });
            return Response.json({ access_token: token, token_type: 'Bearer', expires_in: 600, id_token: idToken || undefined, scope: 'openid profile email' });
        }
        const profile = access.get(request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '');
        if (url.hostname === 'api.x.com' && url.pathname === '/2/users/me') {
            if (tokenFault === 'profile-unavailable') return new Response('Unavailable', { status: 503 });
            return Response.json({ data: { id: tokenFault === 'profile-subject' ? undefined : profile?.sub, name: profile?.name, profile_image_url: profile?.picture, verified: true, email: profile?.email } });
        }
        if (url.hostname === 'discord.com' && decodeURIComponent(url.pathname) === '/api/users/@me') return Response.json({ id: profile?.sub, username: 'discord-user', global_name: profile?.name, email: profile?.email, verified: profile?.email_verified, avatar: 'test-avatar' });
        if (url.hostname === 'api.github.com') {
            if (url.pathname === '/user/emails') return Response.json(profile?.email ? [{ email: profile.email, verified: profile.email_verified, primary: true }] : []);
            return Response.json({ id: profile?.sub, login: 'github-login-fallback', name: profile?.name, email: profile?.email, avatar_url: profile?.picture });
        }
        if (url.pathname === '/userinfo') return Response.json(profile);
        throw new Error(`Unexpected outbound request ${url.origin}${url.pathname}`);
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

it.each(['google', 'github', 'microsoft', 'discord', 'oidc', 'oauth2'] as const)('registers and signs in through %s, preserves identity and stores no upstream tokens', async (type) => {
    const a = await admin(), row = await connector(a, type), b = browser(a.client);
    expect(await env.DB.prepare('SELECT "secret" FROM "socialConnection"').first('secret')).not.toBe('upstream-client-secret');
    await login(b, row, { sub: 'stable-subject', email: 'social@example.com', email_verified: true, name: 'Social Person' });
    const identity = await session(b.client, b.cookie());
    expect(identity?.user.email).toBe('social@example.com');
    const stored = await env.DB.prepare('SELECT * FROM "account" WHERE "providerId" = ?').bind(row.id).first();
    expect(stored).toMatchObject({ accountId: 'stable-subject', accessToken: null, refreshToken: null, idToken: null, password: null });
    await b.request('/api/auth/social/finish', {});
    await b.request('/api/auth/sign-out', {});
    await login(b, row, { sub: 'stable-subject', email: 'changed@example.com', email_verified: true, name: 'Changed Name' });
    expect((await session(b.client, b.cookie()))?.user).toMatchObject({ id: identity!.user.id, email: 'social@example.com', name: 'Social Person' });
});

it('does not initialize any providers for ordinary session reads', async () => {
    const b = await admin(); await connector(b, 'oidc'); requests = [];
    await b.request('/api/auth/get-session');
    expect(requests).toEqual([]);
});

it.each(['microsoft', 'discord'] as const)('stages an unverified %s email without creating an account or session', async (type) => {
    const a = await admin(), row = await connector(a, type), b = browser(a.client);
    const url = await start(b, row);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('scope')).toBe(type === 'microsoft' ? 'openid profile email' : 'identify email');
    if (type === 'microsoft') expect(url.searchParams.get('nonce')).toBeTruthy();
    await callback(b, row, url, { sub: 'unverified-provider', email: 'unverified@example.com' });
    expect(await session(b.client, b.cookie())).toBeNull();
    expect(await (await b.request('/api/auth/social/flow')).json()).toMatchObject({ stage: 'email' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = ?').bind(row.id).first('n')).toBe(0);
});

it.each(['x', 'telegram'] as const)('completes %s registration with a locally verified email and preserves the stable identity on return', async (type) => {
    const a = await admin(), row = await connector(a, type), b = browser(a.client);
    const url = await start(b, row);
    expect(url.origin).toBe(type === 'x' ? 'https://x.com' : 'https://oauth.telegram.org');
    expect(url.pathname).toBe(type === 'x' ? '/i/oauth2/authorize' : '/auth');
    expect(url.searchParams.get('scope')).toBe(type === 'x' ? 'users.read tweet.read' : 'openid profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    if (type === 'telegram') expect(url.searchParams.get('nonce')).toBeTruthy();
    // X has no OIDC contract. Ignore even a forged optional token; only its
    // protected user endpoint can establish the external identity.
    if (type === 'x') tokenFault = 'signature';
    await callback(b, row, url, { sub: 'provider-subject', email: 'provider-claim@example.com', email_verified: true, name: 'Provider Person' });
    expect(await session(b.client, b.cookie())).toBeNull();
    expect(await (await b.request('/api/auth/social/flow')).json()).toMatchObject({ stage: 'email' });
    expect(await env.DB.prepare('SELECT COUNT(*) FROM "account" WHERE "providerId" = ?').bind(row.id).first('COUNT(*)')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM "user"').first('COUNT(*)')).toBe(1);
    expect((await b.request('/api/auth/social/email', { email: `${type}@example.com` })).status).toBe(200);
    expect((await b.request('/api/auth/social/verify-email', { code: mailCode(a.client.messages.at(-1)) })).status).toBe(200);
    const identity = await session(b.client, b.cookie());
    expect(identity?.user).toMatchObject({ email: `${type}@example.com`, name: 'Provider Person' });
    expect(await env.DB.prepare('SELECT * FROM "account" WHERE "providerId" = ?').bind(row.id).first()).toMatchObject({ accountId: 'provider-subject', accessToken: null, refreshToken: null, idToken: null, password: null });
    await b.request('/api/auth/social/finish', {}); await b.request('/api/auth/sign-out', {});
    tokenFault = '';
    await login(b, row, { sub: 'provider-subject', name: 'Updated upstream name' });
    expect((await session(b.client, b.cookie()))?.user).toMatchObject({ id: identity!.user.id, email: `${type}@example.com`, name: 'Provider Person' });
    expect(requests.some((request) => request.includes('confirmed_email'))).toBe(false);
    expect(requests.some((request) => request.startsWith('https://idp.example.com/'))).toBe(false);
});

it.each(['x', 'telegram'] as const)('links %s without an upstream email and requires local MFA when signing in', async (type) => {
    const a = await admin(), row = await connector(a, type), identity = (await session(a.client, a.cookie()))!;
    const linking = await start(a, row, { purpose: 'link', password });
    expect((await callback(a, row, linking, { sub: 'linked-provider-owner' })).headers.get('location')).not.toContain('error=');
    expect((await a.request('/api/auth/social/finish', {})).status).toBe(200);
    expect(await env.DB.prepare('SELECT "userId", "accountId" FROM "account" WHERE "providerId" = ?').bind(row.id).first()).toEqual({ userId: identity.user.id, accountId: 'linked-provider-owner' });
    const enabled = await a.request('/api/auth/two-factor/enable', { password });
    expect(enabled.status).toBe(200);
    const enrollment = await enabled.json<{ totpURI: string; backupCodes: string[] }>();
    expect((await a.request('/api/auth/two-factor/verify-totp', { code: await authenticatorCode(enrollment.totpURI) })).status).toBe(200);
    await a.request('/api/auth/sign-out', {});
    const b = browser(a.client), response = await login(b, row, { sub: 'linked-provider-owner' });
    expect(response.headers.get('location')).toContain('two-factor?social=1');
    expect(await session(b.client, b.cookie())).toBeNull();
    expect((await b.request('/api/auth/two-factor/verify-backup-code', { code: enrollment.backupCodes[0] })).status).toBe(200);
    expect((await session(b.client, b.cookie()))?.user.id).toBe(identity.user.id);
});

it.each(['x', 'telegram'] as const)('keeps %s scopes and protocol parameters within the authentication preset', async (type) => {
    const a = await admin(), row = await connector(a, type);
    const { id, callbackURL, hasSecret, linkedAccounts, identityLocked, iconUrl, position, ...input } = row;
    const invalidScopes = type === 'x' ? [['users.read', 'tweet.read', 'offline.access'], ['users.read', 'tweet.write'], ['users.read', 'tweet.read', 'users.email']]
        : [['openid', 'phone'], ['openid', 'telegram:bot_access'], ['profile']];
    for (const scopes of invalidScopes) expect((await a.request(`/api/admin/social-connections/${id}`, { ...input, config: { ...input.config, scopes } }, 'PATCH')).status).toBe(400);
    for (const extra of [{ scopes: ['offline.access'] }, { authorizationUrl: 'https://attacker.example.com' }, { callbackURL: 'https://attacker.example.com' }]) {
        expect((await a.request('/api/auth/social/start', { connectionId: row.id, locale: 'en-US', ...extra })).status).toBe(400);
    }
    requests = [];
    await a.request('/api/auth/get-session');
    expect(requests).toEqual([]);
});

it.each(['x', 'telegram'] as const)('rejects replay and cancellation for %s without issuing a session', async (type) => {
    const a = await admin(), row = await connector(a, type), b = browser(a.client), url = await start(b, row);
    await callback(b, row, url, { sub: 'unregistered-provider' });
    const replay = await callback(b, row, url, { sub: 'unregistered-provider' });
    expect(replay.headers.get('location')).toContain('error=');
    expect(await session(b.client, b.cookie())).toBeNull();
    const c = browser(a.client), cancelURL = await start(c, row);
    const cancelled = await c.request(`/api/auth/callback/${row.id}?${new URLSearchParams({ state: cancelURL.searchParams.get('state')!, error: 'access_denied' })}`);
    expect(cancelled.headers.get('location')).toContain('SOCIAL_AUTH_CANCELLED');
    expect(await session(c.client, c.cookie())).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) FROM "account" WHERE "providerId" = ?').bind(row.id).first('COUNT(*)')).toBe(0);
});

it.each(['profile-subject', 'profile-unavailable'])('rejects an invalid X %s response without trusting its ID token', async (fault) => {
    const a = await admin(), row = await connector(a, 'x'), b = browser(a.client), url = await start(b, row);
    tokenFault = fault;
    expect((await callback(b, row, url, { sub: 'not-a-verified-profile', email: 'invalid@example.com', email_verified: true })).headers.get('location')).toContain('error=');
    expect(await session(b.client, b.cookie())).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) FROM "account" WHERE "providerId" = ?').bind(row.id).first('COUNT(*)')).toBe(0);
});

it('rejects a Microsoft personal account when the connection accepts only organizations', async () => {
    const a = await admin(), row = await connector(a, 'microsoft', 'organizations'), b = browser(a.client);
    const url = await start(b, row);
    expect(url.pathname).toBe('/organizations/oauth2/v2.0/authorize');
    const response = await callback(b, row, url, { sub: 'personal-account', email: 'personal@example.com', email_verified: true });
    expect(response.headers.get('location')).toContain('error=');
    expect(await session(b.client, b.cookie())).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = ?').bind(row.id).first('n')).toBe(0);
});

it('keeps missing GitHub names unset instead of storing the provider login fallback', async () => {
    const a = await admin(), row = await connector(a, 'github'), b = browser(a.client);
    await login(b, row, { sub: 'github-no-name', email: 'github-no-name@example.com', email_verified: true });
    expect((await session(b.client, b.cookie()))!.user.name).toBe('');
});

it('stages missing/unverified emails, verifies locally, and rejects same-email primary and auxiliary collisions', async () => {
    const a = await admin(), row = await connector(a), b = browser(a.client);
    await addVerifiedEmail(a.client, a.cookie(), 'auxiliary@example.com');
    await login(b, row, { sub: 'no-email', name: 'No Email' });
    expect(await session(b.client, b.cookie())).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) FROM "user"').first('COUNT(*)')).toBe(1);
    expect(await (await b.request('/api/auth/social/flow')).json()).toMatchObject({ stage: 'email' });
    expect((await b.request('/api/auth/social/email', { email: 'admin@example.test' })).status).toBe(400);
    expect((await b.request('/api/auth/social/email', { email: 'auxiliary@example.com' })).status).toBe(400);
    expect((await b.request('/api/auth/social/email', { email: 'new@example.com' })).status).toBe(200);
    const verified = await b.request('/api/auth/social/verify-email', { code: mailCode(a.client.messages.at(-1)) });
    expect(verified.status, await verified.clone().text()).toBe(200);
    expect((await session(b.client, b.cookie()))?.user.email).toBe('new@example.com');
    const other = browser(a.client);
    const duplicate = await callback(other, row, await start(other, row), { sub: 'different', email: 'new@example.com', email_verified: true });
    expect(duplicate.headers.get('location')).toContain('SOCIAL_ACCOUNT_NOT_LINKED');
});

it('rejects state replay, mismatched browser cookies, cancellation and changed connection revisions', async () => {
    const a = await admin(), row = await connector(a), b = browser(a.client);
    const url = await start(b, row), profile = { sub: 'one', email: 'one@example.com', email_verified: true };
    const stranger = browser(a.client);
    expect((await callback(stranger, row, url, profile)).status).toBe(400);
    await callback(b, row, url, profile);
    expect((await callback(b, row, url, profile)).status).toBe(302);
    const other = browser(a.client), pending = await start(other, row);
    await env.DB.prepare('UPDATE "socialConnection" SET "revision" = "revision" + 1 WHERE "id" = ?').bind(row.id).run();
    expect((await callback(other, row, pending, profile)).status).toBe(400);
});

it('requires existing MFA on third-party sign-in and continues with a single-use challenge', async () => {
    const a = await admin(), row = await connector(a), b = browser(a.client);
    await login(b, row, { sub: 'mfa', email: 'mfa@example.com', email_verified: true });
    await b.request('/api/auth/social/finish', {});
    const userId = (await session(b.client, b.cookie()))!.user.id;
    // Passwordless enrollment requires a provider-bound operation proof.
    await loginReauth(b, row, 'two-factor/enable');
    const enabled = await b.request('/api/auth/two-factor/enable', {});
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const enrollment = await enabled.json<{ totpURI: string; backupCodes: string[] }>();
    expect((await b.request('/api/auth/two-factor/verify-totp', { code: await authenticatorCode(enrollment.totpURI) })).status).toBe(200);
    await b.request('/api/auth/sign-out', {});
    const callbackResponse = await login(b, row, { sub: 'mfa', email: 'mfa@example.com', email_verified: true });
    expect(callbackResponse.headers.get('location')).toContain('two-factor?social=1');
    expect(await session(b.client, b.cookie())).toBeNull();
    await env.DB.prepare('UPDATE "socialConnection" SET "revision" = "revision" + 1 WHERE "id" = ?').bind(row.id).run();
    expect((await b.request('/api/auth/two-factor/verify-backup-code', { code: enrollment.backupCodes[0] })).status).toBe(400);
    expect(await session(b.client, b.cookie())).toBeNull();
    for (const name of b.jar.keys()) if (name.endsWith('social_flow')) b.jar.delete(name);
    expect((await b.request('/api/auth/two-factor/verify-backup-code', { code: enrollment.backupCodes[0] })).status).toBe(400);
    await login(b, row, { sub: 'mfa', email: 'mfa@example.com', email_verified: true });
    expect((await b.request('/api/auth/two-factor/verify-backup-code', { code: enrollment.backupCodes[0] })).status).toBe(200);
    expect((await session(b.client, b.cookie()))?.user.id).toBe(userId);
    expect((await b.request('/api/auth/social/finish', {})).status).toBe(200);
    const recovery = await recoveryToken(b.client, 'mfa@example.com');
    expect((await b.request('/api/auth/reset-password', { token: recovery, newPassword: password })).status).toBe(200);
    expect(await session(b.client, b.cookie())).toBeNull();
    expect(await env.DB.prepare('SELECT "twoFactorEnabled" FROM "user" WHERE "id" = ?').bind(userId).first('twoFactorEnabled')).toBe(1);
});

async function loginReauth(b: ReturnType<typeof browser>, row: SocialConnection, action: string) {
    const response = await callback(b, row, await start(b, row, { purpose: 'reauth', action }), { sub: action === 'two-factor/enable' ? 'mfa' : 'owner', email: 'owner@example.com', email_verified: true });
    expect(response.headers.get('location')).not.toContain('error=');
    const finish = await b.request('/api/auth/social/finish', {});
    expect(finish.status, await finish.clone().text()).toBe(200);
}

it('reauthenticates the exact linked identity, protects the last method, and permits password recovery', async () => {
    const a = await admin(), row = await connector(a), b = browser(a.client);
    await login(b, row, { sub: 'owner', email: 'owner@example.com', email_verified: true });
    await b.request('/api/auth/social/finish', {});
    const identities = await (await b.request('/api/auth/social/security')).json<{ identities: { id: string }[]; hasPassword: boolean }>();
    expect(identities.hasPassword).toBe(false);
    expect((await b.request('/api/auth/social/unlink', { accountId: identities.identities[0]!.id })).status).toBe(400);
    await loginReauth(b, row, 'unlink');
    const denied = await b.request('/api/auth/social/unlink', { accountId: identities.identities[0]!.id });
    expect(await denied.json()).toMatchObject({ code: 'SOCIAL_LAST_LOGIN_METHOD' });
    const wrong = await callback(b, row, await start(b, row, { purpose: 'reauth', action: 'set-password' }), { sub: 'attacker', email: 'attacker@example.com', email_verified: true });
    expect(wrong.headers.get('location')).toContain('SOCIAL_WRONG_IDENTITY');
    await loginReauth(b, row, 'set-password');
    const set = await b.request('/api/auth/social/set-password', { newPassword: password });
    expect(set.status, await set.clone().text()).toBe(200);
    const token = await recoveryToken(b.client, 'owner@example.com');
    expect((await b.request('/api/auth/reset-password', { token, newPassword: `${password}new` })).status).toBe(200);
});

it('tests a disabled connector without creating accounts and restricts administration', async () => {
    const a = await admin(), row = await connector(a), guest = browser(a.client);
    expect((await guest.request('/api/admin/social-connections')).status).toBe(401);
    await env.DB.prepare('UPDATE "socialConnection" SET "enabled" = 0 WHERE "id" = ?').bind(row.id).run();
    expect((await guest.request('/api/auth/social/start', { connectionId: row.id, locale: 'en-US', purpose: 'test' })).status).toBe(401);
    const url = await start(a, row, { purpose: 'test' });
    const response = await callback(a, row, url, { sub: 'test-only', email: 'test@example.com', email_verified: true });
    expect(response.headers.get('location')).not.toContain('error=');
    expect(await (await a.request('/api/auth/social/flow')).json()).toMatchObject({ stage: 'tested' });
    expect(await env.DB.prepare('SELECT COUNT(*) FROM "user"').first('COUNT(*)')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM "account" WHERE "providerId" = ?').bind(row.id).first('COUNT(*)')).toBe(0);
});

it.each((['oidc', 'microsoft', 'telegram'] as const).flatMap((type) => [...['nonce', 'issuer', 'audience', 'signature', 'missing', 'upstream'], ...(type === 'telegram' ? ['expired'] : [])].map((fault) => ({ type, fault }))))('rejects $type $fault errors before account/session creation', async ({ type, fault }) => {
    const a = await admin(), row = await connector(a, type), b = browser(a.client);
    const url = await start(b, row); tokenFault = fault;
    const response = await callback(b, row, url, { sub: 'invalid', email: 'invalid@example.com', email_verified: true });
    expect(response.headers.get('location')).toContain('error=');
    expect(await session(b.client, b.cookie())).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) FROM "account" WHERE "providerId" = ?').bind(row.id).first('COUNT(*)')).toBe(0);
});

it('ignores unverified OAuth ID tokens and handles cancellation without provision', async () => {
    const a = await admin(), row = await connector(a), b = browser(a.client);
    tokenFault = 'signature';
    await login(b, row, { sub: 'protected-profile', email: 'oauth@example.com', email_verified: true });
    expect((await session(b.client, b.cookie()))?.user.email).toBe('oauth@example.com');
    const c = browser(a.client), url = await start(c, row);
    const cancelled = await c.request(`/api/auth/callback/${row.id}?${new URLSearchParams({ state: url.searchParams.get('state')!, error: 'access_denied' })}`);
    expect(cancelled.headers.get('location')).toContain('SOCIAL_AUTH_CANCELLED');
    expect(await session(c.client, c.cookie())).toBeNull();
});

it('binds different-email identities explicitly and rejects cross-user/concurrent binding', async () => {
    const a = await admin(), row = await connector(a), b = browser(a.client);
    await b.client.verify('second@example.com');
    expect((await b.request('/api/auth/sign-in/email', { email: 'second@example.com', password })).status).toBe(200);
    const first = await start(a, row, { purpose: 'link', password }), second = await start(b, row, { purpose: 'link', password });
    const results = await Promise.all([callback(a, row, first, { sub: 'shared', email: 'unrelated@example.com', email_verified: true }), callback(b, row, second, { sub: 'shared', email: 'unrelated@example.com', email_verified: true })]);
    expect(results.filter((result) => !result.headers.get('location')?.includes('error=')).length).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM "account" WHERE "providerId" = ?').bind(row.id).first('COUNT(*)')).toBe(1);
    expect((await session(a.client, a.cookie()))?.user.email).toBe('admin@example.test');
    expect((await session(b.client, b.cookie()))?.user.email).toBe('second@example.com');
    const identities = await (await a.request('/api/auth/social/security')).json<{ identities: { id: string }[] }>();
    if (identities.identities.length) {
        expect((await a.request('/api/auth/social/unlink', { accountId: identities.identities[0]!.id, password })).status).toBe(200);
        expect(await env.DB.prepare('SELECT "identityLocked" FROM "socialConnection" WHERE "id" = ?').bind(row.id).first('identityLocked')).toBe(1);
    }
    const { id, callbackURL, hasSecret, linkedAccounts, identityLocked, iconUrl, position, ...input } = row;
    expect((await a.request(`/api/admin/social-connections/${id}`, { ...input, config: { ...input.config, clientId: 'replacement' } }, 'PATCH')).status).toBe(409);
});

it('provisions one user and account atomically under concurrent first login', async () => {
    const a = await admin(), row = await connector(a), b = browser(a.client), c = browser(a.client);
    const urls = await Promise.all([start(b, row), start(c, row)]);
    await Promise.all([callback(b, row, urls[0]!, { sub: 'race', email: 'race-one@example.com', email_verified: true }), callback(c, row, urls[1]!, { sub: 'race', email: 'race-two@example.com', email_verified: true })]);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM "account" WHERE "providerId" = ?').bind(row.id).first('COUNT(*)')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM "user"').first('COUNT(*)')).toBe(2);
});

it('rejects a binding callback after the browser switches away from its initiating session', async () => {
    const a = await admin(), row = await connector(a);
    const pending = await start(a, row, { purpose: 'link', password });
    await a.client.verify('switched@example.com');
    expect((await a.request('/api/auth/sign-in/email', { email: 'switched@example.com', password })).status).toBe(200);
    const response = await callback(a, row, pending, { sub: 'must-not-bind', email: 'unrelated@example.com', email_verified: true });
    expect(response.status).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM "account" WHERE "providerId" = ?').bind(row.id).first('COUNT(*)')).toBe(0);
});

it('rejects completion when the native session expires before the flow finishes', async () => {
    const a = await admin(), row = await connector(a), b = browser(a.client);
    await login(b, row, { sub: 'expired-session', email: 'expired-session@example.com', email_verified: true });
    const identity = (await session(b.client, b.cookie()))!;
    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "id" = ?').bind(new Date(Date.now() - 1000).toISOString(), identity.session.id).run();
    expect((await b.request('/api/auth/social/finish', {})).status).toBe(401);
    expect((await b.request('/api/auth/social/flow')).status).toBe(401);
});

it('binds operation proofs to purpose, session, expiry and a single consumption', async () => {
    const a = await admin(), row = await connector(a), b = browser(a.client);
    await login(b, row, { sub: 'owner', email: 'owner@example.com', email_verified: true }); await b.request('/api/auth/social/finish', {});
    await loginReauth(b, row, 'emails/add');
    expect((await b.request('/api/auth/social/set-password', { newPassword: password })).status).toBe(400);
    expect((await b.request('/api/auth/emails/add', { email: 'extra@example.com' })).status).toBe(200);
    expect((await b.request('/api/auth/emails/add', { email: 'replay@example.com' })).status).toBe(400);
    await loginReauth(b, row, 'set-password');
    await env.DB.prepare('UPDATE "securityProof" SET "expiresAt" = 0').run();
    expect((await b.request('/api/auth/social/set-password', { newPassword: password })).status).toBe(400);
    await loginReauth(b, row, 'set-password');
    const sessionId = (await session(b.client, b.cookie()))!.session.id;
    await env.DB.prepare('DELETE FROM "session" WHERE "id" = ?').bind(sessionId).run();
    expect((await b.request('/api/auth/social/set-password', { newPassword: password })).status).toBe(401);
});

it('continues a signed downstream request after social completion and preserves the local subject', async () => {
    const a = await admin(), row = await connector(a), b = browser(a.client);
    const registration = await a.request('/api/admin/applications', { name: 'Social continuation', type: 'spa', redirectUris: ['https://app.example.com/callback'], postLogoutRedirectUris: ['https://app.example.com/'], scopes: ['openid', 'profile', 'email'] });
    expect(registration.status, await registration.clone().text()).toBe(201);
    const app = await registration.json<{ application: { clientId: string } }>();
    const verifier = 'a'.repeat(43), challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const authorization = await b.request(`/api/auth/oauth2/authorize?${new URLSearchParams({ client_id: app.application.clientId, redirect_uri: 'https://app.example.com/callback', response_type: 'code', scope: 'openid profile email', state: 'downstream', nonce: 'downstream-nonce', code_challenge: challenge, code_challenge_method: 'S256', ui_locales: 'zh-CN' })}`);
    const query = new URL(authorization.headers.get('location')!, origin).search.slice(1);
    expect(query).toBeTruthy();
    const url = await start(b, row, { oauth_query: query, locale: 'zh-CN' });
    await callback(b, row, url, { sub: 'downstream-user', email: 'downstream@example.com', email_verified: true });
    const continued = await b.request('/api/auth/social/finish', {});
    expect(continued.status, await continued.clone().text()).toBe(200);
    const completed = await continued.json<{ redirect: boolean; url: string }>();
    expect(completed.redirect).toBe(true);
    const consentQuery = new URL(completed.url, origin).search.slice(1);
    expect(consentQuery).toBeTruthy();
    const consent = await b.request('/api/auth/oauth2/consent', { accept: true, oauth_query: consentQuery });
    expect(consent.status, await consent.clone().text()).toBe(200);
    const destination = new URL((await consent.json<{ url: string }>()).url);
    expect(destination.origin).toBe('https://app.example.com'); expect(destination.searchParams.get('state')).toBe('downstream');
    const ctx = createExecutionContext();
    const token = await worker.fetch(new Request(`${origin}/api/auth/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: app.application.clientId, redirect_uri: 'https://app.example.com/callback', code: destination.searchParams.get('code')!, code_verifier: verifier }) }), b.client.bindings, ctx);
    await waitOnExecutionContext(ctx);
    expect(token.status, await token.clone().text()).toBe(200);
    const idToken = (await token.json<{ id_token: string }>()).id_token;
    const claims = JSON.parse(atob(idToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { sub: string };
    expect(claims.sub).toBe((await session(b.client, b.cookie()))!.user.id);
});

it('fills only missing names, keeps authenticated avatar sources private, and retries later logins', async () => {
    const a = await admin(), row = await connector(a), b = browser(a.client);
    const profile = { sub: 'profile', email: 'profile@example.com', email_verified: true, picture: 'https://cdn.example.com/photo.png' };
    await login(b, row, profile);
    expect((await session(b.client, b.cookie()))!.user.name).toBe('');
    expect((await b.request('/api/auth/social/avatar-source')).headers.get('content-type')).toBe('image/png');
    const stranger = browser(a.client);
    expect((await stranger.request('/api/auth/social/avatar-source')).status).toBe(401);
    await b.request('/api/auth/social/finish', {});
    expect((await b.request('/api/auth/social/avatar-source')).status).toBe(400);
    await login(b, row, { ...profile, name: 'Filled name' });
    expect((await session(b.client, b.cookie()))!.user.name).toBe('Filled name');
    expect(await (await b.request('/api/auth/social/flow')).json()).toMatchObject({ hasAvatarSource: true });
    await b.request('/api/auth/social/finish', {});
    await login(b, row, { ...profile, name: 'Must not replace' });
    expect((await session(b.client, b.cookie()))!.user.name).toBe('Filled name');
});

it('does not count disabled/archived identities as a remaining sign-in method', async () => {
    const a = await admin(), row = await connector(a), other = await connector(a), b = browser(a.client);
    await login(b, row, { sub: 'owner', email: 'owner@example.com', email_verified: true }); await b.request('/api/auth/social/finish', {});
    await loginReauth(b, row, 'link');
    await callback(b, other, await start(b, other, { purpose: 'link' }), { sub: 'other', email: 'different@example.com', email_verified: true }); await b.request('/api/auth/social/finish', {});
    await env.DB.prepare('UPDATE "socialConnection" SET "enabled" = 0 WHERE "id" = ?').bind(other.id).run();
    await loginReauth(b, row, 'unlink');
    const linked = await env.DB.prepare('SELECT "id" FROM "account" WHERE "providerId" = ?').bind(row.id).first<string>('id');
    expect(await (await b.request('/api/auth/social/unlink', { accountId: linked })).json()).toMatchObject({ code: 'SOCIAL_LAST_LOGIN_METHOD' });
    expect((await session(b.client, b.cookie()))!.user.email).toBe('owner@example.com');
});
