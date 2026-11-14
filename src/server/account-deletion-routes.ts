import { Hono, type MiddlewareHandler } from 'hono';
import type { Env } from './config';
import { createAuth } from './auth';
import { databaseRateLimit } from './rate-limit';

export const deletionRoutes = new Hono<{ Bindings: Env }>();
const authorize: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
    if (c.req.method === 'POST' && c.req.header('Origin') !== c.env.AUTH_URL) return c.json({ code: 'INVALID_ORIGIN' }, 403);
    if (c.req.method === 'POST' && c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return c.json({ code: 'INVALID_INPUT' }, 400);
    const identity = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
    if (!identity) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (identity.user.role !== 'user' || identity.user.banned || !identity.user.emailVerified) return c.json({ code: 'ACCOUNT_DELETION_FORBIDDEN' }, 403);
    const rate = await databaseRateLimit(c.env.DB).consume(`account:delete:${c.req.method}:${identity.user.id}`, { window: 60, max: c.req.method === 'POST' ? 5 : 60 });
    if (!rate.allowed) { c.header('Retry-After', String(rate.retryAfter)); return c.json({ code: 'TOO_MANY_REQUESTS' }, 429); }
    await next();
};
deletionRoutes.use('/deletion-preview', authorize);
deletionRoutes.use('/delete', authorize);
deletionRoutes.get('/deletion-preview', async (c) => c.json(await createAuth(c.env).api.previewAccountDeletion({ headers: c.req.raw.headers })));
deletionRoutes.post('/delete', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ code: 'INVALID_INPUT' }, 400);
    return c.json(await createAuth(c.env).api.requestAccountDeletion({ headers: c.req.raw.headers, body }), 202);
});
deletionRoutes.all('/deletion-preview', (c) => c.json({ code: 'METHOD_NOT_ALLOWED' }, 405));
deletionRoutes.all('/delete', (c) => c.json({ code: 'METHOD_NOT_ALLOWED' }, 405));
