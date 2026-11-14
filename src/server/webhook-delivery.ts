import { symmetricDecrypt } from 'better-auth/crypto';
import type { Env } from './config';
import { checkResolution, publicUrl } from './social-network';
import { webhookSignature, type BusinessEvent, type BusinessEventType } from '../shared/webhooks';

const retention = 7 * 86400_000;
const delays = [300_000, 1_800_000, 7_200_000, 43_200_000, 86_400_000];
interface Job { id: string; eventId: string; subscriptionId: string; generation: number; attempts: number; totalAttempts: number; cycle: number; url: string; secret: string; type: BusinessEventType; subjectId: string; data: string; occurredAt: string }
class DeliveryError extends Error { constructor(readonly code: string, readonly httpStatus?: number) { super(code); } }
const liveSubscription = `EXISTS (SELECT 1 FROM "webhookSubscription" s JOIN "businessEvent" e ON e."id" = d."eventId" WHERE s."id" = d."subscriptionId" AND s."enabled" = 1 AND s."generation" = d."generation" AND EXISTS (SELECT 1 FROM json_each(s."events") WHERE value = e."type"))`;

async function send(env: Env, job: Job, lease: string): Promise<number> {
    const current = async () => {
        const row = await env.DB.prepare(`SELECT ${liveSubscription} AS "eligible" FROM "webhookDelivery" d WHERE d."id" = ? AND d."lease" = ? AND d."leaseUntil" > ? AND d."status" = 'pending'`).bind(job.id, lease, Date.now()).first<{ eligible: number }>();
        if (!row) throw new DeliveryError('LEASE_LOST');
        if (!row.eligible) throw new DeliveryError('SUBSCRIPTION_CHANGED');
    };
    await current();
    let url: URL;
    try { url = publicUrl(job.url); } catch { throw new DeliveryError('INVALID_TARGET'); }
    const signal = AbortSignal.timeout(5000);
    const aborted = new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DeliveryError('TIMEOUT')), { once: true }));
    const within = <T>(promise: Promise<T>) => Promise.race([promise, aborted]);
    try { await within(checkResolution(url)); }
    catch (error) { throw error instanceof DeliveryError ? error : new DeliveryError('INVALID_TARGET'); }
    const secret = await symmetricDecrypt({ key: env.BETTER_AUTH_SECRET, data: job.secret });
    const event: BusinessEvent = { version: 'v1', id: job.eventId, type: job.type, occurredAt: job.occurredAt, subject: { type: 'user', id: job.subjectId }, data: JSON.parse(job.data) };
    const body = JSON.stringify(event), timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await webhookSignature(secret, timestamp, body);
    if (signal.aborted) throw new DeliveryError('TIMEOUT');
    await current();
    let response: Response;
    try { response = await within(fetch(url, { method: 'POST', redirect: 'manual', credentials: 'omit', signal, body, headers: {
        'Content-Type': 'application/json', 'Loginflare-Event-Id': job.eventId, 'Loginflare-Delivery-Id': job.id,
        'Loginflare-Timestamp': timestamp, 'Loginflare-Signature': signature,
    } })); } catch (error) { throw error instanceof DeliveryError ? error : new DeliveryError(signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR'); }
    let count = 0;
    const reader = response.body?.getReader();
    try {
        if (Number(response.headers.get('content-length') ?? 0) > 65_536) throw new DeliveryError('RESPONSE_TOO_LARGE', response.status);
        if (response.status >= 300 && response.status < 400) throw new DeliveryError('REDIRECT_REJECTED', response.status);
        if (reader) while (true) { const part = await within(reader.read()); if (part.done) break; count += part.value.byteLength; if (count > 65_536) throw new DeliveryError('RESPONSE_TOO_LARGE', response.status); }
    } finally { if (reader) void reader.cancel().catch(() => {}); }
    return response.status;
}

/** At-least-once delivery. A lost completion write keeps the lease for safe recovery. */
export async function deliverWebhooks(env: Env, options: { maximum?: number; now?: number } = {}) {
    const started = Date.now(), now = () => options.now ?? Date.now();
    let attempted = 0;
    // Configuration changes cancel old snapshots without unbounded admin-request fan-out.
    const cursor = await env.DB.prepare('SELECT "expiresAt", "id" FROM "maintenanceCursor" WHERE "tableName" = ?').bind('webhook-cancellation').first<{ expiresAt: string; id: string }>();
    const page = await env.DB.prepare(`SELECT "id", "createdAt" FROM "webhookDelivery" WHERE "status" = 'pending' ${cursor?.id ? 'AND ("createdAt","id") > (?,?)' : ''} ORDER BY "createdAt", "id" LIMIT 100`)
        .bind(...(cursor?.id ? [cursor.expiresAt, cursor.id] : [])).all<{ id: string; createdAt: string }>();
    const last = page.results.at(-1);
    const pageIds = JSON.stringify(page.results.map((row) => row.id));
    const cancelled = page.results.length ? await env.DB.batch([
        env.DB.prepare(`UPDATE "webhookDelivery" AS d SET "status" = 'cancelled', "lastCode" = 'SUBSCRIPTION_CHANGED', "completedAt" = ?, "expiresAt" = ?, "lease" = NULL, "leaseUntil" = 0
            WHERE d."id" IN (SELECT value FROM json_each(?)) AND d."status" = 'pending' AND d."leaseUntil" <= ? AND NOT ${liveSubscription}`).bind(now(), now() + retention, pageIds, now()),
        env.DB.prepare(`UPDATE "webhookAttempt" SET "outcome" = 'uncertain', "code" = 'SUBSCRIPTION_CHANGED', "completedAt" = ?, "expiresAt" = ? WHERE "deliveryId" IN (SELECT value FROM json_each(?)) AND "outcome" = 'pending' AND EXISTS (SELECT 1 FROM "webhookDelivery" WHERE "id" = "webhookAttempt"."deliveryId" AND "status" = 'cancelled')`).bind(now(), now() + retention, pageIds),
    ]) : null;
    if (last || cursor?.id) await env.DB.prepare('INSERT INTO "maintenanceCursor" ("tableName","expiresAt","id") VALUES (?,?,?) ON CONFLICT ("tableName") DO UPDATE SET "expiresAt" = excluded."expiresAt", "id" = excluded."id"').bind('webhook-cancellation', last?.createdAt ?? '', last?.id ?? '').run();
    while (attempted < (options.maximum ?? 3) && Date.now() - started < 20_000) {
        const lease = crypto.randomUUID(), time = now();
        const candidate = await env.DB.prepare(`SELECT coalesce(
            (SELECT "id" FROM "webhookDelivery" WHERE "status" = 'pending' AND "leaseUntil" > 0 AND "leaseUntil" <= ? ORDER BY "leaseUntil", "nextAttemptAt", "id" LIMIT 1),
            (SELECT "id" FROM "webhookDelivery" WHERE "status" = 'pending' AND "leaseUntil" = 0 AND "nextAttemptAt" <= ? ORDER BY "nextAttemptAt", "id" LIMIT 1)) AS "id"`).bind(time, time).first<string>('id');
        if (!candidate) break;
        const result = await env.DB.batch([
            env.DB.prepare(`UPDATE "webhookDelivery" SET "lease" = ?, "leaseUntil" = ?, "totalAttempts" = "totalAttempts" + 1 WHERE "id" = ? AND "status" = 'pending' AND "leaseUntil" <= ? AND "nextAttemptAt" <= ?`).bind(lease, time + 30_000, candidate, time, time),
            env.DB.prepare(`UPDATE "webhookAttempt" SET "outcome" = 'uncertain', "code" = 'WORKER_INTERRUPTED', "completedAt" = ?, "expiresAt" = ? WHERE "deliveryId" = ? AND "outcome" = 'pending' AND EXISTS (SELECT 1 FROM "webhookDelivery" WHERE "id" = ? AND "lease" = ?)`).bind(time, time + retention, candidate, candidate, lease),
            env.DB.prepare(`INSERT INTO "webhookAttempt" ("id","deliveryId","number","cycle","createdAt") SELECT ?, "id", "totalAttempts", "cycle", ? FROM "webhookDelivery" WHERE "id" = ? AND "lease" = ?`).bind(lease, new Date(time).toISOString(), candidate, lease),
        ]);
        if (!result[0]!.meta.changes) continue;
        const job = await env.DB.prepare(`SELECT d.*, s."url", s."secret", e."type", e."subjectId", e."data", e."createdAt" AS "occurredAt" FROM "webhookDelivery" d JOIN "webhookSubscription" s ON s."id" = d."subscriptionId" JOIN "businessEvent" e ON e."id" = d."eventId" WHERE d."id" = ? AND d."lease" = ?`).bind(candidate, lease).first<Job>();
        if (!job) break;
        attempted++;
        let status: number | null = null, code: string | null = null;
        try { status = await send(env, job, lease); if (status < 200 || status >= 300) code = 'HTTP_ERROR'; }
        catch (error) { code = error instanceof DeliveryError ? error.code : 'DELIVERY_FAILED'; status = error instanceof DeliveryError ? error.httpStatus ?? null : null; }
        // Leave an expired/lost lease unsettled so its next owner can record an
        // uncertain attempt and retry the same event without spending a retry.
        if (code === 'LEASE_LOST') break;
        const cancelled = code === 'SUBSCRIPTION_CHANGED', success = code === null;
        const finished = cancelled || success || job.attempts >= delays.length, completed = now();
        const outcome = cancelled ? 'cancelled' : success ? 'succeeded' : finished ? 'failed' : 'pending';
        const settled = await env.DB.batch([
            env.DB.prepare(`UPDATE "webhookAttempt" SET "outcome" = ?, "code" = ?, "httpStatus" = ?, "completedAt" = ?, "expiresAt" = ? WHERE "id" = ? AND "outcome" = 'pending' AND EXISTS (SELECT 1 FROM "webhookDelivery" WHERE "id" = ? AND "lease" = ? AND "status" = 'pending' AND "leaseUntil" > max(?, unixepoch('subsec') * 1000))`)
                .bind(success ? 'succeeded' : 'failed', code, status, completed, completed + retention, lease, job.id, lease, completed),
            // Both writes are one transaction: settle only when its first
            // statement accepted this attempt under a still-live lease.
            env.DB.prepare(`UPDATE "webhookDelivery" SET "status" = ?, "attempts" = "attempts" + 1, "lastCode" = ?, "httpStatus" = ?, "nextAttemptAt" = ?, "completedAt" = ?, "expiresAt" = ?, "lease" = NULL, "leaseUntil" = 0 WHERE "id" = ? AND "lease" = ? AND "status" = 'pending' AND EXISTS (SELECT 1 FROM "webhookAttempt" WHERE "id" = ? AND "outcome" IN ('succeeded','failed') AND "completedAt" = ?)`)
                .bind(outcome, code, status, finished ? completed : completed + delays[job.attempts]!, finished ? completed : null, finished ? completed + retention : null, job.id, lease, lease, completed),
        ]);
        if (!settled[1]!.meta.changes) break;
    }
    return { attempted, cancelled: cancelled?.[0]?.meta.changes ?? 0 };
}

/** Children first; bounded pages prevent large history cascades. Pending jobs never expire. */
export async function collectWebhookHistory(env: Pick<Env, 'DB'>, now = Date.now()) {
    for (const table of ['webhookAttempt', 'webhookDelivery', 'businessEvent'] as const) {
        const name = 'webhook-history:' + table;
        const cursor = await env.DB.prepare('SELECT "expiresAt", "id" FROM "maintenanceCursor" WHERE "tableName" = ?').bind(name).first<{ expiresAt: string; id: string }>();
        const page = await env.DB.prepare(`SELECT "id","expiresAt" FROM "${table}" WHERE "expiresAt" <= ? ${cursor?.id ? 'AND ("expiresAt","id") > (?,?)' : ''} ORDER BY "expiresAt","id" LIMIT 100`)
            .bind(now, ...(cursor?.id ? [Number(cursor.expiresAt), cursor.id] : [])).all<{ id: string; expiresAt: number }>();
        const last = page.results.at(-1);
        const children = table === 'webhookDelivery' ? ' AND NOT EXISTS (SELECT 1 FROM "webhookAttempt" WHERE "deliveryId" = "webhookDelivery"."id")'
            : table === 'businessEvent' ? ' AND NOT EXISTS (SELECT 1 FROM "webhookDelivery" WHERE "eventId" = "businessEvent"."id")' : '';
        if (last || cursor?.id) await env.DB.batch([
            env.DB.prepare(`DELETE FROM "${table}" WHERE "id" IN (SELECT value FROM json_each(?)) AND "expiresAt" <= ?${children}`).bind(JSON.stringify(page.results.map((row) => row.id)), now),
            env.DB.prepare('INSERT INTO "maintenanceCursor" ("tableName","expiresAt","id") VALUES (?,?,?) ON CONFLICT ("tableName") DO UPDATE SET "expiresAt" = excluded."expiresAt", "id" = excluded."id"').bind(name, String(last?.expiresAt ?? ''), last?.id ?? ''),
        ]);
    }
}
