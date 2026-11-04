import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { auditRetention, auditStatement, writeAudit } from '../src/server/audit';
import { maintainDatabase } from '../src/server/maintenance';
import { cookies, harness, mailUrl, origin, password, session } from './helpers';
import { authenticatorCode } from './totp';
import app from '../src/server/index';
import { createAuth } from '../src/server/auth';

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected network');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

async function rows(event?: string) {
    return (await env.DB.prepare(`SELECT * FROM "auditLog" ${event ? 'WHERE "event" = ?' : ''} ORDER BY "createdAt", "id"`)
        .bind(...(event ? [event] : [])).all<{ id: string; event: string; actorUserId: string | null; targetUserId: string | null; targetId: string | null;
            requestId: string; outcome: string; reason: string | null; createdAt: string; expiresAt: number }>()).results;
}

it('keeps append records independent of user deletion and collects them only after retention plus the safety buffer', async () => {
    const client = harness(); await client.verify();
    const user = await env.DB.prepare('SELECT "id" FROM "user" LIMIT 1').first<string>('id');
    await writeAudit(env, { event: 'user.tested', outcome: 'success', actorUserId: user, targetUserId: user });
    const recorded = (await rows('user.tested'))[0]!;
    expect(recorded.expiresAt - Date.parse(recorded.createdAt)).toBe(auditRetention);
    await env.DB.prepare('DELETE FROM "user" WHERE "id" = ?').bind(user).run();
    expect((await rows('user.tested'))[0]).toMatchObject({ actorUserId: user, targetUserId: user });
    const now = Date.now();
    await env.DB.prepare('UPDATE "auditLog" SET "expiresAt" = ? WHERE "id" = ?').bind(now - 60_000, recorded.id).run();
    await maintainDatabase(env, now);
    expect((await rows('user.tested'))).toHaveLength(1);
    await env.DB.prepare('UPDATE "auditLog" SET "expiresAt" = ? WHERE "id" = ?').bind(now - 600_000, recorded.id).run();
    const result = await maintainDatabase(env, now);
    expect(result.deleted.auditLog).toBe(1);
    expect(await rows('user.tested')).toHaveLength(0);
});

it('persists only the audit schema and rolls back an audit append with its failed business transaction', async () => {
    const headers = new Headers({ 'CF-Connecting-IP': '192.0.2.40', 'User-Agent': 'Isolated audit client', 'Cookie': 'secret-session-cookie', Authorization: 'Bearer secret-token' });
    await writeAudit(env, { event: 'resource.created', outcome: 'success', actorUserId: 'owner', targetType: 'resource', targetId: 'stable-resource', reason: null }, headers);
    const stored = await env.DB.prepare('SELECT * FROM "auditLog" LIMIT 1').first();
    expect(stored).toMatchObject({ event: 'resource.created', actorUserId: 'owner', ipAddress: '192.0.2.40', userAgent: 'Isolated audit client' });
    expect(JSON.stringify(stored)).not.toMatch(/secret-session-cookie|secret-token|Cookie|Authorization/);
    await expect(env.DB.batch([
        auditStatement(env, { event: 'resource.rollback', outcome: 'success' }),
        env.DB.prepare('INSERT INTO "auditLog" ("id") VALUES (?)').bind('violates-required-fields'),
    ])).rejects.toThrow();
    expect(await rows('resource.rollback')).toHaveLength(0);
});

