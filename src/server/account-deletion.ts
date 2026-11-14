import type { BetterAuthPlugin, GenericEndpointContext } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware, sessionMiddleware } from 'better-auth/api';
import { SignJWT, jwtVerify, decodeJwt } from 'jose';
import { z } from 'zod';
import type { Env } from './config';
import { requireSecurity, securityGuard } from './security-proof';
import { auditRetention } from './audit';

const applicationList = `(SELECT json_group_array(json_object('clientId', "clientId", 'name', "name")) FROM
    (SELECT "clientId", "name" FROM "oauthClient" WHERE "ownerId" = u."id" ORDER BY "clientId"))`;
const eligible = `u."role" = 'user' AND coalesce(u."banned", 0) = 0 AND u."emailVerified" = 1 AND u."deletionRequestedAt" IS NULL`;
const bodySchema = z.object({ preview: z.string().max(16000), password: z.string().max(128).optional(), code: z.string().regex(/^\d{6}$/).optional() }).strict();
const fail = (code: string, status: 'BAD_REQUEST' | 'FORBIDDEN' | 'CONFLICT' = 'BAD_REQUEST'): never => { throw new APIError(status, { code, message: code }); };

export function accountDeletion(env: Env, verifyTotp: (ctx: GenericEndpointContext, code: string) => Promise<unknown>) {
    const key = new TextEncoder().encode(env.BETTER_AUTH_SECRET);
    return { id: 'loginflare-account-deletion', hooks: { before: [{
        matcher: (ctx) => ctx.path === '/verify-email',
        handler: createAuthMiddleware(async (ctx) => {
            // Native links identify an email, not an account ID. This only
            // restricts eligibility; native signature validation remains authoritative.
            let payload;
            try { payload = decodeJwt(String(ctx.query?.token ?? '')); } catch { return; }
            if (typeof payload.email !== 'string' || typeof payload.iat !== 'number') return;
            const current = await env.DB.prepare('SELECT "createdAt" FROM "user" WHERE "email" = ? COLLATE NOCASE').bind(payload.email).first<string>('createdAt');
            if (current && payload.iat < Math.floor(new Date(current).getTime() / 1000)) return fail('INVALID_TOKEN');
        }),
    }] }, endpoints: {
        previewAccountDeletion: createAuthEndpoint('/account/deletion-preview', { method: 'GET', requireHeaders: true, use: [sessionMiddleware] }, async (ctx) => {
            const { user, session } = ctx.context.session;
            const row = await env.DB.prepare(`SELECT ${applicationList} AS applications FROM "user" u WHERE u."id" = ? AND ${eligible}`)
                .bind(user.id).first<{ applications: string }>();
            if (!row) return fail('ACCOUNT_DELETION_FORBIDDEN', 'FORBIDDEN');
            if (await env.DB.prepare('SELECT 1 FROM "oauthClient" WHERE "userId" = ? AND ("ownerId" IS NULL OR "ownerId" <> ?) LIMIT 1').bind(user.id, user.id).first()) fail('ACCOUNT_DELETION_DEPENDENCY', 'CONFLICT');
            const preview = await new SignJWT({ purpose: 'account/delete', sessionId: session.id, applications: row.applications })
                .setProtectedHeader({ alg: 'HS256' }).setIssuer(env.AUTH_URL).setAudience('account/delete').setSubject(user.id).setIssuedAt().setExpirationTime('10m').sign(key);
            return ctx.json({ preview, applications: JSON.parse(row.applications) as { clientId: string; name: string | null }[], expiresIn: 600 });
        }),
        requestAccountDeletion: createAuthEndpoint('/account/delete', { method: 'POST', requireHeaders: true, use: [sessionMiddleware], body: bodySchema }, async (ctx) => {
            const { user, session } = ctx.context.session;
            if (user.role !== 'user' || user.banned || !user.emailVerified) fail('ACCOUNT_DELETION_FORBIDDEN', 'FORBIDDEN');
            let applications: string;
            try {
                const { payload } = await jwtVerify(ctx.body.preview, key, { issuer: env.AUTH_URL, audience: 'account/delete', algorithms: ['HS256'], subject: user.id, requiredClaims: ['iat', 'exp'] });
                if (payload.purpose !== 'account/delete' || payload.sessionId !== session.id || typeof payload.applications !== 'string') throw new Error('Wrong preview');
                applications = payload.applications;
            } catch { return fail('ACCOUNT_DELETION_PREVIEW_EXPIRED'); }
            const authorization = await requireSecurity(ctx, env, 'account/delete', ctx.body.password);
            const factor = await env.DB.prepare('SELECT u."twoFactorEnabled", f."secret", f."verified" FROM "user" u LEFT JOIN "twoFactor" f ON f."userId" = u."id" WHERE u."id" = ?')
                .bind(user.id).first<{ twoFactorEnabled: number; secret: string | null; verified: number | null }>();
            if (!factor) return fail('ACCOUNT_DELETION_FORBIDDEN', 'FORBIDDEN');
            if (factor.twoFactorEnabled && 'credentialHash' in authorization) {
                if (!ctx.body.code || !factor.secret || !factor.verified) return fail('ACCOUNT_DELETION_MFA_REQUIRED');
                await verifyTotp(ctx, ctx.body.code);
            }
            const guard = securityGuard(authorization, 'u."id"');
            const id = crypto.randomUUID(), now = Date.now();
            const result = await env.DB.batch([
                env.DB.prepare(`INSERT INTO "accountDeletion" ("id", "userId", "applicationIds", "requestedAt")
                    SELECT ?, u."id", (SELECT json_group_array(json_extract(value, '$.clientId')) FROM json_each(?)), ? FROM "user" u
                    JOIN "session" s ON s."userId" = u."id" WHERE u."id" = ? AND s."id" = ? AND s."expiresAt" > ? AND s."oauthRevokedAt" IS NULL
                    AND ${eligible} AND ${applicationList} = ? AND ${guard.sql} AND u."twoFactorEnabled" = ?
                    AND (? = 0 OR EXISTS (SELECT 1 FROM "twoFactor" f WHERE f."userId" = u."id" AND f."verified" = 1 AND f."secret" = ?))
                    AND NOT EXISTS (SELECT 1 FROM "oauthClient" WHERE "userId" = u."id" AND ("ownerId" IS NULL OR "ownerId" <> u."id"))`)
                    .bind(id, applications, now, user.id, session.id, new Date(now).toISOString(), applications, ...guard.values, factor.twoFactorEnabled, factor.twoFactorEnabled, factor.secret),
                // This is an ordinary owner disable while the confirmed owner is
                // still active; the task suppresses unbounded grant fan-out.
                env.DB.prepare(`UPDATE "oauthClient" SET "ownerDisabled" = 1, "disabled" = 1, "managementUserId" = ?, "managementSessionId" = ?, "managementAdministrator" = 0
                    WHERE "ownerId" = ? AND coalesce("disabled", 0) = 0 AND EXISTS (SELECT 1 FROM "accountDeletion" WHERE "id" = ?)`)
                    .bind(user.id, session.id, user.id, id),
                env.DB.prepare(`UPDATE "user" SET "deletionRequestedAt" = ?, "banned" = 1 WHERE "id" = ? AND EXISTS (SELECT 1 FROM "accountDeletion" WHERE "id" = ?)`)
                    .bind(now, user.id, id),
            ]);
            if (!result[0]!.meta.changes) fail('ACCOUNT_DELETION_PREVIEW_CHANGED', 'CONFLICT');
            // The task is the durable receipt. Acceptance audit is inserted by its
            // database trigger in the same transaction, never after success.
            return ctx.json({ operationId: id, status: 'pending' as const });
        }),
    } } satisfies BetterAuthPlugin;
}

