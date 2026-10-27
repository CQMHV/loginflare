import { env } from 'cloudflare:workers';
import { createEmailVerificationToken } from 'better-auth/api';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cookies, harness, mailUrl, origin, password, session } from './helpers';

let captchaAccepted = true;
let captchaStatus = 200;

it('logs request metadata without passwords, verification queries or reset-path tokens', async () => {
    const recorder = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
        const client = harness();
        const signup = await client.signup();
        expect(signup.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
        expect(signup.headers.get('cache-control')).toBe('no-store');
        const link = mailUrl(client.messages[0]);
        const token = new URL(link).searchParams.get('token')!;
        await client.request(link);
        await client.request(`/api/auth/reset-password/CaseSensitiveResetSecret?${new URLSearchParams({ callbackURL: `${origin}/en-us/reset-password` })}`);
        await client.request('/api/unknown/PrivatePathValue?private=PrivateQueryValue');
        const messages = recorder.mock.calls.map((args) => args.join(' ')).join('\n');
        expect(messages).toContain('http_request');
        expect(messages).toContain('/api/auth/reset-password/:token');
        for (const sensitive of [password, link, token, 'CaseSensitiveResetSecret', 'PrivatePathValue', 'PrivateQueryValue']) {
            expect(messages).not.toContain(sensitive);
        }
    } finally {
        recorder.mockRestore();
    }
});

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    captchaAccepted = true;
    captchaStatus = 200;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify' || request.method !== 'POST') {
            throw new Error('Unexpected outbound network request in an isolated integration test');
        }
        return Response.json({ success: captchaAccepted }, { status: captchaStatus });
    });
});

afterEach(async () => {
    vi.unstubAllGlobals();
    await reset();
});

