import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { maintainDatabase } from '../src/server/maintenance';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(async () => { await reset(); });

const iso = (value: number) => new Date(value).toISOString();
async function fixture(now: number) {
    await env.DB.prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "role", "banned") VALUES ('owner', 'Owner', 'owner@example.test', 1, ?, ?, 'user', 0)`)
        .bind(iso(now), iso(now)).run();
    await env.DB.prepare('INSERT INTO "oauthClient" ("id", "clientId", "redirectUris") VALUES (?, ?, ?)')
        .bind('client-row', 'client', '["https://client.example.test/callback"]').run();
    await addSession('origin', now + 3_600_000, now);
}
function sessionStatement(id: string, expiresAt: number, now: number) {
    return env.DB.prepare('INSERT INTO "session" ("id", "token", "userId", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, `session:${id}`, 'owner', iso(expiresAt), iso(now), iso(now));
}
async function addSession(id: string, expiresAt: number, now: number) { await sessionStatement(id, expiresAt, now).run(); }
function accessStatement(id: string, sessionId: string, expiresAt: number, now: number) {
    return env.DB.prepare(`INSERT INTO "oauthAccessToken" ("id", "token", "clientId", "sessionId", "userId", "authorizationCodeId", "expiresAt", "createdAt", "scopes") VALUES (?, ?, 'client', ?, 'owner', ?, ?, ?, ?)`)
        .bind(id, `access:${id}`, sessionId, `grant:${id}`, iso(expiresAt), iso(now), '["openid"]');
}

it.each(['oauthAccessToken', 'oauthRefreshToken'] as const)('requires a canonical active origin for a new %s grant while preserving offline grant policy', async (table) => {
    const now = Date.now();
    await fixture(now);
    const issue = (id: string, grant: string, sessionId: string | null = 'origin') => env.DB.prepare(`INSERT INTO "${table}"
        ("id", "token", "clientId", "sessionId", "userId", "authorizationCodeId", "expiresAt", "createdAt", "scopes")
        VALUES (?, ?, 'client', ?, 'owner', ?, ?, ?, ?)`)
        .bind(id, `token:${id}`, sessionId, grant, iso(now + 3_600_000), iso(now), '["openid","offline_access"]').run();
    await issue('canonical', 'existing-grant');
    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "id" = ?').bind(now + 3_600_000, 'origin').run();
    await expect(issue('numeric-origin', 'numeric-grant')).rejects.toThrow('OAUTH_GRANT_UNAVAILABLE');
    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "id" = ?').bind(iso(now - 600_000), 'origin').run();
    await expect(issue('expired-origin', 'expired-grant')).rejects.toThrow('OAUTH_GRANT_UNAVAILABLE');
    // An existing offline grant may outlive the original session, retaining its
    // authoritative policy row even when native refresh detaches the session.
    await issue('offline-successor', 'existing-grant', null);
    expect(await env.DB.prepare('SELECT "originalSessionId" FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = ?')
        .bind('existing-grant').first('originalSessionId')).toBe('origin');
    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ?, "oauthRevokedAt" = ? WHERE "id" = ?')
        .bind(iso(now + 3_600_000), iso(now), 'origin').run();
    await expect(issue('revoked-origin', 'new-grant')).rejects.toThrow('OAUTH_GRANT_UNAVAILABLE');
    await expect(issue('revoked-successor', 'existing-grant', null)).rejects.toThrow('OAUTH_GRANT_UNAVAILABLE');
});

it('collects only proofs and counters past expiry plus the safety buffer', async () => {
    const now = Date.now();
    await fixture(now);
    for (const [id, expiresAt] of [['old', now - 600_000], ['buffer', now - 60_000], ['live', now + 60_000]] as const) {
        await env.DB.batch([
            env.DB.prepare('INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest", "expiresAt") VALUES (?, ?, 1, ?, ?)').bind(`rate:${id}`, id, expiresAt - 60_000, expiresAt),
            env.DB.prepare('INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)').bind(`proof:${id}`, `proof:${id}`, 'owner', iso(expiresAt), iso(now), iso(now)),
            env.DB.prepare('INSERT INTO "emailChallenge" ("id", "userId", "emailId", "purpose", "codeHash", "expiresAt", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?)').bind(`challenge:${id}`, 'owner', 'primary:owner', 'verify', 'hashed-code', expiresAt, now),
        ]);
    }
    const result = await maintainDatabase(env, now);
    expect(result.deleted).toMatchObject({ rateLimit: 1, verification: 1, emailChallenge: 1 });
    for (const table of ['rateLimit', 'verification', 'emailChallenge']) expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).first('count')).toBe(2);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "user"').first('count')).toBe(1);
});

it('retains rotated refresh tombstones until their own expiry and preserves a longer-lived access child', async () => {
    const now = Date.now();
    await fixture(now);
    for (const [id, expiresAt] of [['rotated', now + 600_000], ['expired', now - 600_000], ['parent', now - 600_000]] as const) {
        await env.DB.prepare(`INSERT INTO "oauthRefreshToken" ("id", "token", "clientId", "sessionId", "userId", "authorizationCodeId", "expiresAt", "createdAt", "revoked", "rotatedAt", "scopes") VALUES (?, ?, 'client', 'origin', 'owner', ?, ?, ?, ?, ?, ?)`)
            .bind(id, `refresh:${id}`, `grant:${id}`, iso(expiresAt), iso(now - 86_400_000), iso(now - 86_400_000), iso(now - 86_400_000), '["openid","offline_access"]').run();
    }
    await accessStatement('child', 'origin', now + 3_600_000, now).run();
    await env.DB.prepare('UPDATE "oauthAccessToken" SET "refreshId" = ? WHERE "id" = ?').bind('parent', 'child').run();
    await maintainDatabase(env, now);
    expect(await env.DB.prepare('SELECT "id" FROM "oauthRefreshToken" ORDER BY "id"').all()).toMatchObject({ results: [{ id: 'parent' }, { id: 'rotated' }] });
    expect(await env.DB.prepare('SELECT "refreshId" FROM "oauthAccessToken" WHERE "id" = ?').bind('child').first('refreshId')).toBe('parent');
});

it('does not detach a live access token by deleting its expired session', async () => {
    const now = Date.now();
    await fixture(now);
    await accessStatement('live-access', 'origin', now + 600_000, now).run();
    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "id" = ?').bind(iso(now - 600_000), 'origin').run();
    await addSession('unreferenced', now - 600_000, now);
    await maintainDatabase(env, now);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "session" WHERE "id" = ?').bind('origin').first('count')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "session" WHERE "id" = ?').bind('unreferenced').first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT "sessionId" FROM "oauthAccessToken" WHERE "id" = ?').bind('live-access').first('sessionId')).toBe('origin');
});

it('collects orphaned grants but defers an original session that can still issue credentials', async () => {
    const now = Date.now();
    await fixture(now);
    for (const [id, originalSessionId] of [['orphan', 'missing-session'], ['active-origin', 'origin']] as const) {
        await env.DB.prepare('INSERT INTO "oauthGrantPolicy" ("authorizationCodeId", "userId", "clientId", "originalSessionId", "gcAfter") VALUES (?, ?, ?, ?, ?)')
            .bind(id, 'owner', 'client', originalSessionId, iso(now - 600_000)).run();
    }
    await maintainDatabase(env, now);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = ?').bind('orphan').first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT "gcAfter" FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = ?').bind('active-origin').first('gcAfter')).toBe(iso(now + 3_600_000));
});

it('makes progress past a full first page of referenced expired sessions across scheduled runs', async () => {
    const now = Date.now();
    await fixture(now);
    const blocked = Array.from({ length: 500 }, (_, index) => `blocked:${String(index).padStart(3, '0')}`);
    await env.DB.batch(blocked.map((id) => sessionStatement(id, now + 3_600_000, now)));
    await env.DB.batch(blocked.map((id) => accessStatement(`access:${id}`, id, now + 3_600_000, now)));
    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "id" LIKE ?').bind(iso(now - 3_600_000), 'blocked:%').run();
    await addSession('later-unreferenced', now - 600_000, now);
    for (let run = 0; run < 3; run++) {
        const result = await maintainDatabase(env, now);
        expect(result.batches).toBeLessThanOrEqual(20);
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "session" WHERE "id" = ?').bind('later-unreferenced').first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM "session" WHERE "id" LIKE ?').bind('blocked:%').first('count')).toBe(500);
});

it('stops before scanning or deleting when its wall-clock budget is spent', async () => {
    const now = Date.now();
    let calls = 0;
    const result = await maintainDatabase(env, now, () => calls++ === 0 ? 0 : 20_001);
    expect(result).toMatchObject({ batches: 0, deleted: {}, budgetExhausted: true });
});
