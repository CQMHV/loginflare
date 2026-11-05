import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmailVerificationToken } from 'better-auth/api';
import { acquireLease, beginEffect, ensureControl, issueSession, readControl, readValue, releaseLease, writeValue } from '../src/server/control';
import { handleSetup } from '../src/server/setup';
import { SetupCloudflare, SetupProviderError } from '../src/server/setup-cloudflare';
import { openSetupValue, randomSetupToken, sealSetupValue, setupDigest, setupSecretEqual } from '../src/server/setup-crypto';
import { initialUpgradeProgress } from '../src/server/upgrade';
import { harness, mailUrl, origin, password } from './helpers';

const installationToken = 'test-user-api-token-with-at-least-32-characters';
const accountId = 'a'.repeat(32), zoneId = 'b'.repeat(32), workerName = 'loginflare-test';
beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return Response.json({ success: true });
        throw new Error('Unexpected outbound request');
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

async function fixture() {
    const client = harness();
    const bindings = { ...client.bindings, CF_SETUP_TOKEN: installationToken,
        LOGINFLARE_WORKER_NAME: workerName, LOGINFLARE_ACCOUNT_ID: accountId,
        LOGINFLARE_CONFIG_REVISION: 'revision-one', CF_VERSION_METADATA: { id: 'runtime-one', tag: '', timestamp: new Date().toISOString() } };
    const control = await ensureControl(bindings);
    await env.DB.prepare(`UPDATE "lfControl" SET "installation" = 'installing', "mode" = 'setup', "accountId" = ?, "workerName" = ? WHERE "id" = 1`)
        .bind(accountId, workerName).run();
    const lease = await acquireLease(env.DB, control.taskId);
    const progress = { ...initialUpgradeProgress(), phase: 'complete' as const };
    await writeValue(env.DB, lease, `upgrade:${control.taskId}`, progress);
    await writeValue(env.DB, lease, 'setup:configuration', { authUrl: bindings.AUTH_URL, emailFrom: bindings.EMAIL_FROM,
        zoneId, revision: 'revision-one', phase: 'observed', widgetId: bindings.TURNSTILE_SITE_KEY });
    await writeValue(env.DB, lease, 'setup:credentialDigest', await setupDigest(JSON.stringify([bindings.BETTER_AUTH_SECRET,
        bindings.TURNSTILE_SECRET_KEY, control.instanceId])));
    await releaseLease(env.DB, lease);
    const cookie = `loginflare.control=${await issueSession(env.DB, 'setup', control.taskId)}`;
    async function request(path: string, options: { body?: Record<string, unknown>; cookie?: string; method?: string } = {}) {
        return (await handleSetup(new Request(new URL(path, origin), {
            method: options.method ?? (options.body ? 'POST' : 'GET'), headers: { Origin: origin,
                ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.cookie ? { Cookie: options.cookie } : {}) },
            body: options.body ? JSON.stringify(options.body) : undefined,
        }), bindings))!;
    }
    return { client, bindings, cookie, control, request };
}

async function cleanupFixture(names: string[], checkpoint: 'record-only' | 'effect' | 'legacy-record' = 'effect') {
    const f = await fixture();
    await env.DB.batch([env.DB.prepare(`UPDATE "lfControl" SET "installation" = 'complete', "cleanupPending" = 1 WHERE "id" = 1`),
        env.DB.prepare(`UPDATE "lfControlSession" SET "purpose" = 'cleanup'`)]);
    const id = crypto.randomUUID(), lease = await acquireLease(env.DB, f.control.taskId);
    await writeValue(env.DB, lease, 'setup:cleanupEffect', checkpoint === 'legacy-record' ? { id }
        : { id, names, instanceId: f.control.instanceId });
    if (checkpoint !== 'record-only') await beginEffect(env.DB, lease, 'setup-cleanup', { names }, id);
    await releaseLease(env.DB, lease);
    return { ...f, effectId: id };
}

it('keeps pending credentials encrypted, instance-bound and recoverable with the same token', async () => {
    const secret = randomSetupToken(48);
    const sealed = await sealSetupValue(secret, installationToken, 'instance-one');
    expect(sealed).not.toContain(secret);
    expect(await openSetupValue(sealed, installationToken, 'instance-one')).toBe(secret);
    await expect(openSetupValue(sealed, installationToken, 'instance-two')).rejects.toThrow();
    await expect(openSetupValue(sealed, 'wrong-token', 'instance-one')).rejects.toThrow();
    expect(await setupSecretEqual(secret, secret)).toBe(true);
    expect(await setupSecretEqual(secret, secret + 'x')).toBe(false);
});

it('never forwards Cloudflare credentials to redirects or untrusted API origins', async () => {
    const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ success: true, result: { status: 'active' } }));
    const api = new SetupCloudflare(installationToken, transport);
    await api.verifyUserToken();
    const [url, options] = transport.mock.calls[0]!;
    expect(url).toBe('https://api.cloudflare.com/client/v4/user/tokens/verify');
    expect(options?.redirect).toBe('manual');
    await expect(api.request('https://attacker.test')).rejects.toThrow('INVALID_CLOUDFLARE_PATH');
    const failed = new SetupCloudflare(installationToken, async () => { throw new Error('secret-bearing diagnostics'); });
    await expect(failed.patchSecrets({ accountId, workerName }, { a: 'secret' })).rejects.toMatchObject({ uncertain: true, code: 'CLOUDFLARE_RESULT_UNCERTAIN' });
    await expect(failed.verifyUserToken()).rejects.toMatchObject({ uncertain: false });
});

