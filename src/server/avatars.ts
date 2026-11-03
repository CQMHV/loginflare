import { Hono } from 'hono';
import { createAuth } from './auth';
import type { Env } from './config';
import { databaseRateLimit } from './rate-limit';
import { avatarIdPattern, avatarMimeType, avatarSize, AvatarImageError, inspectImage } from '../shared/avatars';
import { maximumImageBytes } from '../shared/image-limits';

export const avatars = new Hono<{ Bindings: Env }>();

avatars.on(['GET', 'HEAD'], '/avatars/:id', async (c) => {
    const id = c.req.param('id');
    if (!avatarIdPattern.test(id)) { c.header('Cache-Control', 'no-store'); return c.body(null, 404); }
    const conditions = new Headers();
    if (c.req.header('If-None-Match')) conditions.set('If-None-Match', c.req.header('If-None-Match')!);
    const object = c.req.method === 'HEAD' ? await c.env.AVATARS.head(id) : await c.env.AVATARS.get(id, { onlyIf: conditions });
    if (!object) { c.header('Cache-Control', 'no-store'); return c.body(null, 404); }
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=300');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    const unchanged = c.req.method === 'HEAD'
        ? c.req.header('If-None-Match')?.split(',').some((value) => value.trim() === object.httpEtag || value.trim() === '*')
        : !('body' in object);
    if (unchanged) return new Response(null, { status: 304, headers });
    headers.set('Content-Length', String(object.size));
    return new Response('body' in object ? (object as R2ObjectBody).body : null, { headers });
});

avatars.on(['POST', 'DELETE'], '/api/account/avatar', async (c) => {
    if (c.req.header('Origin') !== c.env.AUTH_URL) return c.json({ code: 'INVALID_ORIGIN' }, 403);
    const identity = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
    if (!identity) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (identity.user.banned || !identity.user.emailVerified) return c.json({ code: 'FORBIDDEN' }, 403);
    const uploading = c.req.method === 'POST';
    const importing = uploading && c.req.header('X-Avatar-Import') === 'if-empty';
    for (const [key, window, max] of [
        [`avatar:${uploading ? 'upload' : 'remove'}:${identity.user.id}`, uploading ? 3600 : 60, uploading ? 10 : 30],
        [`avatar:ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`, 60, 60],
    ] as const) {
        const result = await databaseRateLimit(c.env.DB).consume(key, { window, max });
        if (!result.allowed) { c.header('Retry-After', String(result.retryAfter)); return c.json({ code: 'TOO_MANY_REQUESTS' }, 429); }
    }
    const now = Date.now();
    let image: string | null = null;
    if (uploading) {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        if (bytes.length > maximumImageBytes) return c.json({ code: 'IMAGE_UPLOAD_TOO_LARGE' }, 413);
        let file: ReturnType<typeof inspectImage>;
        try { file = inspectImage(bytes); } catch (error) {
            if (error instanceof AvatarImageError || error instanceof RangeError) return c.json({ code: 'AVATAR_INVALID_IMAGE' }, 400);
            throw error;
        }
        if (file.mime !== avatarMimeType || file.width !== avatarSize || file.height !== avatarSize || c.req.header('Content-Type') !== avatarMimeType) return c.json({ code: 'AVATAR_INVALID_IMAGE' }, 400);
        const id = crypto.randomUUID();
        image = `${c.env.AUTH_URL}/avatars/${id}`;
        // Register before writing R2: crashes and uncertain D1 outcomes remain collectable.
        await c.env.DB.prepare('INSERT INTO "userAvatar" ("id", "userId", "url", "createdAt", "deleteAfter") VALUES (?, ?, ?, ?, ?)')
            .bind(id, identity.user.id, image, now, now + 3_600_000).run();
        await c.env.AVATARS.put(id, file.sanitized(), { httpMetadata: { contentType: file.mime, contentDisposition: 'inline' } });
    }
    const committing = Date.now(), nowIso = new Date(committing).toISOString();
    const changed = await c.env.DB.prepare(`UPDATE "user" SET "image" = ?, "updatedAt" = ? WHERE "id" = ? AND COALESCE("banned", 0) = 0 AND "emailVerified" = 1
        AND EXISTS (SELECT 1 FROM "session" s WHERE s."id" = ? AND s."userId" = "user"."id" AND s."expiresAt" > ?)
        ${image ? 'AND EXISTS (SELECT 1 FROM "userAvatar" a WHERE a."url" = ? AND a."userId" = "user"."id" AND a."deleteAfter" > ?)' : ''}
        ${importing ? `AND ("image" IS NULL OR "image" = '')` : ''}`)
        .bind(image, nowIso, identity.user.id, identity.session.id, nowIso, ...(image ? [image, committing] : [])).run();
    if (!changed.meta.changes) {
        if (importing && await c.env.DB.prepare('SELECT 1 FROM "user" WHERE "id" = ? AND "image" IS NOT NULL AND "image" <> ?').bind(identity.user.id, '').first()) return c.json({ imported: false });
        return c.json({ code: 'UNAUTHORIZED' }, 401);
    }
    return c.json({ image });
});
