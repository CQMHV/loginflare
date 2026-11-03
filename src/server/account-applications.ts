import { Hono } from 'hono';
import { createAuth } from './auth';
import type { Env } from './config';
import { PaginationError, pageBoundary, pageResult, readPageInput } from './pagination';
import { databaseRateLimit } from './rate-limit';

type Identity = NonNullable<Awaited<ReturnType<ReturnType<typeof createAuth>['api']['getSession']>>>;
type AccountApplicationEnv = { Bindings: Env; Variables: { identity: Identity } };
const eligibleSession = `EXISTS (SELECT 1 FROM "session" s JOIN "user" u ON u."id" = s."userId"
    WHERE s."id" = ? AND s."userId" = ? AND s."oauthRevokedAt" IS NULL
    AND s."expiresAt" > ? AND u."emailVerified" = 1 AND coalesce(u."banned", 0) = 0)`;

export const accountApplications = new Hono<AccountApplicationEnv>();

accountApplications.onError((error, c) => {
    if (error instanceof PaginationError) return c.json({ code: error.code }, 400);
    throw error;
});

accountApplications.use('*', async (c, next) => {
    if (!['GET', 'POST'].includes(c.req.method)) return c.json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    if (c.req.method !== 'GET' && c.req.header('origin') !== c.env.AUTH_URL) return c.json({ code: 'INVALID_ORIGIN' }, 403);
    if (c.req.method !== 'GET' && c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') return c.json({ code: 'INVALID_INPUT' }, 400);
    const identity = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
    if (!identity) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (identity.user.banned || !identity.user.emailVerified) return c.json({ code: 'FORBIDDEN' }, 403);
    const active = await c.env.DB.prepare(`SELECT ${eligibleSession} AS "active"`)
        .bind(identity.session.id, identity.user.id, new Date().toISOString()).first<number>('active');
    if (!active) return c.json({ code: 'FORBIDDEN' }, 403);
    c.set('identity', identity);
    const rate = await databaseRateLimit(c.env.DB).consume(`loginflare:account-applications:${c.req.method}:${identity.user.id}`, { window: 60, max: c.req.method === 'GET' ? 100 : 30 });
    if (!rate.allowed) { c.header('Retry-After', String(rate.retryAfter)); return c.json({ code: 'TOO_MANY_REQUESTS' }, 429); }
    await next();
});

accountApplications.get('/', async (c) => {
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'account-applications', c.var.identity.user.id, []);
    const boundary = pageBoundary(input, 'clientId');
    const rows = await c.env.DB.prepare(`SELECT "clientId", "scopes", "createdAt",
        (SELECT "name" FROM "oauthClient" WHERE "clientId" = "oauthAccountApplication"."clientId") AS "name",
        (SELECT "disabled" FROM "oauthClient" WHERE "clientId" = "oauthAccountApplication"."clientId") AS "disabled"
        FROM "oauthAccountApplication" WHERE "userId" = ?${boundary.sql}
        ORDER BY "createdAt" ${boundary.order}, "clientId" ${boundary.order} LIMIT ?`)
        .bind(c.var.identity.user.id, ...boundary.values, input.limit + 1)
        .all<{ clientId: string; name: string | null; scopes: string; createdAt: string; disabled: number | null }>();
    const items = rows.results.map((row) => ({ clientId: row.clientId, name: row.name ?? row.clientId,
        scopes: JSON.parse(row.scopes) as string[], authorizedAt: row.createdAt, disabled: !!row.disabled }));
    return c.json(await pageResult(items, input, c.env.BETTER_AUTH_SECRET, (item) => ({ createdAt: item.authorizedAt, id: item.clientId })));
});

accountApplications.post('/:clientId/revoke', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length || c.req.param('clientId').length > 255) return c.json({ code: 'INVALID_INPUT' }, 400);
    const identity = c.var.identity;
    const values = [identity.session.id, identity.user.id, new Date().toISOString()];
    // Deleting native consent atomically revokes this user's grants and pending
    // codes through the migration triggers. No browser session is removed.
    const results = await c.env.DB.batch([
        c.env.DB.prepare(`DELETE FROM "oauthConsent" WHERE "userId" = ? AND "clientId" = ? AND ${eligibleSession}`)
            .bind(identity.user.id, c.req.param('clientId'), ...values),
        c.env.DB.prepare(`SELECT ${eligibleSession} AS "active"`).bind(...values),
    ]);
    if (!(results[1]!.results[0] as { active: number } | undefined)?.active) return c.json({ code: 'FORBIDDEN' }, 403);
    // Identical responses keep absent, previously revoked and foreign grants private.
    return c.json({ status: true });
});
