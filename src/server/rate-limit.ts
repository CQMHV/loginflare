/** Persistent, atomic implementation of Better Auth's rate-limit storage. */
export function databaseRateLimit(database: D1Database) {
    return {
        async consume(key: string, rule: { window: number; max: number }) {
            const now = Date.now();
            const cutoff = now - rule.window * 1000;
            const row = await database.prepare(`INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest", "expiresAt")
                VALUES (?, ?, 1, ?, ?) ON CONFLICT ("key") DO UPDATE SET
                    "count" = CASE WHEN "lastRequest" <= ? THEN 1 ELSE "count" + 1 END,
                    "lastRequest" = ?, "expiresAt" = ?
                WHERE "lastRequest" <= ? OR "count" < ? RETURNING "count"`)
                .bind(crypto.randomUUID(), key, now, now + rule.window * 1000, cutoff, now, now + rule.window * 1000, cutoff, rule.max)
                .first<{ count: number }>();
            if (row) return { allowed: true, retryAfter: null };
            // A denied request does not increment the count or extend the window.
            const denied = await database.prepare('SELECT "lastRequest" FROM "rateLimit" WHERE "key" = ?')
                .bind(key).first<{ lastRequest: number }>();
            if (!denied) throw new Error('Rate-limit state unavailable');
            return { allowed: false, retryAfter: Math.max(1, Math.ceil((Number(denied.lastRequest) + rule.window * 1000 - now) / 1000)) };
        },
    };
}
