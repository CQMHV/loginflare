import { publicAssetsBase } from '../src/shared/public-assets.ts';

/** Preserve lifecycle state and ownership while changing the public URL base.
 * query executes each batch as one transaction, as in the release runner.
 */
export async function migrateAvatarUrls(query, base, { deadline = Date.now() + 60_000 } = {}) {
    let after = '', changed = 0;
    while (true) {
        if (Date.now() >= deadline) throw new Error('Avatar URL migration exceeded its time budget; retry before publishing.');
        const page = (await query([{ sql: 'SELECT "id" FROM "userAvatar" WHERE "id" > ? AND "url" <> ? || \'/\' || "id" ORDER BY "id" LIMIT 200', params: [after, base] }]))[0].results;
        if (!page.length) return changed;
        const end = page.at(-1).id;
        const range = '"id" > ? AND "id" <= ?';
        const ownedRange = 'a."id" > ? AND a."id" <= ?';
        // The first update fires normal user-change events. The final update
        // restores live references after the existing image lifecycle trigger.
        await query([
            { sql: `UPDATE "user" SET "image" = (SELECT ? || '/' || a."id" FROM "userAvatar" a WHERE a."userId" = "user"."id" AND a."url" = "user"."image" AND ${ownedRange}), "updatedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE "id" IN (SELECT a."userId" FROM "userAvatar" a WHERE ${ownedRange} AND a."url" <> ? || '/' || a."id")
                AND EXISTS (SELECT 1 FROM "userAvatar" a WHERE a."userId" = "user"."id" AND a."url" = "user"."image" AND ${ownedRange} AND a."url" <> ? || '/' || a."id")`,
                params: [base, after, end, after, end, base, after, end, base] },
            { sql: `UPDATE "userAvatar" SET "url" = ? || '/' || "id" WHERE ${range} AND "url" <> ? || '/' || "id"`, params: [base, after, end, base] },
            { sql: `UPDATE "userAvatar" SET "deleteAfter" = NULL WHERE ${range} AND "deleteAfter" IS NOT NULL AND EXISTS (SELECT 1 FROM "user" u WHERE u."id" = "userAvatar"."userId" AND u."image" = "userAvatar"."url")`, params: [after, end] },
        ]);
        changed += page.length;
        after = end;
    }
}

export { publicAssetsBase };

export async function verifyMediaHeaders(base, fetcher = fetch) {
    const response = await fetcher(`${base}/loginflare-deployment-header-check`, {
        method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    const policy = response.headers.get('Content-Security-Policy') ?? '';
    if (response.status !== 404 || response.headers.get('X-Content-Type-Options') !== 'nosniff'
        || !/(?:^|;)\s*default-src\s+'none'\s*(?:;|$)/.test(policy)
        || !/(?:^|;)\s*sandbox\s*(?:;|$)/.test(policy)
        || !/(?:^|;)\s*frame-ancestors\s+'none'\s*(?:;|$)/.test(policy)
        || !/(?:^|;)\s*script-src\s+'none'\s*(?:;|$)/.test(policy)
        || response.headers.get('Access-Control-Allow-Origin') !== '*'
        || response.headers.get('Cross-Origin-Resource-Policy') !== 'cross-origin') {
        throw new Error('Public media domain must serve R2 with the documented security headers, including on 404 responses.');
    }
}