describe('email accounts in the Workers runtime', () => {
    it('requires a verified email, creates a D1 session, and signs out', async () => {
        const client = harness();
        await client.signup();
        const storedPassword = await env.DB.prepare('SELECT "password" FROM "account" WHERE "providerId" = ?')
            .bind('credential').first<string>('password');
        expect(storedPassword).toBeTruthy();
        expect(storedPassword).not.toBe(password);
        const denied = await client.request('/api/auth/sign-in/email', {
            body: { email: 'person@example.test', password },
        });
        expect(denied.status).toBe(403);
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "session"').first('count')).toBe(0);
        const verification = await client.request(mailUrl(client.messages[0]));
        expect([200, 302]).toContain(verification.status);
        const cookie = await client.signin();
        expect((await session(client, cookie))?.user.email).toBe('person@example.test');
        const signedOut = await client.request('/api/auth/sign-out', { body: {}, cookie });
        expect(signedOut.status).toBe(200);
        expect(await session(client, cookie)).toBeNull();
    });

    it('uses the account locale for email and a lowercase localized callback', async () => {
        const client = harness();
        await client.signup('person@example.test', 'zh-CN');
        expect(client.messages[0].subject).toMatch(/[\u3400-\u9fff]/);
        const verificationUrl = new URL(mailUrl(client.messages[0]));
        expect(verificationUrl.origin).toBe(origin);
        expect(verificationUrl.searchParams.get('callbackURL')).toContain('/zh-cn/');
        const result = await client.request(verificationUrl.href);
        if (result.status === 302) expect(result.headers.get('location')).toContain('/zh-cn/');
        expect(client.messages[0].html).toContain('lang="zh-CN"');
        const cookie = await client.signin();
        expect((await session(client, cookie))?.user.locale).toBe('zh-CN');
        await client.request('/api/auth/update-user', { body: { locale: 'en-US' }, cookie });
        await client.request('/api/auth/request-password-reset', {
            body: { email: 'person@example.test', redirectTo: `${origin}/en-us/reset-password` },
        });
        const resetMail = client.messages.at(-1);
        expect(resetMail?.subject).not.toMatch(/[\u3400-\u9fff]/);
        expect(resetMail?.html).toContain('lang="en-US"');
    });

    it('rejects wrong passwords and does not create a session on repeated verification', async () => {
        const client = harness();
        await client.verify();
        await client.request(mailUrl(client.messages[0]));
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "session"').first('count')).toBe(0);
        const response = await client.request('/api/auth/sign-in/email', {
            body: { email: 'person@example.test', password: 'incorrect-password' },
        });
        expect(response.status).toBe(401);
        expect(response.headers.get('set-cookie') ?? '').not.toContain('session_token=');
    });

    it('rejects an expired signed verification token without verifying the account', async () => {
        const client = harness();
        await client.signup();
        const token = await createEmailVerificationToken(env.BETTER_AUTH_SECRET, 'person@example.test', undefined, -60);
        const url = new URL('/api/auth/verify-email', origin);
        url.searchParams.set('token', token);
        url.searchParams.set('callbackURL', `${origin}/en-us/verified`);
        const response = await client.request(url.href);
        expect(response.status >= 400 || response.headers.get('location')?.includes('error=')).toBeTruthy();
        expect(await env.DB.prepare('SELECT "emailVerified" FROM "user" WHERE "email" = ?')
            .bind('person@example.test').first('emailVerified')).toBe(0);
    });

    it('resets a password, revokes every old session, and rejects reset-token replay', async () => {
        const client = harness();
        await client.verify();
        const first = await client.signin();
        const second = await client.signin();
        const requested = await client.request('/api/auth/request-password-reset', {
            body: { email: 'person@example.test', redirectTo: `${origin}/en-us/reset-password` },
        });
        expect(requested.status).toBe(200);
        const linkResponse = await client.request(mailUrl(client.messages.at(-1)));
        expect(linkResponse.status).toBe(302);
        const redirect = new URL(linkResponse.headers.get('location')!, origin);
        expect(redirect.pathname).toBe('/en-us/reset-password');
        const token = redirect.searchParams.get('token');
        expect(token).toBeTruthy();
        const replacement = 'New-integration-password-912!';
        const resetResponse = await client.request('/api/auth/reset-password', {
            body: { token, newPassword: replacement },
        });
        expect(resetResponse.status).toBe(200);
        expect(await session(client, first)).toBeNull();
        expect(await session(client, second)).toBeNull();
        const replay = await client.request('/api/auth/reset-password', {
            body: { token, newPassword: 'Another-password-714!' },
        });
        expect(replay.ok).toBe(false);
        await client.signin('person@example.test', replacement);
    });

    it('rejects expired reset tokens', async () => {
        const client = harness();
        await client.verify();
        await client.request('/api/auth/request-password-reset', {
            body: { email: 'person@example.test', redirectTo: `${origin}/en-us/reset-password` },
        });
        const linkResponse = await client.request(mailUrl(client.messages.at(-1)));
        const token = new URL(linkResponse.headers.get('location')!, origin).searchParams.get('token');
        await env.DB.prepare('UPDATE "verification" SET "expiresAt" = ?').bind(Date.now() - 60_000).run();
        const response = await client.request('/api/auth/reset-password', {
            body: { token, newPassword: 'Replacement-password-123!' },
        });
        expect(response.ok).toBe(false);
    });

    it('changes a password only with the current password and revokes other sessions', async () => {
        const client = harness();
        await client.verify();
        const current = await client.signin();
        const other = await client.signin();
        const rejected = await client.request('/api/auth/change-password', {
            body: { currentPassword: 'wrong', newPassword: 'New-password-912!', revokeOtherSessions: true },
            cookie: current,
        });
        expect(rejected.ok).toBe(false);
        const changed = await client.request('/api/auth/change-password', {
            body: { currentPassword: password, newPassword: 'New-password-912!', revokeOtherSessions: true },
            cookie: current,
        });
        expect(changed.status).toBe(200);
        expect(await session(client, cookies(changed))).not.toBeNull();
        expect(await session(client, current)).toBeNull();
        expect(await session(client, other)).toBeNull();
    });

    it('revokes an individual session and all other sessions', async () => {
        const client = harness();
        await client.verify();
        const current = await client.signin();
        const other = await client.signin();
        const otherSession = await session(client, other);
        const revoked = await client.request('/api/auth/revoke-session', {
            body: { token: otherSession!.session.token }, cookie: current,
        });
        expect(revoked.status).toBe(200);
        expect(await session(client, other)).toBeNull();
        const third = await client.signin();
        await client.request('/api/auth/revoke-other-sessions', { body: {}, cookie: current });
        expect(await session(client, current)).not.toBeNull();
        expect(await session(client, third)).toBeNull();
    });

    it('renews an aging session and forwards the refreshed browser cookie', async () => {
        const client = harness();
        await client.verify();
        const cookie = await client.signin();
        const identity = (await session(client, cookie))!;
        const shortenedExpiry = Date.now() + 5 * 24 * 60 * 60 * 1000;
        await env.DB.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "id" = ?')
            .bind(shortenedExpiry, identity.session.id).run();

        const response = await client.request('/api/auth/get-session', { cookie });
        expect(response.status).toBe(200);
        const renewedCookie = cookies(response);
        expect(renewedCookie).toContain('session_token=');
        const storedExpiry = await env.DB.prepare('SELECT "expiresAt" FROM "session" WHERE "id" = ?')
            .bind(identity.session.id).first<string>('expiresAt');
        expect(Date.parse(storedExpiry!)).toBeGreaterThan(shortenedExpiry + 24 * 60 * 60 * 1000);
        expect((await session(client, renewedCookie))?.user.id).toBe(identity.user.id);
    });

    it('does not allow one user to revoke another user’s session', async () => {
        const client = harness();
        await client.verify();
        const ownerCookie = await client.signin();
        const ownerSession = await session(client, ownerCookie);
        await client.verify('attacker@example.test');
        const attackerCookie = await client.signin('attacker@example.test');
        const response = await client.request('/api/auth/revoke-session', {
            cookie: attackerCookie, body: { token: ownerSession!.session.token },
        });
        // The native endpoint acknowledges idempotently without disclosing ownership.
        expect(response.status).toBe(200);
        expect(await session(client, ownerCookie)).not.toBeNull();
    });

    it('does not reveal whether a password-reset email belongs to an account', async () => {
        const client = harness();
        await client.verify();
        const known = await client.request('/api/auth/request-password-reset', {
            body: { email: 'person@example.test', redirectTo: `${origin}/en-us/reset-password` },
        });
        const unknown = await client.request('/api/auth/request-password-reset', {
            body: { email: 'nobody@example.test', redirectTo: `${origin}/en-us/reset-password` },
        });
        expect(unknown.status).toBe(known.status);
        expect(await unknown.json()).toEqual(await known.json());
    });

    it('reports email-send failures and supports resending without creating a second account', async () => {
        const client = harness();
        client.setMailFailure(true);
        const failed = await client.request('/api/auth/sign-up/email', {
            body: { name: 'Mail Test', email: 'mail@example.test', password,
                callbackURL: `${origin}/en-us/verified`, locale: 'en-US' },
        });
        expect(failed.status).toBe(503);
        const failure = await failed.json();
        expect(failure).toMatchObject({ code: 'EMAIL_DELIVERY_FAILED' });
        expect(JSON.stringify(failure)).not.toContain('Test mail delivery failure');
        client.setMailFailure(false);
        const resent = await client.request('/api/auth/send-verification-email', {
            body: { email: 'mail@example.test', callbackURL: `${origin}/en-us/verified` },
        });
        expect(resent.ok).toBe(true);
        expect(client.messages).toHaveLength(1);
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "user" WHERE "email" = ?')
            .bind('mail@example.test').first('count')).toBe(1);
    });

    it('rejects missing, invalid and unavailable Turnstile verification', async () => {
        const client = harness();
        const body = { email: 'person@example.test', password };
        const missing = await client.request('/api/auth/sign-in/email', { body, captcha: false });
        expect(missing.ok).toBe(false);
        captchaAccepted = false;
        const invalid = await client.request('/api/auth/sign-in/email', { body });
        expect(invalid.ok).toBe(false);
        captchaStatus = 503;
        const unavailable = await client.request('/api/auth/sign-in/email', { body });
        expect(unavailable.ok).toBe(false);
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "session"').first('count')).toBe(0);
    });

    it('persists sensitive-endpoint rate limits across request-scoped auth instances', async () => {
        const client = harness();
        const statuses: number[] = [];
        for (let attempt = 0; attempt < 4; attempt++) {
            const response = await client.request('/api/auth/send-verification-email', {
                body: { email: 'unknown@example.test', callbackURL: `${origin}/en-us/verified` },
            });
            statuses.push(response.status);
        }
        expect(statuses.slice(0, 3)).not.toContain(429);
        expect(statuses[3]).toBe(429);
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "rateLimit"').first('count')).toBeGreaterThan(0);
    });

    it('accepts only en-US and zh-CN as persisted account locales', async () => {
        const client = harness();
        await client.verify();
        const cookie = await client.signin();
        const renamed = await client.request('/api/auth/update-user', { body: { name: 'Updated Name' }, cookie });
        expect(renamed.status).toBe(200);
        expect((await session(client, cookie))?.user.name).toBe('Updated Name');
        for (const locale of ['en', 'zh', 'en-us', 'zh-cn', 'fr-FR']) {
            const response = await client.request('/api/auth/update-user', { body: { locale }, cookie });
            expect(response.ok).toBe(false);
        }
        expect((await session(client, cookie))?.user.locale).toBe('en-US');
    });
});