it('opens standalone status before business initialization and does not expose candidate details anonymously', async () => {
    const f = await fixture();
    const response = await f.request('/api/setup/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ installed: false, authenticated: false });
    const visible = await f.request('/api/setup/status', { cookie: f.cookie });
    expect(await visible.json()).toMatchObject({ authenticated: true, schemaReady: true, configObserved: true,
        turnstileSiteKey: f.bindings.TURNSTILE_SITE_KEY });
    expect((await f.request('/api/setup/candidate', { body: {} })).status).toBe(401);
});

it('returns selected public configuration to its installer before observation without exposing secrets anonymously or in authenticated status', async () => {
    const f = await fixture();
    f.bindings.LOGINFLARE_CONFIG_REVISION = 'not-yet-observed';
    const anonymous = await (await f.request('/api/setup/status')).json();
    expect(anonymous).not.toHaveProperty('configuration');
    expect(anonymous).not.toHaveProperty('candidateEmail');
    const authenticated = await (await f.request('/api/setup/status', { cookie: f.cookie })).json();
    expect(authenticated).toMatchObject({ authenticated: true, configObserved: false,
        configuration: { authUrl: f.bindings.AUTH_URL, emailFrom: f.bindings.EMAIL_FROM, zoneId } });
    expect(Object.keys((authenticated as { configuration: Record<string, unknown> }).configuration).sort()).toEqual(['authUrl', 'emailFrom', 'zoneId']);
    for (const secret of [installationToken, f.bindings.BETTER_AUTH_SECRET, f.bindings.TURNSTILE_SECRET_KEY]) {
        expect(JSON.stringify(anonymous)).not.toContain(secret);
        expect(JSON.stringify(authenticated)).not.toContain(secret);
    }
});

it('keeps completed-installation status accessible during a failed upgrade without reading user or account tables', async () => {
    const f = await fixture();
    await env.DB.prepare(`UPDATE "lfControl" SET "installation" = 'complete', "mode" = 'failed',
        "candidateUserId" = 'old-admin', "candidateEmail" = 'admin@example.test' WHERE "id" = 1`).run();
    const blocked = vi.fn();
    f.bindings.DB = new Proxy(f.bindings.DB, { get(database, key) {
        if (key === 'prepare') return (sql: string) => {
            if (/\b(?:FROM|JOIN)\s+"?(?:user|account)"?(?:\s|$)/i.test(sql)) {
                blocked(); throw new Error('Business tables are unavailable during this failed upgrade');
            }
            return database.prepare(sql);
        };
        const value = Reflect.get(database, key, database);
        return typeof value === 'function' ? value.bind(database) : value;
    } });
    const response = await f.request('/api/setup/status', { cookie: f.cookie });
    expect(response.status, await response.clone().text()).toBe(200);
    const status = await response.json();
    expect(status).toMatchObject({ installed: true, authenticated: true, mode: 'failed' });
    expect(status).not.toHaveProperty('candidateCreated');
    expect(status).not.toHaveProperty('candidateVerified');
    expect(status).not.toHaveProperty('candidateEmail');
    expect(blocked).not.toHaveBeenCalled();
});

it.each(['/api/setup/authenticate', '/api/maintenance/challenge'])('requires an explicitly supplied token at the public %s entry', async (path) => {
    const f = await fixture();
    const current = await readControl(env.DB);
    const outbound = vi.fn(async () => { throw new Error('Missing credentials must never reach Cloudflare'); });
    vi.stubGlobal('fetch', outbound);
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM "lfControlSession"').first<number>('n');
    for (const body of [{}, { nonce: randomSetupToken() }, { token: '', nonce: randomSetupToken() }]) {
        const denied = await f.request(path, { body });
        expect(denied.status).toBe(401);
        expect(await denied.json()).toMatchObject({ code: 'CLOUDFLARE_TOKEN_REQUIRED' });
        expect(denied.headers.get('set-cookie')).toBeNull();
    }
    expect(outbound).not.toHaveBeenCalled();
    expect(await readControl(env.DB)).toEqual(current);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "lfControlSession"').first<number>('n')).toBe(sessions);
    expect(await readValue(env.DB, 'setup:challenge')).toBeNull();
    expect(await readValue(env.DB, 'setup:challengeStaged')).toBeNull();
});

it('keeps a reserved email retryable after captcha rejects registration before creating its user', async () => {
    const f = await fixture();
    const input = { name: 'Installer', email: 'installer@example.test', username: 'installer', password,
        locale: 'en-US', captchaToken: 'rejected-captcha-token' };
    vi.stubGlobal('fetch', async () => Response.json({ success: false }));
    const failed = await f.request('/api/setup/candidate', { cookie: f.cookie, body: input });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    const reserved = await readControl(env.DB);
    expect(reserved.candidateEmail).toBe(input.email);
    expect(reserved.candidateUserId).toBeTruthy();
    expect(await env.DB.prepare('SELECT 1 FROM "user" WHERE "id" = ?').bind(reserved.candidateUserId).first()).toBeNull();
    expect(await (await f.request('/api/setup/status', { cookie: f.cookie })).json()).toMatchObject({ candidateEmail: input.email,
        candidateCreated: false, candidateVerified: false });
    vi.stubGlobal('fetch', async () => Response.json({ success: true }));
    const retried = await f.request('/api/setup/candidate', { cookie: f.cookie, body: { ...input, captchaToken: 'test-captcha-token' } });
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect((await readControl(env.DB)).candidateUserId).toBe(reserved.candidateUserId);
    expect(await (await f.request('/api/setup/status', { cookie: f.cookie })).json()).toMatchObject({ candidateCreated: true, candidateVerified: false });
    expect(f.client.messages).toHaveLength(1);
});

it('retries native signup with the fixed reserved ID after an unused unverified user was left without any account', async () => {
    const f = await fixture();
    const id = crypto.randomUUID(), email = 'installer@example.test', now = new Date().toISOString();
    await env.DB.prepare('UPDATE "lfControl" SET "candidateUserId" = ?, "candidateEmail" = ? WHERE "id" = 1').bind(id, email).run();
    await env.DB.prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "role", "banned", "username", "locale")
        VALUES (?, 'Incomplete', ?, 0, ?, ?, 'user', 0, 'half.user', 'en-US')`).bind(id, email, now, now).run();
    expect(await (await f.request('/api/setup/status', { cookie: f.cookie })).json()).toMatchObject({ candidateCreated: false, candidateVerified: false });
    const response = await f.request('/api/setup/candidate', { cookie: f.cookie,
        body: { name: 'Installer', email, username: 'installer', password, locale: 'en-US', captchaToken: 'test-captcha-token' } });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await env.DB.prepare('SELECT "id", "name", "username" FROM "user" WHERE "id" = ?').bind(id).first())
        .toMatchObject({ id, name: 'Installer', username: 'installer' });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM "account" WHERE "userId" = ? AND "providerId" = 'credential' AND length("password") > 0`)
        .bind(id).first<number>('n')).toBe(1);
    expect((await readControl(env.DB)).candidateUserId).toBe(id);
    expect(f.client.messages).toHaveLength(1);
});

