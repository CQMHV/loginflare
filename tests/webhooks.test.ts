import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { symmetricEncrypt } from 'better-auth/crypto';
import { resolve4, resolve6 } from 'node:dns/promises';
import { deliverWebhooks, collectWebhookHistory } from '../src/server/webhook-delivery';
import { businessEventTypes, verifyWebhook } from '../src/shared/webhooks';
import { harness, session, origin, addVerifiedEmail } from './helpers';
import { interceptSql } from './sql-race';
import worker from '../src/server/index';

vi.mock('node:dns/promises', () => ({ resolve4: vi.fn(), resolve6: vi.fn() }));
const key = 'lfwh_' + 'test-signing-key'.repeat(3), destination = 'https://hooks.example.com/inbox';
const sent: { body: string; headers: Headers; redirect: RequestRedirect | undefined }[] = [];
let reply: () => Response | Promise<Response>;
beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.mocked(resolve4).mockResolvedValue(['93.184.216.34']); vi.mocked(resolve6).mockResolvedValue([]);
    sent.length = 0; reply = () => new Response(null, { status: 204 });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith('https://hooks.example.com')) { sent.push({ body: String(init?.body), headers: new Headers(init?.headers), redirect: init?.redirect }); return reply(); }
        if (String(input).startsWith('https://challenges.cloudflare.com')) return Response.json({ success: true });
        throw new Error('Unexpected network request');
    });
});
afterEach(async () => { vi.unstubAllGlobals(); vi.clearAllMocks(); await reset(); });
async function subscription(events: readonly string[] = businessEventTypes) {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO webhookSubscription (id,name,url,events,secret,enabled,createdAt) VALUES (?,?,?,?,?,1,?)')
        .bind(id, 'Test', destination, JSON.stringify(events), await symmetricEncrypt({ key: env.BETTER_AUTH_SECRET, data: key }), new Date().toISOString()).run();
    return id;
}
function insertUser(id = crypto.randomUUID()) {
    return env.DB.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)').bind(id, 'Sensitive name', `${id}@example.com`, new Date().toISOString(), new Date().toISOString());
}
async function event() { const id = crypto.randomUUID(); await insertUser(id).run(); return id; }
const delivery = () => env.DB.prepare('SELECT * FROM webhookDelivery ORDER BY createdAt, id LIMIT 1').first<{ id: string; eventId: string; status: string; attempts: number; totalAttempts: number; cycle: number; leaseUntil: number; nextAttemptAt: number; lastCode: string; expiresAt: number }>();
async function admin() {
    const client = harness(); await client.verify(); const cookie = await client.signin(); const identity = (await session(client, cookie))!;
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(identity.user.id).run();
    return { client, cookie, identity };
}
it('commits outbox and subscription fan-out with the fact, and rolls both back on batch failure', async () => {
    await subscription(['user.created']); const id = crypto.randomUUID();
    await expect(env.DB.batch([insertUser(id), insertUser(id)])).rejects.toThrow();
    expect(await env.DB.prepare('SELECT count(*) n FROM businessEvent').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM webhookDelivery').first('n')).toBe(0);
    await insertUser(id).run();
    expect(await env.DB.prepare('SELECT count(*) n FROM webhookDelivery').first('n')).toBe(1);
    await expect(env.DB.prepare("UPDATE businessEvent SET data = '{}' ").run()).rejects.toThrow('BUSINESS_EVENT_IMMUTABLE');
});
it('emits all six facts with finite data and preserves deletion after the account is gone', async () => {
    await subscription(); const id = await event();
    await env.DB.prepare('UPDATE user SET emailVerified = 1 WHERE id = ?').bind(id).run();
    await env.DB.prepare('UPDATE user SET name = ?, image = ? WHERE id = ?').bind('Private new name', 'https://secret.example.com/?token=credential', id).run();
    await env.DB.prepare('UPDATE user SET banned = 1 WHERE id = ?').bind(id).run();
    await env.DB.prepare('UPDATE user SET banned = 0 WHERE id = ?').bind(id).run();
    // Native deletion freezes the account without claiming an administrator suspension.
    await env.DB.prepare('UPDATE user SET deletionRequestedAt = ?, banned = 1 WHERE id = ?').bind(new Date().toISOString(), id).run();
    await env.DB.prepare('DELETE FROM user WHERE id = ?').bind(id).run();
    const rows = (await env.DB.prepare('SELECT type, data, subjectId FROM businessEvent').all<{ type: string; data: string; subjectId: string }>()).results;
    expect(rows).toHaveLength(6); expect(new Set(rows.map((row) => row.type))).toEqual(new Set(businessEventTypes));
    expect(rows.find((row) => row.type === 'user.updated')?.data).toBe('{"fields":["name","image"]}');
    expect(rows.find((row) => row.type === 'email.verified')?.data).toBe('{"primary":true}');
    expect(JSON.stringify(rows)).not.toMatch(/Private|Sensitive|credential|token=|@example/);
    await deliverWebhooks(env, { maximum: 10 });
    expect(sent).toHaveLength(6); expect(sent.some((item) => JSON.parse(item.body).type === 'user.deleted')).toBe(true);
});
it('captures native signup, primary verification and auxiliary verification once each', async () => {
    const client = harness(); await subscription(['user.created', 'email.verified']); await client.verify(); const cookie = await client.signin();
    await addVerifiedEmail(client, cookie, 'secondary@example.com');
    expect((await env.DB.prepare('SELECT type FROM businessEvent WHERE type = ?').bind('email.verified').all()).results).toHaveLength(2);
    expect(sent.filter((item) => JSON.parse(item.body).type === 'email.verified')).toHaveLength(2);
});
it('claims concurrently once and sends a timestamped signature over the exact body', async () => {
    await subscription(['user.created']); await event();
    await Promise.all([deliverWebhooks(env), deliverWebhooks({ ...env })]);
    expect(sent).toHaveLength(1); const item = sent[0]!;
    const parsed = await verifyWebhook(key, item.headers.get('Loginflare-Timestamp')!, item.headers.get('Loginflare-Signature')!, item.body);
    expect(item.headers.get('Loginflare-Event-Id')).toBe(parsed.id); expect(item.headers.get('Loginflare-Delivery-Id')).toBe((await delivery())!.id);
    expect(item.redirect).toBe('manual'); expect((await delivery())!.status).toBe('succeeded');
    await expect(verifyWebhook(key, item.headers.get('Loginflare-Timestamp')!, item.headers.get('Loginflare-Signature')!, item.body + ' ')).rejects.toThrow();
});
it('uses the agreed five delays then retains the final failure for seven days', async () => {
    await subscription(['user.created']); await event(); reply = () => new Response('sensitive response token', { status: 503 });
    const delays = [300_000, 1_800_000, 7_200_000, 43_200_000, 86_400_000]; let now = Date.now() + 100;
    for (let attempt = 0; attempt < 6; attempt++) {
        await deliverWebhooks(env, { maximum: 1, now }); const row = (await delivery())!;
        expect(row.attempts).toBe(attempt + 1); expect(row.lastCode).toBe('HTTP_ERROR');
        if (attempt < 5) { expect(row.status).toBe('pending'); expect(row.nextAttemptAt).toBe(now + delays[attempt]!); now = row.nextAttemptAt; }
        else { expect(row.status).toBe('failed'); expect(row.expiresAt).toBe(now + 7 * 86400_000); }
    }
    expect(sent).toHaveLength(6); expect(await env.DB.prepare('SELECT count(*) n FROM webhookAttempt').first('n')).toBe(6);
    expect(JSON.stringify((await env.DB.prepare('SELECT * FROM webhookAttempt').all()).results)).not.toContain('sensitive');
});
it('recovers a lost completion write without pretending that a successful receiver was never called', async () => {
    await subscription(['user.created']); await event();
    const fault = interceptSql(env.DB, /UPDATE "webhookAttempt" SET "outcome" = \?/, async () => { throw new Error('D1 unavailable after accepted request'); });
    await expect(deliverWebhooks({ ...env, DB: fault.proxy })).rejects.toThrow('D1 unavailable');
    const before = (await delivery())!; expect(before.status).toBe('pending'); expect(before.attempts).toBe(0); expect(before.leaseUntil).toBeGreaterThan(Date.now());
    await deliverWebhooks(env, { now: before.leaseUntil + 1 });
    expect(sent).toHaveLength(2); expect(JSON.parse(sent[0]!.body).id).toBe(JSON.parse(sent[1]!.body).id);
    expect((await delivery())!.status).toBe('succeeded'); expect((await delivery())!.totalAttempts).toBe(2);
    expect((await env.DB.prepare('SELECT outcome,code FROM webhookAttempt ORDER BY number').all()).results).toEqual([{ outcome: 'uncertain', code: 'WORKER_INTERRUPTED' }, { outcome: 'succeeded', code: null }]);
});
it.each([{ status: 302, headers: new Headers({ Location: 'http://127.0.0.1/internal' }), code: 'REDIRECT_REJECTED' }, { status: 200, headers: new Headers({ 'Content-Length': '65537' }), code: 'RESPONSE_TOO_LARGE' }])('rejects unsafe receiver responses: $code', async ({ status, headers, code }) => {
    await subscription(['user.created']); await event(); reply = () => new Response(null, { status, headers });
    await deliverWebhooks(env); expect(sent).toHaveLength(1); expect((await delivery())!.lastCode).toBe(code);
});
it('bounds streamed responses even without Content-Length', async () => {
    await subscription(['user.created']); await event(); reply = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65_537)); controller.close(); } }));
    await deliverWebhooks(env); expect((await delivery())!.lastCode).toBe('RESPONSE_TOO_LARGE');
});
it('times out stalled responses and schedules a retry', async () => {
    await subscription(['user.created']); await event(); reply = () => new Promise(() => {});
    await deliverWebhooks(env); expect((await delivery())!.lastCode).toBe('TIMEOUT'); expect((await delivery())!.status).toBe('pending');
});
it('rechecks DNS at delivery time and rejects mixed private records without fetching', async () => {
    await subscription(['user.created']); await event(); vi.mocked(resolve6).mockResolvedValue(['::1']);
    await deliverWebhooks(env); expect(sent).toHaveLength(0); expect((await delivery())!.lastCode).toBe('INVALID_TARGET');
});
it('cancels disabled configuration snapshots and closes interrupted attempts', async () => {
    const id = await subscription(['user.created']); await event();
    const fault = interceptSql(env.DB, /UPDATE "webhookAttempt" SET "outcome" = \?/, async () => { throw new Error('completion lost'); });
    await expect(deliverWebhooks({ ...env, DB: fault.proxy })).rejects.toThrow(); const row = (await delivery())!;
    await env.DB.prepare('UPDATE webhookSubscription SET enabled = 0, generation = generation + 1 WHERE id = ?').bind(id).run();
    await deliverWebhooks(env, { now: row.leaseUntil + 1 }); expect(sent).toHaveLength(1); expect((await delivery())!.status).toBe('cancelled');
    expect(await env.DB.prepare('SELECT outcome FROM webhookAttempt').first('outcome')).toBe('uncertain');
    await collectWebhookHistory(env, row.leaseUntil + 1 + 7 * 86400_000);
    expect(await delivery()).toBeNull(); expect(await env.DB.prepare('SELECT count(*) n FROM businessEvent').first('n')).toBe(0);
});
it('does not delete pending events when their base retention elapses', async () => {
    await subscription(['user.created']); await event(); await collectWebhookHistory(env, Date.now() + 90 * 86400_000);
    expect((await delivery())!.status).toBe('pending'); expect(await env.DB.prepare('SELECT count(*) n FROM businessEvent').first('n')).toBe(1);
});
it('guards admin access, public targets, strict bodies and one-time encrypted secrets', async () => {
    const f = await admin(), path = '/api/admin/webhooks';
    expect((await f.client.request(path)).status).toBe(401);
    const input = { name: 'CRM', url: destination, events: ['user.created'], enabled: false };
    for (const url of ['http://example.com', 'https://127.0.0.1', 'https://[::1]/', 'https://example.com:8443/', 'https://user:pass@example.com/']) expect((await f.client.request(path, { cookie: f.cookie, body: { ...input, url } })).status).toBe(400);
    expect((await f.client.request(path, { cookie: f.cookie, headers: { Origin: 'https://evil.example.com' }, body: input })).status).toBe(403);
    expect((await f.client.request(path, { cookie: f.cookie, body: { ...input, secret: 'injected' } })).status).toBe(400);
    const created = await f.client.request(path, { cookie: f.cookie, body: input }); expect(created.status).toBe(201);
    const receipt = await created.json<{ id: string; secret: string }>(); expect(receipt.secret).toMatch(/^lfwh_/);
    expect(await env.DB.prepare('SELECT secret FROM webhookSubscription').first('secret')).not.toBe(receipt.secret);
    const list = await f.client.request(path, { cookie: f.cookie }); expect(await list.text()).not.toContain(receipt.secret);
    expect((await f.client.request(`${path}/${receipt.id}/rotate-secret`, { cookie: f.cookie, body: { version: 1 } })).status).toBe(200);
    expect((await f.client.request(`${path}/${receipt.id}/rotate-secret`, { cookie: f.cookie, body: { version: 1 } })).status).toBe(409);
});
it('keeps the event ID on manual redelivery, rejects stale cycles and audits successful changes only', async () => {
    const f = await admin(); await subscription(['user.created']); await event(); await deliverWebhooks(env); const row = (await delivery())!;
    const path = `/api/admin/webhooks/deliveries/${row.id}/retry`;
    const result = await f.client.request(path, { cookie: f.cookie, body: { cycle: 0 } }); expect(result.status).toBe(200);
    expect((await f.client.request(path, { cookie: f.cookie, body: { cycle: 0 } })).status).toBe(409);
    expect((await delivery())!.eventId).toBe(row.eventId); expect((await delivery())!.cycle).toBe(1);
    expect(sent).toHaveLength(2); expect(await env.DB.prepare("SELECT count(*) n FROM auditLog WHERE event = 'webhook.redelivered'").first('n')).toBe(1);
    const details = await f.client.request(`/api/admin/webhooks/deliveries/${row.id}`, { cookie: f.cookie }); expect(details.status).toBe(200);
    expect((await details.json<{ attempts: unknown[] }>()).attempts).toHaveLength(2);
});
it('bounds fan-out in the database even with competing configuration writers', async () => {
    for (let i = 0; i < 20; i++) await subscription(['user.created']);
    await expect(subscription(['user.created'])).rejects.toThrow('WEBHOOK_LIMIT_REACHED');
    await event(); expect(await env.DB.prepare('SELECT count(*) n FROM webhookDelivery').first('n')).toBe(20);
});
it('preserves queued deliveries on rename, cancels them on key rotation and rejects stale configuration writes', async () => {
    const f = await admin(), identifier = await subscription(['user.created']); await event(); reply = () => new Response(null, { status: 503 });
    const path = '/api/admin/webhooks/' + identifier, input = { name: 'Renamed', url: destination, events: ['user.created'], enabled: true, version: 1 };
    expect((await f.client.request(path, { cookie: f.cookie, method: 'PUT', body: input })).status).toBe(200);
    expect(await env.DB.prepare('SELECT generation FROM webhookSubscription').first('generation')).toBe(1); expect((await delivery())!.status).toBe('pending');
    expect((await f.client.request(path, { cookie: f.cookie, method: 'PUT', body: input })).status).toBe(409);
    expect((await f.client.request(path + '/rotate-secret', { cookie: f.cookie, body: { version: 2 } })).status).toBe(200);
    // A scan that just reached the tail resets its cursor before the next pass.
    await deliverWebhooks(env);
    expect((await delivery())!.status).toBe('cancelled'); expect(sent).toHaveLength(1);
    expect(await env.DB.prepare("SELECT count(*) n FROM auditLog WHERE event = 'webhook.updated'").first('n')).toBe(1);
});
it('pages long configurations using small scope-bound cursors without including the destination', async () => {
    const f = await admin(); await subscription(); await subscription();
    await env.DB.prepare('UPDATE webhookSubscription SET url = ?, enabled = 0').bind('https://hooks.example.com/inbox?' + 'a'.repeat(1900)).run();
    const response = await f.client.request('/api/admin/webhooks?limit=1', { cookie: f.cookie });
    const first = await response.json<{ items: { id: string }[]; pageInfo: { nextCursor: string } }>();
    expect(first.pageInfo.nextCursor.length).toBeLessThan(700);
    const next = await f.client.request('/api/admin/webhooks?limit=1&cursor=' + encodeURIComponent(first.pageInfo.nextCursor), { cookie: f.cookie });
    expect(next.status).toBe(200); expect((await next.json<{ items: { id: string }[] }>()).items[0]!.id).not.toBe(first.items[0]!.id);
    expect((await f.client.request('/api/admin/webhooks/deliveries?limit=1&cursor=' + encodeURIComponent(first.pageInfo.nextCursor), { cookie: f.cookie })).status).toBe(400);
});
it('advances history scans past more than a page of referenced pending events', async () => {
    const id = await subscription(['user.created']);
    await env.DB.batch(Array.from({ length: 101 }, () => insertUser()));
    await env.DB.prepare('UPDATE webhookSubscription SET enabled = 0 WHERE id = ?').bind(id).run();
    const unreferenced = await event(), future = Date.now() + 90 * 86400_000;
    await collectWebhookHistory(env, future); await collectWebhookHistory(env, future);
    expect(await env.DB.prepare('SELECT count(*) n FROM businessEvent WHERE subjectId = ?').bind(unreferenced).first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM businessEvent').first('n')).toBe(101);
});
it('returns the native profile response while its receiver is still waiting', async () => {
    const f = await admin(); await subscription(['user.updated']);
    let release!: (value: Response) => void;
    const waiting = new Promise<Response>((resolve) => { release = resolve; }); reply = () => waiting;
    const context = createExecutionContext();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const response = await Promise.race([
            worker.fetch(new Request(origin + '/api/auth/update-user', { method: 'POST', headers: { Origin: origin, Cookie: f.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Nonblocking update' }) }), f.client.bindings, context),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP waited on receiver')), 3000); }),
        ]);
        expect(response.status).toBe(200);
    } finally { clearTimeout(timer); release(new Response(null, { status: 204 })); await waitOnExecutionContext(context); }
    expect(sent).toHaveLength(1); expect((await delivery())!.status).toBe('succeeded');
});
it('rechecks subscription eligibility after DNS resolution and before sending', async () => {
    const id = await subscription(['user.created']); await event();
    vi.mocked(resolve4).mockImplementationOnce(async () => {
        await env.DB.prepare('UPDATE webhookSubscription SET enabled = 0, generation = generation + 1 WHERE id = ?').bind(id).run();
        return ['93.184.216.34'];
    });
    await deliverWebhooks(env); expect(sent).toHaveLength(0); expect((await delivery())!.status).toBe('cancelled');
});
