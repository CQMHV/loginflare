-- Loginflare policy state is separate from Better Auth's token implementation.
-- Native authorizationCodeId identifies one grant across all refresh rotations.
-- Keep the original session ID after ordinary logout clears native token foreign keys.
-- Security revocation must close new grants before native session deletion runs.
ALTER TABLE "session" ADD COLUMN "oauthRevokedAt" TEXT;

CREATE TABLE "oauthGrantPolicy" (
    "authorizationCodeId" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
    "originalSessionId" TEXT NOT NULL,
    "revokedAt" TEXT
);
CREATE INDEX "oauthGrantPolicy_userId_idx" ON "oauthGrantPolicy" ("userId");
CREATE INDEX "oauthGrantPolicy_originalSessionId_idx" ON "oauthGrantPolicy" ("originalSessionId");

-- Refresh rotation does a native compare-and-set followed by a separate INSERT.
-- These guards prevent an in-flight successor from escaping a completed revocation.
-- A new grant must still have its original active session; an existing offline
-- grant may keep refreshing after that session has ended through ordinary logout.
CREATE TRIGGER "oauthRefreshToken_policy_guard" BEFORE INSERT ON "oauthRefreshToken"
WHEN NEW."authorizationCodeId" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND COALESCE("banned", 0) = 0 AND "emailVerified" = 1)
    OR EXISTS (SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId" AND "revokedAt" IS NOT NULL)
    OR (NOT EXISTS (SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId")
        AND NOT EXISTS (SELECT 1 FROM "session" WHERE "id" = NEW."sessionId" AND "userId" = NEW."userId"
            AND "oauthRevokedAt" IS NULL
            AND CASE WHEN typeof("expiresAt") IN ('integer', 'real') THEN "expiresAt" / 1000.0 ELSE unixepoch("expiresAt") END > unixepoch()))
BEGIN
    SELECT RAISE(ABORT, 'OAUTH_GRANT_UNAVAILABLE');
END;

CREATE TRIGGER "oauthAccessToken_policy_guard" BEFORE INSERT ON "oauthAccessToken"
WHEN NEW."authorizationCodeId" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND COALESCE("banned", 0) = 0 AND "emailVerified" = 1)
    OR EXISTS (SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId" AND "revokedAt" IS NOT NULL)
    OR (NOT EXISTS (SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId")
        AND NOT EXISTS (SELECT 1 FROM "session" WHERE "id" = NEW."sessionId" AND "userId" = NEW."userId"
            AND "oauthRevokedAt" IS NULL
            AND CASE WHEN typeof("expiresAt") IN ('integer', 'real') THEN "expiresAt" / 1000.0 ELSE unixepoch("expiresAt") END > unixepoch()))
BEGIN
    SELECT RAISE(ABORT, 'OAUTH_GRANT_UNAVAILABLE');
END;

CREATE TRIGGER "oauthRefreshToken_policy_register" AFTER INSERT ON "oauthRefreshToken"
WHEN NOT EXISTS (SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId")
BEGIN
    INSERT INTO "oauthGrantPolicy" ("authorizationCodeId", "userId", "clientId", "originalSessionId")
        VALUES (NEW."authorizationCodeId", NEW."userId", NEW."clientId", NEW."sessionId");
END;

CREATE TRIGGER "oauthAccessToken_policy_register" AFTER INSERT ON "oauthAccessToken"
WHEN NOT EXISTS (SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId")
BEGIN
    INSERT INTO "oauthGrantPolicy" ("authorizationCodeId", "userId", "clientId", "originalSessionId")
        VALUES (NEW."authorizationCodeId", NEW."userId", NEW."clientId", NEW."sessionId");
END;

CREATE TRIGGER "oauthGrantPolicy_revoke_tokens" AFTER UPDATE OF "revokedAt" ON "oauthGrantPolicy"
WHEN NEW."revokedAt" IS NOT NULL
BEGIN
    UPDATE "oauthRefreshToken" SET "revoked" = NEW."revokedAt"
        WHERE "authorizationCodeId" = NEW."authorizationCodeId" AND "revoked" IS NULL;
    UPDATE "oauthAccessToken" SET "revoked" = NEW."revokedAt"
        WHERE "authorizationCodeId" = NEW."authorizationCodeId" AND "revoked" IS NULL;
END;

-- The session marker blocks first grants while this trigger revokes existing ones.
-- Both changes commit together; ordinary logout never sets the marker.
CREATE TRIGGER "session_revoke_oauth_grants" AFTER UPDATE OF "oauthRevokedAt" ON "session"
WHEN NEW."oauthRevokedAt" IS NOT NULL
BEGIN
    UPDATE "oauthGrantPolicy" SET "revokedAt" = NEW."oauthRevokedAt"
        WHERE "originalSessionId" = NEW."id" AND "revokedAt" IS NULL;
END;

-- Account suspension is an authorization boundary, including offline grants.
-- The flag and all revocations commit together, even if later session cleanup fails.
CREATE TRIGGER "user_suspend_oauth_grants" AFTER UPDATE OF "banned" ON "user"
WHEN NEW."banned" = 1
BEGIN
    UPDATE "session" SET "oauthRevokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE "userId" = NEW."id" AND "oauthRevokedAt" IS NULL;
    UPDATE "oauthGrantPolicy" SET "revokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE "userId" = NEW."id" AND "revokedAt" IS NULL;
END;