it('does not delete or promote an already verified candidate missing its credential account', async () => {
    const f = await fixture();
    const id = crypto.randomUUID(), email = 'installer@example.test', now = new Date().toISOString();
    await env.DB.prepare('UPDATE "lfControl" SET "candidateUserId" = ?, "candidateEmail" = ? WHERE "id" = 1').bind(id, email).run();
    await env.DB.prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "role", "banned", "username", "locale")
        VALUES (?, 'Preserved', ?, 1, ?, ?, 'user', 0, 'preserved.user', 'en-US')`).bind(id, email, now, now).run();
    const response = await f.request('/api/setup/candidate', { cookie: f.cookie,
        body: { name: 'Installer', email, username: 'installer', password, locale: 'en-US', captchaToken: 'test-captcha-token' } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'CANDIDATE_ACCOUNT_INCOMPLETE' });
    const finished = await f.request('/api/setup/finish', { cookie: f.cookie, body: {} });
    expect(finished.status).toBe(409);
    expect(await env.DB.prepare('SELECT "name", "role", "emailVerified" FROM "user" WHERE "id" = ?').bind(id).first())
        .toMatchObject({ name: 'Preserved', role: 'user', emailVerified: 1 });
    expect((await readControl(env.DB)).installation).toBe('installing');
});

it('allows cross-device email verification without granting installation authority', async () => {
    const f = await fixture();
    const created = await f.request('/api/setup/candidate', { cookie: f.cookie,
        body: { name: 'Installer', email: 'installer@example.test', username: 'installer', password,
            locale: 'zh-CN', captchaToken: 'test-captcha-token' } });
    expect(created.status, await created.clone().text()).toBe(200);
    const control = await readControl(env.DB);
    expect(control.candidateUserId).toBeTruthy();
    const mail = mailUrl(f.client.messages[0]);
    expect(new URL(mail).pathname).toBe('/api/auth/verify-email');
    expect(new URL(mail).searchParams.get('callbackURL')).toBe(`${origin}/zh-cn/setup/verified`);
    const verified = await f.request(mail);
    expect(verified.status, await verified.clone().text()).toBe(302);
    expect(verified.headers.get('location')).toBe(`${origin}/zh-cn/setup/verified`);
    expect(await env.DB.prepare('SELECT "role" FROM "user" WHERE "id" = ?').bind(control.candidateUserId).first('role')).toBe('user');
    expect((await f.request('/api/setup/finish', { body: {} })).status).toBe(401);
    const finished = await f.request('/api/setup/finish', { cookie: f.cookie, body: {} });
    expect(finished.status, await finished.clone().text()).toBe(200);
    expect(await readControl(env.DB)).toMatchObject({ installation: 'complete', cleanupPending: 1 });
    expect(await env.DB.prepare('SELECT "role" FROM "user" WHERE "id" = ?').bind(control.candidateUserId).first('role')).toBe('admin');
    expect((await f.request('/api/setup/configure', { cookie: f.cookie, body: {} })).status).toBe(403);
    expect((await f.request('/api/setup/candidate', { cookie: f.cookie, body: {} })).status).toBe(403);
});

it('rejects verification tokens for other accounts even when their signature is valid', async () => {
    const f = await fixture();
    await env.DB.prepare('UPDATE "lfControl" SET "candidateUserId" = ?, "candidateEmail" = ? WHERE "id" = 1')
        .bind('bound-candidate', 'bound@example.test').run();
    const token = await createEmailVerificationToken(f.bindings.BETTER_AUTH_SECRET, 'other@example.test');
    const denied = await f.request(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ code: 'INVALID_VERIFICATION_LINK' });
});

it('requires a write challenge for recovery and consumes it once without rotating auth material', async () => {
    const f = await fixture();
    let challengeName = '', challengeText = '';
    const nonce = randomSetupToken();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init), path = new URL(request.url).pathname;
        if (path.endsWith('/tokens/verify')) return Response.json({ success: true, result: { status: 'active' } });
        if (path.endsWith('/versions/runtime-one')) return Response.json({ success: true, result: { id: 'runtime-one' } });
        if (path.endsWith('/secrets-bulk')) {
            const body = await request.json() as { secrets: Record<string, { text: string }> };
            expect(Object.keys(body.secrets)).toHaveLength(1);
            [challengeName, { text: challengeText }] = Object.entries(body.secrets)[0]!;
            expect(challengeName).toMatch(/^LF_CONTROL_CHALLENGE_/);
            return Response.json({ success: true, result: {} });
        }
        throw new Error('Unexpected API call');
    });
    await new SetupCloudflare(installationToken).verifyUserToken();
    const started = await f.request('/api/maintenance/challenge', { body: { token: installationToken, nonce } });
    expect(started.status, await started.clone().text()).toBe(202);
    const { challengeId } = await started.json() as { challengeId: string };
    const waiting = await f.request('/api/maintenance/verify', { body: { challengeId, nonce } });
    expect(waiting.status).toBe(202);
    Object.defineProperty(f.bindings, challengeName, { value: challengeText, configurable: true });
    expect((await f.request('/api/maintenance/verify', { body: { challengeId, nonce: randomSetupToken() } })).status).toBe(401);
    const verified = await f.request('/api/maintenance/verify', { body: { challengeId, nonce } });
    expect(verified.status, await verified.clone().text()).toBe(200);
    expect(verified.headers.get('set-cookie')).toContain('loginflare.control=');
    expect((await f.request('/api/maintenance/verify', { body: { challengeId, nonce } })).status).toBe(401);
    expect(f.bindings.BETTER_AUTH_SECRET).toBe(env.BETTER_AUTH_SECRET);
});

it('does not authorize a read-only Cloudflare token', async () => {
    const f = await fixture();
    await env.DB.prepare('UPDATE "lfControl" SET "installation" = ?, "cleanupPending" = 0 WHERE "id" = 1').bind('complete').run();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith('/tokens/verify')) return Response.json({ success: true, result: { status: 'active' } });
        if (request.url.endsWith('/versions/runtime-one')) return Response.json({ success: true, result: { id: 'runtime-one' } });
        return Response.json({ success: false }, { status: 403 });
    });
    const denied = await f.request('/api/maintenance/challenge', { body: { token: installationToken, nonce: randomSetupToken() } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('set-cookie')).toBeNull();
    expect(await readValue(env.DB, 'setup:challenge')).toBeNull();
    expect(await readValue(env.DB, 'setup:challengeStaged')).toBeNull();
    expect((await readControl(env.DB)).cleanupPending).toBe(0);
});

it('finishes cleanup after a successful deletion loses its response, without reopening installation', async () => {
    const f = await fixture();
    await env.DB.batch([env.DB.prepare('UPDATE "lfControl" SET "installation" = ?, "cleanupPending" = 1 WHERE "id" = 1').bind('complete'),
        env.DB.prepare('UPDATE "lfControlSession" SET "purpose" = ?').bind('cleanup')]);
    let present = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === 'GET' && request.url.endsWith('/secrets')) return Response.json({ success: true,
            result: present ? [{ name: 'CF_SETUP_TOKEN', type: 'secret_text' }] : [] });
        if (request.method === 'PATCH') { present = false; throw new Error('Response was lost'); }
        throw new Error('Unexpected API call');
    });
    const first = await f.request('/api/setup/cleanup', { cookie: f.cookie, body: { token: installationToken } });
    expect(first.status).toBe(503);
    expect(await readControl(env.DB)).toMatchObject({ installation: 'complete', cleanupPending: 1 });
    const second = await f.request('/api/setup/cleanup', { cookie: f.cookie, body: { token: installationToken } });
    expect(second.status, await second.clone().text()).toBe(200);
    expect(await readControl(env.DB)).toMatchObject({ installation: 'complete', cleanupPending: 0 });
    expect(await readValue(env.DB, 'setup:credentials')).toBeNull();
});

it.each(['record-only', 'effect', 'legacy-record'] as const)('resumes a %s pre-dispatch cleanup checkpoint using only its frozen names', async (checkpoint) => {
    const oldName = `LF_CONTROL_CHALLENGE_${'1'.repeat(32)}`;
    const newName = `LF_CONTROL_CHALLENGE_${'2'.repeat(32)}`;
    const names = ['CF_SETUP_TOKEN', oldName];
    const f = await cleanupFixture(names, checkpoint);
    const lease = await acquireLease(env.DB, f.control.taskId);
    await writeValue(env.DB, lease, 'setup:challengeNames', [newName]);
    await releaseLease(env.DB, lease);
    const remote = new Set([...names, newName, 'BETTER_AUTH_SECRET', 'LOGINFLARE_CONFIG_REVISION']);
    const patches: Record<string, null>[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === 'GET' && request.url.endsWith('/secrets')) return Response.json({ success: true,
            result: [...remote].map((name) => ({ name, type: 'secret_text' })) });
        if (request.method === 'PATCH') {
            const value = await request.json() as { secrets: Record<string, null> };
            patches.push(value.secrets);
            for (const [name, action] of Object.entries(value.secrets)) { expect(action).toBeNull(); remote.delete(name); }
            return Response.json({ success: true, result: {} });
        }
        throw new Error('Unexpected API call');
    });
    const response = await f.request('/api/setup/cleanup', { cookie: f.cookie, body: { token: installationToken } });
    expect(response.status, await response.clone().text()).toBe(202);
    expect(patches).toEqual([{ CF_SETUP_TOKEN: null, [oldName]: null }]);
    expect(remote.has(newName)).toBe(true);
    expect(remote.has('BETTER_AUTH_SECRET')).toBe(true);
    expect(remote.has('LOGINFLARE_CONFIG_REVISION')).toBe(true);
    expect(await env.DB.prepare('SELECT "status" FROM "lfControlEffect" WHERE "id" = ?').bind(f.effectId).first('status')).toBe('done');
    expect(await readValue(env.DB, 'setup:cleanupEffect')).toBeNull();
    expect((await readControl(env.DB)).cleanupPending).toBe(1);
});

it('does not guess the name set of a legacy id-only cleanup checkpoint with no effect record', async () => {
    const f = await cleanupFixture(['CF_SETUP_TOKEN'], 'record-only');
    const lease = await acquireLease(env.DB, f.control.taskId);
    await writeValue(env.DB, lease, 'setup:cleanupEffect', { id: f.effectId });
    await releaseLease(env.DB, lease);
    const outbound = vi.fn(async () => { throw new Error('The lost name set must not be inferred from current Secrets'); });
    vi.stubGlobal('fetch', outbound);
    const response = await f.request('/api/setup/cleanup', { cookie: f.cookie, body: { token: installationToken } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'CLEANUP_INTENT_NAMES_REQUIRED' });
    expect(outbound).not.toHaveBeenCalled();
    expect(await readValue(env.DB, 'setup:cleanupEffect')).toEqual({ id: f.effectId });
});

it('replays an ambiguous cleanup that never reached Cloudflare with the identical null patch', async () => {
    const f = await fixture();
    await env.DB.batch([env.DB.prepare(`UPDATE "lfControl" SET "installation" = 'complete', "cleanupPending" = 1 WHERE "id" = 1`),
        env.DB.prepare(`UPDATE "lfControlSession" SET "purpose" = 'cleanup'`)]);
    const remote = new Set(['CF_SETUP_TOKEN', 'BETTER_AUTH_SECRET']);
    const patches: Record<string, null>[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === 'GET' && request.url.endsWith('/secrets')) return Response.json({ success: true,
            result: [...remote].map((name) => ({ name, type: 'secret_text' })) });
        if (request.method === 'PATCH') {
            const value = await request.json() as { secrets: Record<string, null> };
            patches.push(value.secrets);
            if (patches.length === 1) throw new Error('Connection failed before dispatch reached Cloudflare');
            for (const [name, action] of Object.entries(value.secrets)) { expect(action).toBeNull(); remote.delete(name); }
            return Response.json({ success: true, result: {} });
        }
        throw new Error('Unexpected API call');
    });
    const first = await f.request('/api/setup/cleanup', { cookie: f.cookie, body: { token: installationToken } });
    expect(first.status).toBe(503);
    expect(await readValue(env.DB, 'setup:cleanupEffect')).toMatchObject({ names: ['CF_SETUP_TOKEN'], instanceId: f.control.instanceId });
    const second = await f.request('/api/setup/cleanup', { cookie: f.cookie, body: { token: installationToken } });
    expect(second.status, await second.clone().text()).toBe(200);
    expect(patches).toEqual([{ CF_SETUP_TOKEN: null }, { CF_SETUP_TOKEN: null }]);
    expect(remote.has('BETTER_AUTH_SECRET')).toBe(true);
    expect((await readControl(env.DB)).cleanupPending).toBe(0);
});

it('recovers pending cleanup with a fresh write token before issuing a new nonce challenge, keeping late deletion harmless', async () => {
    const oldName = `LF_CONTROL_CHALLENGE_${'3'.repeat(32)}`;
    const f = await cleanupFixture(['CF_SETUP_TOKEN', oldName]);
    const nonce = randomSetupToken(), oldChallengeId = crypto.randomUUID(), oldProofEffect = crypto.randomUUID();
    const seed = await acquireLease(env.DB, f.control.taskId);
    await writeValue(env.DB, seed, 'setup:challenge', { id: oldChallengeId, name: oldName, taskId: f.control.taskId,
        nonceDigest: await setupDigest(nonce), digest: await setupDigest('old-proof'), used: false, expiresAt: Date.now() + 600_000, effectId: oldProofEffect });
    await writeValue(env.DB, seed, 'setup:challengeNames', [oldName]);
    await env.DB.prepare(`INSERT INTO "lfControlEffect" ("id", "scopeId", "generation", "kind", "payload", "status", "createdAt")
        VALUES (?, ?, ?, 'maintenance-challenge', ?, 'done', ?)`).bind(oldProofEffect, f.control.taskId, seed.generation,
        JSON.stringify({ name: oldName }), Date.now()).run();
    await releaseLease(env.DB, seed);
    const remote = new Set(['CF_SETUP_TOKEN', oldName, 'BETTER_AUTH_SECRET', 'LOGINFLARE_CONFIG_REVISION']);
    const patches: Record<string, null | { text: string }>[] = [];
    let dispatched!: () => void, completeOld!: () => void;
    const firstDispatch = new Promise<void>((resolve) => { dispatched = resolve; });
    const oldCompletion = new Promise<void>((resolve) => { completeOld = resolve; });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith('/tokens/verify')) return Response.json({ success: true, result: { status: 'active' } });
        if (request.url.endsWith('/versions/runtime-one')) return Response.json({ success: true, result: { id: 'runtime-one' } });
        if (request.method === 'GET' && request.url.endsWith('/secrets')) return Response.json({ success: true,
            result: [...remote].map((name) => ({ name, type: 'secret_text' })) });
        if (request.method === 'PATCH') {
            const value = await request.json() as { secrets: Record<string, null | { text: string }> };
            patches.push(value.secrets);
            if (patches.length === 1) { dispatched(); await oldCompletion; }
            for (const [name, action] of Object.entries(value.secrets)) {
                if (action === null) remote.delete(name); else remote.add(name);
            }
            return Response.json({ success: true, result: {} });
        }
        throw new Error('Unexpected API call');
    });
    const oldRequest = f.request('/api/setup/cleanup', { cookie: f.cookie, body: { token: installationToken } });
    await firstDispatch;
    let staleResponse: Response | undefined;
    let newName = '';
    try {
        await env.DB.prepare('UPDATE "lfControl" SET "leaseUntil" = 0 WHERE "id" = 1').run();
        const recovered = await f.request('/api/maintenance/challenge', { body: { token: installationToken, nonce } });
        expect(recovered.status, await recovered.clone().text()).toBe(202);
        expect(recovered.headers.get('set-cookie')).toBeNull();
        expect(await recovered.json()).not.toMatchObject({ challengeId: oldChallengeId });
        expect(patches[1]).toEqual(patches[0]);
        const created = Object.entries(patches[2]!).filter(([, value]) => value !== null);
        expect(created).toHaveLength(1);
        newName = created[0]![0];
        expect(newName).not.toBe(oldName);
        expect(remote.has(newName)).toBe(true);
    } finally { completeOld(); staleResponse = await oldRequest; }
    expect(staleResponse.status).toBe(409);
    expect(remote.has(newName)).toBe(true);
    expect(remote.has('BETTER_AUTH_SECRET')).toBe(true);
    expect(remote.has('LOGINFLARE_CONFIG_REVISION')).toBe(true);
    expect((await readControl(env.DB)).cleanupPending).toBe(1);
});

it('does not grant a read-only token a recovery session when old cleanup names are already absent', async () => {
    const f = await cleanupFixture(['CF_SETUP_TOKEN']);
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM "lfControlSession"').first<number>('n');
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith('/tokens/verify')) return Response.json({ success: true, result: { status: 'active' } });
        if (request.url.endsWith('/versions/runtime-one')) return Response.json({ success: true, result: { id: 'runtime-one' } });
        if (request.method === 'GET' && request.url.endsWith('/secrets')) return Response.json({ success: true, result: [] });
        if (request.method === 'PATCH') {
            const value = await request.json() as { secrets: Record<string, unknown> };
            writes.push(value.secrets);
            return Response.json({ success: false }, { status: 403 });
        }
        throw new Error('Unexpected API call');
    });
    const response = await f.request('/api/maintenance/challenge', { body: { token: 'read-only-user-api-token-with-long-value', nonce: randomSetupToken() } });
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await env.DB.prepare('SELECT "status" FROM "lfControlEffect" WHERE "id" = ?').bind(f.effectId).first('status')).toBe('done');
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0]!)).toHaveLength(1);
    expect(Object.keys(writes[0]!)[0]).toMatch(/^LF_CONTROL_CHALLENGE_/);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "lfControlSession"').first<number>('n')).toBe(sessions);
});

it('configures resources in resumable steps and never regenerates a key after a lost Secrets response', async () => {
    const f = await fixture();
    f.bindings.BETTER_AUTH_SECRET = '';
    f.bindings.TURNSTILE_SECRET_KEY = '';
    await env.DB.prepare('DELETE FROM "lfControlValue" WHERE "key" IN (?, ?)').bind('setup:configuration', 'setup:credentialDigest').run();
    const domains: { hostname: string; service: string; id: string }[] = [];
    const senders: { tag: string; name: string; enabled: boolean }[] = [];
    const widgets: { name: string; sitekey: string; secret: string; domains: string[]; mode: string }[] = [];
    let patches = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init), path = new URL(request.url).pathname;
        const result = (value: unknown) => Response.json({ success: true, result: value });
        if (path.endsWith('/tokens/verify')) return result({ status: 'active' });
        if (path.endsWith(`/zones/${zoneId}`)) return result({ id: zoneId, name: 'example.test', account: { id: accountId }, status: 'active' });
        if (path.endsWith('/workers/domains')) {
            if (request.method === 'PUT') {
                const value = await request.json() as { hostname: string; service: string };
                domains.push({ ...value, id: 'domain-one' });
            }
            return result(request.method === 'GET' ? domains : domains[0]);
        }
        if (path.endsWith('/email/sending/subdomains')) {
            if (request.method === 'POST') senders.push({ tag: 'sending-one', name: 'notify.example.test', enabled: true });
            return result(request.method === 'GET' ? senders : senders[0]);
        }
        if (path.endsWith('/sending-one/dns')) return result([]);
        if (path.endsWith('/challenges/widgets')) {
            if (request.method === 'POST') {
                const value = await request.json() as { name: string; domains: string[]; mode: string };
                widgets.push({ ...value, sitekey: '0x4-official-key', secret: 'official-turnstile-secret' });
            }
            return result(request.method === 'GET' ? widgets : widgets[0]);
        }
        if (path.endsWith('/secrets-bulk')) {
            patches++;
            const value = await request.json() as { secrets: Record<string, { text: string }> };
            Object.assign(f.bindings, Object.fromEntries(Object.entries(value.secrets).map(([key, item]) => [key, item.text])));
            throw new Error('The write committed but the response was lost');
        }
        throw new Error(`Unexpected synthetic API path ${path}`);
    });
    const configure = () => f.request('/api/setup/configure', { cookie: f.cookie, body: {
        authUrl: 'https://login.example.test', emailFrom: 'no-reply@notify.example.test', zoneId, siteZoneId: zoneId,
    } });
    for (let step = 0; step < 3; step++) expect((await configure()).status).toBe(202);
    const lost = await configure();
    expect(lost.status, await lost.clone().text()).toBe(503);
    const firstKey = f.bindings.BETTER_AUTH_SECRET;
    expect(firstKey.length).toBeGreaterThanOrEqual(32);
    expect((await configure()).status).toBe(202);
    expect((await configure()).status).toBe(202);
    expect(f.bindings.BETTER_AUTH_SECRET).toBe(firstKey);
    expect(patches).toBe(1);
    expect(await (await f.request('/api/setup/status', { cookie: f.cookie })).json()).toMatchObject({ configObserved: true,
        authUrl: 'https://login.example.test' });
    const envelope = await readValue<string>(env.DB, 'setup:credentials');
    expect(JSON.parse(await openSetupValue(envelope!, installationToken, f.control.instanceId))).toMatchObject({ authSecret: firstKey });
});

it('preserves an expired unresolved challenge instead of replacing its proof and intent', async () => {
    const f = await fixture();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith('/tokens/verify')) return Response.json({ success: true, result: { status: 'active' } });
        if (request.url.endsWith('/versions/runtime-one')) return Response.json({ success: true, result: { id: 'runtime-one' } });
        throw new Error('Unknown write result');
    });
    expect((await f.request('/api/maintenance/challenge', { body: { token: installationToken, nonce: randomSetupToken() } })).status).toBe(503);
    const prior = await readValue<Record<string, unknown>>(env.DB, 'setup:challengeStaged');
    const lease = await acquireLease(env.DB, f.control.taskId);
    await writeValue(env.DB, lease, 'setup:challengeStaged', { ...prior, expiresAt: 1 });
    await releaseLease(env.DB, lease);
    const retry = await f.request('/api/maintenance/challenge', { body: { token: installationToken, nonce: randomSetupToken() } });
    expect(retry.status).toBe(409);
    expect(await readValue(env.DB, 'setup:challengeStaged')).toMatchObject({ id: prior!.id, nonceDigest: prior!.nonceDigest });
});

it('allows refresh with a new nonce only through a new successful write, preserving the old owner after read-only rejection', async () => {
    const f = await fixture();
    const writes: Record<string, { text: string } | null>[] = [];
    const readOnly = 'read-only-user-token-with-at-least-32-characters';
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith('/tokens/verify')) return Response.json({ success: true, result: { status: 'active' } });
        if (request.url.endsWith('/versions/runtime-one')) return Response.json({ success: true, result: { id: 'runtime-one' } });
        if (request.url.endsWith('/secrets-bulk')) {
            if (request.headers.get('authorization') === `Bearer ${readOnly}`) return Response.json({ success: false }, { status: 403 });
            const value = await request.json() as { secrets: Record<string, { text: string } | null> };
            writes.push(value.secrets);
            for (const [name, secret] of Object.entries(value.secrets)) if (secret === null) Reflect.deleteProperty(f.bindings, name);
            return Response.json({ success: true, result: {} });
        }
        throw new Error('Unexpected synthetic API request');
    });
    const nonce = randomSetupToken();
    const first = await f.request('/api/maintenance/challenge', { body: { token: installationToken, nonce } });
    expect(first.status).toBe(202);
    const original = await first.json() as { challengeId: string };
    const [firstName, firstValue] = Object.entries(writes[0]!)[0]!;
    Object.defineProperty(f.bindings, firstName, { value: firstValue!.text, configurable: true });
    const newNonce = randomSetupToken();
    const denied = await f.request('/api/maintenance/challenge', { body: { token: readOnly, nonce: newNonce } });
    expect(denied.status).toBe(403);
    expect(await readValue(env.DB, 'setup:challenge')).toMatchObject({ id: original.challengeId });
    expect((await f.request('/api/maintenance/verify', { body: { ...original, nonce: newNonce } })).status).toBe(401);
    expect((await f.request('/api/maintenance/verify', { body: { ...original, nonce } })).status).toBe(200);
    const refreshed = await f.request('/api/maintenance/challenge', { body: { token: installationToken, nonce: newNonce } });
    expect(refreshed.status, await refreshed.clone().text()).toBe(202);
    const latest = await refreshed.json() as { challengeId: string };
    expect(latest.challengeId).not.toBe(original.challengeId);
    expect(writes).toHaveLength(2);
    expect(writes[1]![firstName]).toBeNull();
    expect(writes[1]).not.toHaveProperty('CF_SETUP_TOKEN');
    expect(writes[1]).not.toHaveProperty('BETTER_AUTH_SECRET');
    expect((await f.request('/api/maintenance/verify', { body: { ...latest, nonce: newNonce } })).status).toBe(202);
    const [name, value] = Object.entries(writes[1]!).find(([, value]) => value !== null)!;
    Object.defineProperty(f.bindings, name, { value: value!.text, configurable: true });
    expect((await f.request('/api/maintenance/verify', { body: { ...latest, nonce: newNonce } })).status).toBe(200);
});

it('bounds temporary secrets by replacing terminal challenges across repeated page refreshes', async () => {
    const f = await fixture();
    const remote = new Set<string>();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith('/tokens/verify')) return Response.json({ success: true, result: { status: 'active' } });
        if (request.url.endsWith('/versions/runtime-one')) return Response.json({ success: true, result: { id: 'runtime-one' } });
        if (request.url.endsWith('/secrets-bulk')) {
            const value = await request.json() as { secrets: Record<string, { text: string } | null> };
            for (const [name, secret] of Object.entries(value.secrets)) {
                expect(name).toMatch(/^LF_CONTROL_CHALLENGE_[a-f0-9]{32}$/);
                if (secret === null) remote.delete(name); else remote.add(name);
            }
            return Response.json({ success: true, result: {} });
        }
        throw new Error('Unexpected synthetic API request');
    });
    for (let refresh = 0; refresh < 12; refresh++) {
        // Simulate refreshes in distinct rate-limit windows without sleeping.
        await env.DB.prepare('DELETE FROM "lfSetupRate"').run().catch(() => undefined);
        const response = await f.request('/api/maintenance/challenge', { body: { token: installationToken, nonce: randomSetupToken() } });
        expect(response.status, await response.clone().text()).toBe(202);
        expect(remote.size).toBe(1);
        expect(await readValue<string[]>(env.DB, 'setup:challengeNames')).toHaveLength(1);
    }
});

it('rejects another account workers.dev suffix even when the Worker name matches', async () => {
    const f = await fixture();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init), path = new URL(request.url).pathname;
        if (path.endsWith('/tokens/verify')) return Response.json({ success: true, result: { status: 'active' } });
        if (path.endsWith(`/zones/${zoneId}`)) return Response.json({ success: true,
            result: { id: zoneId, name: 'example.test', account: { id: accountId }, status: 'active' } });
        if (path.endsWith(`/accounts/${accountId}/workers/subdomain`)) return Response.json({ success: true, result: { subdomain: 'owned-account' } });
        throw new Error('No writes are permitted for an unowned issuer');
    });
    const response = await f.request('/api/setup/configure', { cookie: f.cookie, body: {
        authUrl: `https://${workerName}.other-account.workers.dev`, emailFrom: 'no-reply@notify.example.test', zoneId,
    } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'WORKERS_SUBDOMAIN_MISMATCH' });
    expect(f.bindings.BETTER_AUTH_SECRET).toBe(env.BETTER_AUTH_SECRET);
});
