import { Hono } from 'hono';
import { z } from 'zod';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import type { Env } from './config';
import { createAuth } from './auth';
import { databaseRateLimit } from './rate-limit';
import { publicUrl } from './social-network';
import { connectionTypes, type ConnectionConfig, type ConnectionType, type PublicProvider, type SocialConnection } from '../shared/social';
import { avatarIdPattern, inspectImage } from '../shared/avatars';
import { maximumImageBytes } from '../shared/image-limits';
import { parseSvg } from '../shared/svg';

export interface ConnectionRow {
    id: string; name: string; type: ConnectionType; config: string; secret: string | null;
    enabled: number; archived: number; position: number; revision: number; linkedAccounts?: number;
    identityLocked: number; iconId: string | null;
}
export interface LoadedConnection extends Omit<ConnectionRow, 'config' | 'secret'> { config: ConnectionConfig; secret: string }
const url = z.string().max(2048).refine((value) => { try { publicUrl(value); return true; } catch { return false; } });
const field = z.string().max(100).regex(/^(?:[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*$|^$/).refine((value) => !value.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part)));
const configSchema = z.object({
    clientId: z.string().trim().min(1).max(512), issuer: url.optional(), discoveryUrl: url.optional(),
    authorizationUrl: url.optional(), tokenUrl: url.optional(), userInfoUrl: url.optional(),
    tokenAuth: z.enum(['client_secret_basic', 'client_secret_post']),
    scopes: z.array(z.string().min(1).max(200).regex(/^\S+$/)).max(20),
    fields: z.object({ subject: field.refine(Boolean), name: field, email: field, emailVerified: field, image: field }).strict(),
}).strict();
const inputSchema = z.object({
    name: z.string().trim().min(1).max(100), type: z.enum(connectionTypes), config: configSchema,
    clientSecret: z.string().min(1).max(4096).optional(), enabled: z.boolean(), archived: z.boolean(),
    revision: z.number().int().nonnegative(),
    iconId: z.string().regex(avatarIdPattern).nullable().optional(),
}).strict().refine((value) => value.type !== 'oidc' || !!value.config.issuer && !!value.config.discoveryUrl)
    .refine((value) => value.type !== 'oauth2' || !!value.config.authorizationUrl && !!value.config.tokenUrl && !!value.config.userInfoUrl);

