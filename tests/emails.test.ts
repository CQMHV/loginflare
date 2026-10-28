import { env } from 'cloudflare:workers';
import { hashPassword } from 'better-auth/crypto';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addVerifiedEmail, cookies, harness, mailCode, password, recoveryToken, session } from './helpers';

type Harness = ReturnType<typeof harness>;
interface Email {
    id: string;
    email: string;
    verified: boolean;
    primary: boolean;
}
interface Challenge { emailId: string; challengeId: string }

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify' || request.method !== 'POST') {
            throw new Error('Unexpected outbound request in an isolated email-management test');
        }
        return Response.json({ success: true });
    });
});

afterEach(async () => {
    vi.unstubAllGlobals();
    await reset();
});

async function fixture() {
    const client = harness();
    await client.verify();
    const cookie = await client.signin();
    return { client, cookie };
}

async function list(client: Harness, cookie: string) {
    const response = await client.request('/api/auth/emails', { cookie });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json<{ emails: Email[] }>()).emails;
}

async function add(client: Harness, cookie: string, email = 'secondary@example.test') {
    const response = await client.request('/api/auth/emails/add', { cookie, body: { email, password } });
    expect(response.status, await response.clone().text()).toBe(200);
    return { ...await response.json<Challenge>(), code: mailCode(client.messages.at(-1)) };
}

async function verify(client: Harness, cookie: string, challenge: { challengeId: string; code: string }) {
    return client.request('/api/auth/emails/verify', { cookie, body: { challengeId: challenge.challengeId, code: challenge.code } });
}

async function start(client: Harness, identifier: string, email: string) {
    const response = await client.request('/api/auth/emails/recovery/start', { body: { identifier, email } });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json<{ status: boolean; challengeId: string }>();
}

