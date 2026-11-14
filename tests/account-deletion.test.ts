import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { serializeSigned } from 'hono/utils/cookie';
import worker from '../src/server/index';
import { createAuth } from '../src/server/auth';
import { collectAccountDeletions } from '../src/server/account-deletion';
import { maintainDatabase } from '../src/server/maintenance';
import { activeApiToken } from '../src/server/api-access-policy';
import { harness, origin, password, session, cookies } from './helpers';
import { authenticatorCode } from './totp';
import { interceptSql } from './sql-race';
import { clientRegistration } from '../src/server/client-registration';

const settings = { name: 'Owned application', type: 'web' as const, redirectUris: ['https://client.example.test/callback'], postLogoutRedirectUris: ['https://client.example.test/'], scopes: ['openid', 'profile', 'email', 'offline_access'] };
beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        if (new Request(input).url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected external request');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
async function fixture() {
    const client = harness(); await client.verify();
    const cookie = await client.signin(), identity = (await session(client, cookie))!;
    return { client, cookie, identity };
}
async function application(f: Awaited<ReturnType<typeof fixture>>) {
    const response = await f.client.request('/api/developer/applications', { cookie: f.cookie, body: settings });
    expect(response.status, await response.clone().text()).toBe(201);
    return response.json<{ application: { clientId: string }; clientSecret: string }>();
}
async function preview(f: Awaited<ReturnType<typeof fixture>>) {
    const response = await f.client.request('/api/account/deletion-preview', { cookie: f.cookie });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json<{ preview: string; applications: { clientId: string; name: string }[] }>();
}
async function request(f: Awaited<ReturnType<typeof fixture>>, token: string) {
    return f.client.request('/api/account/delete', { cookie: f.cookie, body: { preview: token, password } });
}
async function collect(limit = 80) {
    let batches = 0;
    await collectAccountDeletions(env, { available: () => batches < limit, used: (n) => { batches += n; } }, Date.now() + 3000);
    return batches;
}
it('requires the current ordinary account, exact origin and fresh authenticated preview', async () => {
    const f = await fixture();
    expect((await f.client.request('/api/account/deletion-preview')).status).toBe(401);
    expect((await f.client.request('/api/account/delete', { headers: { Authorization: 'Bearer machine-token' }, body: { preview: 'unknown' } })).status).toBe(401);
    expect((await f.client.request('/api/auth/account/delete', { cookie: f.cookie, body: {} })).status).toBe(404);
    const p = await preview(f);
    expect((await f.client.request('/api/account/delete', { cookie: f.cookie, body: { preview: p.preview, password: 'wrong' } })).status).toBe(400);
    expect((await f.client.request('/api/account/delete', { cookie: f.cookie, body: { preview: p.preview, password, userId: f.identity.user.id } })).ok).toBe(false);
    expect((await f.client.request('/api/account/delete', { cookie: f.cookie, body: { preview: p.preview, password }, headers: { Origin: 'https://attacker.test' } })).status).toBe(403);
    const other = await f.client.administrator();
    expect((await f.client.request('/api/account/deletion-preview', { cookie: other })).status).toBe(403);
    expect((await f.client.request('/api/account/delete', { cookie: other, body: { preview: p.preview, password } })).status).toBe(403);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM accountDeletion').first('n')).toBe(0);
});
it('freezes the user and owned applications atomically and completes without deleting another account', async () => {
    const f = await fixture(), app = await application(f), p = await preview(f);
    expect(p.applications).toEqual([{ clientId: app.application.clientId, name: settings.name }]);
    await f.client.verify('other@example.test');
    const otherCookie = await f.client.signin('other@example.test'), other = (await session(f.client, otherCookie))!;
    const response = await request(f, p.preview);
    expect(response.status, await response.clone().text()).toBe(202);
    const result = await response.json<{ operationId: string }>();
    expect(await env.DB.prepare('SELECT banned FROM user WHERE id = ?').bind(f.identity.user.id).first('banned')).toBe(1);
    expect(await env.DB.prepare('SELECT disabled FROM oauthClient WHERE clientId = ?').bind(app.application.clientId).first('disabled')).toBe(1);
    expect((await f.client.request('/api/auth/get-session', { cookie: f.cookie })).status).toBe(403);
    await expect(env.DB.prepare('UPDATE user SET banned = 0 WHERE id = ?').bind(f.identity.user.id).run()).rejects.toThrow();
    expect((await request(f, p.preview)).status).toBe(403);
    await collect();
    expect(await env.DB.prepare('SELECT id FROM user WHERE id = ?').bind(f.identity.user.id).first()).toBeNull();
    expect((await env.DB.prepare("SELECT type, data FROM businessEvent WHERE subjectId = ? AND type IN ('user.deleted','user.suspended')").bind(f.identity.user.id).all()).results).toEqual([{ type: 'user.deleted', data: '{}' }]);
    expect(await env.DB.prepare('SELECT clientId FROM oauthClient WHERE clientId = ?').bind(app.application.clientId).first()).toBeNull();
    expect((await session(f.client, otherCookie))!.user.id).toBe(other.user.id);
    expect(await env.DB.prepare('SELECT status FROM accountDeletion WHERE id = ?').bind(result.operationId).first('status')).toBe('complete');
    expect((await env.DB.prepare('SELECT event FROM auditLog WHERE targetId = ? ORDER BY event').bind(result.operationId).all()).results).toEqual([{ event: 'account.deleted' }, { event: 'account.deletion_requested' }]);
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await collect()).toBe(0);
});
it.each(['applications', 'password', 'mfa'] as const)('rechecks %s at the final transaction boundary', async (change) => {
    const f = await fixture(); await application(f); const p = await preview(f);
    const race = interceptSql(env.DB, /INSERT INTO "accountDeletion"/, async () => {
        if (change === 'applications') await application(f);
        else if (change === 'password') await env.DB.prepare('UPDATE account SET password = ? WHERE userId = ?').bind('changed-hash', f.identity.user.id).run();
        else await env.DB.prepare('UPDATE user SET twoFactorEnabled = 1 WHERE id = ?').bind(f.identity.user.id).run();
    });
    const response = await worker.fetch(new Request(origin + '/api/account/delete', { method: 'POST', headers: { Cookie: f.cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ preview: p.preview, password }) }), { ...f.client.bindings, DB: race.proxy }, createExecutionContext());
    expect(race.invoked()).toBe(true);
    expect(response.status).toBe(409);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM accountDeletion').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT banned FROM user WHERE id = ?').bind(f.identity.user.id).first('banned')).toBeFalsy();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM oauthClient WHERE disabled = 1').first('n')).toBe(0);
});
it('binds previews to the exact user and session and rejects expired receipts', async () => {
    const f = await fixture(), p = await preview(f);
    const second = await f.client.signin();
    expect((await f.client.request('/api/account/delete', { cookie: second, body: { preview: p.preview, password } })).status).toBe(400);
    await f.client.verify('foreign@example.test'); const foreign = await f.client.signin('foreign@example.test');
    expect((await f.client.request('/api/account/delete', { cookie: foreign, body: { preview: p.preview, password } })).status).toBe(400);
    const { SignJWT } = await import('jose');
    const expired = await new SignJWT({ purpose: 'account/delete', applications: '[]', sessionId: f.identity.session.id })
        .setProtectedHeader({ alg: 'HS256' }).setIssuer(origin).setAudience('account/delete').setSubject(f.identity.user.id).setIssuedAt().setExpirationTime(1).sign(new TextEncoder().encode(env.BETTER_AUTH_SECRET));
    expect((await request(f, expired)).status).toBe(400);
});
it('requires the enabled TOTP in addition to the current password', async () => {
    const f = await fixture();
    const started = await f.client.request('/api/auth/two-factor/enable', { cookie: f.cookie, body: { password } });
    const enrollment = await started.json<{ totpURI: string }>();
    const verified = await f.client.request('/api/auth/two-factor/verify-totp', { cookie: f.cookie, body: { code: await authenticatorCode(enrollment.totpURI) } });
    f.cookie = cookies(verified); f.identity = (await session(f.client, f.cookie))!;
    const p = await preview(f);
    expect((await request(f, p.preview)).status).toBe(400);
    const wrong = String((Number(await authenticatorCode(enrollment.totpURI)) + 1) % 1000000).padStart(6, '0');
    expect((await f.client.request('/api/account/delete', { cookie: f.cookie, body: { preview: p.preview, password, code: wrong } })).ok).toBe(false);
    const response = await f.client.request('/api/account/delete', { cookie: f.cookie, body: { preview: p.preview, password, code: await authenticatorCode(enrollment.totpURI) } });
    expect(response.status, await response.clone().text()).toBe(202);
    expect(Object.keys(await response.json()).sort()).toEqual(['operationId', 'status']);
});
it('requires a single-use, purpose-bound proof for passwordless accounts', async () => {
    const f = await fixture();
    await env.DB.prepare('DELETE FROM account WHERE userId = ?').bind(f.identity.user.id).run();
    const p = await preview(f), id = crypto.randomUUID();
    const context = await createAuth(f.client.bindings).$context;
    const proofCookie = (await serializeSigned(context.createAuthCookie('security_proof').name, id, env.BETTER_AUTH_SECRET)).split(';')[0];
    await env.DB.prepare('INSERT INTO securityProof (id, userId, sessionId, purpose, expiresAt) VALUES (?, ?, ?, ?, ?)').bind(id, f.identity.user.id, f.identity.session.id, 'unlink', Date.now() + 300000).run();
    expect((await f.client.request('/api/account/delete', { cookie: f.cookie + '; ' + proofCookie, body: { preview: p.preview } })).status).toBe(400);
    await env.DB.prepare('UPDATE securityProof SET purpose = ?, expiresAt = 0 WHERE id = ?').bind('account/delete', id).run();
    expect((await f.client.request('/api/account/delete', { cookie: f.cookie + '; ' + proofCookie, body: { preview: p.preview } })).status).toBe(400);
    await env.DB.prepare('UPDATE securityProof SET expiresAt = ? WHERE id = ?').bind(Date.now() + 300000, id).run();
    await env.DB.prepare('UPDATE securityProof SET purpose = ? WHERE id = ?').bind('account/delete', id).run();
    expect((await f.client.request('/api/account/delete', { cookie: f.cookie + '; ' + proofCookie, body: { preview: p.preview } })).status).toBe(202);
    expect(await env.DB.prepare('SELECT used FROM securityProof WHERE id = ?').bind(id).first('used')).toBe(1);
});
it('accepts only one concurrent request and retains one durable audit receipt', async () => {
    const f = await fixture(), p = await preview(f);
    const responses = await Promise.all([request(f, p.preview), request(f, p.preview)]);
    expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM accountDeletion').first('n')).toBe(1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM auditLog WHERE event = 'account.deletion_requested'").first('n')).toBe(1);
});
it('resumes bounded cleanup after failure and preserves media deletion retries', async () => {
    const f = await fixture(), app = await application(f), p = await preview(f);
    await env.AVATARS.put('deletion-image', 'fixture');
    await env.DB.prepare('INSERT INTO userAvatar (id, userId, url, createdAt) VALUES (?, ?, ?, ?)').bind('deletion-image', f.identity.user.id, origin + '/avatars/deletion-image', Date.now()).run();
    expect((await request(f, p.preview)).status).toBe(202);
    expect(await collect(1)).toBe(1);
    const race = interceptSql(env.DB, /DELETE FROM "oauthRefreshToken"/, async () => { throw new Error('Injected storage failure'); });
    await expect(collectAccountDeletions({ DB: race.proxy }, { available: () => true, used: () => {} }, Date.now() + 3000)).rejects.toThrow('Injected');
    expect(await env.DB.prepare('SELECT leaseUntil FROM accountDeletion').first('leaseUntil')).toBe(0);
    await collect();
    expect(await env.DB.prepare('SELECT id FROM user WHERE id = ?').bind(f.identity.user.id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT userId FROM userAvatar WHERE id = ?').bind('deletion-image').first('userId')).toBeNull();
    const remove = vi.spyOn(env.AVATARS, 'delete').mockRejectedValueOnce(new Error('R2 unavailable'));
    await expect(maintainDatabase(env, Date.now() + 900000)).rejects.toThrow('R2 unavailable'); remove.mockRestore();
    expect(await env.DB.prepare('SELECT id FROM userAvatar WHERE id = ?').bind('deletion-image').first()).not.toBeNull();
    await maintainDatabase(env, Date.now() + 900000);
    expect(await env.AVATARS.head('deletion-image')).toBeNull();
    expect(await env.DB.prepare('SELECT clientId FROM oauthClient WHERE clientId = ?').bind(app.application.clientId).first()).toBeNull();
});
it('disables online identity introspection for a deleting user and application', async () => {
    const f = await fixture(), app = await application(f), p = await preview(f);
    const token = { sub: f.identity.user.id, client_id: app.application.clientId, aud: `${origin}/api/auth/oauth2/userinfo` };
    expect(await activeApiToken(f.client.bindings, token)).toBe(true);
    expect((await request(f, p.preview)).status).toBe(202);
    expect(await activeApiToken(f.client.bindings, token)).toBe(false);
});

it('limits each cleanup mutation even when hundreds of credentials remain', async () => {
    const f = await fixture(), app = await application(f), p = await preview(f), expires = new Date(Date.now() + 3600000).toISOString();
    await env.DB.prepare('INSERT INTO oauthGrantPolicy (authorizationCodeId, userId, clientId, originalSessionId, gcAfter, activatedAt) VALUES (?, ?, ?, ?, ?, ?)')
        .bind('many-grants', f.identity.user.id, app.application.clientId, f.identity.session.id, expires, new Date().toISOString()).run();
    await env.DB.prepare(`INSERT INTO oauthAccessToken (id, token, clientId, userId, sessionId, authorizationCodeId, expiresAt, createdAt, scopes)
        WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 600)
        SELECT 'id-' || x, 'token-' || x, ?, ?, ?, 'many-grants', ?, ?, '["openid"]' FROM n`)
        .bind(app.application.clientId, f.identity.user.id, f.identity.session.id, expires, new Date().toISOString()).run();
    expect((await request(f, p.preview)).status).toBe(202);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM oauthAccessToken WHERE revoked IS NULL').first('n')).toBe(600);
    await collect(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM oauthAccessToken').first('n')).toBe(500);
    await collect();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM oauthAccessToken').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT status FROM accountDeletion').first('status')).toBe('complete');
});

async function authorization(f: Awaited<ReturnType<typeof fixture>>, clientId: string, cookie: string) {
    const auth = createAuth(f.client.bindings), verifier = 'deletion-pkce-verifier-with-more-than-forty-three-characters';
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: settings.redirectUris[0], response_type: 'code', scope: 'openid profile email offline_access', code_challenge: challenge, code_challenge_method: 'S256', state: crypto.randomUUID(), nonce: crypto.randomUUID() });
    const response = await auth.handler(new Request(origin + '/api/auth/oauth2/authorize?' + query, { headers: { Cookie: cookie } }));
    expect(response.status, await response.clone().text()).toBe(302);
    let url = new URL(response.headers.get('location')!, origin);
    if (url.pathname === '/en-us/consent') {
        const accepted = await auth.handler(new Request(origin + '/api/auth/oauth2/consent', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ accept: true, oauth_query: url.search.slice(1) }) }));
        expect(accepted.status, await accepted.clone().text()).toBe(200);
        url = new URL((await accepted.json<{ url: string }>()).url);
    }
    return { code: url.searchParams.get('code')!, verifier };
}
it('rejects other users’ old tokens and pending codes for an owned application after acceptance', async () => {
    const f = await fixture(), app = await application(f), p = await preview(f);
    await f.client.verify('consumer@example.test'); const consumer = await f.client.signin('consumer@example.test');
    const basic = 'Basic ' + btoa(encodeURIComponent(app.application.clientId) + ':' + encodeURIComponent(app.clientSecret));
    const auth = createAuth(f.client.bindings);
    const token = (body: Record<string, string>) => auth.handler(new Request(origin + '/api/auth/oauth2/token', { method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }));
    const first = await authorization(f, app.application.clientId, consumer);
    const issued = await token({ grant_type: 'authorization_code', code: first.code, code_verifier: first.verifier, redirect_uri: settings.redirectUris[0] });
    expect(issued.status, await issued.clone().text()).toBe(200);
    const tokens = await issued.json<{ access_token: string; refresh_token: string }>();
    expect((await f.client.request('/api/auth/oauth2/userinfo', { headers: { Authorization: 'Bearer ' + tokens.access_token } })).status).toBe(200);
    const pending = await authorization(f, app.application.clientId, consumer);
    expect((await request(f, p.preview)).status).toBe(202);
    expect((await f.client.request('/api/auth/oauth2/userinfo', { headers: { Authorization: 'Bearer ' + tokens.access_token } })).ok).toBe(false);
    expect((await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).ok).toBe(false);
    expect((await token({ grant_type: 'authorization_code', code: pending.code, code_verifier: pending.verifier, redirect_uri: settings.redirectUris[0] })).ok).toBe(false);
    expect((await session(f.client, consumer))!.user.email).toBe('consumer@example.test');
    await collect();
    expect((await session(f.client, consumer))!.user.email).toBe('consumer@example.test');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM verification WHERE identifier = ?').bind((await env.DB.prepare('SELECT authorizationCodeId FROM oauthGrantPolicy LIMIT 1').first<string>('authorizationCodeId')) ?? 'absent').first('n')).toBe(0);
});

