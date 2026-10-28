import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware, sensitiveSessionMiddleware } from 'better-auth/api';
import { z } from 'zod';
import type { Env } from './config';
import { sendEmailCode } from './mail';

const emailInput = z.email().max(254).transform((value) => value.toLowerCase());
const passwordInput = z.string().min(1).max(128);
const challengeInput = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) });
const lifetime = 10 * 60_000;
type Address = { id: string; userId: string; email: string; verified: number; createdAt: number };
type AccountUser = { id: string; email: string; name: string; locale?: unknown; banned?: boolean | null };

function fail(code: string, status: 'BAD_REQUEST' | 'UNAUTHORIZED' | 'TOO_MANY_REQUESTS' | 'SERVICE_UNAVAILABLE' = 'BAD_REQUEST'): never {
    throw new APIError(status, { code, message: code });
}

function randomCode(): string {
    let value = '';
    while (value.length < 6) {
        for (const byte of crypto.getRandomValues(new Uint8Array(12))) {
            if (byte < 250) value += byte % 10;
            if (value.length === 6) break;
        }
    }
    return value;
}

export function emailManagement(env: Env, schedule?: (task: Promise<unknown>) => void): BetterAuthPlugin {
    async function digest(challengeId: string, code: string): Promise<string> {
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.BETTER_AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${challengeId}:${code}`)));
        return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    async function quota(key: string) {
        const now = Date.now();
        const row = await env.DB.prepare(`INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest") VALUES (?, ?, 1, ?)
            ON CONFLICT ("key") DO UPDATE SET "count" = CASE WHEN "lastRequest" < ? THEN 1 ELSE "count" + 1 END,
                "lastRequest" = CASE WHEN "lastRequest" < ? THEN ? ELSE "lastRequest" END RETURNING "count"`)
            .bind(crypto.randomUUID(), `emails:${key}`, now, now - 60_000, now - 60_000, now).first<{ count: number }>();
        if (!row || row.count > 3) fail('TOO_MANY_REQUESTS', 'TOO_MANY_REQUESTS');
    }

    async function address(userId: string, emailId: string) {
        const row = await env.DB.prepare('SELECT * FROM "userEmail" WHERE "id" = ? AND "userId" = ?').bind(emailId, userId).first<Address>();
        if (!row) fail('EMAIL_NOT_FOUND');
        return row;
    }

    async function requirePassword(context: {
        internalAdapter: { findCredentialAccount: (id: string) => Promise<{ password?: string | null } | null> };
        password: { verify: (data: { hash: string; password: string }) => Promise<boolean> };
    }, userId: string, password: string) {
        const account = await context.internalAdapter.findCredentialAccount(userId);
        if (!account?.password || !await context.password.verify({ hash: account.password, password })) fail('INVALID_PASSWORD');
        return account.password;
    }

    async function challenge(user: AccountUser, row: Address, purpose: 'verify' | 'recovery', credentialHash?: string) {
        const challengeId = crypto.randomUUID();
        const code = randomCode();
        const hash = await digest(challengeId, code);
        const now = Date.now();
        const inserted = await env.DB.batch([
            env.DB.prepare('DELETE FROM "emailChallenge" WHERE "expiresAt" <= ? OR ("userId" = ? AND "emailId" = ? AND "purpose" = ?)').bind(now, user.id, row.id, purpose),
            env.DB.prepare(`INSERT INTO "emailChallenge" ("id", "userId", "emailId", "purpose", "codeHash", "attempts", "expiresAt", "createdAt")
                SELECT ?, ?, ?, ?, ?, 0, ?, ? WHERE EXISTS (SELECT 1 FROM "user" u JOIN "userEmail" e ON e."userId" = u."id"
                    WHERE u."id" = ? AND e."id" = ? AND COALESCE(u."banned", 0) = 0 ${purpose === 'recovery' ? 'AND e."verified" = 1' : ''}
                    ${credentialHash ? 'AND EXISTS (SELECT 1 FROM "account" a WHERE a."userId" = u."id" AND a."providerId" = \'credential\' AND a."password" = ?)' : ''})`)
                .bind(challengeId, user.id, row.id, purpose, hash, now + lifetime, now, user.id, row.id, ...(credentialHash ? [credentialHash] : [])),
        ]);
        if (!inserted[1].meta.changes) fail('INVALID_CODE');
        async function deliver() {
            try {
                await sendEmailCode(env, { ...user, email: row.email }, code, purpose);
            } catch {
                await env.DB.prepare('DELETE FROM "emailChallenge" WHERE "id" = ?').bind(challengeId).run();
                if (purpose !== 'recovery') fail('EMAIL_DELIVERY_FAILED', 'SERVICE_UNAVAILABLE');
                // Public recovery must not disclose account eligibility on mail failure.
                console.error(JSON.stringify({ event: 'email_recovery_delivery_failed' }));
            }
        }
        if (purpose === 'recovery' && schedule) schedule(deliver());
        else await deliver();
        return challengeId;
    }

    async function attempt(challengeId: string, purpose: 'verify' | 'recovery', userId?: string) {
        const row = await env.DB.prepare(`UPDATE "emailChallenge" SET "attempts" = "attempts" + 1
            WHERE "id" = ? AND "purpose" = ? AND "expiresAt" > ? AND "attempts" < 5 ${userId ? 'AND "userId" = ?' : ''}
            AND EXISTS (SELECT 1 FROM "user" WHERE "id" = "emailChallenge"."userId" AND COALESCE("banned", 0) = 0)
            RETURNING "userId", "emailId"`)
            .bind(challengeId, purpose, Date.now(), ...(userId ? [userId] : [])).first<{ userId: string; emailId: string }>();
        if (!row) fail('INVALID_CODE');
        return row;
    }

    return {
        id: 'loginflare-emails',
        schema: {
            userEmail: { fields: {
                userId: { type: 'string', references: { model: 'user', field: 'id', onDelete: 'cascade' } },
                email: { type: 'string', unique: true },
                verified: { type: 'boolean', defaultValue: false },
                createdAt: { type: 'date' },
            } },
            emailChallenge: { fields: {
                userId: { type: 'string', references: { model: 'user', field: 'id', onDelete: 'cascade' } },
                emailId: { type: 'string', references: { model: 'userEmail', field: 'id', onDelete: 'cascade' } },
                purpose: { type: 'string' }, codeHash: { type: 'string', returned: false },
                attempts: { type: 'number', defaultValue: 0 }, expiresAt: { type: 'date' }, createdAt: { type: 'date' },
            } },
        },
        hooks: { before: [{
            matcher: (ctx) => ctx.path === '/sign-up/email',
            handler: createAuthMiddleware(async (ctx) => {
                const email = typeof ctx.body?.email === 'string' ? ctx.body.email.toLowerCase() : '';
                const occupied = await env.DB.prepare(`SELECT 1 FROM "userEmail" e WHERE e."email" = ?
                    AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u."email" = e."email" COLLATE NOCASE)`).bind(email).first();
                if (occupied) fail('USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL');
            }),
        }] },
        endpoints: {
            listEmails: createAuthEndpoint('/emails', { method: 'GET', use: [sensitiveSessionMiddleware] }, async (ctx) => {
                const user = ctx.context.session.user;
                const rows = await env.DB.prepare('SELECT * FROM "userEmail" WHERE "userId" = ? ORDER BY "createdAt", "id"').bind(user.id).all<Address>();
                return ctx.json({ emails: rows.results.map((row) => ({ id: row.id, email: row.email, verified: !!row.verified, primary: row.email === user.email.toLowerCase() })) });
            }),
            addEmail: createAuthEndpoint('/emails/add', {
                method: 'POST', use: [sensitiveSessionMiddleware], body: z.object({ email: emailInput, password: passwordInput }),
            }, async (ctx) => {
                const user = ctx.context.session.user;
                const credentialHash = await requirePassword(ctx.context, user.id, ctx.body.password);
                await quota(`manage:${user.id}`);
                // Pending auxiliary reservations expire after one day. Native unverified
                // signup addresses follow Better Auth's existing account lifecycle.
                await env.DB.prepare(`DELETE FROM "userEmail" WHERE "email" = ? AND "verified" = 0 AND "createdAt" < ?
                    AND NOT EXISTS (SELECT 1 FROM "user" WHERE "user"."email" = "userEmail"."email" COLLATE NOCASE)`).bind(ctx.body.email, Date.now() - 86_400_000).run();
                const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM "userEmail" WHERE "userId" = ?').bind(user.id).first<{ n: number }>();
                if (count && count.n >= 10) fail('EMAIL_LIMIT_REACHED');
                const row: Address = { id: crypto.randomUUID(), userId: user.id, email: ctx.body.email, verified: 0, createdAt: Date.now() };
                try {
                    const inserted = await env.DB.prepare(`INSERT INTO "userEmail" ("id", "userId", "email", "verified", "createdAt")
                        SELECT ?, ?, ?, 0, ? FROM "user" u WHERE u."id" = ? AND COALESCE(u."banned", 0) = 0
                        AND EXISTS (SELECT 1 FROM "account" a WHERE a."userId" = u."id" AND a."providerId" = 'credential' AND a."password" = ?)`)
                        .bind(row.id, row.userId, row.email, row.createdAt, user.id, credentialHash).run();
                    if (!inserted.meta.changes) fail('INVALID_PASSWORD');
                } catch (error) {
                    if (String(error).includes('UNIQUE')) fail('EMAIL_ALREADY_EXISTS');
                    if (String(error).includes('EMAIL_LIMIT_REACHED')) fail('EMAIL_LIMIT_REACHED');
                    throw error;
                }
                try {
                    return ctx.json({ emailId: row.id, challengeId: await challenge(user, row, 'verify', credentialHash) });
                } catch (error) {
                    await env.DB.prepare('DELETE FROM "userEmail" WHERE "id" = ? AND "verified" = 0').bind(row.id).run();
                    throw error;
                }
            }),
            resendEmail: createAuthEndpoint('/emails/resend', {
                method: 'POST', use: [sensitiveSessionMiddleware], body: z.object({ emailId: z.string().min(1), password: passwordInput }),
            }, async (ctx) => {
                const user = ctx.context.session.user;
                const credentialHash = await requirePassword(ctx.context, user.id, ctx.body.password);
                const row = await address(user.id, ctx.body.emailId);
                if (row.verified) fail('EMAIL_ALREADY_VERIFIED');
                await quota(`manage:${user.id}`);
                return ctx.json({ challengeId: await challenge(user, row, 'verify', credentialHash) });
            }),
            verifyAdditionalEmail: createAuthEndpoint('/emails/verify', {
                method: 'POST', use: [sensitiveSessionMiddleware], body: challengeInput,
            }, async (ctx) => {
                const userId = ctx.context.session.user.id;
                const row = await attempt(ctx.body.challengeId, 'verify', userId);
                const hash = await digest(ctx.body.challengeId, ctx.body.code);
                const now = Date.now();
                const results = await env.DB.batch([
                    env.DB.prepare(`UPDATE "userEmail" SET "verified" = 1 WHERE "id" = ? AND "userId" = ?
                        AND EXISTS (SELECT 1 FROM "emailChallenge" WHERE "id" = ? AND "userId" = ? AND "purpose" = 'verify' AND "codeHash" = ? AND "expiresAt" > ? AND "attempts" <= 5)`)
                        .bind(row.emailId, userId, ctx.body.challengeId, userId, hash, now),
                    env.DB.prepare('DELETE FROM "emailChallenge" WHERE "id" = ? AND "codeHash" = ? AND "purpose" = ?').bind(ctx.body.challengeId, hash, 'verify'),
                ]);
                if (!results[0].meta.changes) fail('INVALID_CODE');
                return ctx.json({ status: true });
            }),
            setPrimaryEmail: createAuthEndpoint('/emails/set-primary', {
                method: 'POST', use: [sensitiveSessionMiddleware], body: z.object({ emailId: z.string().min(1), password: passwordInput }),
            }, async (ctx) => {
                const user = ctx.context.session.user;
                const credentialHash = await requirePassword(ctx.context, user.id, ctx.body.password);
                const row = await address(user.id, ctx.body.emailId);
                if (!row.verified) fail('EMAIL_NOT_VERIFIED');
                // Bind the final write to the verified target and the password just
                // checked, so concurrent removal or credential changes cannot revive it.
                try {
                    const updated = await env.DB.prepare(`UPDATE "user" SET "email" = ?, "emailVerified" = 1, "updatedAt" = ?
                        WHERE "id" = ? AND COALESCE("banned", 0) = 0
                        AND EXISTS (SELECT 1 FROM "userEmail" e WHERE e."id" = ? AND e."userId" = "user"."id" AND e."verified" = 1)
                        AND EXISTS (SELECT 1 FROM "account" a WHERE a."userId" = "user"."id" AND a."providerId" = 'credential' AND a."password" = ?)`)
                        .bind(row.email, new Date().toISOString(), user.id, row.id, credentialHash).run();
                    if (!updated.meta.changes) fail('INVALID_PASSWORD');
                } catch (error) {
                    if (String(error).includes('EMAIL_NOT_VERIFIED')) fail('EMAIL_NOT_VERIFIED');
                    if (String(error).includes('EMAIL_ALREADY_EXISTS')) fail('EMAIL_ALREADY_EXISTS');
                    throw error;
                }
                return ctx.json({ status: true });
            }),
            removeEmail: createAuthEndpoint('/emails/remove', {
                method: 'POST', use: [sensitiveSessionMiddleware], body: z.object({ emailId: z.string().min(1), password: passwordInput }),
            }, async (ctx) => {
                const user = ctx.context.session.user;
                const credentialHash = await requirePassword(ctx.context, user.id, ctx.body.password);
                const row = await address(user.id, ctx.body.emailId);
                if (row.email === user.email.toLowerCase()) fail('PRIMARY_EMAIL_REQUIRED');
                try {
                    const removed = await env.DB.prepare(`DELETE FROM "userEmail" WHERE "id" = ? AND "userId" = ?
                        AND EXISTS (SELECT 1 FROM "user" u JOIN "account" a ON a."userId" = u."id"
                            WHERE u."id" = ? AND COALESCE(u."banned", 0) = 0 AND a."providerId" = 'credential' AND a."password" = ?)`)
                        .bind(row.id, user.id, user.id, credentialHash).run();
                    if (!removed.meta.changes) fail('INVALID_PASSWORD');
                } catch (error) {
                    if (String(error).includes('PRIMARY_EMAIL_REQUIRED')) fail('PRIMARY_EMAIL_REQUIRED');
                    throw error;
                }
                return ctx.json({ status: true });
            }),
            startEmailRecovery: createAuthEndpoint('/emails/recovery/start', {
                method: 'POST', body: z.object({ identifier: z.string().min(1).max(254), email: emailInput }),
            }, async (ctx) => {
                const identifier = ctx.body.identifier.trim().toLowerCase();
                await quota(`recovery:${identifier}`);
                const user = await env.DB.prepare(`SELECT "id", "email", "name", "locale", "banned" FROM "user"
                    WHERE ${identifier.includes('@') ? '"email" = ? COLLATE NOCASE' : '"username" = ? COLLATE NOCASE'} AND "emailVerified" = 1 AND COALESCE("banned", 0) = 0`)
                    .bind(identifier).first<AccountUser>();
                const row = user ? await env.DB.prepare('SELECT * FROM "userEmail" WHERE "userId" = ? AND "email" = ? AND "verified" = 1')
                    .bind(user.id, ctx.body.email).first<Address>() : null;
                let challengeId = crypto.randomUUID();
                if (user && row) {
                    try {
                        challengeId = await challenge(user, row, 'recovery');
                    } catch (error) {
                        if (!(error instanceof APIError) || error.body?.code !== 'INVALID_CODE') throw error;
                    }
                }
                return ctx.json({ status: true, challengeId });
            }),
            verifyEmailRecovery: createAuthEndpoint('/emails/recovery/verify', { method: 'POST', body: challengeInput }, async (ctx) => {
                const row = await attempt(ctx.body.challengeId, 'recovery');
                const hash = await digest(ctx.body.challengeId, ctx.body.code);
                const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
                const now = Date.now();
                // Use the pinned Better Auth version's native reset-ticket shape and consume
                // the proof in one D1 batch. Its /reset-password endpoint retains sole
                // ownership of password hashing, ticket use and revocation hooks.
                const results = await env.DB.batch([
                    env.DB.prepare(`INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
                        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM "emailChallenge" c JOIN "userEmail" e ON e."id" = c."emailId"
                            JOIN "user" u ON u."id" = c."userId" WHERE c."id" = ? AND c."purpose" = 'recovery' AND c."codeHash" = ?
                            AND c."expiresAt" > ? AND c."attempts" <= 5 AND e."verified" = 1 AND COALESCE(u."banned", 0) = 0)`)
                        .bind(crypto.randomUUID(), `reset-password:${token}`, row.userId, new Date(now + lifetime).toISOString(), new Date(now).toISOString(), new Date(now).toISOString(), ctx.body.challengeId, hash, now),
                    env.DB.prepare('DELETE FROM "emailChallenge" WHERE "id" = ? AND "codeHash" = ? AND "purpose" = ?').bind(ctx.body.challengeId, hash, 'recovery'),
                ]);
                if (!results[0].meta.changes) fail('INVALID_CODE');
                return ctx.json({ token });
            }),
        },
    } satisfies BetterAuthPlugin;
}
