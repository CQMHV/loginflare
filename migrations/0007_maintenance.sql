-- Expiration is explicit so cleanup never scans a counter key or resets live limits.
ALTER TABLE "rateLimit" ADD COLUMN "expiresAt" INTEGER NOT NULL DEFAULT 0;
UPDATE "rateLimit" SET "expiresAt" = "lastRequest" + 60000;
CREATE INDEX "rateLimit_expiry_idx" ON "rateLimit" ("expiresAt", "id");
CREATE INDEX "emailChallenge_expiry_idx" ON "emailChallenge" ("expiresAt", "id");
CREATE INDEX "emailChallenge_target_idx" ON "emailChallenge" ("userId", "emailId", "purpose");
CREATE INDEX "verification_expiry_idx" ON "verification" ("expiresAt", "id");
CREATE INDEX "session_expiry_idx" ON "session" ("expiresAt", "id");
CREATE INDEX "oauthAccessToken_expiry_idx" ON "oauthAccessToken" ("expiresAt", "id");
CREATE INDEX "oauthRefreshToken_expiry_idx" ON "oauthRefreshToken" ("expiresAt", "id");
CREATE INDEX "oauthAccessToken_grant_expiry_idx" ON "oauthAccessToken" ("authorizationCodeId", "expiresAt" DESC);
CREATE INDEX "oauthRefreshToken_grant_expiry_idx" ON "oauthRefreshToken" ("authorizationCodeId", "expiresAt" DESC);

-- A grant cannot be collected before the longest-lived credential it issued.
ALTER TABLE "oauthGrantPolicy" ADD COLUMN "gcAfter" TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
UPDATE "oauthGrantPolicy" SET "gcAfter" = max(
    coalesce((SELECT "expiresAt" FROM "oauthAccessToken" WHERE "authorizationCodeId" = "oauthGrantPolicy"."authorizationCodeId" ORDER BY "expiresAt" DESC LIMIT 1), '1970-01-01T00:00:00.000Z'),
    coalesce((SELECT "expiresAt" FROM "oauthRefreshToken" WHERE "authorizationCodeId" = "oauthGrantPolicy"."authorizationCodeId" ORDER BY "expiresAt" DESC LIMIT 1), '1970-01-01T00:00:00.000Z')
);
CREATE INDEX "oauthGrantPolicy_gc_idx" ON "oauthGrantPolicy" ("gcAfter", "authorizationCodeId");

CREATE TABLE "maintenanceCursor" (
    "tableName" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" TEXT NOT NULL,
    "id" TEXT NOT NULL
);

-- Preparation makes every native date canonical ISO UTC text before this
-- migration runs; grant guards use the same representation as native reads.
DROP TRIGGER "oauthRefreshToken_policy_guard";
CREATE TRIGGER "oauthRefreshToken_policy_guard" BEFORE INSERT ON "oauthRefreshToken"
WHEN NEW."authorizationCodeId" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND COALESCE("banned", 0) = 0 AND "emailVerified" = 1)
    OR EXISTS (SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId" AND "revokedAt" IS NOT NULL)
    OR (NOT EXISTS (SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId")
        AND NOT EXISTS (SELECT 1 FROM "session" WHERE "id" = NEW."sessionId" AND "userId" = NEW."userId"
            AND "oauthRevokedAt" IS NULL
            AND "expiresAt" > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
BEGIN
    SELECT RAISE(ABORT, 'OAUTH_GRANT_UNAVAILABLE');
END;

DROP TRIGGER "oauthAccessToken_policy_guard";
CREATE TRIGGER "oauthAccessToken_policy_guard" BEFORE INSERT ON "oauthAccessToken"
WHEN NEW."authorizationCodeId" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND COALESCE("banned", 0) = 0 AND "emailVerified" = 1)
    OR EXISTS (SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId" AND "revokedAt" IS NOT NULL)
    OR (NOT EXISTS (SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId")
        AND NOT EXISTS (SELECT 1 FROM "session" WHERE "id" = NEW."sessionId" AND "userId" = NEW."userId"
            AND "oauthRevokedAt" IS NULL
            AND "expiresAt" > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
BEGIN
    SELECT RAISE(ABORT, 'OAUTH_GRANT_UNAVAILABLE');
END;

DROP TRIGGER "oauthRefreshToken_policy_register";
CREATE TRIGGER "oauthRefreshToken_policy_register" AFTER INSERT ON "oauthRefreshToken"
BEGIN
    INSERT INTO "oauthGrantPolicy" ("authorizationCodeId", "userId", "clientId", "originalSessionId", "gcAfter")
        VALUES (NEW."authorizationCodeId", NEW."userId", NEW."clientId", coalesce(NEW."sessionId", (SELECT "originalSessionId" FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId")), NEW."expiresAt")
        ON CONFLICT ("authorizationCodeId") DO UPDATE SET "gcAfter" = max("gcAfter", excluded."gcAfter");
END;
DROP TRIGGER "oauthAccessToken_policy_register";
CREATE TRIGGER "oauthAccessToken_policy_register" AFTER INSERT ON "oauthAccessToken"
BEGIN
    INSERT INTO "oauthGrantPolicy" ("authorizationCodeId", "userId", "clientId", "originalSessionId", "gcAfter")
        VALUES (NEW."authorizationCodeId", NEW."userId", NEW."clientId", coalesce(NEW."sessionId", (SELECT "originalSessionId" FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId")), NEW."expiresAt")
        ON CONFLICT ("authorizationCodeId") DO UPDATE SET "gcAfter" = max("gcAfter", excluded."gcAfter");
END;
