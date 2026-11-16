import { APIError } from 'better-auth/api';

/** Shared by every delivery path. Fixed windows are reserved together, before changing a proof. */
export async function reserveMail(database: D1Database, address: string, now = Date.now()) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address.trim().toLowerCase()));
    const recipient = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const budgets = JSON.stringify([
        { key: `mail:recipient:minute:${recipient}`, window: 60_000, max: 3 },
        { key: `mail:recipient:day:${recipient}`, window: 86_400_000, max: 20 },
        { key: 'mail:instance:minute', window: 60_000, max: 300 },
        { key: 'mail:instance:day', window: 86_400_000, max: 10_000 },
    ]);
    const rows = await database.prepare(`WITH budgets AS MATERIALIZED (
            SELECT json_extract(value, '$.key') AS key, json_extract(value, '$.window') AS duration,
                json_extract(value, '$.max') AS maximum FROM json_each(?)
        ), permitted AS MATERIALIZED (
            SELECT NOT EXISTS (SELECT 1 FROM budgets b JOIN rateLimit r ON r.key = b.key
                WHERE r.lastRequest > ? - b.duration AND r.count >= b.maximum) AS allowed
        ) INSERT INTO rateLimit(id, key, count, lastRequest, expiresAt)
        SELECT lower(hex(randomblob(16))), key, 1, ?, ? + duration FROM budgets WHERE (SELECT allowed FROM permitted)
        ON CONFLICT(key) DO UPDATE SET
            count = CASE WHEN rateLimit.expiresAt <= excluded.lastRequest THEN 1 ELSE rateLimit.count + 1 END,
            lastRequest = CASE WHEN rateLimit.expiresAt <= excluded.lastRequest THEN excluded.lastRequest ELSE rateLimit.lastRequest END,
            expiresAt = CASE WHEN rateLimit.expiresAt <= excluded.lastRequest THEN excluded.expiresAt ELSE rateLimit.expiresAt END
        RETURNING key`).bind(budgets, now, now, now).all();
    if (rows.results.length === 4) return { allowed: true, retryAfter: 0 };
    const denied = await database.prepare(`SELECT max(r.expiresAt - ?) AS remaining FROM json_each(?) b
        JOIN rateLimit r ON r.key = json_extract(b.value, '$.key')
        WHERE r.expiresAt > ? AND r.count >= json_extract(b.value, '$.max')`).bind(now, budgets, now).first<number>('remaining');
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(Number(denied ?? 60_000) / 1000)) };
}

export async function requireMailBudget(database: D1Database, address: string) {
    const result = await reserveMail(database, address);
    if (!result.allowed) throw new APIError('TOO_MANY_REQUESTS', { code: 'TOO_MANY_REQUESTS', retryAfter: result.retryAfter });
}