it('records successful and failed password sign-in without credentials, mail links, or caller-provided request IDs', async () => {
    const client = harness(); await client.verify();
    const response = await client.request('/api/auth/sign-in/email', {
        headers: { 'X-Loginflare-Request-ID': 'forged-request-id' }, body: { email: 'person@example.test', password },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const identity = (await session(client, cookies(response)))!;
    const succeeded = (await rows('authentication.sign_in')).find((entry) => entry.outcome === 'success');
    expect(succeeded).toMatchObject({ actorUserId: identity.user.id, targetUserId: identity.user.id, requestId: response.headers.get('X-Request-ID') });
    expect(succeeded!.requestId).not.toBe('forged-request-id');
    expect(await rows('user.registered')).toEqual(expect.arrayContaining([expect.objectContaining({ targetUserId: identity.user.id })]));
    const wrongPassword = 'wrong-password-943!';
    const rejected = await client.request('/api/auth/sign-in/email', { body: { email: 'person@example.test', password: wrongPassword } });
    expect(rejected.status).toBe(401);
    expect(await rows('authentication.sign_in')).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'failure', actorUserId: null, reason: 'INVALID_EMAIL_OR_PASSWORD' })]));
    const serialized = JSON.stringify(await rows());
    for (const secret of [password, wrongPassword, 'test-captcha-token', mailUrl(client.messages.at(-1)), identity.session.token]) expect(serialized).not.toContain(secret);
});

it('does not record a signed-in user until MFA completes and distinguishes failed MFA attempts', async () => {
    const client = harness(); await client.verify();
    const cookie = await client.signin();
    const enrollmentResponse = await client.request('/api/auth/two-factor/enable', { cookie, body: { password } });
    expect(enrollmentResponse.status).toBe(200);
    const enrollment = await enrollmentResponse.json<{ totpURI: string; backupCodes: string[] }>();
    const confirmation = await client.request('/api/auth/two-factor/verify-totp', { cookie, body: { code: await authenticatorCode(enrollment.totpURI) } });
    expect(confirmation.status, await confirmation.clone().text()).toBe(200);
    const countBefore = (await rows('authentication.sign_in')).filter((entry) => entry.outcome === 'success').length;
    const signin = await client.request('/api/auth/sign-in/email', { body: { email: 'person@example.test', password } });
    expect(signin.status).toBe(200);
    expect(await signin.clone().json()).toMatchObject({ twoFactorRedirect: true });
    expect((await rows('authentication.sign_in')).filter((entry) => entry.outcome === 'success')).toHaveLength(countBefore);
    expect(await rows('authentication.challenge')).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'success', actorUserId: null })]));
    const challengedCookie = cookies(signin);
    const failed = await client.request('/api/auth/two-factor/verify-backup-code', { cookie: challengedCookie, body: { code: 'invalid-backup-code' } });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    const verified = await client.request('/api/auth/two-factor/verify-backup-code', { cookie: challengedCookie, body: { code: enrollment.backupCodes[0] } });
    expect(verified.status, await verified.clone().text()).toBe(200);
    expect(await rows('mfa.verified')).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'failure' }), expect.objectContaining({ outcome: 'success' })]));
    expect((await rows('authentication.sign_in')).filter((entry) => entry.outcome === 'success')).toHaveLength(countBefore + 1);
    expect(JSON.stringify(await rows())).not.toContain(enrollment.backupCodes[0]);
    expect(JSON.stringify(await rows())).not.toContain(enrollment.totpURI);
});

