export interface Address { id: string; userId: string; email: string; verified: number; createdAt: number }
interface Challenge { id: string; userId: string; emailId: string; purpose: 'verify' | 'recovery'; hash: string; now: number; expiresAt: number; credentialHash?: string }

/** Per-account mail quota uses a fixed window, unlike the native API limiter. */
export async function consumeEmailQuota(database: D1Database, key: string) {
    const now = Date.now();
    return database.prepare(`INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest", "expiresAt") VALUES (?, ?, 1, ?, ?)
        ON CONFLICT ("key") DO UPDATE SET "count" = CASE WHEN "lastRequest" <= ? THEN 1 ELSE "count" + 1 END,
            "expiresAt" = CASE WHEN "lastRequest" <= ? THEN ? ELSE "expiresAt" END,
            "lastRequest" = CASE WHEN "lastRequest" <= ? THEN ? ELSE "lastRequest" END RETURNING "count"`)
        .bind(crypto.randomUUID(), `emails:${key}`, now, now + 60_000, now - 60_000, now - 60_000, now + 60_000, now - 60_000, now)
        .first<{ count: number }>();
}

/** Replace only this address's proof; global expired-data cleanup is scheduled. */
export async function replaceEmailChallenge(database: D1Database, challenge: Challenge) {
    const { id, userId, emailId, purpose, hash, now, expiresAt, credentialHash } = challenge;
    const results = await database.batch([
        database.prepare('DELETE FROM "emailChallenge" WHERE "userId" = ? AND "emailId" = ? AND "purpose" = ?').bind(userId, emailId, purpose),
        database.prepare(`INSERT INTO "emailChallenge" ("id", "userId", "emailId", "purpose", "codeHash", "attempts", "expiresAt", "createdAt")
            SELECT ?, ?, ?, ?, ?, 0, ?, ? WHERE EXISTS (SELECT 1 FROM "user" u JOIN "userEmail" e ON e."userId" = u."id"
                WHERE u."id" = ? AND e."id" = ? AND COALESCE(u."banned", 0) = 0 ${purpose === 'recovery' ? 'AND e."verified" = 1' : ''}
                ${credentialHash ? 'AND EXISTS (SELECT 1 FROM "account" a WHERE a."userId" = u."id" AND a."providerId" = \'credential\' AND a."password" = ?)' : ''})`)
            .bind(id, userId, emailId, purpose, hash, expiresAt, now, userId, emailId, ...(credentialHash ? [credentialHash] : [])),
    ]);
    return results[1].meta.changes;
}

export async function verifyEmailAddress(database: D1Database, emailId: string, userId: string, challengeId: string, hash: string) {
    const results = await database.batch([
        database.prepare(`UPDATE "userEmail" SET "verified" = 1 WHERE "id" = ? AND "userId" = ?
            AND EXISTS (SELECT 1 FROM "emailChallenge" WHERE "id" = ? AND "userId" = ? AND "purpose" = 'verify' AND "codeHash" = ? AND "expiresAt" > ? AND "attempts" <= 5)`)
            .bind(emailId, userId, challengeId, userId, hash, Date.now()),
        database.prepare('DELETE FROM "emailChallenge" WHERE "id" = ? AND "codeHash" = ? AND "purpose" = ?').bind(challengeId, hash, 'verify'),
    ]);
    return results[0].meta.changes;
}

export async function setPrimaryAddress(database: D1Database, address: Address, credentialHash: string) {
    const result = await database.prepare(`UPDATE "user" SET "email" = ?, "emailVerified" = 1, "updatedAt" = ?
        WHERE "id" = ? AND COALESCE("banned", 0) = 0
        AND EXISTS (SELECT 1 FROM "userEmail" e WHERE e."id" = ? AND e."userId" = "user"."id" AND e."verified" = 1)
        AND EXISTS (SELECT 1 FROM "account" a WHERE a."userId" = "user"."id" AND a."providerId" = 'credential' AND a."password" = ?)`)
        .bind(address.email, new Date().toISOString(), address.userId, address.id, credentialHash).run();
    return result.meta.changes;
}

export async function removeEmailAddress(database: D1Database, address: Address, credentialHash: string) {
    const result = await database.prepare(`DELETE FROM "userEmail" WHERE "id" = ? AND "userId" = ?
        AND EXISTS (SELECT 1 FROM "user" u JOIN "account" a ON a."userId" = u."id"
            WHERE u."id" = ? AND COALESCE(u."banned", 0) = 0 AND a."providerId" = 'credential' AND a."password" = ?)`)
        .bind(address.id, address.userId, address.userId, credentialHash).run();
    return result.meta.changes;
}

/** Consume the proof and create the native reset ticket in the same D1 batch. */
export async function consumeRecoveryChallenge(database: D1Database, userId: string, challengeId: string, hash: string, token: string, lifetime: number) {
    const now = Date.now();
    const results = await database.batch([
        database.prepare(`INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
            SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM "emailChallenge" c JOIN "userEmail" e ON e."id" = c."emailId"
                JOIN "user" u ON u."id" = c."userId" WHERE c."id" = ? AND c."purpose" = 'recovery' AND c."codeHash" = ?
                AND c."expiresAt" > ? AND c."attempts" <= 5 AND e."verified" = 1 AND COALESCE(u."banned", 0) = 0)`)
            .bind(crypto.randomUUID(), `reset-password:${token}`, userId, new Date(now + lifetime).toISOString(), new Date(now).toISOString(), new Date(now).toISOString(), challengeId, hash, now),
        database.prepare('DELETE FROM "emailChallenge" WHERE "id" = ? AND "codeHash" = ? AND "purpose" = ?').bind(challengeId, hash, 'recovery'),
    ]);
    return results[0].meta.changes;
}
