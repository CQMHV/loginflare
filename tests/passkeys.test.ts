import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { serializeSigned } from 'hono/utils/cookie';
import { createAuth } from '../src/server/auth';
import worker from '../src/server/index';
import { collectAccountDeletions } from '../src/server/account-deletion';
import { harness, origin, password, session, cookies } from './helpers';
import { authenticator } from './passkey-authenticator';
import { interceptSql } from './sql-race';
import { authenticatorCode } from './totp';
import { accountPasskeys } from '../src/server/passkeys';

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async () => Response.json({ success: true }));
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
async function fixture() {
    const client = harness(); await client.verify(); const cookie = await client.signin(), identity = (await session(client, cookie))!;
    const key = await authenticator();
    return { client, cookie, identity, key };
}
async function options(f: Awaited<ReturnType<typeof fixture>>) {
    const response = await f.client.request('/api/auth/passkey/generate-register-options', { cookie: f.cookie, body: { password } });
    expect(response.status, await response.clone().text()).toBe(200);
    const data = await response.json<{ challenge: string; rp: { id: string }; authenticatorSelection: { userVerification: string } }>();
    expect(data).toHaveProperty('rp');
    expect(cookies(response)).toContain('better-auth-passkey');
    return { data, cookie: f.cookie + '; ' + cookies(response) };
}
async function register(f: Awaited<ReturnType<typeof fixture>>) {
    const p = await options(f), response = await f.key.registration(p.data.challenge);
    const result = await f.client.request('/api/auth/passkey/verify-registration', { cookie: p.cookie, body: { response, name: 'Test key' } });
    expect(result.status, await result.clone().text()).toBe(200);
    return result.json<{ id: string }>();
}
async function login(f: Awaited<ReturnType<typeof fixture>>, changes: { origin?: string; rp?: string; uv?: boolean; expired?: boolean; concurrent?: boolean } = {}) {
    const started = await f.client.request('/api/browser/auth-flows', { cookie: f.cookie, body: { kind: 'login', locale: 'en-US' } });
    const flow = await started.json<{ flowId: string }>(), headers = { 'X-Loginflare-Flow': flow.flowId };
    const generated = await f.client.request('/api/auth/passkey/generate-authenticate-options', { cookie: f.cookie, headers });
    expect(generated.status, await generated.clone().text()).toBe(200);
    const options = await generated.json<{ challenge: string; userVerification: string }>();
    expect(options.userVerification).toBe('required');
    const response = await f.key.assertion(options.challenge, changes.origin, changes.rp, changes.uv);
    if (changes.expired) await env.DB.prepare(`UPDATE verification SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE json_valid(value) AND json_extract(value, '$.expectedChallenge') = ?`).bind(options.challenge).run();
    const cookie = f.cookie + '; ' + cookies(generated);
    const send = () => f.client.request('/api/auth/passkey/verify-authentication', { cookie, headers, body: { response } });
    const [result, duplicate] = changes.concurrent ? await Promise.all([send(), send()]) : [await send()];
    return { result: result!, duplicate, send, cookie, headers };
}
it('uses fixed RP/origin and requires verified authentication and reauthentication for enrollment', async () => {
    const f = await fixture();
    expect((await f.client.request('/api/auth/passkey/generate-register-options', { body: { password } })).status).toBe(401);
    expect((await f.client.request('/api/auth/passkey/generate-register-options', { cookie: f.cookie })).status).toBe(405);
    expect((await f.client.request('/api/auth/passkey/generate-register-options', { cookie: f.cookie, body: { password: 'wrong' } })).ok).toBe(false);
    expect((await f.client.request('/api/auth/passkey/generate-register-options', { cookie: f.cookie, body: { password, context: 'injected' } })).status).toBe(400);
    const p = await options(f); expect(p.data.rp.id).toBe('localhost'); expect(p.data.authenticatorSelection.userVerification).toBe('required');
    expect((await f.client.request('/api/auth/passkey/verify-registration', { cookie: p.cookie, body: { response: {}, createSession: true } })).status).toBe(400);
});
it('registers and authenticates through the native verifier and consumes each challenge once', async () => {
    const f = await fixture(), key = await register(f), attempt = await login(f);
    expect(attempt.result.status, await attempt.result.clone().text()).toBe(200);
    expect((await attempt.result.json<{ user: { id: string } }>()).user.id).toBe(f.identity.user.id);
    expect((await attempt.send()).ok).toBe(false);
    const list = await f.client.request('/api/auth/passkey/list-user-passkeys', { cookie: f.cookie + '; ' + cookies(attempt.result) });
    const text = await list.text(); expect(text).toContain(key.id); expect(text).not.toContain('publicKey'); expect(text).not.toContain('credentialID');
});
it('accepts recent reauthentication on an older still-live session', async () => {
    const f = await fixture();
    await env.DB.prepare('UPDATE session SET createdAt = ? WHERE id = ?').bind(new Date(Date.now() - 2 * 86400_000).toISOString(), f.identity.session.id).run();
    await register(f);
    expect(await env.DB.prepare('SELECT count(*) n FROM passkey').first('n')).toBe(1);
});
it.each([{ origin: 'https://attacker.test' }, { rp: 'attacker.test' }, { uv: false }, { expired: true }])('rejects invalid assertions: %j', async (changes) => {
    const f = await fixture(); await register(f); const attempt = await login(f, changes);
    expect(attempt.result.ok, await attempt.result.clone().text()).toBe(false);
});
it.each(['origin', 'rp', 'verification', 'expired', 'replay'] as const)('rejects invalid enrollment: %s', async (change) => {
    const f = await fixture(), p = await options(f);
    const response = await f.key.registration(p.data.challenge, change === 'origin' ? 'https://attacker.test' : origin, change === 'rp' ? 'attacker.test' : 'localhost', change !== 'verification');
    if (change === 'expired') await env.DB.prepare(`UPDATE verification SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE json_valid(value) AND json_extract(value, '$.expectedChallenge') = ?`).bind(p.data.challenge).run();
    const send = () => f.client.request('/api/auth/passkey/verify-registration', { cookie: p.cookie, body: { response, name: 'Enrollment boundary' } });
    if (change === 'replay') expect((await send()).status).toBe(200);
    expect((await send()).ok).toBe(false);
    expect(await env.DB.prepare('SELECT count(*) n FROM passkey').first('n')).toBe(change === 'replay' ? 1 : 0);
});
it('preserves a usable method when two passwordless passkeys are deleted concurrently', async () => {
    const f = await fixture(), first = await register(f); f.key = await authenticator(); const second = await register(f);
    await env.DB.prepare('DELETE FROM account WHERE userId = ?').bind(f.identity.user.id).run();
    const context = await createAuth(f.client.bindings).$context;
    const attempts = await Promise.all([first.id, second.id].map(async (id) => {
        const proof = crypto.randomUUID();
        await env.DB.prepare('INSERT INTO securityProof (id,userId,sessionId,purpose,expiresAt) VALUES (?,?,?,?,?)').bind(proof, f.identity.user.id, f.identity.session.id, 'passkeys/delete', Date.now() + 60_000).run();
        const signed = await serializeSigned(context.createAuthCookie('security_proof').name, proof, env.BETTER_AUTH_SECRET);
        return f.client.request('/api/auth/passkey/delete-passkey', { cookie: f.cookie + '; ' + signed.split(';')[0], body: { id } });
    }));
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(await env.DB.prepare('SELECT count(*) n FROM passkey').first('n')).toBe(1);
});
it('binds enrollment to the exact account and session and checks password changes at insertion', async () => {
    const f = await fixture(), p = await options(f), response = await f.key.registration(p.data.challenge);
    const otherSession = await f.client.signin();
    expect((await f.client.request('/api/auth/passkey/verify-registration', { cookie: otherSession + '; ' + cookies(new Response(null, { headers: { 'set-cookie': p.cookie.split('; ').at(-1)! } })), body: { response, name: 'wrong session' } })).ok).toBe(false);
    f.cookie = otherSession; f.identity = (await session(f.client, otherSession))!;
    const next = await options(f), valid = await f.key.registration(next.data.challenge);
    const race = interceptSql(env.DB, /insert into ["`]passkey["`]/i, async () => { await env.DB.prepare('UPDATE account SET password = ? WHERE userId = ?').bind('changed', f.identity.user.id).run(); });
    const result = await worker.fetch(new Request(origin + '/api/auth/passkey/verify-registration', { method: 'POST', headers: { Cookie: next.cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ response: valid, name: 'Raced key' }) }), { ...f.client.bindings, DB: race.proxy }, createExecutionContext());
    expect(race.invoked()).toBe(true); expect(result.ok).toBe(false); expect(await env.DB.prepare('SELECT count(*) n FROM passkey').first('n')).toBe(0);
});
it('requires ownership and current security authorization to rename/delete and prevents the last login method disappearing', async () => {
    const f = await fixture(), key = await register(f);
    await f.client.verify('other@example.test'); const other = await f.client.signin('other@example.test');
    for (const path of ['update-passkey', 'delete-passkey']) expect((await f.client.request('/api/auth/passkey/' + path, { cookie: other, body: { id: key.id, password, ...(path === 'update-passkey' ? { name: 'Stolen' } : {}) } })).ok).toBe(false);
    expect((await f.client.request('/api/auth/passkey/update-passkey', { cookie: f.cookie, body: { id: key.id, name: 'Renamed', password } })).status).toBe(200);
    await env.DB.prepare('DELETE FROM account WHERE userId = ?').bind(f.identity.user.id).run();
    const proof = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO securityProof (id,userId,sessionId,purpose,expiresAt) VALUES (?,?,?,?,?)').bind(proof, f.identity.user.id, f.identity.session.id, 'passkeys/delete', Date.now() + 60_000).run();
    const context = await createAuth(f.client.bindings).$context;
    const signed = await serializeSigned(context.createAuthCookie('security_proof').name, proof, env.BETTER_AUTH_SECRET);
    expect((await f.client.request('/api/auth/passkey/delete-passkey', { cookie: f.cookie + '; ' + signed.split(';')[0], body: { id: key.id } })).ok).toBe(false);
    expect(await env.DB.prepare('SELECT count(*) n FROM passkey').first('n')).toBe(1);
});
it('requires TOTP after passkey login and rejects unavailable accounts', async () => {
    const f = await fixture(); await register(f);
    const enable = await f.client.request('/api/auth/two-factor/enable', { cookie: f.cookie, body: { password } });
    expect(enable.status, await enable.clone().text()).toBe(200);
    const setup = await enable.json<{ totpURI: string }>();
    const enabled = await f.client.request('/api/auth/two-factor/verify-totp', { cookie: f.cookie + '; ' + cookies(enable), body: { code: await authenticatorCode(setup.totpURI) } });
    expect(enabled.status).toBe(200); f.cookie += '; ' + cookies(enabled);
    const attempt = await login(f); expect(await attempt.result.json()).toMatchObject({ twoFactorRedirect: true });
    const done = await f.client.request('/api/auth/two-factor/verify-totp', { cookie: attempt.cookie + '; ' + cookies(attempt.result), headers: attempt.headers, body: { code: await authenticatorCode(setup.totpURI) } });
    expect(done.status, await done.clone().text()).toBe(200);
    await env.DB.prepare('UPDATE user SET banned = 1 WHERE id = ?').bind(f.identity.user.id).run();
    expect((await login(f)).result.ok).toBe(false);
});
it('allows only one concurrent use of an authentication challenge', async () => {
    const f = await fixture(); await register(f);
    const attempt = await login(f, { concurrent: true });
    expect([attempt.result.status, attempt.duplicate!.status].sort()).toEqual([200, 400]);
});
it.each(['banned', 'emailVerified', 'deletionRequestedAt'] as const)('rejects passkey sign-in for an unavailable account: %s', async (column) => {
    const f = await fixture(); await register(f);
    await env.DB.prepare(`UPDATE "user" SET "${column}" = ? WHERE "id" = ?`).bind(column === 'emailVerified' ? 0 : column === 'banned' ? 1 : Date.now(), f.identity.user.id).run();
    expect((await login(f)).result.ok).toBe(false);
});
it('refuses a session if its passkey is deleted at the final insertion boundary', async () => {
    const f = await fixture(), key = await register(f);
    const race = interceptSql(env.DB, /insert into ["`]session["`]/i, async () => { await env.DB.prepare('DELETE FROM passkey WHERE id = ?').bind(key.id).run(); });
    f.client.bindings.DB = race.proxy;
    expect((await login(f)).result.ok).toBe(false); expect(race.invoked()).toBe(true);
    expect(await env.DB.prepare('SELECT count(*) n FROM session WHERE userId = ?').bind(f.identity.user.id).first('n')).toBe(1);
});
it('rejects registration against another account even with a copied challenge cookie', async () => {
    const f = await fixture(), p = await options(f);
    await f.client.verify('other@example.test'); const other = await f.client.signin('other@example.test');
    const result = await f.client.request('/api/auth/passkey/verify-registration', { cookie: other + '; ' + p.cookie.split('; ').at(-1), body: { response: await f.key.registration(p.data.challenge), name: 'Wrong account' } });
    expect(result.ok).toBe(false); expect(await env.DB.prepare('SELECT count(*) n FROM passkey').first('n')).toBe(0);
});
it('checks the pinned upstream endpoint, schema and ceremony contract before dependency upgrades', async () => {
    const plugin = accountPasskeys(harness().bindings, 'Loginflare');
    expect(plugin.version).toBe('1.7.13');
    expect(plugin.endpoints!.verifyPasskeyRegistration.path).toBe('/passkey/verify-registration');
    expect(plugin.endpoints!.verifyPasskeyAuthentication.path).toBe('/passkey/verify-authentication');
    expect(plugin.schema!.passkey.fields.credentialID.required).toBe(true);
    expect(plugin.schema!.passkey.fields.userId.references).toEqual({ model: 'user', field: 'id' });
});
it('cleans credentials and enrollment challenges through resumable account deletion', async () => {
    const f = await fixture(); await register(f); await options(f);
    const preview = await (await f.client.request('/api/account/deletion-preview', { cookie: f.cookie })).json<{ preview: string }>();
    expect((await f.client.request('/api/account/delete', { cookie: f.cookie, body: { preview: preview.preview, password } })).status).toBe(202);
    let batches = 0;
    await collectAccountDeletions(env, { available: () => batches < 60, used: (n) => { batches += n; } }, Date.now() + 3000);
    expect(await env.DB.prepare('SELECT count(*) n FROM passkey').first('n')).toBe(0);
    expect(await env.DB.prepare(`SELECT count(*) n FROM verification WHERE json_valid(value) AND json_extract(value, '$.userData.id') = ?`).bind(f.identity.user.id).first('n')).toBe(0);
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
