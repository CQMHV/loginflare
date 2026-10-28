import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cookies, harness, mailUrl, origin, password, session } from './helpers';

let captchaAccepted = true;

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    captchaAccepted = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected outbound request');
        return Response.json({ success: captchaAccepted });
    });
});

afterEach(async () => {
    vi.unstubAllGlobals();
    await reset();
});

async function signup(client: ReturnType<typeof harness>, username: unknown, email = 'username@example.test') {
    return client.request('/api/auth/sign-up/email', {
        body: { username, email, name: 'Username Person', password, locale: 'en-US', callbackURL: `${origin}/en-us/verified` },
    });
}

async function login(client: ReturnType<typeof harness>, username: string, candidate = password) {
    return client.request('/api/auth/sign-in/username', { body: { username, password: candidate } });
}

async function verifiedUsername() {
    const client = harness();
    const created = await signup(client, 'Mixed.Name_17');
    expect(created.status, await created.clone().text()).toBe(200);
    await client.request(mailUrl(client.messages.at(-1)));
    const signedIn = await login(client, 'MIXED.NAME_17');
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    return { client, cookie: cookies(signedIn) };
}

describe('username credentials in the Workers runtime', () => {
    it('stores a normalized unique username without replacing the display name, and requires email verification', async () => {
        const client = harness();
        const created = await signup(client, 'Mixed.Name_17');
        expect(created.status, await created.clone().text()).toBe(200);
        expect(await env.DB.prepare('SELECT "name", "username" FROM "user" WHERE "email" = ?').bind('username@example.test').first())
            .toEqual({ name: 'Username Person', username: 'mixed.name_17' });
        expect(await env.DB.prepare('PRAGMA table_info("user")').all()).not.toMatchObject({ results: expect.arrayContaining([expect.objectContaining({ name: 'displayUsername' })]) });
        const unverified = await login(client, 'mixed.name_17');
        expect(unverified.status).toBe(403);
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "session"').first('count')).toBe(0);
        await client.request(mailUrl(client.messages.at(-1)));
        const signedIn = await login(client, 'MIXED.NAME_17');
        expect(signedIn.status, await signedIn.clone().text()).toBe(200);
        expect((await session(client, cookies(signedIn)))?.user).toMatchObject({ username: 'mixed.name_17', name: 'Username Person' });
    });

    it('rejects case-equivalent signup names and unsupported username values', async () => {
        const client = harness();
        expect((await signup(client, 'Unique_Name')).status).toBe(200);
        const duplicate = await signup(client, 'UNIQUE_NAME', 'duplicate@example.test');
        expect(duplicate.ok).toBe(false);
        expect(await duplicate.json()).toMatchObject({ code: 'USERNAME_IS_ALREADY_TAKEN' });
        const invalidValues: unknown[] = ['', 'ab', 'a'.repeat(31), 'person@example.test', 'with-dash', 'with space', '中文用户名', null, 123];
        for (const [index, username] of invalidValues.entries()) {
            const rejected = await client.request('/api/auth/sign-up/email', {
                body: { username, email: `invalid-${index}@example.test`, name: 'Invalid', password },
                headers: { 'CF-Connecting-IP': `192.0.2.${index + 30}` },
            });
            expect(rejected.ok, JSON.stringify(username)).toBe(false);
        }
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "user"').first('count')).toBe(1);
    });

    it('keeps email-only accounts usable and lets their owners choose and change a username', async () => {
        const client = harness();
        await client.verify();
        const cookie = await client.signin();
        expect((await session(client, cookie))?.user.username ?? null).toBeNull();
        const chosen = await client.request('/api/auth/update-user', { cookie, body: { username: 'First_Name' } });
        expect(chosen.status, await chosen.clone().text()).toBe(200);
        expect((await login(client, 'FIRST_NAME')).status).toBe(200);
        const changed = await client.request('/api/auth/update-user', { cookie, body: { username: 'second.name', name: 'Still a separate display name' } });
        expect(changed.status, await changed.clone().text()).toBe(200);
        expect((await login(client, 'first_name')).status).toBe(401);
        expect((await login(client, 'SECOND.NAME')).status).toBe(200);
        expect((await session(client, cookie))?.user).toMatchObject({ username: 'second.name', name: 'Still a separate display name' });
        expect(await client.signin()).toBeTruthy();
        for (const username of ['', null, 123, 'with space']) {
            expect((await client.request('/api/auth/update-user', { cookie, body: { username } })).ok).toBe(false);
        }
        expect((await session(client, cookie))?.user.username).toBe('second.name');
    });

    it('does not allow duplicate usernames when two authenticated owners claim a name concurrently', async () => {
        const client = harness();
        await client.verify();
        const first = await client.signin();
        await client.verify('second@example.test');
        const second = await client.signin('second@example.test');
        const results = await Promise.all([first, second].map((cookie) => client.request('/api/auth/update-user', { cookie, body: { username: 'same_name' } })));
        expect(results.filter((response) => response.ok)).toHaveLength(1);
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "user" WHERE "username" = ?').bind('same_name').first('count')).toBe(1);
        for (const response of results.filter((response) => !response.ok)) expect(await response.text()).not.toContain('UNIQUE constraint');
    });

    it('rejects unknown usernames and wrong passwords without issuing a session', async () => {
        const { client } = await verifiedUsername();
        for (const [username, candidate] of [['missing_user', password], ['mixed.name_17', 'incorrect-password']]) {
            const rejected = await login(client, username!, candidate);
            expect(rejected.status).toBe(401);
            expect(rejected.headers.get('set-cookie') ?? '').not.toContain('session_token=');
            expect(await rejected.json()).toMatchObject({ code: 'INVALID_USERNAME_OR_PASSWORD' });
        }
    });

    it('enforces same-origin and CAPTCHA checks on username sign-in', async () => {
        const { client } = await verifiedUsername();
        const body = { username: 'mixed.name_17', password };
        const foreign = await client.request('/api/auth/sign-in/username', { body, headers: { Origin: 'https://attacker.invalid' } });
        expect(foreign.status).toBe(403);
        const missing = await client.request('/api/auth/sign-in/username', { body, captcha: false });
        expect(missing.ok).toBe(false);
        captchaAccepted = false;
        const invalid = await client.request('/api/auth/sign-in/username', { body });
        expect(invalid.ok).toBe(false);
        const availability = await client.request('/api/auth/is-username-available', { body: { username: 'mixed.name_17' } });
        expect(availability.status).toBe(404);
    });

    it('rate-limits username password guesses through persistent D1 state', async () => {
        const client = harness();
        const results = [];
        for (let attempt = 0; attempt < 6; attempt++) results.push(await login(client, 'missing_user', 'wrong-password'));
        expect(results.slice(0, 5).every((response) => response.status === 401)).toBe(true);
        expect(results[5]!.status).toBe(429);
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "rateLimit"').first('count')).toBeGreaterThan(0);
    });

    it('does not let a suspended user sign in by username', async () => {
        const { client, cookie } = await verifiedUsername();
        const identity = (await session(client, cookie))!;
        const administrator = await client.administrator();
        expect((await client.request('/api/auth/admin/ban-user', { cookie: administrator, body: { userId: identity.user.id } })).status).toBe(200);
        expect((await login(client, 'mixed.name_17')).ok).toBe(false);
        expect(await session(client, cookie)).toBeNull();
        expect((await client.request('/api/auth/admin/unban-user', { cookie: administrator, body: { userId: identity.user.id } })).status).toBe(200);
        expect((await login(client, 'mixed.name_17')).status).toBe(200);
    });
});