export async function connection(env: Env, id: string, testing = false): Promise<LoadedConnection | null> {
    const row = await env.DB.prepare('SELECT * FROM "socialConnection" WHERE "id" = ? AND "archived" = 0').bind(id).first<ConnectionRow>();
    if (!row || (!testing && !row.enabled) || !row.secret) return null;
    return { ...row, config: JSON.parse(row.config) as ConnectionConfig, secret: await symmetricDecrypt({ key: env.BETTER_AUTH_SECRET, data: row.secret }) };
}
export async function publicProviders(env: Env): Promise<PublicProvider[]> {
    return (await env.DB.prepare('SELECT "id", "name", "type", "iconId" FROM "socialConnection" WHERE "enabled" = 1 AND "archived" = 0 ORDER BY "position", "id"')
        .all<Pick<ConnectionRow, 'id' | 'name' | 'type' | 'iconId'>>()).results.map(({ iconId, ...provider }) => ({ ...provider, iconUrl: socialIconUrl(iconId) }));
}
export function socialIconUrl(id: string | null): string | null { return id ? `/social/icons/${id}` : null; }
function present(env: Env, row: ConnectionRow): SocialConnection {
    return { id: row.id, name: row.name, type: row.type, position: row.position, revision: row.revision,
        config: JSON.parse(row.config) as ConnectionConfig, hasSecret: !!row.secret,
        enabled: !!row.enabled, archived: !!row.archived, identityLocked: !!row.identityLocked, linkedAccounts: row.linkedAccounts ?? 0,
        iconId: row.iconId, iconUrl: socialIconUrl(row.iconId),
        callbackURL: `${env.AUTH_URL}/api/auth/callback/${row.id}` };
}
function identityConfig(value: { type: string; config: ConnectionConfig }) {
    const c = value.config;
    return JSON.stringify([value.type, c.clientId, c.issuer, c.discoveryUrl, c.authorizationUrl, c.tokenUrl, c.userInfoUrl, c.fields.subject]);
}
type Identity = NonNullable<Awaited<ReturnType<ReturnType<typeof createAuth>['api']['getSession']>>>;
export const socialConnections = new Hono<{ Bindings: Env; Variables: { identity: Identity } }>();
socialConnections.get('/api/social/providers', async (c) => c.json({ providers: await publicProviders(c.env) }));
socialConnections.use('/api/admin/social-connections/*', async (c, next) => {
    const identity = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
    if (!identity) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (identity.user.banned || !identity.user.emailVerified || identity.user.role !== 'admin') return c.json({ code: 'FORBIDDEN' }, 403);
    c.set('identity', identity);
    if (c.req.method !== 'GET') {
        if (c.req.header('origin') !== c.env.AUTH_URL) return c.json({ code: 'INVALID_ORIGIN' }, 403);
        if (c.req.path !== '/api/admin/social-connections/icon' && !c.req.header('content-type')?.startsWith('application/json')) return c.json({ code: 'INVALID_INPUT' }, 400);
        const rate = await databaseRateLimit(c.env.DB).consume(`social:admin:${identity.user.id}`, { window: 60, max: 30 });
        if (!rate.allowed) return c.json({ code: 'TOO_MANY_REQUESTS' }, 429);
    }
    await next();
});
const administrator = `EXISTS (SELECT 1 FROM "user" u JOIN "session" s ON s."userId" = u."id" WHERE u."id" = ? AND u."role" = 'admin' AND COALESCE(u."banned", 0) = 0 AND u."emailVerified" = 1 AND s."id" = ? AND s."expiresAt" > ?)`;
const availableIcon = `(? IS NULL OR EXISTS (SELECT 1 FROM "socialIcon" i WHERE i."id" = ? AND (i."deleteAfter" IS NULL OR i."deleteAfter" > ?)))`;
async function isAdministrator(env: Env, identity: Identity) {
    return !!await env.DB.prepare(`SELECT 1 WHERE ${administrator}`).bind(identity.user.id, identity.session.id, new Date().toISOString()).first();
}
async function hasIcon(env: Env, id: string | null) {
    return !id || !!await env.DB.prepare('SELECT 1 FROM "socialIcon" WHERE "id" = ? AND ("deleteAfter" IS NULL OR "deleteAfter" > ?)').bind(id, Date.now()).first();
}
socialConnections.post('/api/admin/social-connections/icon', async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > maximumImageBytes) return c.json({ code: 'IMAGE_UPLOAD_TOO_LARGE' }, 413);
    if (!bytes.length) return c.json({ code: 'SOCIAL_ICON_INVALID' }, 400);
    let content: Uint8Array, mime: string;
    try {
        if (c.req.header('Content-Type')?.split(';')[0] === 'image/svg+xml') {
            parseSvg(bytes); content = bytes; mime = 'image/svg+xml';
        } else {
            const image = inspectImage(bytes);
            if (image.width > 2048 || image.height > 2048) return c.json({ code: 'SOCIAL_ICON_INVALID' }, 400);
            content = image.sanitized(); mime = image.mime;
        }
    } catch { return c.json({ code: 'SOCIAL_ICON_INVALID' }, 400); }
    const id = crypto.randomUUID(), now = Date.now();
    await c.env.DB.prepare('INSERT INTO "socialIcon" ("id", "createdAt", "deleteAfter") VALUES (?, ?, ?)').bind(id, now, now + 3_600_000).run();
    await c.env.AVATARS.put(`social-icons/${id}`, content, { httpMetadata: { contentType: mime, contentDisposition: 'attachment' } });
    if (!await isAdministrator(c.env, c.get('identity'))) return c.json({ code: 'UNAUTHORIZED' }, 401);
    return c.json({ iconId: id, iconUrl: socialIconUrl(id) });
});
socialConnections.on(['GET', 'HEAD'], '/social/icons/:id', async (c) => {
    const id = c.req.param('id');
    if (!avatarIdPattern.test(id)) { c.header('Cache-Control', 'no-store'); return c.body(null, 404); }
    const conditions = new Headers();
    if (c.req.header('If-None-Match')) conditions.set('If-None-Match', c.req.header('If-None-Match')!);
    const object = c.req.method === 'HEAD' ? await c.env.AVATARS.head(`social-icons/${id}`) : await c.env.AVATARS.get(`social-icons/${id}`, { onlyIf: conditions });
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
const select = `SELECT c.*, (SELECT COUNT(*) FROM "account" a WHERE a."providerId" = c."id") AS "linkedAccounts" FROM "socialConnection" c`;
socialConnections.get('/api/admin/social-connections', async (c) => {
    const rows = await c.env.DB.prepare(`${select} ORDER BY "position", "id"`).all<ConnectionRow>();
    return c.json({ connections: rows.results.map((row) => present(c.env, row)) });
});
socialConnections.post('/api/admin/social-connections/reorder', async (c) => {
    const ids = z.array(z.string().uuid()).min(1).max(100);
    const parsed = z.object({ order: ids, previousOrder: ids }).strict().refine(({ order, previousOrder }) => {
        const previous = new Set(previousOrder);
        return new Set(order).size === order.length && previous.size === previousOrder.length
            && order.length === previousOrder.length && order.every((id) => previous.has(id));
    }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ code: 'INVALID_INPUT' }, 400);
    const identity = c.get('identity');
    // Materialize the old order before updating any row so every position is
    // committed together, only if the caller's complete snapshot still matches.
    const result = await c.env.DB.prepare(`WITH currentOrder AS MATERIALIZED (
        SELECT json_group_array("id") AS ids FROM (SELECT "id" FROM "socialConnection" ORDER BY "position", "id")
    ), allowed AS MATERIALIZED (SELECT 1 FROM currentOrder WHERE ids = ? AND ${administrator})
        UPDATE "socialConnection" SET "position" = (SELECT CAST("key" AS INTEGER) FROM json_each(?) WHERE "value" = "socialConnection"."id")
        WHERE EXISTS (SELECT 1 FROM allowed)`)
        .bind(JSON.stringify(parsed.data.previousOrder), identity.user.id, identity.session.id, new Date().toISOString(), JSON.stringify(parsed.data.order)).run();
    if (!result.meta.changes) {
        if (!await isAdministrator(c.env, identity)) return c.json({ code: 'UNAUTHORIZED' }, 401);
        return c.json({ code: 'SOCIAL_CONNECTION_CONFLICT' }, 409);
    }
    const rows = await c.env.DB.prepare(`${select} ORDER BY "position", "id"`).all<ConnectionRow>();
    return c.json({ connections: rows.results.map((row) => present(c.env, row)) });
});
socialConnections.post('/api/admin/social-connections/:id/test', async (c) => {
    const body = z.object({ locale: z.enum(['en-US', 'zh-CN']) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: 'INVALID_INPUT' }, 400);
    const selected = await connection(c.env, c.req.param('id'), true);
    if (!selected) return c.json({ code: 'SOCIAL_CONNECTION_NOT_FOUND' }, 404);
    return createAuth(c.env, undefined, (task) => c.executionCtx.waitUntil(task), selected).handler(new Request(`${c.env.AUTH_URL}/api/auth/social/start`, {
        method: 'POST', headers: c.req.raw.headers, body: JSON.stringify({ connectionId: selected.id, locale: body.data.locale, purpose: 'test' }),
    }));
});
socialConnections.post('/api/admin/social-connections', async (c) => {
    const parsed = inputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !parsed.data.clientSecret) return c.json({ code: 'INVALID_INPUT' }, 400);
    const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM "socialConnection"').first<number>('n');
    if ((count ?? 0) >= 100) return c.json({ code: 'SOCIAL_CONNECTION_LIMIT' }, 400);
    const value = parsed.data, id = crypto.randomUUID(), now = new Date().toISOString();
    const iconId = value.iconId ?? null, identity = c.get('identity');
    if (!await hasIcon(c.env, iconId)) return c.json({ code: 'SOCIAL_ICON_UNAVAILABLE' }, 400);
    const secret = await symmetricEncrypt({ key: c.env.BETTER_AUTH_SECRET, data: value.clientSecret! });
    const committing = Date.now();
    const result = await c.env.DB.prepare(`INSERT INTO "socialConnection" ("id", "name", "type", "config", "secret", "position", "createdAt", "updatedAt", "iconId")
        SELECT ?, ?, ?, ?, ?, COALESCE((SELECT MAX("position") FROM "socialConnection"), -1) + 1, ?, ?, ? WHERE ${administrator} AND ${availableIcon}`)
        .bind(id, value.name, value.type, JSON.stringify(value.config), secret, now, now, iconId,
            identity.user.id, identity.session.id, new Date(committing).toISOString(), iconId, iconId, committing).run();
    if (!result.meta.changes) {
        if (!await isAdministrator(c.env, identity)) return c.json({ code: 'UNAUTHORIZED' }, 401);
        return c.json({ code: 'SOCIAL_ICON_UNAVAILABLE' }, 400);
    }
    return c.json(present(c.env, (await c.env.DB.prepare(`${select} WHERE c."id" = ?`).bind(id).first<ConnectionRow>())!), 201);
});
socialConnections.patch('/api/admin/social-connections/:id', async (c) => {
    const parsed = inputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ code: 'INVALID_INPUT' }, 400);
    const row = await c.env.DB.prepare(`${select} WHERE c."id" = ?`).bind(c.req.param('id')).first<ConnectionRow>();
    if (!row) return c.json({ code: 'SOCIAL_CONNECTION_NOT_FOUND' }, 404);
    const value = parsed.data;
    const iconId = value.iconId === undefined ? row.iconId : value.iconId, identity = c.get('identity');
    if (!await hasIcon(c.env, iconId)) return c.json({ code: 'SOCIAL_ICON_UNAVAILABLE' }, 400);
    const changingIdentity = identityConfig({ type: row.type, config: JSON.parse(row.config) as ConnectionConfig }) !== identityConfig(value);
    if (row.archived || (row.identityLocked && changingIdentity)) return c.json({ code: 'SOCIAL_IDENTITY_CONFIG_LOCKED' }, 409);
    const secret = value.clientSecret ? await symmetricEncrypt({ key: c.env.BETTER_AUTH_SECRET, data: value.clientSecret }) : row.secret;
    const committing = Date.now();
    const result = await c.env.DB.prepare(`UPDATE "socialConnection" SET "name" = ?, "type" = ?, "config" = ?, "secret" = ?, "enabled" = ?, "archived" = ?, "iconId" = ?, "revision" = "revision" + 1, "updatedAt" = ?
        WHERE "id" = ? AND "revision" = ? AND ("identityLocked" = 0 OR ? = 0) AND ${administrator} AND ${availableIcon}`)
        .bind(value.name, value.type, JSON.stringify(value.config), secret, Number(value.enabled && !value.archived), Number(value.archived), iconId, new Date(committing).toISOString(), row.id, value.revision, Number(changingIdentity),
            identity.user.id, identity.session.id, new Date(committing).toISOString(), iconId, iconId, committing).run();
    if (!result.meta.changes) {
        if (!await isAdministrator(c.env, identity)) return c.json({ code: 'UNAUTHORIZED' }, 401);
        if (!await hasIcon(c.env, iconId)) return c.json({ code: 'SOCIAL_ICON_UNAVAILABLE' }, 400);
        return c.json({ code: 'SOCIAL_CONNECTION_CONFLICT' }, 409);
    }
    return c.json(present(c.env, (await c.env.DB.prepare(`${select} WHERE c."id" = ?`).bind(row.id).first<ConnectionRow>())!));
});
