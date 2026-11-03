-- Preserve existing connections, identities, icons and pending flows while expanding preset types.

PRAGMA defer_foreign_keys = ON;

DROP TRIGGER "social_identity_lock";

DROP TRIGGER "social_session_origin";

DROP TRIGGER "social_identity_immutable";

DROP TRIGGER "social_icon_created";

DROP TRIGGER "social_icon_changed";

DROP TRIGGER "social_icon_removed";

CREATE TABLE "socialConnection_next" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL CHECK ("type" IN ('google', 'github', 'microsoft', 'discord', 'oidc', 'oauth2')),
    "config" TEXT NOT NULL,
    "secret" TEXT,
    "enabled" INTEGER NOT NULL DEFAULT 0,
    "archived" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "identityLocked" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL,
    "iconId" TEXT REFERENCES "socialIcon" ("id")
);

INSERT INTO "socialConnection_next" SELECT * FROM "socialConnection";

DROP TABLE "socialConnection";

ALTER TABLE "socialConnection_next" RENAME TO "socialConnection";

CREATE INDEX "socialConnection_public_idx" ON "socialConnection" ("enabled", "archived", "position", "id");

CREATE INDEX "socialConnection_iconId_idx" ON "socialConnection" ("iconId") WHERE "iconId" IS NOT NULL;

CREATE TRIGGER "social_identity_lock" AFTER INSERT ON "account"
BEGIN
    UPDATE "socialConnection" SET "identityLocked" = 1 WHERE "id" = NEW."providerId";
END;

CREATE TRIGGER "social_identity_immutable" BEFORE UPDATE ON "socialConnection"
WHEN OLD."identityLocked" = 1 AND (NEW."identityLocked" <> 1 OR NEW."type" IS NOT OLD."type"
    OR json_extract(NEW."config", '$.clientId') IS NOT json_extract(OLD."config", '$.clientId')
    OR json_extract(NEW."config", '$.tenantId') IS NOT json_extract(OLD."config", '$.tenantId')
    OR json_extract(NEW."config", '$.issuer') IS NOT json_extract(OLD."config", '$.issuer')
    OR json_extract(NEW."config", '$.discoveryUrl') IS NOT json_extract(OLD."config", '$.discoveryUrl')
    OR json_extract(NEW."config", '$.authorizationUrl') IS NOT json_extract(OLD."config", '$.authorizationUrl')
    OR json_extract(NEW."config", '$.tokenUrl') IS NOT json_extract(OLD."config", '$.tokenUrl')
    OR json_extract(NEW."config", '$.userInfoUrl') IS NOT json_extract(OLD."config", '$.userInfoUrl')
    OR json_extract(NEW."config", '$.fields.subject') IS NOT json_extract(OLD."config", '$.fields.subject'))
BEGIN
    SELECT RAISE(ABORT, 'SOCIAL_IDENTITY_CONFIG_LOCKED');
END;

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

CREATE TRIGGER "social_icon_created" AFTER INSERT ON "socialConnection"
WHEN NEW."iconId" IS NOT NULL
BEGIN
    UPDATE "socialIcon" SET "deleteAfter" = NULL WHERE "id" = NEW."iconId";
END;

CREATE TRIGGER "social_icon_changed" AFTER UPDATE OF "iconId" ON "socialConnection"
WHEN OLD."iconId" IS NOT NEW."iconId"
BEGIN
    UPDATE "socialIcon" SET "deleteAfter" = CAST(unixepoch('subsec') * 1000 AS INTEGER) + 3600000
        WHERE "id" = OLD."iconId" AND NOT EXISTS (SELECT 1 FROM "socialConnection" WHERE "iconId" = OLD."iconId");
    UPDATE "socialIcon" SET "deleteAfter" = NULL WHERE "id" = NEW."iconId";
END;

CREATE TRIGGER "social_icon_removed" AFTER DELETE ON "socialConnection"
BEGIN
    UPDATE "socialIcon" SET "deleteAfter" = CAST(unixepoch('subsec') * 1000 AS INTEGER) + 3600000
        WHERE "id" = OLD."iconId" AND NOT EXISTS (SELECT 1 FROM "socialConnection" WHERE "iconId" = OLD."iconId");
END;

PRAGMA defer_foreign_keys = OFF;