interface Job { id: string; userId: string; applicationIds: string; stage: number; requestedAt: number }

/** One lease, one bounded statement at a time; no request credentials are needed. */
export async function collectAccountDeletions(env: Pick<Env, 'DB'>, budget: { available: () => boolean; used: (count: number) => void }, now = Date.now()) {
    const candidate = await env.DB.prepare(`SELECT "id" FROM "accountDeletion" WHERE "status" = 'pending' AND "leaseUntil" <= ? ORDER BY "requestedAt", "id" LIMIT 1`).bind(now).first<{ id: string }>();
    if (!candidate || !budget.available()) return;
    const lease = crypto.randomUUID();
    const job = await env.DB.prepare(`UPDATE "accountDeletion" SET "lease" = ?, "leaseUntil" = ? WHERE "id" = ? AND "status" = 'pending' AND "leaseUntil" <= ? RETURNING *`)
        .bind(lease, now + 60_000, candidate.id, now).first<Job>();
    if (!job) return;
    const owned = '"clientId" IN (SELECT value FROM json_each(?))';
    const scoped = `("userId" = ? OR ${owned})`;
    const tokenValues = [job.userId, job.applicationIds];
    // Ordinals are durable job state; append/migrate rather than reorder them.
    const stages: { table: string; where: string; values: (string | number)[]; update?: string; grant?: boolean }[] = [
        { table: 'oauthAccessToken', where: scoped, values: tokenValues },
        { table: 'oauthRefreshToken', where: `${scoped} AND NOT EXISTS (SELECT 1 FROM "oauthAccessToken" a WHERE a."refreshId" = "oauthRefreshToken"."id")`, values: tokenValues },
        { table: 'oauthGrantPolicy', where: scoped, values: tokenValues, grant: true },
        { table: 'verification', where: '"value" = ? OR "value" IN (SELECT "id" FROM "socialFlow" WHERE "userId" = ?)', values: [job.userId, job.userId] },
        { table: 'oauthConsent', where: scoped, values: tokenValues },
        { table: 'oauthAccountApplication', where: scoped, values: tokenValues },
        { table: 'oauthClientResource', where: owned, values: [job.applicationIds] },
        { table: 'oauthClient', where: '"ownerId" = ?', values: [job.userId] },
        { table: 'browserAuthFlow', where: '"userId" = ? OR "targetUserId" = ?', values: [job.userId, job.userId] },
        { table: 'socialFlow', where: '"userId" = ?', values: [job.userId] },
        { table: 'securityProof', where: '"userId" = ?', values: [job.userId] },
        { table: 'browserAccount', where: '"userId" = ?', values: [job.userId] },
        { table: 'session', where: '"userId" = ?', values: [job.userId] },
        { table: 'twoFactor', where: '"userId" = ?', values: [job.userId] },
        { table: 'account', where: '"userId" = ?', values: [job.userId] },
        { table: 'apiUserRole', where: '"userId" = ?', values: [job.userId] },
        { table: 'userAvatar', where: '"userId" = ?', values: [job.userId], update: `"deleteAfter" = ${now}, "userId" = NULL` },
        { table: 'emailChallenge', where: '"userId" = ?', values: [job.userId] },
        // Keep the single primary reservation until the parent DELETE removes
        // it atomically. Releasing it in a previous Cron would split uniqueness.
        { table: 'userEmail', where: '"userId" = ? AND "email" <> (SELECT "email" FROM "user" WHERE "id" = ?) COLLATE NOCASE', values: [job.userId, job.userId] },
    ];
    const ownedLease = `EXISTS (SELECT 1 FROM "accountDeletion" WHERE "id" = ? AND "lease" = ? AND "leaseUntil" > ? AND "status" = 'pending')`;
    try {
        while (budget.available() && Date.now() < now + 20_000) {
            const stage = stages[job.stage];
            if (!stage) {
                await env.DB.batch([
                    env.DB.prepare(`DELETE FROM "user" WHERE "id" = ? AND "deletionRequestedAt" IS NOT NULL AND ${ownedLease}
                        AND NOT EXISTS (SELECT 1 FROM "oauthClient" WHERE "userId" = "user"."id" OR "ownerId" = "user"."id")`).bind(job.userId, job.id, lease, Date.now()),
                    env.DB.prepare(`UPDATE "accountDeletion" SET "status" = 'complete', "completedAt" = ?, "expiresAt" = ? WHERE "id" = ? AND "lease" = ? AND NOT EXISTS (SELECT 1 FROM "user" WHERE "id" = ?)`)
                        .bind(now, now + auditRetention, job.id, lease, job.userId),
                ]);
                budget.used(1); break;
            }
            // Re-registered addresses must have a different JWT issued-at second.
            if (stage.table === 'userEmail' && now < job.requestedAt + 2000) break;
            const select = `SELECT rowid FROM "${stage.table}" WHERE (${stage.where}) LIMIT 100`;
            const mutation = stage.update ? `UPDATE "${stage.table}" SET ${stage.update}` : `DELETE FROM "${stage.table}"`;
            const statements = [];
            if (stage.grant) statements.push(env.DB.prepare(`DELETE FROM "verification" WHERE "identifier" IN (SELECT "authorizationCodeId" FROM "oauthGrantPolicy" WHERE rowid IN (${select})) AND ${ownedLease}`)
                .bind(...stage.values, job.id, lease, Date.now()));
            statements.push(env.DB.prepare(`${mutation} WHERE rowid IN (${select}) AND ${ownedLease}`).bind(...stage.values, job.id, lease, Date.now()));
            statements.push(env.DB.prepare(`UPDATE "accountDeletion" SET "stage" = "stage" + 1 WHERE "id" = ? AND "lease" = ? AND NOT EXISTS (SELECT 1 FROM "${stage.table}" WHERE ${stage.where})`).bind(job.id, lease, ...stage.values));
            const results = await env.DB.batch(statements);
            budget.used(1);
            if (results.at(-1)!.meta.changes) job.stage++;
        }
    } finally { await env.DB.prepare('UPDATE "accountDeletion" SET "lease" = NULL, "leaseUntil" = 0 WHERE "id" = ? AND "lease" = ?').bind(job.id, lease).run(); }
}