describe('primary and secondary email management in the Workers runtime', () => {
    it('registers the primary address and verifies a normalized secondary without changing the login address', async () => {
        const { client, cookie } = await fixture();
        expect(await list(client, cookie)).toEqual([expect.objectContaining({ email: 'person@example.test', primary: true, verified: true })]);
        const added = await add(client, cookie, 'Secondary@Example.Test');
        expect((await session(client, cookie))?.user.email).toBe('person@example.test');
        expect(await list(client, cookie)).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: added.emailId, email: 'secondary@example.test', primary: false, verified: false }),
        ]));
        const stored = await env.DB.prepare('SELECT "codeHash" FROM "emailChallenge" WHERE "id" = ?').bind(added.challengeId).first<string>('codeHash');
        expect(stored).toBeTruthy();
        expect(stored).not.toBe(added.code);
        expect((await verify(client, cookie, added)).status).toBe(200);
        expect((await list(client, cookie)).find((email) => email.id === added.emailId)?.verified).toBe(true);
        const rejected = await client.request('/api/auth/sign-in/email', { body: { email: 'secondary@example.test', password } });
        expect(rejected.status).toBe(401);
        expect(rejected.headers.get('set-cookie') ?? '').not.toContain('session_token=');
    });

    it('reserves both primary and pending secondary addresses across accounts and registration', async () => {
        const { client, cookie } = await fixture();
        await add(client, cookie);
        await client.verify('second@example.test');
        const other = await client.signin('second@example.test');
        for (const email of ['PERSON@example.test', 'SECONDARY@example.test']) {
            const duplicate = await client.request('/api/auth/emails/add', { cookie: other, body: { email, password } });
            expect(duplicate.ok).toBe(false);
            expect(await duplicate.json()).toMatchObject({ code: 'EMAIL_ALREADY_EXISTS' });
        }
        const signup = await client.request('/api/auth/sign-up/email', {
            body: { name: 'Cannot claim a secondary', email: 'SECONDARY@example.test', password },
        });
        expect(signup.ok).toBe(false);
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "user" WHERE lower("email") = ?').bind('secondary@example.test').first('count')).toBe(0);
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "userEmail" WHERE lower("email") = ?').bind('secondary@example.test').first('count')).toBe(1);
    });

    it('allows only one owner when two accounts add the same normalized address concurrently', async () => {
        const { client, cookie } = await fixture();
        await client.verify('second@example.test');
        const other = await client.signin('second@example.test');
        const responses = await Promise.all([cookie, other].map((owner, index) => client.request('/api/auth/emails/add', {
            cookie: owner, body: { email: index ? 'Contested@example.test' : 'contested@example.test', password },
        })));
        expect(responses.filter((response) => response.ok)).toHaveLength(1);
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "userEmail" WHERE lower("email") = ?').bind('contested@example.test').first('count')).toBe(1);
        for (const response of responses.filter((response) => !response.ok)) {
            expect(response.status).toBeLessThan(500);
            expect(await response.text()).not.toContain('UNIQUE constraint');
        }
    });

    it('arbitrates a concurrent registration and secondary-address reservation in the database', async () => {
        const { client, cookie } = await fixture();
        const [added, registered] = await Promise.all([
            client.request('/api/auth/emails/add', { cookie, body: { email: 'race@example.test', password } }),
            client.request('/api/auth/sign-up/email', { body: { name: 'Contending registrant', email: 'RACE@example.test', password } }),
        ]);
        const rows = await env.DB.prepare('SELECT "userId" FROM "userEmail" WHERE lower("email") = ?').bind('race@example.test').all<{ userId: string }>();
        expect(rows.results).toHaveLength(1);
        const registeredUser = await env.DB.prepare('SELECT "id" FROM "user" WHERE lower("email") = ?').bind('race@example.test').first<{ id: string }>();
        if (registeredUser) expect(rows.results[0].userId).toBe(registeredUser.id);
        else expect(added.ok).toBe(true);
        expect([added, registered].filter((response) => response.ok)).toHaveLength(1);
        for (const response of [added, registered]) {
            expect(response.status).toBeLessThan(500);
            expect(await response.text()).not.toContain('UNIQUE constraint');
        }
    });

    it('requires the current password and an authenticated same-origin session for sensitive changes', async () => {
        const { client, cookie } = await fixture();
        const added = await add(client, cookie);
        for (const endpoint of ['add', 'resend', 'set-primary', 'remove']) {
            const body = endpoint === 'add' ? { email: 'wrong-password@example.test', password: 'incorrect-password' }
                : { emailId: added.emailId, password: 'incorrect-password' };
            const rejected = await client.request(`/api/auth/emails/${endpoint}`, { cookie, body });
            expect(rejected.ok).toBe(false);
            expect(await rejected.json()).toMatchObject({ code: 'INVALID_PASSWORD' });
            expect((await client.request(`/api/auth/emails/${endpoint}`, { body })).status).toBe(401);
        }
        expect((await client.request('/api/auth/emails')).status).toBe(401);
        const foreign = await client.request('/api/auth/emails/verify', {
            cookie, body: { challengeId: added.challengeId, code: added.code }, headers: { Origin: 'https://attacker.invalid' },
        });
        expect(foreign.status).toBe(403);
        expect((await list(client, cookie)).find((email) => email.id === added.emailId)?.verified).toBe(false);
    });

    it('binds verification to its account and consumes a valid challenge once', async () => {
        const { client, cookie } = await fixture();
        const added = await add(client, cookie);
        await client.verify('second@example.test');
        const other = await client.signin('second@example.test');
        expect((await verify(client, other, added)).ok).toBe(false);
        expect((await verify(client, cookie, added)).status).toBe(200);
        expect((await verify(client, cookie, added)).ok).toBe(false);
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "emailChallenge" WHERE "id" = ?').bind(added.challengeId).first('count')).toBe(0);
    });

    it('separates address-verification challenges from password-recovery challenges', async () => {
        const { client, cookie } = await fixture();
        const added = await add(client, cookie);
        const wrongPurpose = await client.request('/api/auth/emails/recovery/verify', { body: { challengeId: added.challengeId, code: added.code } });
        expect(wrongPurpose.ok).toBe(false);
        expect((await verify(client, cookie, added)).status).toBe(200);
        const recovery = await start(client, 'person@example.test', 'secondary@example.test');
        const code = mailCode(client.messages.at(-1));
        expect((await verify(client, cookie, { challengeId: recovery.challengeId, code })).ok).toBe(false);
        expect((await client.request('/api/auth/emails/recovery/verify', { body: { challengeId: recovery.challengeId, code } })).status).toBe(200);
    });

    it('expires verification challenges and locks them after five wrong attempts', async () => {
        const { client, cookie } = await fixture();
        const expired = await add(client, cookie, 'expired@example.test');
        await env.DB.prepare('UPDATE "emailChallenge" SET "expiresAt" = ? WHERE "id" = ?').bind(Date.now() - 60_000, expired.challengeId).run();
        expect((await verify(client, cookie, expired)).ok).toBe(false);
        const exhausted = await add(client, cookie, 'exhausted@example.test');
        const wrong = exhausted.code === '000000' ? '000001' : '000000';
        for (let attempt = 0; attempt < 5; attempt++) expect((await verify(client, cookie, { challengeId: exhausted.challengeId, code: wrong })).ok).toBe(false);
        expect((await verify(client, cookie, exhausted)).ok).toBe(false);
        expect((await list(client, cookie)).filter((email) => !email.primary).every((email) => !email.verified)).toBe(true);
    });

    it('resending invalidates the previous challenge and verifies with the replacement', async () => {
        const { client, cookie } = await fixture();
        const added = await add(client, cookie);
        const resent = await client.request('/api/auth/emails/resend', { cookie, body: { emailId: added.emailId, password } });
        expect(resent.status, await resent.clone().text()).toBe(200);
        const { challengeId } = await resent.json<{ challengeId: string }>();
        expect(challengeId).not.toBe(added.challengeId);
        const code = mailCode(client.messages.at(-1));
        expect((await verify(client, cookie, added)).ok).toBe(false);
        expect((await verify(client, cookie, { challengeId, code })).status).toBe(200);
    });

    it('switches only to a verified owned address while preserving identity, username, and password', async () => {
        const { client, cookie } = await fixture();
        expect((await client.request('/api/auth/update-user', { cookie, body: { username: 'email_owner' } })).status).toBe(200);
        const before = (await session(client, cookie))!;
        const added = await add(client, cookie);
        const unverified = await client.request('/api/auth/emails/set-primary', { cookie, body: { emailId: added.emailId, password } });
        expect(unverified.ok).toBe(false);
        expect(await unverified.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
        expect((await verify(client, cookie, added)).status).toBe(200);
        const changed = await client.request('/api/auth/emails/set-primary', { cookie, body: { emailId: added.emailId, password } });
        expect(changed.status, await changed.clone().text()).toBe(200);
        expect((await session(client, cookie))?.user).toMatchObject({ id: before.user.id, email: 'secondary@example.test', username: 'email_owner' });
        const addresses = await list(client, cookie);
        expect(addresses.filter((email) => email.primary)).toEqual([{ id: added.emailId, email: 'secondary@example.test', primary: true, verified: true }]);
        expect(addresses).toEqual(expect.arrayContaining([expect.objectContaining({ email: 'person@example.test', primary: false, verified: true })]));
        expect(await env.DB.prepare('SELECT "email", "emailVerified" FROM "user" WHERE "id" = ?').bind(before.user.id).first()).toEqual({ email: 'secondary@example.test', emailVerified: 1 });
        expect((await client.request('/api/auth/sign-in/email', { body: { email: 'person@example.test', password } })).status).toBe(401);
        await client.signin('SECONDARY@example.test');
        const byUsername = await client.request('/api/auth/sign-in/username', { body: { username: 'EMAIL_OWNER', password } });
        expect(byUsername.status).toBe(200);
        expect((await session(client, cookies(byUsername)))?.user.id).toBe(before.user.id);
    });

    it('guards the primary address, isolates ownership, and releases a removed secondary address', async () => {
        const { client, cookie } = await fixture();
        const primary = (await list(client, cookie))[0];
        const refused = await client.request('/api/auth/emails/remove', { cookie, body: { emailId: primary.id, password } });
        expect(refused.ok).toBe(false);
        expect(await refused.json()).toMatchObject({ code: 'PRIMARY_EMAIL_REQUIRED' });
        const added = await add(client, cookie);
        await client.verify('second@example.test');
        const other = await client.signin('second@example.test');
        for (const endpoint of ['set-primary', 'remove', 'resend']) {
            expect((await client.request(`/api/auth/emails/${endpoint}`, { cookie: other, body: { emailId: added.emailId, password } })).ok).toBe(false);
        }
        expect((await client.request('/api/auth/emails/remove', { cookie, body: { emailId: added.emailId, password } })).status).toBe(200);
        expect((await verify(client, cookie, added)).ok).toBe(false);
        const replacement = await add(client, other, 'SECONDARY@example.test');
        expect(replacement.emailId).not.toBe(added.emailId);
        expect((await list(client, other)).find((email) => email.id === replacement.emailId)?.verified).toBe(false);
    });

    it('does not resurrect a removed address when promotion and removal race', async () => {
        const { client, cookie } = await fixture();
        const emailId = await addVerifiedEmail(client, cookie, 'secondary@example.test');
        const responses = await Promise.all(['set-primary', 'remove'].map((endpoint) => client.request(`/api/auth/emails/${endpoint}`, {
            cookie, body: { emailId, password },
        })));
        expect(responses.filter((response) => response.ok)).toHaveLength(1);
        const identity = (await session(client, cookie))!;
        const addresses = await list(client, cookie);
        expect(addresses.filter((email) => email.primary)).toEqual([expect.objectContaining({ email: identity.user.email, verified: true })]);
        const secondary = addresses.find((email) => email.id === emailId);
        if (responses[0].ok) expect(secondary).toMatchObject({ email: identity.user.email, primary: true, verified: true });
        else expect(secondary).toBeUndefined();
        for (const response of responses) expect(response.status).toBeLessThan(500);
    });

    it('rejects a stale promotion after its verified target has already been removed', async () => {
        const { client, cookie } = await fixture();
        const emailId = await addVerifiedEmail(client, cookie, 'secondary@example.test');
        const identity = (await session(client, cookie))!;
        expect((await client.request('/api/auth/emails/remove', { cookie, body: { emailId, password } })).status).toBe(200);
        await expect(env.DB.prepare('UPDATE "user" SET "email" = ?, "emailVerified" = 1 WHERE "id" = ?')
            .bind('secondary@example.test', identity.user.id).run()).rejects.toThrow();
        expect((await session(client, cookie))?.user.email).toBe('person@example.test');
        expect(await list(client, cookie)).toHaveLength(1);
    });

    it('rejects a promotion when the credential changes after password verification but before the write', async () => {
        const { client, cookie } = await fixture();
        const emailId = await addVerifiedEmail(client, cookie, 'secondary@example.test');
        const identity = (await session(client, cookie))!;
        const replacementHash = await hashPassword('Concurrent-credential-replacement-643!');
        const database = client.bindings.DB;
        let credentialChanged = false;
        client.bindings.DB = new Proxy(database, {
            get(target, property) {
                if (property === 'prepare') return (sql: string) => {
                    const statement = target.prepare(sql);
                    if (!/^\s*UPDATE\s+"user"\s+SET\s+"email"\s*=/.test(sql)) return statement;
                    return new Proxy(statement, {
                        get(prepared, key) {
                            if (key === 'bind') return (...values: unknown[]) => {
                                const bound = prepared.bind(...values);
                                return new Proxy(bound, {
                                    get(executable, operation) {
                                        if (operation === 'run') return async () => {
                                            await database.prepare('UPDATE "account" SET "password" = ? WHERE "userId" = ? AND "providerId" = ?')
                                                .bind(replacementHash, identity.user.id, 'credential').run();
                                            credentialChanged = true;
                                            return executable.run();
                                        };
                                        const value = Reflect.get(executable, operation);
                                        return typeof value === 'function' ? value.bind(executable) : value;
                                    },
                                });
                            };
                            const value = Reflect.get(prepared, key);
                            return typeof value === 'function' ? value.bind(prepared) : value;
                        },
                    });
                };
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
        const response = await client.request('/api/auth/emails/set-primary', { cookie, body: { emailId, password } });
        expect(credentialChanged).toBe(true);
        expect(response.ok).toBe(false);
        expect(await response.json()).toMatchObject({ code: 'INVALID_PASSWORD' });
        expect((await session(client, cookie))?.user.email).toBe('person@example.test');
        expect((await list(client, cookie)).filter((email) => email.primary)).toEqual([expect.objectContaining({ email: 'person@example.test' })]);
    });

    it('enforces the ten-address limit when the final two reservations race', async () => {
        const { client, cookie } = await fixture();
        const identity = (await session(client, cookie))!;
        await env.DB.batch(Array.from({ length: 8 }, (_, index) => env.DB.prepare(
            'INSERT INTO "userEmail" ("id", "userId", "email", "verified", "createdAt") VALUES (?, ?, ?, 1, ?)',
        ).bind(crypto.randomUUID(), identity.user.id, `existing-${index}@example.test`, Date.now())));
        const responses = await Promise.all(['last-one@example.test', 'last-two@example.test'].map((email) => client.request('/api/auth/emails/add', {
            cookie, body: { email, password },
        })));
        expect(responses.filter((response) => response.ok)).toHaveLength(1);
        expect(await list(client, cookie)).toHaveLength(10);
        for (const response of responses.filter((response) => !response.ok)) {
            expect(response.status).toBeLessThan(500);
            expect(await response.json()).toMatchObject({ code: 'EMAIL_LIMIT_REACHED' });
        }
    });

    it('reclaims only the requested expired pending reservation without sweeping other accounts', async () => {
        const { client, cookie } = await fixture();
        const unrelated = await add(client, cookie, 'unrelated-pending@example.test');
        await client.verify('second@example.test');
        const other = await client.signin('second@example.test');
        const target = await add(client, other, 'expired-reservation@example.test');
        await env.DB.prepare('UPDATE "userEmail" SET "createdAt" = ? WHERE "id" IN (?, ?)')
            .bind(Date.now() - 2 * 86_400_000, unrelated.emailId, target.emailId).run();
        await add(client, cookie, 'fresh@example.test');
        expect((await list(client, cookie)).some((email) => email.id === unrelated.emailId)).toBe(true);
        expect((await list(client, other)).some((email) => email.id === target.emailId)).toBe(true);
        const reclaimed = await add(client, cookie, 'EXPIRED-RESERVATION@example.test');
        expect(reclaimed.emailId).not.toBe(target.emailId);
        expect((await list(client, other)).some((email) => email.id === target.emailId)).toBe(false);
        expect((await verify(client, other, target)).ok).toBe(false);
    });

    it('keeps database constraints authoritative when a native user update tries to claim another account’s secondary', async () => {
        const { client, cookie } = await fixture();
        await addVerifiedEmail(client, cookie, 'secondary@example.test');
        await client.verify('second@example.test');
        await expect(env.DB.prepare('UPDATE "user" SET "email" = ? WHERE "email" = ?')
            .bind('SECONDARY@example.test', 'second@example.test').run()).rejects.toThrow();
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "user" WHERE "email" = ?').bind('second@example.test').first('count')).toBe(1);
        expect((await list(client, cookie)).find((email) => email.email === 'secondary@example.test')?.primary).toBe(false);
    });
});

describe('password recovery through verified account emails', () => {
    it('keeps recovery responses indistinguishable on delivery failure and removes unusable challenges', async () => {
        const { client } = await fixture();
        const before = client.messages.length;
        client.setMailFailure(true);
        for (const [identifier, email] of [
            ['person@example.test', 'person@example.test'],
            ['unknown@example.test', 'person@example.test'],
            ['person@example.test', 'unrelated@example.test'],
        ]) {
            const response = await client.request('/api/auth/emails/recovery/start', { body: { identifier, email } });
            expect(response.status, await response.clone().text()).toBe(200);
            expect(await response.json()).toEqual({ status: true, challengeId: expect.any(String) });
            expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "emailChallenge" WHERE "purpose" = ?').bind('recovery').first('count')).toBe(0);
        }
        expect(client.messages).toHaveLength(before);
    });

    it('recovers through a secondary after selecting the account by username, revokes sessions, and rejects reuse', async () => {
        const { client, cookie } = await fixture();
        const other = await client.signin();
        expect((await client.request('/api/auth/update-user', { cookie, body: { username: 'recover_owner' } })).status).toBe(200);
        await addVerifiedEmail(client, cookie, 'recovery@example.test');
        const token = await recoveryToken(client, 'RECOVER_OWNER', 'RECOVERY@example.test');
        const replacement = 'Changed-secondary-recovery-password-643!';
        const changed = await client.request('/api/auth/reset-password', { body: { token, newPassword: replacement } });
        expect(changed.status, await changed.clone().text()).toBe(200);
        expect(await session(client, cookie)).toBeNull();
        expect(await session(client, other)).toBeNull();
        expect((await client.request('/api/auth/reset-password', { body: { token, newPassword: password } })).ok).toBe(false);
        expect((await client.request('/api/auth/sign-in/email', { body: { email: 'person@example.test', password } })).status).toBe(401);
        await client.signin('person@example.test', replacement);
        expect((await client.request('/api/auth/sign-in/email', { body: { email: 'recovery@example.test', password: replacement } })).status).toBe(401);
    });

    it('does not select an account from a secondary, an unverified email, or another owner’s address', async () => {
        const { client, cookie } = await fixture();
        await addVerifiedEmail(client, cookie, 'secondary@example.test');
        await add(client, cookie, 'pending@example.test');
        const before = client.messages.length;
        const attempts = [
            ['secondary@example.test', 'secondary@example.test'],
            ['person@example.test', 'pending@example.test'],
            ['person@example.test', 'unrelated@example.test'],
            ['unknown@example.test', 'person@example.test'],
        ];
        for (const [index, [identifier, email]] of attempts.entries()) {
            const response = await client.request('/api/auth/emails/recovery/start', {
                body: { identifier, email }, headers: { 'CF-Connecting-IP': `192.0.2.${80 + index}` },
            });
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ status: true, challengeId: expect.any(String) });
        }
        expect(client.messages).toHaveLength(before);
    });

    it('requires CAPTCHA and limits recovery-code sending through persistent state', async () => {
        const client = harness();
        const body = { identifier: 'unknown@example.test', email: 'unknown@example.test' };
        expect((await client.request('/api/auth/emails/recovery/start', { body, captcha: false })).ok).toBe(false);
        const responses = [];
        for (let attempt = 0; attempt < 4; attempt++) responses.push(await client.request('/api/auth/emails/recovery/start', {
            body, headers: { 'CF-Connecting-IP': '192.0.2.99' },
        }));
        expect(responses.slice(0, 3).every((response) => response.status === 200)).toBe(true);
        expect(responses[3].status).toBe(429);
    });

    it('expires and consumes recovery codes without exposing a usable password-reset token', async () => {
        const { client } = await fixture();
        const expired = await start(client, 'person@example.test', 'person@example.test');
        const expiredCode = mailCode(client.messages.at(-1));
        await env.DB.prepare('UPDATE "emailChallenge" SET "expiresAt" = ? WHERE "id" = ?').bind(Date.now() - 60_000, expired.challengeId).run();
        const rejected = await client.request('/api/auth/emails/recovery/verify', { body: { challengeId: expired.challengeId, code: expiredCode } });
        expect(rejected.ok).toBe(false);
        expect(await rejected.json()).not.toHaveProperty('token');
        const active = await start(client, 'person@example.test', 'person@example.test');
        const body = { challengeId: active.challengeId, code: mailCode(client.messages.at(-1)) };
        const first = await client.request('/api/auth/emails/recovery/verify', { body });
        expect(first.status).toBe(200);
        expect(await first.json()).toHaveProperty('token');
        expect((await client.request('/api/auth/emails/recovery/verify', { body })).ok).toBe(false);
    });

    it('limits recovery-code guesses and issues one reset ticket under concurrent consumption', async () => {
        const { client } = await fixture();
        const exhausted = await start(client, 'person@example.test', 'person@example.test');
        const exhaustedCode = mailCode(client.messages.at(-1));
        const wrong = exhaustedCode === '000000' ? '000001' : '000000';
        for (let attempt = 0; attempt < 5; attempt++) {
            expect((await client.request('/api/auth/emails/recovery/verify', { body: { challengeId: exhausted.challengeId, code: wrong } })).ok).toBe(false);
        }
        expect((await client.request('/api/auth/emails/recovery/verify', { body: { challengeId: exhausted.challengeId, code: exhaustedCode } })).ok).toBe(false);
        const active = await start(client, 'person@example.test', 'person@example.test');
        const body = { challengeId: active.challengeId, code: mailCode(client.messages.at(-1)) };
        const responses = await Promise.all([0, 1].map(() => client.request('/api/auth/emails/recovery/verify', { body })));
        expect(responses.filter((response) => response.ok)).toHaveLength(1);
        expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "verification" WHERE "identifier" LIKE ?').bind('reset-password:%').first('count')).toBe(1);
    });

    it('invalidates recovery challenges and issued reset tokens when the email configuration changes', async () => {
        const { client, cookie } = await fixture();
        const secondaryId = await addVerifiedEmail(client, cookie, 'secondary@example.test');
        const token = await recoveryToken(client, 'person@example.test', 'secondary@example.test');
        const challenge = await start(client, 'person@example.test', 'secondary@example.test');
        const code = mailCode(client.messages.at(-1));
        expect((await client.request('/api/auth/emails/remove', { cookie, body: { emailId: secondaryId, password } })).status).toBe(200);
        expect((await client.request('/api/auth/emails/recovery/verify', { body: { challengeId: challenge.challengeId, code } })).ok).toBe(false);
        expect((await client.request('/api/auth/reset-password', { body: { token, newPassword: 'Changed-invalidated-password-643!' } })).ok).toBe(false);
    });
});