it('blocks an in-flight refresh successor after its application owner is frozen', async () => {
    const f = await fixture(), app = await application(f), p = await preview(f);
    await f.client.verify('consumer@example.test'); const consumer = await f.client.signin('consumer@example.test');
    const basic = 'Basic ' + btoa(encodeURIComponent(app.application.clientId) + ':' + encodeURIComponent(app.clientSecret));
    const pending = await authorization(f, app.application.clientId, consumer);
    const form = { grant_type: 'authorization_code', code: pending.code, code_verifier: pending.verifier, redirect_uri: settings.redirectUris[0] };
    const issued = await createAuth(f.client.bindings).handler(new Request(origin + '/api/auth/oauth2/token', { method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) }));
    expect(issued.status, await issued.clone().text()).toBe(200);
    const tokens = await issued.json<{ refresh_token: string }>();
    const race = interceptSql(env.DB, /insert into ["`]?oauthRefreshToken/i, async () => { expect((await request(f, p.preview)).status).toBe(202); });
    const response = await createAuth({ ...f.client.bindings, DB: race.proxy }).handler(new Request(origin + '/api/auth/oauth2/token', { method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }) }));
    expect(race.invoked()).toBe(true);
    expect(response.ok).toBe(false);
    await collect();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM oauthRefreshToken').first('n')).toBe(0);
});
it('protects legacy instance references and preserves independent machine identities', async () => {
    const f = await fixture();
    const legacy = await clientRegistration(f.client.bindings, settings);
    await legacy.statement.run();
    await env.DB.prepare('UPDATE oauthClient SET userId = ? WHERE clientId = ?').bind(f.identity.user.id, legacy.clientId).run();
    expect((await f.client.request('/api/account/deletion-preview', { cookie: f.cookie })).status).toBe(409);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM accountDeletion').first('n')).toBe(0);
    await env.DB.prepare('UPDATE oauthClient SET userId = NULL WHERE clientId = ?').bind(legacy.clientId).run();
    const machine = await clientRegistration(f.client.bindings, { name: 'Independent machine', type: 'machine', scopes: [] });
    await machine.statement.run();
    await env.DB.prepare('INSERT INTO machineApp (clientId) VALUES (?)').bind(machine.clientId).run();
    const p = await preview(f); expect(p.applications).toEqual([]);
    expect((await request(f, p.preview)).status).toBe(202); await collect();
    expect(await env.DB.prepare('SELECT clientId FROM machineApp WHERE clientId = ?').bind(machine.clientId).first('clientId')).toBe(machine.clientId);
    expect(await env.DB.prepare('SELECT clientId FROM oauthClient WHERE clientId = ?').bind(legacy.clientId).first('clientId')).toBe(legacy.clientId);
});
it('does not release addresses within the same issued-at second, and rejects older email links for later accounts', async () => {
    const f = await fixture(), p = await preview(f);
    expect((await request(f, p.preview)).status).toBe(202);
    const requestedAt = (await env.DB.prepare('SELECT requestedAt FROM accountDeletion').first<number>('requestedAt'))!;
    let batches = 0;
    await collectAccountDeletions(env, { available: () => batches < 80, used: (n) => { batches += n; } }, requestedAt);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM userEmail WHERE userId = ?').bind(f.identity.user.id).first('n')).toBe(1);
    await collect();
    await f.client.signup();
    const { SignJWT } = await import('jose');
    const old = await new SignJWT({ email: 'person@example.test' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt(Math.floor(Date.now() / 1000) - 60).setExpirationTime('1h').sign(new TextEncoder().encode(env.BETTER_AUTH_SECRET));
    const response = await f.client.request('/api/auth/verify-email?token=' + encodeURIComponent(old));
    expect(response.ok).toBe(false);
    expect(await env.DB.prepare('SELECT emailVerified FROM user WHERE email = ?').bind('person@example.test').first('emailVerified')).toBe(0);
});
it('resumes an expired lease without replaying completion or losing the job', async () => {
    const f = await fixture(), p = await preview(f);
    expect((await request(f, p.preview)).status).toBe(202);
    await env.DB.prepare('UPDATE accountDeletion SET lease = ?, leaseUntil = ?').bind('crashed-worker', Date.now() + 60000).run();
    expect(await collect()).toBe(0);
    await env.DB.prepare('UPDATE accountDeletion SET leaseUntil = 0').run();
    await collect(); await collect();
    expect(await env.DB.prepare('SELECT status FROM accountDeletion').first('status')).toBe('complete');
    expect(await env.DB.prepare("SELECT count(*) AS n FROM auditLog WHERE event = 'account.deleted'").first('n')).toBe(1);
});
it('cleans resource links and user assignments without deleting instance roles, resources or permissions', async () => {
    const f = await fixture(), app = await application(f), admin = await f.client.administrator();
    const resourceResponse = await f.client.request('/api/admin/access/resources', { cookie: admin, body: { name: 'Shared API', identifier: 'https://shared-api.example.test' } });
    expect(resourceResponse.status, await resourceResponse.clone().text()).toBe(201);
    const resource = await resourceResponse.json<{ id: string }>();
    const permissionResponse = await f.client.request(`/api/admin/access/resources/${resource.id}/permissions`, { cookie: admin, body: { name: 'Read', scope: 'shared:read' } });
    expect(permissionResponse.status, await permissionResponse.clone().text()).toBe(201);
    const permission = await permissionResponse.json<{ id: string }>();
    const roleResponse = await f.client.request('/api/admin/access/roles', { cookie: admin, body: { name: 'Shared reader', permissionIds: [permission.id] } });
    expect(roleResponse.status).toBe(201); const role = await roleResponse.json<{ id: string }>();
    expect((await f.client.request(`/api/admin/access/users/${f.identity.user.id}/roles`, { cookie: admin, method: 'PUT', body: { roleIds: [role.id] } })).status).toBe(200);
    expect((await f.client.request(`/api/admin/access/resources/${resource.id}/applications`, { cookie: admin, body: { clientId: app.application.clientId } })).status).toBe(201);
    const p = await preview(f); expect((await request(f, p.preview)).status).toBe(202);
    expect((await f.client.request('/api/auth/admin/unban-user', { cookie: admin, body: { userId: f.identity.user.id } })).status).toBe(409);
    await collect();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM oauthClientResource WHERE clientId = ?').bind(app.application.clientId).first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM apiUserRole WHERE userId = ?').bind(f.identity.user.id).first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT id FROM apiRole WHERE id = ?').bind(role.id).first('id')).toBe(role.id);
    expect(await env.DB.prepare('SELECT id FROM apiPermission WHERE id = ?').bind(permission.id).first('id')).toBe(permission.id);
    expect(await env.DB.prepare('SELECT id FROM oauthResource WHERE id = ?').bind(resource.id).first('id')).toBe(resource.id);
});
