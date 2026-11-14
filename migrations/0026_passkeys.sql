CREATE TABLE "passkey" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "name" TEXT,
    "publicKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "credentialID" TEXT NOT NULL UNIQUE,
    "counter" INTEGER NOT NULL,
    "deviceType" TEXT NOT NULL,
    "backedUp" INTEGER NOT NULL,
    "transports" TEXT,
    "createdAt" DATE,
    "aaguid" TEXT
);
CREATE INDEX "passkey_user_idx" ON "passkey" ("userId", "id");
ALTER TABLE "session" ADD COLUMN "passkeyId" TEXT;
CREATE TRIGGER "passkey_session_guard" BEFORE INSERT ON "session"
WHEN NEW."passkeyId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "passkey" p JOIN "user" u ON u."id" = p."userId" WHERE p."id" = NEW."passkeyId" AND p."userId" = NEW."userId"
        AND u."emailVerified" = 1 AND coalesce(u."banned", 0) = 0 AND u."deletionRequestedAt" IS NULL
)
BEGIN SELECT RAISE(ABORT, 'PASSKEY_NOT_AVAILABLE'); END;
CREATE TRIGGER "passkey_counter_guard" BEFORE UPDATE OF "counter" ON "passkey"
WHEN (NEW."counter" <> 0 OR OLD."counter" <> 0) AND NEW."counter" <= OLD."counter"
BEGIN SELECT RAISE(ABORT, 'PASSKEY_COUNTER_REPLAY'); END;
CREATE INDEX "verification_passkey_registration_idx" ON "verification" (CASE WHEN json_valid("value") THEN json_extract("value", '$.userData.id') END);
CREATE INDEX "verification_passkey_permit_idx" ON "verification" (CASE WHEN json_valid("value") THEN json_extract("value", '$.userId') END);
CREATE TRIGGER "passkey_registration_guard" BEFORE INSERT ON "passkey"
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM "verification" v JOIN "user" u ON u."id" = NEW."userId"
        JOIN "session" s ON s."id" = json_extract(v."value", '$.sessionId') AND s."userId" = u."id"
        WHERE v."identifier" = 'passkey:register:' || NEW."credentialID" AND v."expiresAt" > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND json_extract(v."value", '$.userId') = u."id" AND u."emailVerified" = 1 AND coalesce(u."banned", 0) = 0 AND u."deletionRequestedAt" IS NULL
        AND s."expiresAt" > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND s."oauthRevokedAt" IS NULL
        AND (EXISTS (SELECT 1 FROM "account" a WHERE a."userId" = u."id" AND a."providerId" = 'credential' AND a."password" = json_extract(v."value", '$.authorization.credentialHash'))
            OR EXISTS (SELECT 1 FROM "securityProof" p WHERE p."id" = json_extract(v."value", '$.authorization.proofId') AND p."userId" = u."id" AND p."sessionId" = s."id"
                AND p."purpose" = 'passkeys/add' AND p."used" = 1 AND p."expiresAt" > unixepoch('subsec') * 1000))
        AND (SELECT count(*) FROM "passkey" WHERE "userId" = u."id") < 20
    ) THEN RAISE(ABORT, 'PASSKEY_NOT_AVAILABLE') END;
END;
CREATE TRIGGER "passkey_registration_consume" AFTER INSERT ON "passkey"
BEGIN DELETE FROM "verification" WHERE "identifier" = 'passkey:register:' || NEW."credentialID"; END;
CREATE TRIGGER "passkey_frozen_update" BEFORE UPDATE ON "passkey"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = OLD."userId" AND (coalesce("banned", 0) = 1 OR "emailVerified" = 0 OR "deletionRequestedAt" IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'PASSKEY_NOT_AVAILABLE'); END;
CREATE TRIGGER "passkey_last_login_method" BEFORE DELETE ON "passkey"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = OLD."userId" AND "deletionRequestedAt" IS NULL)
    AND NOT EXISTS (SELECT 1 FROM "passkey" WHERE "userId" = OLD."userId" AND "id" <> OLD."id")
    AND NOT EXISTS (SELECT 1 FROM "account" a LEFT JOIN "socialConnection" c ON c."id" = a."providerId" WHERE a."userId" = OLD."userId"
        AND ((a."providerId" = 'credential' AND a."password" IS NOT NULL) OR (c."enabled" = 1 AND c."archived" = 0)))
BEGIN SELECT RAISE(ABORT, 'PASSKEY_LAST_LOGIN_METHOD'); END;