it('restricts audit reads to active administrators and returns indexed filter-bound cursor pages and event detail', async () => {
    const client = harness(); await client.verify(); const memberCookie = await client.signin();
    const adminCookie = await client.administrator();
    expect((await client.request('/api/admin/audit-logs')).status).toBe(401);
    expect((await client.request('/api/admin/audit-logs', { cookie: memberCookie })).status).toBe(403);
    expect((await client.request('/api/admin/audit-logs', { cookie: adminCookie, body: {} })).status).toBe(405);
    for (let index = 0; index < 3; index++) await writeAudit(env, { event: 'role.changed', outcome: 'success', actorUserId: 'audit-admin', targetUserId: `user-${index}` });
    const first = await client.request('/api/admin/audit-logs?limit=2&lookupField=event&lookupValue=role.changed', { cookie: adminCookie });
    expect(first.status).toBe(200);
    const page = await first.json<{ items: { id: string; event: string }[]; pageInfo: { nextCursor: string | null } }>();
    expect(page.items).toHaveLength(2); expect(page.pageInfo.nextCursor).toBeTruthy();
    expect(page.items.every((item) => item.event === 'role.changed')).toBe(true);
    const second = await client.request(`/api/admin/audit-logs?${new URLSearchParams({ limit: '2', lookupField: 'event', lookupValue: 'role.changed', cursor: page.pageInfo.nextCursor! })}`, { cookie: adminCookie });
    expect((await second.json<{ items: unknown[] }>()).items).toHaveLength(1);
    const transferred = await client.request(`/api/admin/audit-logs?${new URLSearchParams({ limit: '2', lookupField: 'outcome', lookupValue: 'success', cursor: page.pageInfo.nextCursor! })}`, { cookie: adminCookie });
    expect(transferred.status).toBe(400);
    const detail = await client.request(`/api/admin/audit-logs/${page.items[0].id}`, { cookie: adminCookie });
    expect(await detail.json()).toMatchObject({ id: page.items[0].id, event: 'role.changed', actorUserId: 'audit-admin' });
    expect((await client.request(`/api/admin/audit-logs/${page.items[0].id}`, { cookie: memberCookie })).status).toBe(403);
    await env.DB.prepare('UPDATE "auditLog" SET "expiresAt" = 0 WHERE "id" = ?').bind(page.items[0].id).run();
    expect((await client.request(`/api/admin/audit-logs/${page.items[0].id}`, { cookie: adminCookie })).status).toBe(404);
});

it('records application changes with the authenticated actor and never retains generated client secrets', async () => {
    const client = harness(), cookie = await client.administrator();
    const identity = (await session(client, cookie))!;
    const created = await client.request('/api/admin/applications', { cookie, body: {
        name: 'Audited application', type: 'web', redirectUris: ['https://audit-app.example.test/callback'], postLogoutRedirectUris: ['https://audit-app.example.test/'], scopes: ['openid'],
    } });
    expect(created.status, await created.clone().text()).toBe(201);
    const result = await created.json<{ application: { clientId: string }; clientSecret: string }>();
    const event = (await rows('application.created'))[0]!;
    expect(event).toMatchObject({ actorUserId: identity.user.id, outcome: 'success' });
    expect(event.requestId).toBe(created.headers.get('X-Request-ID'));
    expect(JSON.stringify(await rows())).not.toContain(result.clientSecret);
    const ban = await client.request('/api/auth/admin/ban-user', { cookie, body: { userId: identity.user.id, banReason: 'not-for-audit' } });
    expect(ban.status).toBe(403);
    expect(JSON.stringify(await rows())).not.toContain('not-for-audit');
    const sentinel = 'do-not-log-this-submitted-target-537';
    // Invoke the same native endpoint after its session guard so its own failed
    // user lookup is observed (the HTTP facade rejects this even earlier).
    await expect(createAuth(client.bindings).api.banUser({ headers: new Headers({ Cookie: cookie, Origin: origin }), body: { userId: sentinel, banReason: sentinel } })).rejects.toThrow();
    expect(await rows('user.suspended')).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'failure', targetUserId: null, targetId: null })]));
    expect(JSON.stringify(await rows())).not.toContain(sentinel);
    const unknownApplication = await client.request(`/api/admin/applications/${sentinel}`, { cookie, method: 'PATCH', body: { disabled: true } });
    expect(unknownApplication.status).toBe(404);
    expect(await rows('application.updated')).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'failure', targetId: null })]));
    expect(JSON.stringify(await rows())).not.toContain(sentinel);
});

