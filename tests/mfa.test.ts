import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cookies, harness, origin, password, recoveryToken, session } from './helpers';
import { authenticatorCode } from './totp';

type Client = ReturnType<typeof harness>;
type Enrollment = { totpURI: string; backupCodes: string[] };
let address = 0;
const headers = () => ({ 'CF-Connecting-IP': `198.51.100.${++address}` });
async function factor(client: Client, path: string, cookie: string, body: Record<string, unknown>) {
    return client.request(`/api/auth/two-factor/${path}`, { cookie, body, headers: headers(), captcha: false });
}
async function enroll(client: Client, cookie: string) {
    const started = await factor(client, 'enable', cookie, { password });
    expect(started.status, await started.clone().text()).toBe(200);
    const enrollment = await started.json<Enrollment>();
    const verified = await factor(client, 'verify-totp', cookie, { code: await authenticatorCode(enrollment.totpURI) });
    expect(verified.status, await verified.clone().text()).toBe(200);
    return { ...enrollment, cookie: cookies(verified) };
}
async function challenge(client: Client, username?: string, candidate = password) {
    const response = await client.request(`/api/auth/sign-in/${username ? 'username' : 'email'}`, {
        body: { ...(username ? { username } : { email: 'person@example.test' }), password: candidate }, headers: headers(),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
    const cookie = cookies(response);
    expect(await session(client, cookie)).toBeNull();
    return cookie;
}

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    address = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        if (new Request(input).url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected network request');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

it('confirms enrollment before activation, encrypts credentials, and revokes older sessions', async () => {
    const client = harness();
    await client.verify();
    const older = await client.signin();
    const cookie = await client.signin();
    expect((await factor(client, 'enable', cookie, { password: 'wrong' })).status).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "twoFactor"').first('n')).toBe(0);
    const started = await factor(client, 'enable', cookie, { password });
    const data = await started.json<Enrollment>();
    expect(data.backupCodes).toHaveLength(10);
    expect(await env.DB.prepare('SELECT "twoFactorEnabled" FROM "user"').first('twoFactorEnabled')).toBe(0);
    expect((await factor(client, 'verify-totp', cookie, { code: 'invalid' })).status).toBe(401);
    const stored = await env.DB.prepare('SELECT "secret", "backupCodes" FROM "twoFactor"').first<{ secret: string; backupCodes: string }>();
    expect(stored?.secret).not.toBe(new URL(data.totpURI).searchParams.get('secret'));
    for (const code of data.backupCodes) expect(stored?.backupCodes).not.toContain(code);
    const verified = await factor(client, 'verify-totp', cookie, { code: await authenticatorCode(data.totpURI) });
    expect(verified.status, await verified.clone().text()).toBe(200);
    expect(await env.DB.prepare('SELECT "twoFactorEnabled" FROM "user"').first('twoFactorEnabled')).toBe(1);
    expect(await session(client, older)).toBeNull();
    expect(await session(client, cookie)).toBeNull();
    const active = cookies(verified);
    expect(await session(client, active)).toBeTruthy();
    expect((await factor(client, 'enable', active, { password })).status).toBe(400);
});

it('requires MFA for both email and username sign-in and consumes the login challenge once', async () => {
    const client = harness();
    await client.verify();
    const original = await client.signin();
    await client.request('/api/auth/update-user', { cookie: original, body: { username: 'mfa_person' } });
    const enrolled = await enroll(client, original);
    for (const username of [undefined, 'MFA_PERSON']) {
        const pending = await challenge(client, username);
        expect((await client.request('/api/account/sessions', { cookie: pending })).status).toBe(401);
        expect((await factor(client, 'verify-totp', pending, { code: 'invalid' })).status).toBe(401);
        const verified = await factor(client, 'verify-totp', pending, { code: await authenticatorCode(enrolled.totpURI) });
        expect(verified.status, await verified.clone().text()).toBe(200);
        expect(await session(client, cookies(verified))).toBeTruthy();
        expect((await factor(client, 'verify-totp', pending, { code: await authenticatorCode(enrolled.totpURI) })).status).toBe(401);
    }
});

it('consumes recovery codes once, replaces old codes, and safely disables MFA', async () => {
    const client = harness();
    await client.verify();
    const enrollment = await enroll(client, await client.signin());
    const pending = await challenge(client);
    const recovered = await factor(client, 'verify-backup-code', pending, { code: enrollment.backupCodes[0] });
    expect(recovered.status).toBe(200);
    const cookie = cookies(recovered);
    const second = await challenge(client);
    expect((await factor(client, 'verify-backup-code', second, { code: enrollment.backupCodes[0] })).status).toBe(401);
    const replacement = await factor(client, 'generate-backup-codes', cookie, { password });
    expect(replacement.status).toBe(200);
    const { backupCodes } = await replacement.json<{ backupCodes: string[] }>();
    expect((await factor(client, 'verify-backup-code', second, { code: enrollment.backupCodes[1] })).status).toBe(401);
    const next = await factor(client, 'verify-backup-code', second, { code: backupCodes[0] });
    expect(next.status).toBe(200);
    expect((await factor(client, 'disable', cookies(next), { password: 'wrong' })).status).toBe(400);
    const disabled = await factor(client, 'disable', cookies(next), { password });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "twoFactor"').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT "twoFactorEnabled" FROM "user"').first('twoFactorEnabled')).toBe(0);
    expect(await session(client, enrollment.cookie)).toBeNull();
    expect(await session(client, cookie)).toBeNull();
    expect(await session(client, cookies(disabled))).toBeTruthy();
    expect(await client.signin()).toContain('session_token=');
});

it('rejects expired challenges and limits attempts across new challenges and IP addresses', async () => {
    const client = harness();
    await client.verify();
    const enrollment = await enroll(client, await client.signin());
    const expired = await challenge(client);
    await env.DB.prepare(`UPDATE "verification" SET "expiresAt" = ? WHERE "identifier" LIKE '2fa-%'`).bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await factor(client, 'verify-totp', expired, { code: await authenticatorCode(enrollment.totpURI) })).status).toBe(401);
    for (let group = 0; group < 2; group++) {
        const pending = await challenge(client);
        for (let i = 0; i < 5; i++) expect((await factor(client, 'verify-totp', pending, { code: 'invalid' })).status).toBe(401);
        const denied = await factor(client, 'verify-totp', pending, { code: await authenticatorCode(enrollment.totpURI) });
        expect(denied.status).toBe(group ? 429 : 400);
    }
    const locked = await challenge(client);
    const response = await factor(client, 'verify-backup-code', locked, { code: enrollment.backupCodes[0] });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: 'ACCOUNT_TEMPORARILY_LOCKED' });
});

