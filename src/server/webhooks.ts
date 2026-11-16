import { Hono } from 'hono';
import { markWebhookWork } from './request-work';
import { symmetricEncrypt } from 'better-auth/crypto';
import { z } from 'zod';
import type { Env } from './config';
import { createAuth } from './auth';
import { businessEventTypes } from '../shared/webhooks';
import { checkResolution, publicUrl } from './social-network';
import { databaseRateLimit } from './rate-limit';
import { auditStatement } from './audit';
import { PaginationError, pageBoundary, pageResult, readPageInput } from './pagination';

const config = z.object({ name: z.string().trim().min(1).max(100), url: z.string().max(2048), events: z.array(z.enum(businessEventTypes)).min(1).max(6).refine((items) => new Set(items).size === items.length), enabled: z.boolean() }).strict();
const receipt = '"id","name","url","events","enabled","version","generation","createdAt"';
const id = z.string().uuid();
const secret = () => 'lfwh_' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
function changedAudit(env: Env, actor: string, event: string, identifier: string, headers: Headers) {
    return env.DB.prepare(`INSERT INTO "auditLog" ("id","event","outcome","actorUserId","targetType","targetId","requestId","createdAt","expiresAt") SELECT ?, ?, 'success',?,'webhook',?,?,?,? WHERE changes() = 1`)
        .bind(crypto.randomUUID(), event, actor, identifier, headers.get('X-Loginflare-Request-ID') ?? crypto.randomUUID(), new Date().toISOString(), Date.now() + 90 * 86400_000);
}
type Variables = { actor: string };
export const webhooks = new Hono<{ Bindings: Env; Variables: Variables }>();
webhooks.onError((error, c) => {
    if (error instanceof PaginationError) return c.json({ code: error.code }, 400);
    if (error.message.includes('WEBHOOK_LIMIT_REACHED')) return c.json({ code: 'WEBHOOK_LIMIT_REACHED' }, 409);
    throw error;
});
webhooks.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && (c.req.header('Origin') !== c.env.AUTH_URL || c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')) return c.json({ code: 'INVALID_ORIGIN' }, 403);
    const identity = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
    if (!identity) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (identity.user.role !== 'admin' || identity.user.banned || !identity.user.emailVerified) return c.json({ code: 'FORBIDDEN' }, 403);
    c.set('actor', identity.user.id);
    const rate = await databaseRateLimit(c.env.DB).consume(`webhooks:${c.req.method}:${identity.user.id}`, { window: 60, max: c.req.method === 'GET' ? 100 : 10 });
    if (!rate.allowed) { c.header('Retry-After', String(rate.retryAfter)); return c.json({ code: 'TOO_MANY_REQUESTS' }, 429); }
    await next();
    if (c.req.method !== 'GET' && c.res.status < 400) markWebhookWork(c.env);
});
async function target(value: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const url = publicUrl(value);
        await Promise.race([checkResolution(url), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), 5000); })]);
        return url.href;
    } catch { return null; }
    finally { clearTimeout(timer); }
}
webhooks.get('/', async (c) => {
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'webhooks', 'admin', []), boundary = pageBoundary(input, 'id');
    const rows = await c.env.DB.prepare(`SELECT ${receipt} FROM "webhookSubscription" WHERE 1=1 ${boundary.sql} ORDER BY "createdAt" ${boundary.order}, "id" ${boundary.order} LIMIT ?`).bind(...boundary.values, input.limit + 1).all<{ id: string; createdAt: string }>();
    return c.json(await pageResult(rows.results, input, c.env.BETTER_AUTH_SECRET, (row) => ({ id: row.id, createdAt: row.createdAt })));
});
webhooks.post('/', async (c) => {
    const input = config.safeParse(await c.req.json().catch(() => null)); if (!input.success) return c.json({ code: 'INVALID_INPUT' }, 400);
    const url = await target(input.data.url); if (!url) return c.json({ code: 'WEBHOOK_INVALID_TARGET' }, 400);
    const count = await c.env.DB.prepare('SELECT count(*) AS total, coalesce(sum("enabled"),0) AS active FROM "webhookSubscription"').first<{ total: number; active: number }>();
    if (count!.total >= 100 || input.data.enabled && count!.active >= 20) return c.json({ code: 'WEBHOOK_LIMIT_REACHED' }, 409);
    const key = secret(), identifier = crypto.randomUUID();
    await c.env.DB.batch([
        c.env.DB.prepare('INSERT INTO "webhookSubscription" ("id","name","url","events","enabled","secret","createdAt") VALUES (?,?,?,?,?,?,?)').bind(identifier, input.data.name, url, JSON.stringify([...input.data.events].sort()), Number(input.data.enabled), await symmetricEncrypt({ key: c.env.BETTER_AUTH_SECRET, data: key }), new Date().toISOString()),
        auditStatement(c.env, { event: 'webhook.created', outcome: 'success', actorUserId: c.var.actor, targetType: 'webhook', targetId: identifier }, c.req.raw.headers),
    ]);
    return c.json({ id: identifier, secret: key }, 201);
});
webhooks.put('/:id', async (c) => {
    const input = config.extend({ version: z.number().int().positive() }).safeParse(await c.req.json().catch(() => null));
    if (!id.safeParse(c.req.param('id')).success || !input.success) return c.json({ code: 'INVALID_INPUT' }, 400);
    const url = await target(input.data.url); if (!url) return c.json({ code: 'WEBHOOK_INVALID_TARGET' }, 400);
    const events = JSON.stringify([...input.data.events].sort());
    const active = await c.env.DB.prepare('SELECT count(*) AS n FROM "webhookSubscription" WHERE "enabled" = 1 AND "id" <> ?').bind(c.req.param('id')).first<number>('n');
    if (input.data.enabled && active! >= 20) return c.json({ code: 'WEBHOOK_LIMIT_REACHED' }, 409);
    const result = await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE "webhookSubscription" SET "name" = ?, "generation" = "generation" + CASE WHEN "url" <> ? OR "events" <> ? OR "enabled" <> ? THEN 1 ELSE 0 END, "url" = ?, "events" = ?, "enabled" = ?, "version" = "version" + 1 WHERE "id" = ? AND "version" = ?`).bind(input.data.name, url, events, Number(input.data.enabled), url, events, Number(input.data.enabled), c.req.param('id'), input.data.version),
        // Audit only if the exact conditional configuration write succeeded.
        c.env.DB.prepare(`INSERT INTO "auditLog" ("id","event","outcome","actorUserId","targetType","targetId","requestId","createdAt","expiresAt") SELECT ?, 'webhook.updated','success',?,'webhook',?,?,?,? WHERE changes() = 1`).bind(crypto.randomUUID(), c.var.actor, c.req.param('id'), c.req.header('X-Loginflare-Request-ID')!, new Date().toISOString(), Date.now() + 90 * 86400_000),
    ]);
    return result[0]!.meta.changes ? c.json({ status: true }) : c.json({ code: 'WEBHOOK_CHANGED' }, 409);
});
webhooks.post('/:id/rotate-secret', async (c) => {
    const input = z.object({ version: z.number().int().positive() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!id.safeParse(c.req.param('id')).success || !input.success) return c.json({ code: 'INVALID_INPUT' }, 400);
    const key = secret();
    const changed = await c.env.DB.batch([
        c.env.DB.prepare('UPDATE "webhookSubscription" SET "secret" = ?, "version" = "version" + 1, "generation" = "generation" + 1 WHERE "id" = ? AND "version" = ?').bind(await symmetricEncrypt({ key: c.env.BETTER_AUTH_SECRET, data: key }), c.req.param('id'), input.data.version),
        changedAudit(c.env, c.var.actor, 'webhook.secret_rotated', c.req.param('id'), c.req.raw.headers),
    ]);
    if (!changed[0]!.meta.changes) return c.json({ code: 'WEBHOOK_CHANGED' }, 409);
    return c.json({ secret: key });
});
webhooks.delete('/:id', async (c) => {
    const input = z.object({ version: z.number().int().positive() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!id.safeParse(c.req.param('id')).success || !input.success) return c.json({ code: 'INVALID_INPUT' }, 400);
    const changed = await c.env.DB.batch([
        c.env.DB.prepare('DELETE FROM "webhookSubscription" WHERE "id" = ? AND "version" = ? AND "enabled" = 0 AND NOT EXISTS (SELECT 1 FROM "webhookDelivery" WHERE "subscriptionId" = "webhookSubscription"."id")').bind(c.req.param('id'), input.data.version),
        changedAudit(c.env, c.var.actor, 'webhook.deleted', c.req.param('id'), c.req.raw.headers),
    ]);
    return changed[0]!.meta.changes ? c.json({ status: true }) : c.json({ code: 'WEBHOOK_DELETE_REJECTED' }, 409);
});
const deliveryFields = `d."id",d."eventId",d."subscriptionId",d."generation",d."status",d."attempts",d."totalAttempts",d."cycle",d."nextAttemptAt",d."lastCode",d."httpStatus",d."createdAt",d."completedAt",d."expiresAt",e."type",e."subjectId"`;
webhooks.get('/deliveries', async (c) => {
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'webhook-deliveries', 'admin', ['subscriptionId', 'eventId', 'status']), boundary = pageBoundary(input, 'id');
    // Qualify the cursor columns shared by the joined event table.
    const seek = boundary.sql.replaceAll('"createdAt"', 'd."createdAt"').replaceAll('"id"', 'd."id"');
    const rows = await c.env.DB.prepare(`SELECT ${deliveryFields} FROM "webhookDelivery" d JOIN "businessEvent" e ON e."id" = d."eventId" WHERE 1=1 ${input.lookupField ? `AND d."${input.lookupField}" = ?` : ''} ${seek} ORDER BY d."createdAt" ${boundary.order}, d."id" ${boundary.order} LIMIT ?`)
        .bind(...(input.lookupField ? [input.lookupValue!] : []), ...boundary.values, input.limit + 1).all<{ id: string; createdAt: string }>();
    return c.json(await pageResult(rows.results, input, c.env.BETTER_AUTH_SECRET, (row) => ({ id: row.id, createdAt: row.createdAt })));
});
webhooks.get('/deliveries/:id', async (c) => {
    if (!/^[a-f0-9]{32}$/.test(c.req.param('id')) || new URL(c.req.url).search) return c.json({ code: 'INVALID_INPUT' }, 400);
    const row = await c.env.DB.prepare(`SELECT ${deliveryFields}, e."data" FROM "webhookDelivery" d JOIN "businessEvent" e ON e."id" = d."eventId" WHERE d."id" = ?`).bind(c.req.param('id')).first();
    if (!row) return c.json({ code: 'NOT_FOUND' }, 404);
    const attempts = await c.env.DB.prepare('SELECT "number","cycle","outcome","code","httpStatus","createdAt","completedAt" FROM "webhookAttempt" WHERE "deliveryId" = ? ORDER BY "number" DESC LIMIT 100').bind(c.req.param('id')).all();
    return c.json({ ...row, attempts: attempts.results });
});
webhooks.post('/deliveries/:id/retry', async (c) => {
    const input = z.object({ cycle: z.number().int().min(0) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!/^[a-f0-9]{32}$/.test(c.req.param('id')) || !input.success) return c.json({ code: 'INVALID_INPUT' }, 400);
    const changed = await c.env.DB.batch([
        c.env.DB.prepare(`UPDATE "webhookDelivery" AS d SET "status" = 'pending', "attempts" = 0, "cycle" = "cycle" + 1, "generation" = (SELECT "generation" FROM "webhookSubscription" WHERE "id" = d."subscriptionId"), "nextAttemptAt" = ?, "completedAt" = NULL, "expiresAt" = NULL, "lastCode" = NULL, "httpStatus" = NULL
            WHERE d."id" = ? AND d."cycle" = ? AND d."status" <> 'pending' AND d."leaseUntil" = 0 AND d."expiresAt" > ? AND EXISTS (SELECT 1 FROM "webhookSubscription" s JOIN "businessEvent" e ON e."id" = d."eventId" WHERE s."id" = d."subscriptionId" AND s."enabled" = 1 AND EXISTS (SELECT 1 FROM json_each(s."events") WHERE value = e."type"))`)
            .bind(Date.now(), c.req.param('id'), input.data.cycle, Date.now()),
        changedAudit(c.env, c.var.actor, 'webhook.redelivered', c.req.param('id'), c.req.raw.headers),
    ]);
    return changed[0]!.meta.changes ? c.json({ status: true }) : c.json({ code: 'WEBHOOK_RETRY_REJECTED' }, 409);
});