it('attributes browser-wide actions to this tab selection instead of another account canonical cookie and retains verified deletion targets', async () => {
    const client = harness(); await client.verify('first@example.test'); await client.verify('second@example.test');
    const firstCookie = await client.signin('first@example.test');
    const first = (await session(client, firstCookie))!;
    const second = await client.request('/api/auth/sign-in/email', { cookie: firstCookie, body: { email: 'second@example.test', password } });
    expect(second.status, await second.clone().text()).toBe(200);
    const jar = new Map<string, string>();
    for (const line of [firstCookie, cookies(second)]) for (const pair of line.split(';')) {
        const index = pair.indexOf('='); if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const listed = await client.request('/api/browser/accounts', { cookie });
    const { accounts } = await listed.json<{ accounts: { id: string; user: { id: string }; status: string }[] }>();
    expect(accounts.filter((account) => account.status === 'active')).toHaveLength(2);
    const accountId = accounts.find((account) => account.user.id === first.user.id)!.id;
    const signedOut = await client.request('/api/browser/accounts/sign-out-all', { cookie, headers: { 'X-Loginflare-Account': accountId }, body: {} });
    expect(signedOut.status, await signedOut.clone().text()).toBe(200);
    expect(await rows('browser.all_signed_out')).toEqual([expect.objectContaining({ actorUserId: first.user.id, requestId: signedOut.headers.get('X-Request-ID') })]);
    const removed = await client.request(`/api/browser/accounts/${accountId}`, { cookie, method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await rows('browser.account_removed')).toEqual([expect.objectContaining({ outcome: 'success', targetId: accountId })]);
});

it('attributes token issuance to the authorization subject and client instead of an unrelated browser session', async () => {
    const client = harness(), adminCookie = await client.administrator();
    const callback = 'https://audit-app.example.test/callback';
    const created = await client.request('/api/admin/applications', { cookie: adminCookie, body: {
        name: 'Audit token application', type: 'spa', redirectUris: [callback], postLogoutRedirectUris: ['https://audit-app.example.test/'], scopes: ['openid', 'profile'],
    } });
    expect(created.status).toBe(201);
    const { application } = await created.json<{ application: { clientId: string } }>();
    await client.verify(); const cookie = await client.signin(); const identity = (await session(client, cookie))!;
    const verifier = 'a'.repeat(43);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const requested = await client.request(`/api/auth/oauth2/authorize?${new URLSearchParams({ client_id: application.clientId, redirect_uri: callback, response_type: 'code', scope: 'openid profile', state: 'audit-state', nonce: 'audit-nonce', code_challenge: challenge, code_challenge_method: 'S256' })}`, { cookie });
    expect(requested.status).toBe(302);
    const continuation = new URL(requested.headers.get('location')!, origin);
    const accepted = await client.request('/api/auth/oauth2/consent', { cookie, body: { accept: true, oauth_query: continuation.search.slice(1) } });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const result = await accepted.json<{ url: string }>();
    const code = new URL(result.url).searchParams.get('code')!;
    const context = createExecutionContext();
    const exchanged = await app.fetch(new Request(`${origin}/api/auth/oauth2/token`, {
        method: 'POST', headers: { Origin: origin, Cookie: adminCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: application.clientId, code, code_verifier: verifier, redirect_uri: callback }),
    }), client.bindings, context);
    await waitOnExecutionContext(context);
    expect(exchanged.status, await exchanged.clone().text()).toBe(200);
    const tokens = await exchanged.json<{ access_token: string; id_token: string }>();
    const issued = (await rows('oauth.token_issued')).find((entry) => entry.outcome === 'success');
    expect(issued).toMatchObject({ actorUserId: null, targetUserId: identity.user.id, requestId: exchanged.headers.get('X-Request-ID') });
    expect(await env.DB.prepare('SELECT "clientId" FROM "auditLog" WHERE "id" = ?').bind(issued!.id).first('clientId')).toBe(application.clientId);
    for (const token of [tokens.access_token, tokens.id_token, code, verifier]) expect(JSON.stringify(await rows())).not.toContain(token);
});