describe('server-side management boundaries', () => {
    it('rejects ordinary-user admin access and self-promotion through account updates', async () => {
        const client = harness();
        await client.verify();
        const cookie = await client.signin();
        const denied = await client.request('/api/auth/admin/list-users', { cookie });
        expect(denied.status).toBe(403);
        for (const body of [{ role: 'admin' }, { emailVerified: true }, { banned: false }, { email: 'other@example.test' }]) {
            const response = await client.request('/api/auth/update-user', { cookie, body });
            expect(response.ok).toBe(false);
        }
        const current = await session(client, cookie);
        expect(current?.user.role).toBe('user');
        expect(current?.user.email).toBe('person@example.test');
    });

    it('bans an ordinary user, invalidates existing sessions, then allows a fresh login after unban', async () => {
        const client = harness();
        await client.verify();
        const cookie = await client.signin();
        const user = (await session(client, cookie))!.user;
        const administrator = await client.administrator();
        const banned = await client.request('/api/auth/admin/ban-user', {
            cookie: administrator, body: { userId: user.id, banReason: 'Integration test' },
        });
        expect(banned.status).toBe(200);
        expect(await session(client, cookie)).toBeNull();
        const login = await client.request('/api/auth/sign-in/email', {
            body: { email: user.email, password },
        });
        expect(login.ok).toBe(false);
        const unbanned = await client.request('/api/auth/admin/unban-user', {
            cookie: administrator, body: { userId: user.id },
        });
        expect(unbanned.status).toBe(200);
        expect(await session(client, cookie)).toBeNull();
        await client.signin();
    });

    it('lists users and revokes an ordinary user’s sessions without exposing admin-only mutations', async () => {
        const client = harness();
        const email = 'person-with-a-long-email-for-admin-search-12345@example.test';
        await client.verify(email);
        const cookie = await client.signin(email);
        const user = (await session(client, cookie))!.user;
        const administrator = await client.administrator();
        const listed = await client.request('/api/auth/admin/list-users?limit=10&offset=0', { cookie: administrator });
        expect(listed.status).toBe(200);
        const list = await listed.json<{ users: { email: string }[]; total: number }>();
        expect(list.users.some((entry) => entry.email === user.email)).toBe(true);
        const detail = await client.request(`/api/auth/admin/get-user?${new URLSearchParams({ id: user.id })}`, {
            cookie: administrator,
        });
        expect(detail.status).toBe(200);
        expect(await detail.json()).toMatchObject({ id: user.id, email: user.email, role: 'user' });
        const searched = await client.request(`/api/auth/admin/list-users?${new URLSearchParams({ filterValue: email, filterField: 'email', filterOperator: 'eq', limit: '1', offset: '0' })}`, {
            cookie: administrator,
        });
        expect(searched.status).toBe(200);
        expect(await searched.json()).toMatchObject({ total: 1, users: [{ email: user.email }] });
        const unsupported = await client.request('/api/auth/admin/list-users?searchValue=person&searchField=email&searchOperator=contains', { cookie: administrator });
        expect(unsupported.status).toBe(400);
        const revoked = await client.request('/api/auth/admin/revoke-user-sessions', {
            cookie: administrator, body: { userId: user.id },
        });
        expect(revoked.status).toBe(200);
        expect(await session(client, cookie)).toBeNull();
    });

    it('does not allow an administrator to ban or revoke another administrator', async () => {
        const client = harness();
        const cookie = await client.administrator();
        const administrator = (await session(client, cookie))!.user;
        for (const endpoint of ['ban-user', 'unban-user', 'revoke-user-sessions']) {
            const response = await client.request(`/api/auth/admin/${endpoint}`, {
                cookie, body: { userId: administrator.id },
            });
            expect(response.status).toBe(403);
        }
        expect(await session(client, cookie)).not.toBeNull();
    });

    it.each(['admin/set-role', 'admin/set-user-password', 'admin/create-user', 'admin/remove-user',
        'admin/impersonate-user', 'delete-user', 'change-email', 'sign-in/social'])('closes unused endpoint %s', async (path) => {
        const client = harness();
        const response = await client.request(`/api/auth/${path}`, { body: {} });
        expect([403, 404, 405]).toContain(response.status);
    });

    it('rejects unsafe origins and off-site callbacks', async () => {
        const client = harness();
        const foreign = await client.request('/api/auth/sign-in/email', {
            body: { email: 'person@example.test', password }, headers: { Origin: 'https://attacker.invalid' },
        });
        expect(foreign.ok).toBe(false);
        const redirected = await client.request('/api/auth/sign-up/email', {
            body: { name: 'Test', email: 'new@example.test', password, callbackURL: 'https://attacker.invalid/return' },
        });
        expect(redirected.ok).toBe(false);
        expect(client.messages).toHaveLength(0);
    });

    it('never serves HTML at unknown API paths or reveals secrets through public configuration', async () => {
        const client = harness();
        const health = await client.request('/api/health');
        expect(health.status).toBe(200);
        const configuration = await client.request('/api/config');
        expect(configuration.status).toBe(200);
        const config = await configuration.json();
        expect(config).toEqual({ turnstileSiteKey: env.TURNSTILE_SITE_KEY });
        expect(JSON.stringify(config)).not.toContain(env.BETTER_AUTH_SECRET);
        const missing = await client.request('/api/not-an-api');
        expect(missing.status).toBe(404);
        expect(missing.headers.get('content-type')).toContain('application/json');
    });

    it('fails closed when required authentication configuration is missing', async () => {
        const client = harness();
        client.bindings.BETTER_AUTH_SECRET = '';
        const response = await client.request('/api/config');
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'CONFIGURATION_ERROR' });
    });

    it.each(['/EN-us/login', '/en-US/login', '/zh-CN/login', '/fr-fr/login', '/en-us/LOGIN', '/en-us/not-a-page'])
    ('returns an HTTP 404 for unsupported page path %s', async (path) => {
        const client = harness();
        const response = await client.request(path);
        expect(response.status).toBe(404);
    });
});
