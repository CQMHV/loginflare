import { connectManagement, ManagementApiError, type AuditPage } from '../../management-worker/src/client';
import type { AuditExportBindings } from '../worker-configuration';

/** Bounded overlapping sweeps, with deduplication and a durable continuation. */
export async function exportAudit(env: AuditExportBindings) {
    const started = Date.now(), lease = crypto.randomUUID();
    const source = JSON.stringify([env.AUTH_ISSUER, env.MACHINE_CLIENT_ID]);
    await env.DB.prepare('INSERT INTO "exportCheckpoint" ("id","source") VALUES (1,?) ON CONFLICT ("id") DO NOTHING').bind(source).run();
    const checkpoint = await env.DB.prepare('SELECT "source","cursor" FROM "exportCheckpoint" WHERE "id" = 1').first<{ source: string; cursor: string | null }>();
    if (checkpoint?.source !== source) throw new Error('ARCHIVE_SOURCE_CHANGED');
    const claimed = await env.DB.prepare('UPDATE "exportCheckpoint" SET "lease" = ?, "leaseUntil" = ? WHERE "id" = 1 AND "leaseUntil" <= ? AND "source" = ?')
        .bind(lease, started + 60_000, started, source).run();
    if (!claimed.meta.changes) return { pages: 0, inserted: 0, busy: true };
    let pages = 0, inserted = 0;
    try {
        // Read the cursor after claiming: a concurrent exporter may have advanced it.
        let cursor = await env.DB.prepare('SELECT "cursor" FROM "exportCheckpoint" WHERE "id" = 1 AND "lease" = ?').bind(lease).first<string | null>('cursor');
        const client = await connectManagement(env, ['management:audit:read']);
        async function persist(page: AuditPage, next: string | null) {
            const owned = 'EXISTS (SELECT 1 FROM "exportCheckpoint" WHERE "id" = 1 AND "lease" = ? AND "leaseUntil" > ?)';
            const now = Date.now();
            const result = await env.DB.batch([
                // One JSON parameter avoids a 101-statement batch for a full page.
                env.DB.prepare(`INSERT INTO "auditArchive" ("id","payload","createdAt","exportedAt") SELECT json_extract(value,'$.id'), value, json_extract(value,'$.createdAt'), ? FROM json_each(?) WHERE ${owned} ON CONFLICT ("id") DO NOTHING`)
                    .bind(new Date(now).toISOString(), JSON.stringify(page.items), lease, now),
                env.DB.prepare('UPDATE "exportCheckpoint" SET "cursor" = ? WHERE "id" = 1 AND "lease" = ? AND "leaseUntil" > ?').bind(next, lease, now),
            ]);
            if (!result[1]!.meta.changes) throw new Error('EXPORT_LEASE_LOST');
            pages++; inserted += result[0]!.meta.changes;
        }
        // Always copy the newest page, then continue the older sweep. On reaching
        // the end, the next invocation starts another sweep to catch late inserts.
        const head = await client.listAuditLogs({ limit: 100 });
        const continuation = cursor ?? head.pageInfo.nextCursor;
        await persist(head, continuation);
        cursor = continuation;
        while (cursor && pages < 5 && Date.now() - started < 20_000) {
            let page: AuditPage;
            try { page = await client.listAuditLogs({ limit: 100, cursor }); }
            catch (error) {
                // Key rotation can invalidate a signed source cursor. Restart the
                // sweep after the already archived head; IDs remain deduplicated.
                if (!(error instanceof ManagementApiError) || error.code !== 'INVALID_CURSOR') throw error;
                await persist({ items: [], pageInfo: { nextCursor: null, previousCursor: null } }, head.pageInfo.nextCursor);
                break;
            }
            cursor = page.pageInfo.nextCursor;
            await persist(page, cursor);
        }
        return { pages, inserted, busy: false };
    } finally {
        await env.DB.prepare('UPDATE "exportCheckpoint" SET "lease" = NULL, "leaseUntil" = 0 WHERE "id" = 1 AND "lease" = ?').bind(lease).run();
    }
}
export default {
    fetch() { return new Response('Not found', { status: 404 }); },
    async scheduled(_event: ScheduledController, env: AuditExportBindings) {
        try { console.log(JSON.stringify({ event: 'audit_export', ...await exportAudit(env) })); }
        catch { console.error(JSON.stringify({ event: 'audit_export_failed' })); throw new Error('AUDIT_EXPORT_FAILED'); }
    },
} satisfies ExportedHandler<AuditExportBindings>;
