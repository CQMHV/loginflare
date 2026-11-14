import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import receiver from '../examples/webhook-receiver/src/index';
import { exportAudit } from '../examples/audit-export/src/index';
import { webhookSignature, type BusinessEvent } from '../src/shared/webhooks';
import { interceptSql } from './sql-race';
import type { AuditExportBindings } from '../examples/audit-export/worker-configuration';
import inboxSchema from '../examples/webhook-receiver/migrations/0001_inbox.sql?raw';
import archiveSchema from '../examples/audit-export/migrations/0001_archive.sql?raw';

const key = 'lfwh_receiver-example-test-key', configuration: AuditExportBindings = { DB: env.DB, AUTH_ISSUER: 'https://identity.example.com/api/auth', MACHINE_CLIENT_ID: 'archive-client', MACHINE_CLIENT_SECRET: 'archive-secret' };
beforeEach(async () => { for (const schema of [inboxSchema, archiveSchema]) for (const statement of schema.split(';').filter((sql) => sql.trim())) await env.DB.prepare(statement).run(); });
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
const fact: BusinessEvent = { version: 'v1', id: 'a'.repeat(32), type: 'user.deleted', occurredAt: '2026-11-14T00:00:00.000Z', subject: { type: 'user', id: 'deleted-person' }, data: {} };
async function notification(options: { timestamp?: string; body?: string; signature?: string; eventId?: string } = {}) {
    const body = options.body ?? JSON.stringify(fact), timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
    return new Request('https://receiver.example.com/webhooks', { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'Loginflare-Timestamp': timestamp, 'Loginflare-Signature': options.signature ?? await webhookSignature(key, timestamp, body), 'Loginflare-Event-Id': options.eventId ?? fact.id } });
}
it('accepts authenticated events once across duplicate and newly signed manual redeliveries', async () => {
    const bindings = { DB: env.DB, WEBHOOK_SECRET: key };
    expect((await receiver.fetch(await notification(), bindings)).status).toBe(200);
    expect(await (await receiver.fetch(await notification(), bindings)).json()).toEqual({ code: 'DUPLICATE' });
    expect(await env.DB.prepare('SELECT count(*) n FROM webhookInbox').first('n')).toBe(1);
});
it('rejects stale replay, signature tampering, mismatched IDs, unsupported data and oversized streams', async () => {
    const bindings = { DB: env.DB, WEBHOOK_SECRET: key };
    for (const options of [{ timestamp: String(Math.floor(Date.now() / 1000) - 301) }, { signature: 'v1=' + '0'.repeat(64) }, { eventId: 'b'.repeat(32) }, { body: JSON.stringify({ ...fact, data: { token: 'unexpected' } }) }, { body: 'x'.repeat(16_385) }]) {
        expect((await receiver.fetch(await notification(options), bindings)).ok).toBe(false);
    }
    expect(await env.DB.prepare('SELECT count(*) n FROM webhookInbox').first('n')).toBe(0);
});
it('returns retryable failure when the durable inbox does not commit', async () => {
    const fault = interceptSql(env.DB, /INSERT INTO "webhookInbox"/, async () => { throw new Error('D1 failure'); });
    expect((await receiver.fetch(await notification(), { DB: fault.proxy, WEBHOOK_SECRET: key })).status).toBe(503);
    expect((await receiver.fetch(await notification(), { DB: env.DB, WEBHOOK_SECRET: key })).status).toBe(200);
});
it('does not strip a byte-order mark before checking the raw-body signature', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000)), body = JSON.stringify(fact);
    const request = await notification({ timestamp, body: '\ufeff' + body, signature: await webhookSignature(key, timestamp, body) });
    expect((await receiver.fetch(request, { DB: env.DB, WEBHOOK_SECRET: key })).status).toBe(401);
    expect(await env.DB.prepare('SELECT count(*) n FROM webhookInbox').first('n')).toBe(0);
});
function mockAudit(source: (cursor: string | null) => { ids: string[]; next: string | null } | Response) {
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/oauth2/token')) {
            expect(new URLSearchParams(String(init?.body)).get('scope')).toBe('management:audit:read');
            return Response.json({ access_token: 'test.access.token', token_type: 'Bearer', expires_in: 300, scope: 'management:audit:read' });
        }
        requests.push(url.searchParams.get('cursor') ?? 'head');
        const page = source(url.searchParams.get('cursor')); if (page instanceof Response) return page;
        return Response.json({ items: page.ids.map((id) => ({ id, event: 'user.suspended', outcome: 'success', createdAt: '2026-11-14T00:00:00.000Z', actorUserId: 'admin', targetUserId: 'person', requestId: 'request', ipAddress: '192.0.2.1', userAgent: 'Fixture', unknownCredential: 'must-not-export' })), pageInfo: { nextCursor: page.next, previousCursor: null } });
    });
    return requests;
}
it('archives full allowlisted audit fields and repeats bounded sweeps with ID deduplication', async () => {
    const requests = mockAudit((cursor) => cursor ? { ids: ['older'], next: null } : { ids: ['latest'], next: 'older-page' });
    expect(await exportAudit(configuration)).toMatchObject({ pages: 2, inserted: 2 });
    expect(await exportAudit(configuration)).toMatchObject({ pages: 2, inserted: 0 });
    expect(requests).toEqual(['head', 'older-page', 'head', 'older-page']);
    const payload = await env.DB.prepare('SELECT payload FROM auditArchive LIMIT 1').first<string>('payload');
    expect(JSON.parse(payload!)).toMatchObject({ actorUserId: 'admin', targetUserId: 'person', requestId: 'request', userAgent: 'Fixture' });
    expect(payload).not.toContain('must-not-export'); expect(payload).not.toContain('test.access.token');
});
it('coordinates simultaneous Cron invocations with a database lease', async () => {
    mockAudit(() => ({ ids: ['one'], next: null }));
    const results = await Promise.all([exportAudit(configuration), exportAudit({ ...configuration })]);
    expect(results.filter((result) => result.busy)).toHaveLength(1); expect(await env.DB.prepare('SELECT count(*) n FROM auditArchive').first('n')).toBe(1);
});
it('persists a continuation after five pages and resumes while polling the latest head', async () => {
    const requests = mockAudit((cursor) => { const number = Number(cursor ?? 0); return { ids: ['event-' + number], next: number < 6 ? String(number + 1) : null }; });
    expect((await exportAudit(configuration)).pages).toBe(5);
    expect(await env.DB.prepare('SELECT cursor FROM exportCheckpoint').first('cursor')).toBe('5');
    expect((await exportAudit(configuration)).pages).toBe(3);
    expect(requests).toEqual(['head', '1', '2', '3', '4', 'head', '5', '6']);
    expect(await env.DB.prepare('SELECT count(*) n FROM auditArchive').first('n')).toBe(7);
});
it('keeps archive and cursor unchanged when a page transaction fails, then recovers', async () => {
    mockAudit(() => ({ ids: ['one'], next: 'page-two' }));
    const fault = interceptSql(env.DB, /INSERT INTO "auditArchive"/, async () => { throw new Error('storage unavailable'); });
    await expect(exportAudit({ ...configuration, DB: fault.proxy })).rejects.toThrow('storage unavailable');
    expect(await env.DB.prepare('SELECT cursor FROM exportCheckpoint').first('cursor')).toBeNull();
    expect(await env.DB.prepare('SELECT count(*) n FROM auditArchive').first('n')).toBe(0);
    mockAudit(() => ({ ids: ['one'], next: null })); expect((await exportAudit(configuration)).inserted).toBe(1);
});
it('retains committed progress on API errors and reclaims an interrupted exporter after lease expiry', async () => {
    mockAudit((cursor) => cursor ? Response.json({ code: 'SERVICE_UNAVAILABLE' }, { status: 503 }) : { ids: ['head'], next: 'continue' });
    await expect(exportAudit(configuration)).rejects.toThrow('SERVICE_UNAVAILABLE');
    expect(await env.DB.prepare('SELECT cursor FROM exportCheckpoint').first('cursor')).toBe('continue');
    await env.DB.prepare('UPDATE exportCheckpoint SET lease = ?, leaseUntil = ?').bind('crashed-worker', Date.now() + 60_000).run();
    expect((await exportAudit(configuration)).busy).toBe(true);
    await env.DB.prepare('UPDATE exportCheckpoint SET leaseUntil = 1').run();
    mockAudit(() => ({ ids: ['tail'], next: null })); expect((await exportAudit(configuration)).inserted).toBe(1);
});
it('refuses to mix archives between source instances or machine identities', async () => {
    mockAudit(() => ({ ids: ['one'], next: null })); await exportAudit(configuration);
    await expect(exportAudit({ ...configuration, MACHINE_CLIENT_ID: 'another-client' })).rejects.toThrow('ARCHIVE_SOURCE_CHANGED');
});
it('restarts a sweep if source key rotation invalidates its cursor', async () => {
    mockAudit(() => ({ ids: ['head'], next: null })); await exportAudit(configuration);
    await env.DB.prepare('UPDATE exportCheckpoint SET cursor = ?').bind('old-signed-cursor').run();
    mockAudit((cursor) => cursor ? Response.json({ code: 'INVALID_CURSOR' }, { status: 400 }) : { ids: ['head'], next: 'new-cursor' });
    await exportAudit(configuration); expect(await env.DB.prepare('SELECT cursor FROM exportCheckpoint').first('cursor')).toBe('new-cursor');
});
