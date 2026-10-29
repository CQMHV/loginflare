import type { Env } from './config';

const batchSize = 500;
const maximumBatches = 20;
const maximumDuration = 20_000;
const safetyBuffer = 5 * 60_000;

export interface MaintenanceResult {
    batches: number;
    deleted: Record<string, number>;
    deferred: number;
    budgetExhausted: boolean;
}

/** Credentials expire on use. Collection has separate, bounded work and seek state. */
export async function maintainDatabase(env: Pick<Env, 'DB'>, now = Date.now(), clock = Date.now): Promise<MaintenanceResult> {
    const started = clock();
    const cutoff = now - safetyBuffer;
    const cutoffIso = new Date(cutoff).toISOString();
    const nowIso = new Date(now).toISOString();
    const result: MaintenanceResult = { batches: 0, deleted: {}, deferred: 0, budgetExhausted: false };
    const positions = new Map((await env.DB.prepare('SELECT "tableName", "expiresAt", "id" FROM "maintenanceCursor"').all<{ tableName: string; expiresAt: string; id: string }>()).results.map((row) => [row.tableName, row]));
    const tasks = [
        { table: 'rateLimit', cutoff },
        { table: 'emailChallenge', cutoff },
        { table: 'verification', cutoff: cutoffIso },
        { table: 'oauthAccessToken', cutoff: cutoffIso },
        { table: 'oauthRefreshToken', cutoff: cutoffIso, guard: 'AND NOT EXISTS (SELECT 1 FROM "oauthAccessToken" a WHERE a."refreshId" = "oauthRefreshToken"."id")' },
        { table: 'session', cutoff: cutoffIso, guard: `AND NOT EXISTS (SELECT 1 FROM "oauthAccessToken" a WHERE a."sessionId" = "session"."id")
            AND NOT EXISTS (SELECT 1 FROM "oauthRefreshToken" r WHERE r."sessionId" = "session"."id")` },
    ];
    const canContinue = () => result.batches < maximumBatches && clock() - started < maximumDuration;
    let workRemains = true;
    while (workRemains && canContinue()) {
        workRemains = false;
        for (const task of tasks) {
            if (!canContinue()) break;
            const position = positions.get(task.table);
            const values: (string | number)[] = [task.cutoff];
            if (position?.id) values.push(typeof task.cutoff === 'number' ? Number(position.expiresAt) : position.expiresAt, position.id);
            values.push(batchSize);
            // Select a bounded page before reference checks, never scan for 500 eligible deletions.
            const rows = await env.DB.prepare(`SELECT "id", "expiresAt" FROM "${task.table}" WHERE "expiresAt" <= ?
                ${position?.id ? 'AND ("expiresAt", "id") > (?, ?)' : ''} ORDER BY "expiresAt", "id" LIMIT ?`)
                .bind(...values).all<{ id: string; expiresAt: string | number }>();
            const statements: D1PreparedStatement[] = [];
            for (let offset = 0; offset < rows.results.length; offset += 90) {
                const ids = rows.results.slice(offset, offset + 90).map((row) => row.id);
                statements.push(env.DB.prepare(`DELETE FROM "${task.table}" WHERE "id" IN (${ids.map(() => '?').join(',')}) AND "expiresAt" <= ? ${task.guard ?? ''}`)
                    .bind(...ids, task.cutoff));
            }
            const last = rows.results.at(-1);
            const next = { tableName: task.table, expiresAt: last ? String(last.expiresAt) : '', id: last?.id ?? '' };
            statements.push(env.DB.prepare(`INSERT INTO "maintenanceCursor" ("tableName", "expiresAt", "id") VALUES (?, ?, ?)
                ON CONFLICT ("tableName") DO UPDATE SET "expiresAt" = excluded."expiresAt", "id" = excluded."id"`)
                .bind(next.tableName, next.expiresAt, next.id));
            if (!canContinue()) break;
            const changes = await env.DB.batch(statements);
            positions.set(task.table, next);
            result.batches++;
            result.deleted[task.table] = (result.deleted[task.table] ?? 0) + changes.slice(0, -1).reduce((total, change) => total + change.meta.changes, 0);
            workRemains ||= rows.results.length === batchSize;
        }
        if (!canContinue()) break;
        const grants = await env.DB.prepare('SELECT "authorizationCodeId" FROM "oauthGrantPolicy" WHERE "gcAfter" <= ? ORDER BY "gcAfter", "authorizationCodeId" LIMIT ?')
            .bind(cutoffIso, batchSize).all<{ authorizationCodeId: string }>();
        const statements: D1PreparedStatement[] = [];
        for (let offset = 0; offset < grants.results.length; offset += 90) {
            const ids = grants.results.slice(offset, offset + 90).map((row) => row.authorizationCodeId);
            const placeholders = ids.map(() => '?').join(',');
            statements.push(env.DB.prepare(`DELETE FROM "oauthGrantPolicy" WHERE "authorizationCodeId" IN (${placeholders})
                AND NOT EXISTS (SELECT 1 FROM "oauthAccessToken" a WHERE a."authorizationCodeId" = "oauthGrantPolicy"."authorizationCodeId")
                AND NOT EXISTS (SELECT 1 FROM "oauthRefreshToken" r WHERE r."authorizationCodeId" = "oauthGrantPolicy"."authorizationCodeId")
                AND NOT EXISTS (SELECT 1 FROM "session" s WHERE s."id" = "oauthGrantPolicy"."originalSessionId" AND s."expiresAt" > ?)`)
                .bind(...ids, cutoffIso));
            statements.push(env.DB.prepare(`UPDATE "oauthGrantPolicy" SET "gcAfter" = max(?,
                coalesce((SELECT "expiresAt" FROM "oauthAccessToken" a WHERE a."authorizationCodeId" = "oauthGrantPolicy"."authorizationCodeId" ORDER BY "expiresAt" DESC LIMIT 1), ?),
                coalesce((SELECT "expiresAt" FROM "oauthRefreshToken" r WHERE r."authorizationCodeId" = "oauthGrantPolicy"."authorizationCodeId" ORDER BY "expiresAt" DESC LIMIT 1), ?),
                coalesce((SELECT "expiresAt" FROM "session" s WHERE s."id" = "oauthGrantPolicy"."originalSessionId"), ?))
                WHERE "authorizationCodeId" IN (${placeholders})`).bind(nowIso, cutoffIso, cutoffIso, cutoffIso, ...ids));
        }
        if (!canContinue()) break;
        if (statements.length) {
            const changes = await env.DB.batch(statements);
            for (const [index, change] of changes.entries()) {
                if (index % 2 === 0) result.deleted.oauthGrantPolicy = (result.deleted.oauthGrantPolicy ?? 0) + change.meta.changes;
                else result.deferred += change.meta.changes;
            }
        }
        result.batches++;
        workRemains ||= grants.results.length === batchSize;
    }
    result.budgetExhausted = !canContinue();
    return result;
}