it('preserves MFA across password recovery and invalidates pending login challenges', async () => {
    const client = harness();
    await client.verify();
    const enrollment = await enroll(client, await client.signin());
    const pending = await challenge(client);
    const token = await recoveryToken(client);
    expect((await client.request('/api/auth/reset-password', { body: { token, newPassword: `${password}new` } })).status).toBe(200);
    expect((await factor(client, 'verify-backup-code', pending, { code: enrollment.backupCodes[0] })).status).toBe(401);
    await challenge(client, undefined, `${password}new`);
    expect(await env.DB.prepare('SELECT "twoFactorEnabled" FROM "user"').first('twoFactorEnabled')).toBe(1);
});

it('rejects accounts banned while MFA verification was pending', async () => {
    const client = harness();
    await client.verify();
    const enrollment = await enroll(client, await client.signin());
    const pending = await challenge(client);
    await env.DB.prepare('UPDATE "user" SET "banned" = 1').run();
    expect((await factor(client, 'verify-totp', pending, { code: await authenticatorCode(enrollment.totpURI) })).status).toBe(403);
});

it('restricts MFA routes, origin, fields and enrollment to authenticated users', async () => {
    const client = harness();
    expect((await factor(client, 'enable', '', { password })).status).toBe(401);
    for (const path of ['view-backup-codes', 'send-otp', 'verify-otp', 'get-totp-uri']) {
        expect((await factor(client, path, '', {})).status).toBe(404);
    }
    expect((await factor(client, 'verify-totp', '', { code: '123456', trustDevice: true })).status).toBe(400);
    expect((await client.request('/api/auth/two-factor/enable', { body: { password }, headers: { Origin: 'https://other.test' } })).status).toBe(403);
    expect((await client.request('/api/auth/two-factor/enable')).status).toBe(405);
});

it('rate limits MFA verification using D1 storage', async () => {
    const client = harness();
    for (let index = 0; index < 3; index++) {
        expect((await client.request('/api/auth/two-factor/verify-totp', { body: { code: '123456' } })).status).toBe(401);
    }
    expect((await client.request('/api/auth/two-factor/verify-totp', { body: { code: '123456' } })).status).toBe(429);
});
