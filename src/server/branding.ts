import { Hono, type MiddlewareHandler } from 'hono';
import { parseSvg } from '../shared/svg';
import { z } from 'zod';
import { createAuth } from './auth';
import type { Env } from './config';
import { databaseRateLimit } from './rate-limit';
import { avatarIdPattern, inspectImage } from '../shared/avatars';
import { colorSchemes, maximumBrandLogoBytes } from '../shared/branding';
import { publicBranding, readBranding } from './branding-settings';

type Identity = NonNullable<Awaited<ReturnType<ReturnType<typeof createAuth>['api']['getSession']>>>;
type BrandingEnv = { Bindings: Env; Variables: { identity: Identity } };
export const branding = new Hono<BrandingEnv>();

const authorize: MiddlewareHandler<BrandingEnv> = async (c, next) => {
    if (c.req.method !== 'GET' && c.req.header('Origin') !== c.env.AUTH_URL) return c.json({ code: 'INVALID_ORIGIN' }, 403);
    const identity = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
    if (!identity) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (identity.user.banned || !identity.user.emailVerified || identity.user.role !== 'admin') return c.json({ code: 'FORBIDDEN' }, 403);
    c.set('identity', identity);
    if (c.req.method !== 'GET') {
        const result = await databaseRateLimit(c.env.DB).consume(`branding:${identity.user.id}`, { window: 3600, max: 30 });
        if (!result.allowed) { c.header('Retry-After', String(result.retryAfter)); return c.json({ code: 'TOO_MANY_REQUESTS' }, 429); }
    }
    await next();
};
branding.use('/api/admin/branding', authorize);
branding.use('/api/admin/branding/logo', authorize);
branding.get('/api/branding', async (c) => c.json(publicBranding(await readBranding(c.env.DB))));
branding.get('/api/admin/branding', async (c) => c.json(publicBranding(await readBranding(c.env.DB))));

const settings = z.object({
    name: z.string().trim().min(1).max(100).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).transform((value) => value.toLowerCase()),
    colorScheme: z.enum(colorSchemes),
    logoId: z.string().regex(avatarIdPattern).nullable(),
    revision: z.number().int().nonnegative(),
}).strict();
branding.put('/api/admin/branding', async (c) => {
    if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) return c.json({ code: 'INVALID_INPUT' }, 400);
    const parsed = settings.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ code: 'INVALID_INPUT' }, 400);
    const value = parsed.data, identity = c.get('identity'), now = Date.now();
    if (value.logoId) {
        const available = await c.env.DB.prepare('SELECT 1 FROM "brandLogo" WHERE "id" = ? AND ("deleteAfter" IS NULL OR "deleteAfter" > ?)').bind(value.logoId, now).first();
        if (!available) return c.json({ code: 'BRANDING_LOGO_UNAVAILABLE' }, 400);
    }
    const committing = Date.now();
    const result = await c.env.DB.prepare(`UPDATE "siteBranding" SET "name" = ?, "primaryColor" = ?, "colorScheme" = ?, "logoId" = ?, "revision" = "revision" + 1 WHERE "id" = 1 AND "revision" = ?
        AND EXISTS (SELECT 1 FROM "user" u JOIN "session" s ON s."userId" = u."id" WHERE u."id" = ? AND u."role" = 'admin' AND COALESCE(u."banned", 0) = 0 AND u."emailVerified" = 1 AND s."id" = ? AND s."expiresAt" > ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM "brandLogo" l WHERE l."id" = ? AND (l."deleteAfter" IS NULL OR l."deleteAfter" > ?)))`)
        .bind(value.name, value.primaryColor, value.colorScheme, value.logoId, value.revision, identity.user.id, identity.session.id, new Date(committing).toISOString(), value.logoId, value.logoId, committing).run();
    if (!result.meta.changes) {
        if ((await readBranding(c.env.DB)).revision !== value.revision) return c.json({ code: 'BRANDING_CONFLICT' }, 409);
        if (value.logoId && !await c.env.DB.prepare('SELECT 1 FROM "brandLogo" WHERE "id" = ? AND ("deleteAfter" IS NULL OR "deleteAfter" > ?)').bind(value.logoId, Date.now()).first()) return c.json({ code: 'BRANDING_LOGO_UNAVAILABLE' }, 400);
        return c.json({ code: 'UNAUTHORIZED' }, 401);
    }
    return c.json(publicBranding(await readBranding(c.env.DB)));
});

branding.post('/api/admin/branding/logo', async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length || bytes.length > maximumBrandLogoBytes) return c.json({ code: 'BRANDING_LOGO_INVALID' }, 400);
    let content: Uint8Array, mime: string;
    try {
        if (c.req.header('Content-Type')?.split(';')[0] === 'image/svg+xml') {
            parseSvg(bytes);
            content = bytes; mime = 'image/svg+xml';
        } else {
            const image = inspectImage(bytes);
            if (image.width > 2048 || image.height > 2048) return c.json({ code: 'BRANDING_LOGO_INVALID' }, 400);
            content = image.sanitized(); mime = image.mime;
        }
    } catch { return c.json({ code: 'BRANDING_LOGO_INVALID' }, 400); }
    const id = crypto.randomUUID(), now = Date.now();
    await c.env.DB.prepare('INSERT INTO "brandLogo" ("id", "createdAt", "deleteAfter") VALUES (?, ?, ?)').bind(id, now, now + 3_600_000).run();
    await c.env.AVATARS.put(`branding/${id}`, content, { httpMetadata: { contentType: mime, contentDisposition: 'attachment' } });
    const identity = c.get('identity');
    const authorized = await c.env.DB.prepare(`SELECT 1 FROM "user" u JOIN "session" s ON s."userId" = u."id" WHERE u."id" = ? AND u."role" = 'admin' AND COALESCE(u."banned", 0) = 0 AND u."emailVerified" = 1 AND s."id" = ? AND s."expiresAt" > ?`)
        .bind(identity.user.id, identity.session.id, new Date().toISOString()).first();
    if (!authorized) return c.json({ code: 'UNAUTHORIZED' }, 401);
    return c.json({ logoId: id, logoUrl: `/branding/logos/${id}` });
});
branding.on(['GET', 'HEAD'], '/branding/logos/:id', async (c) => {
    const id = c.req.param('id');
    if (!avatarIdPattern.test(id)) { c.header('Cache-Control', 'no-store'); return c.body(null, 404); }
    const conditions = new Headers();
    if (c.req.header('If-None-Match')) conditions.set('If-None-Match', c.req.header('If-None-Match')!);
    const object = c.req.method === 'HEAD' ? await c.env.AVATARS.head(`branding/${id}`) : await c.env.AVATARS.get(`branding/${id}`, { onlyIf: conditions });
    if (!object) { c.header('Cache-Control', 'no-store'); return c.body(null, 404); }
    const headers = new Headers(); object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag); headers.set('Cache-Control', 'public, max-age=300');
    headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    headers.set('X-Content-Type-Options', 'nosniff');
    const unchanged = c.req.method === 'HEAD' ? c.req.header('If-None-Match')?.split(',').some((value) => value.trim() === object.httpEtag || value.trim() === '*') : !('body' in object);
    if (unchanged) return new Response(null, { status: 304, headers });
    headers.set('Content-Length', String(object.size));
    return new Response('body' in object ? (object as R2ObjectBody).body : null, { headers });
});
