-- Keep existing registrations instance-managed; only new self-service clients receive an owner.
ALTER TABLE "oauthClient" ADD COLUMN "ownerId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE;
ALTER TABLE "oauthClient" ADD COLUMN "ownerDisabled" INTEGER NOT NULL DEFAULT 0 CHECK ("ownerDisabled" IN (0, 1));
ALTER TABLE "oauthClient" ADD COLUMN "adminSuspended" INTEGER NOT NULL DEFAULT 0 CHECK ("adminSuspended" IN (0, 1));
ALTER TABLE "oauthClient" ADD COLUMN "managementUserId" TEXT;
ALTER TABLE "oauthClient" ADD COLUMN "managementSessionId" TEXT;
ALTER TABLE "oauthClient" ADD COLUMN "managementAdministrator" INTEGER NOT NULL DEFAULT 0 CHECK ("managementAdministrator" IN (0, 1));

UPDATE "oauthClient" SET "adminSuspended" = COALESCE("disabled", 0);

CREATE INDEX "oauthClient_ownerId_createdAt_clientId_idx" ON "oauthClient" ("ownerId", "createdAt" DESC, "clientId" DESC);
CREATE INDEX "oauthClient_ownerId_name_createdAt_clientId_idx" ON "oauthClient" ("ownerId", "name", "createdAt" DESC, "clientId" DESC);

CREATE TRIGGER "oauthClient_owner_immutable" BEFORE UPDATE OF "ownerId" ON "oauthClient"
WHEN NEW."ownerId" IS NOT OLD."ownerId"
BEGIN
    SELECT RAISE(ABORT, 'APPLICATION_OWNERSHIP_IMMUTABLE');
END;

CREATE TRIGGER "oauthClient_owner_limit" BEFORE INSERT ON "oauthClient"
WHEN NEW."ownerId" IS NOT NULL AND (SELECT COUNT(*) FROM "oauthClient" WHERE "ownerId" = NEW."ownerId") >= 20
BEGIN
    SELECT RAISE(ABORT, 'APPLICATION_LIMIT');
END;

-- Server-only schema defaults/onUpdate fields stamp the current actor. The
-- statements below recheck eligibility at the native adapter's actual write.
CREATE TRIGGER "oauthClient_management_create" BEFORE INSERT ON "oauthClient"
WHEN NEW."ownerId" IS NOT NULL OR NEW."managementUserId" IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM "user" u JOIN "session" s ON s."userId" = u."id"
        WHERE u."id" = NEW."managementUserId" AND s."id" = NEW."managementSessionId"
        AND u."emailVerified" = 1 AND COALESCE(u."banned", 0) = 0 AND s."oauthRevokedAt" IS NULL
        AND s."expiresAt" > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND ((NEW."managementAdministrator" = 1 AND u."role" = 'admin' AND NEW."ownerId" IS NULL)
            OR (NEW."managementAdministrator" = 0 AND NEW."ownerId" = u."id"))
    ) THEN RAISE(ABORT, 'APPLICATION_ACCESS_REVOKED') END;
    SELECT CASE WHEN NEW."ownerDisabled" <> 0 OR NEW."adminSuspended" <> 0 OR COALESCE(NEW."disabled", 0) <> 0
        THEN RAISE(ABORT, 'APPLICATION_STATUS_CONFLICT') END;
END;

CREATE TRIGGER "oauthClient_management_update" BEFORE UPDATE ON "oauthClient"
WHEN NEW."ownerId" IS NOT NULL OR NEW."managementUserId" IS NOT NULL
BEGIN
    SELECT CASE WHEN NEW."managementAdministrator" = 0 AND OLD."adminSuspended" = 1
        THEN RAISE(ABORT, 'APPLICATION_SUSPENDED') END;
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM "user" u JOIN "session" s ON s."userId" = u."id"
        WHERE u."id" = NEW."managementUserId" AND s."id" = NEW."managementSessionId"
        AND u."emailVerified" = 1 AND COALESCE(u."banned", 0) = 0 AND s."oauthRevokedAt" IS NULL
        AND s."expiresAt" > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        AND ((NEW."managementAdministrator" = 1 AND u."role" = 'admin' AND NEW."ownerDisabled" = OLD."ownerDisabled")
            OR (NEW."managementAdministrator" = 0 AND OLD."ownerId" = u."id" AND NEW."adminSuspended" = OLD."adminSuspended"))
    ) THEN RAISE(ABORT, 'APPLICATION_ACCESS_REVOKED') END;
    SELECT CASE WHEN COALESCE(NEW."disabled", 0) <> (NEW."ownerDisabled" OR NEW."adminSuspended")
        THEN RAISE(ABORT, 'APPLICATION_STATUS_CONFLICT') END;
END;
