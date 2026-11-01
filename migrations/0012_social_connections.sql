CREATE TABLE "socialConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL CHECK ("type" IN ('google', 'github', 'oidc', 'oauth2')),
    "config" TEXT NOT NULL,
    "secret" TEXT,
    "enabled" INTEGER NOT NULL DEFAULT 0,
    "archived" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "identityLocked" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL
);
CREATE INDEX "socialConnection_public_idx" ON "socialConnection" ("enabled", "archived", "position", "id");
CREATE UNIQUE INDEX "account_provider_subject_idx" ON "account" ("providerId", "accountId");
CREATE TRIGGER "social_identity_lock" AFTER INSERT ON "account"
BEGIN
    UPDATE "socialConnection" SET "identityLocked" = 1 WHERE "id" = NEW."providerId";
END;
CREATE TRIGGER "social_identity_immutable" BEFORE UPDATE ON "socialConnection"
WHEN OLD."identityLocked" = 1 AND (NEW."identityLocked" <> 1 OR NEW."type" IS NOT OLD."type"
    OR json_extract(NEW."config", '$.clientId') IS NOT json_extract(OLD."config", '$.clientId')
    OR json_extract(NEW."config", '$.issuer') IS NOT json_extract(OLD."config", '$.issuer')
    OR json_extract(NEW."config", '$.discoveryUrl') IS NOT json_extract(OLD."config", '$.discoveryUrl')
    OR json_extract(NEW."config", '$.authorizationUrl') IS NOT json_extract(OLD."config", '$.authorizationUrl')
    OR json_extract(NEW."config", '$.tokenUrl') IS NOT json_extract(OLD."config", '$.tokenUrl')
    OR json_extract(NEW."config", '$.userInfoUrl') IS NOT json_extract(OLD."config", '$.userInfoUrl')
    OR json_extract(NEW."config", '$.fields.subject') IS NOT json_extract(OLD."config", '$.fields.subject'))
BEGIN
    SELECT RAISE(ABORT, 'SOCIAL_IDENTITY_CONFIG_LOCKED');
END;

-- Only encrypted profile/continuation data is kept here; never upstream tokens.
CREATE TABLE "socialFlow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectionId" TEXT NOT NULL REFERENCES "socialConnection" ("id"),
    "revision" INTEGER NOT NULL,
    "browserHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL CHECK ("purpose" IN ('login', 'link', 'reauth', 'test')),
    "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
    "sessionId" TEXT,
    "stage" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" INTEGER NOT NULL
);
CREATE INDEX "socialFlow_expiry_idx" ON "socialFlow" ("expiresAt", "id");
CREATE INDEX "socialFlow_user_idx" ON "socialFlow" ("userId");

CREATE TABLE "securityProof" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "sessionId" TEXT NOT NULL REFERENCES "session" ("id") ON DELETE CASCADE,
    "purpose" TEXT NOT NULL,
    "expiresAt" INTEGER NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "securityProof_expiry_idx" ON "securityProof" ("expiresAt", "id");

ALTER TABLE "session" ADD COLUMN "socialFlowId" TEXT;
CREATE TRIGGER "social_session_origin" BEFORE INSERT ON "session"
WHEN NEW."socialFlowId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "socialFlow" f JOIN "socialConnection" c ON c."id" = f."connectionId"
    WHERE f."id" = NEW."socialFlowId" AND f."expiresAt" > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND f."stage" IN ('exchanging', 'verified-email', 'mfa') AND (f."userId" IS NULL OR f."userId" = NEW."userId")
    AND c."revision" = f."revision" AND c."enabled" = 1 AND c."archived" = 0
    AND (f."purpose" = 'login' OR (f."purpose" = 'reauth' AND EXISTS (
        SELECT 1 FROM "session" s WHERE s."id" = f."sessionId" AND s."userId" = f."userId"
        AND s."expiresAt" > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))))
)
BEGIN
    SELECT RAISE(ABORT, 'SOCIAL_FLOW_EXPIRED');
END;

-- Account recovery, password changes and account suspension invalidate pending work.
CREATE TRIGGER "social_password_changed" AFTER UPDATE OF "password" ON "account"
WHEN OLD."password" IS NOT NEW."password"
BEGIN
    DELETE FROM "verification" WHERE "identifier" LIKE '2fa-%' AND "value" = NEW."userId";
    DELETE FROM "verification" WHERE "identifier" LIKE 'social-mfa:%' AND "value" IN (SELECT "id" FROM "socialFlow" WHERE "userId" = NEW."userId");
    DELETE FROM "socialFlow" WHERE "userId" = NEW."userId";
    DELETE FROM "securityProof" WHERE "userId" = NEW."userId";
END;
CREATE TRIGGER "social_password_added" AFTER INSERT ON "account"
WHEN NEW."providerId" = 'credential' AND NEW."password" IS NOT NULL
BEGIN
    DELETE FROM "verification" WHERE "identifier" LIKE '2fa-%' AND "value" = NEW."userId";
    DELETE FROM "verification" WHERE "identifier" LIKE 'social-mfa:%' AND "value" IN (SELECT "id" FROM "socialFlow" WHERE "userId" = NEW."userId");
    DELETE FROM "socialFlow" WHERE "userId" = NEW."userId";
    DELETE FROM "securityProof" WHERE "userId" = NEW."userId";
END;
CREATE TRIGGER "social_account_suspended" AFTER UPDATE OF "banned" ON "user"
WHEN NEW."banned" = 1
BEGIN
    DELETE FROM "verification" WHERE "identifier" LIKE '2fa-%' AND "value" = NEW."id";
    DELETE FROM "verification" WHERE "identifier" LIKE 'social-mfa:%' AND "value" IN (SELECT "id" FROM "socialFlow" WHERE "userId" = NEW."id");
    DELETE FROM "socialFlow" WHERE "userId" = NEW."id";
    DELETE FROM "securityProof" WHERE "userId" = NEW."id";
END;
