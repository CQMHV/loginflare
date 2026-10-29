import { Hono, type MiddlewareHandler } from 'hono';
import { createAuth } from './auth';
import type { Env } from './config';
import { PaginationError, pageBoundary, pageResult, readPageInput } from './pagination';
import { databaseRateLimit } from './rate-limit';

type Auth = ReturnType<typeof createAuth>;
type Identity = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;
type ManagementEnv = { Bindings: Env; Variables: { identity: Identity; auth: Auth } };
export const management = new Hono<ManagementEnv>();
management.onError((error, c) => {
    if (error instanceof PaginationError) return c.json({ code: error.code }, 400);
    throw error;
});

const authorize: MiddlewareHandler<ManagementEnv> = async (c, next) => {
    if (c.req.method !== 'GET') return c.json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    const limit = await databaseRateLimit(c.env.DB).consume(`loginflare:list:${c.req.path}:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`, { window: 60, max: 100 });
    if (!limit.allowed) { c.header('Retry-After', String(limit.retryAfter)); return c.json({ code: 'TOO_MANY_REQUESTS' }, 429); }
    const auth = createAuth(c.env);
    const identity = await auth.api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
    if (!identity) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (identity.user.banned || !identity.user.emailVerified || (c.req.path.includes('/admin/') && identity.user.role !== 'admin')) return c.json({ code: 'FORBIDDEN' }, 403);
    c.set('identity', identity); c.set('auth', auth);
    await next();
};
management.use('/admin/users', authorize);
management.use('/account/sessions', authorize);

interface UserRow { id: string; name: string; username: string | null; email: string; emailVerified: number; role: string | null; banned: number | null; createdAt: string }
management.get('/admin/users', async (c) => {
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'users', 'administrators', ['id', 'username', 'email']);
    const boundary = pageBoundary(input, 'id');
    const filter = input.lookupField ? ` WHERE "${input.lookupField}" = ?` : ' WHERE 1 = 1';
    const result = await c.env.DB.prepare(`SELECT "id", "name", "username", "email", "emailVerified", "role", "banned", "createdAt" FROM "user"${filter}${boundary.sql} ORDER BY "createdAt" ${boundary.order}, "id" ${boundary.order} LIMIT ?`)
        .bind(...(input.lookupValue ? [input.lookupValue] : []), ...boundary.values, input.limit + 1).all<UserRow>();
    const rows = result.results.map((user) => ({ ...user, emailVerified: !!user.emailVerified, banned: !!user.banned }));
    return c.json(await pageResult(rows, input, c.env.BETTER_AUTH_SECRET, (item) => ({ createdAt: item.createdAt, id: item.id })));
});

interface SessionRow { id: string; token: string; userId: string; createdAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null }
management.get('/account/sessions', async (c) => {
    const identity = c.var.identity;
    const freshAge = (await c.var.auth.$context).sessionConfig.freshAge;
    if (freshAge !== 0 && Date.now() - new Date(identity.session.createdAt).getTime() >= freshAge * 1000) return c.json({ code: 'SESSION_NOT_FRESH' }, 403);
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'sessions', identity.user.id, []);
    const boundary = pageBoundary(input, 'id');
    const now = new Date().toISOString();
    const rows = await c.env.DB.prepare(`SELECT "id", "token", "userId", "createdAt", "expiresAt", "ipAddress", "userAgent" FROM "session" WHERE "userId" = ? AND "expiresAt" > ?${boundary.sql} ORDER BY "createdAt" ${boundary.order}, "id" ${boundary.order} LIMIT ?`)
        .bind(identity.user.id, now, ...boundary.values, input.limit + 1).all<SessionRow>();
    const other = await c.env.DB.prepare('SELECT 1 FROM "session" WHERE "userId" = ? AND "expiresAt" > ? AND "id" <> ? LIMIT 1')
        .bind(identity.user.id, now, identity.session.id).first();
    return c.json({ ...await pageResult(rows.results, input, c.env.BETTER_AUTH_SECRET, (item) => ({ createdAt: item.createdAt, id: item.id })), hasOtherSessions: !!other });
});
