-- Machine identities are independent of people, browser sessions and user grants.
CREATE TABLE "machineApp" (
    "clientId" TEXT NOT NULL PRIMARY KEY REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
    "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0)
);
CREATE TABLE "machineRole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL UNIQUE,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TEXT NOT NULL
);
CREATE INDEX "machineRole_page_idx" ON "machineRole" ("createdAt" DESC, "id" DESC);
CREATE TABLE "machineRolePermission" (
    "roleId" TEXT NOT NULL REFERENCES "machineRole" ("id") ON DELETE CASCADE,
    "permissionId" TEXT NOT NULL REFERENCES "apiPermission" ("id") ON DELETE CASCADE,
    PRIMARY KEY ("roleId", "permissionId")
);
CREATE INDEX "machineRolePermission_permission_idx" ON "machineRolePermission" ("permissionId", "roleId");
CREATE TABLE "machineRoleManagementScope" (
    "roleId" TEXT NOT NULL REFERENCES "machineRole" ("id") ON DELETE CASCADE,
    "scope" TEXT NOT NULL CHECK ("scope" IN ('management:users:read', 'management:users:write', 'management:applications:read', 'management:applications:write', 'management:resources:read', 'management:resources:write', 'management:roles:read', 'management:roles:write', 'management:role-assignments:read', 'management:role-assignments:write', 'management:audit:read')),
    PRIMARY KEY ("roleId", "scope")
);
CREATE TABLE "machineAppRole" (
    "clientId" TEXT NOT NULL REFERENCES "machineApp" ("clientId") ON DELETE CASCADE,
    "roleId" TEXT NOT NULL REFERENCES "machineRole" ("id") ON DELETE CASCADE,
    PRIMARY KEY ("clientId", "roleId")
);
CREATE INDEX "machineAppRole_role_idx" ON "machineAppRole" ("roleId", "clientId");
CREATE VIEW "machineScope" AS
    SELECT a."clientId", p."scope", r."identifier" AS "resource" FROM "machineAppRole" a
    JOIN "machineRolePermission" rp ON rp."roleId" = a."roleId" JOIN "apiPermission" p ON p."id" = rp."permissionId"
    JOIN "oauthResource" r ON r."id" = p."resourceId"
    UNION
    SELECT a."clientId", s."scope", 'urn:loginflare:management' AS "resource" FROM "machineAppRole" a
    JOIN "machineRoleManagementScope" s ON s."roleId" = a."roleId";

-- A server-owned RFC 8707 audience: it cannot be changed through either resource API.
INSERT INTO "oauthResource" ("id", "identifier", "name", "accessTokenTtl", "allowedScopes", "disabled", "policyVersion", "createdAt", "updatedAt")
VALUES ('loginflare-management', 'urn:loginflare:management', 'Loginflare Management API', 300, '["management:users:read","management:users:write","management:applications:read","management:applications:write","management:resources:read","management:resources:write","management:roles:read","management:roles:write","management:role-assignments:read","management:role-assignments:write","management:audit:read"]', 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
CREATE TRIGGER "machine_resource_update" BEFORE UPDATE ON "oauthResource"
WHEN OLD."id" = 'loginflare-management'
BEGIN SELECT RAISE(ABORT, 'MACHINE_SYSTEM_RESOURCE'); END;
CREATE TRIGGER "machine_resource_delete" BEFORE DELETE ON "oauthResource"
WHEN OLD."id" = 'loginflare-management'
BEGIN SELECT RAISE(ABORT, 'MACHINE_SYSTEM_RESOURCE'); END;
CREATE TRIGGER "machine_permission_reserved" BEFORE INSERT ON "apiPermission"
WHEN NEW."scope" LIKE 'management:%' OR NEW."resourceId" = 'loginflare-management'
BEGIN SELECT RAISE(ABORT, 'MACHINE_SYSTEM_RESOURCE'); END;
CREATE TRIGGER "machine_app_limit" BEFORE INSERT ON "machineApp"
WHEN (SELECT COUNT(*) FROM "machineApp") >= 500
BEGIN SELECT RAISE(ABORT, 'MACHINE_LIMIT'); END;
CREATE TRIGGER "machine_role_limit" BEFORE INSERT ON "machineRole"
WHEN (SELECT COUNT(*) FROM "machineRole") >= 200
BEGIN SELECT RAISE(ABORT, 'MACHINE_LIMIT'); END;

-- The checkpoint is private, transaction-local and never populated from request claims alone.
CREATE TABLE "machineWrite" (
    "id" TEXT NOT NULL PRIMARY KEY CHECK ("id" = 'machine'),
    "clientId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "expiresAt" INTEGER NOT NULL,
    "targetUserId" TEXT
);
CREATE TRIGGER "machineWrite_authorize" BEFORE INSERT ON "machineWrite"
BEGIN
    SELECT CASE WHEN NEW."scope" = 'management:users:write' AND (NEW."targetUserId" IS NULL OR NOT EXISTS (
        SELECT 1 FROM "user" WHERE "id" = NEW."targetUserId" AND coalesce("role", 'user') <> 'admin'
    )) THEN RAISE(ABORT, 'MACHINE_ACCESS_REVOKED') END;
    SELECT CASE WHEN NEW."expiresAt" <= unixepoch() OR NOT EXISTS (
        SELECT 1 FROM "machineApp" m JOIN "oauthClient" c ON c."clientId" = m."clientId"
        JOIN "machineScope" s ON s."clientId" = m."clientId"
        JOIN "oauthClientResource" link ON link."clientId" = m."clientId" AND link."resourceId" = s."resource"
        JOIN "oauthResource" r ON r."identifier" = s."resource"
        WHERE m."clientId" = NEW."clientId" AND m."version" = NEW."version" AND coalesce(c."disabled", 0) = 0
        AND c."referenceId" = 'loginflare' AND coalesce(r."disabled", 0) = 0
        AND s."resource" = 'urn:loginflare:management' AND s."scope" = NEW."scope"
        AND NEW."scope" IN (SELECT value FROM json_each(c."clientCredentialsScopes"))
    ) THEN RAISE(ABORT, 'MACHINE_ACCESS_REVOKED') END;
END;

-- Role changes update native scope ceilings and invalidate every prior generation.
CREATE TRIGGER "machineAppRole_insert_projection" AFTER INSERT ON "machineAppRole"
BEGIN
    UPDATE "machineApp" SET "version" = "version" + 1 WHERE "clientId" = NEW."clientId";
    UPDATE "oauthClient" SET "clientCredentialsScopes" = (SELECT json_group_array("scope") FROM (SELECT DISTINCT "scope" FROM "machineScope" WHERE "clientId" = "oauthClient"."clientId" ORDER BY "scope")),
        "managementUserId" = NULL, "managementSessionId" = NULL, "managementAdministrator" = 1
    WHERE "clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" = NEW."clientId");
    DELETE FROM "oauthClientResource" WHERE "clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" = NEW."clientId")
        AND "resourceId" NOT IN (SELECT "resource" FROM "machineScope" WHERE "clientId" = "oauthClientResource"."clientId");
    INSERT OR IGNORE INTO "oauthClientResource" ("id", "clientId", "resourceId", "createdAt")
        SELECT lower(hex(randomblob(16))), s."clientId", s."resource", strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM "machineScope" s
        WHERE s."clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" = NEW."clientId");
END;

-- Role changes update native scope ceilings and invalidate every prior generation.
CREATE TRIGGER "machineAppRole_delete_projection" AFTER DELETE ON "machineAppRole"
BEGIN
    UPDATE "machineApp" SET "version" = "version" + 1 WHERE "clientId" = OLD."clientId";
    UPDATE "oauthClient" SET "clientCredentialsScopes" = (SELECT json_group_array("scope") FROM (SELECT DISTINCT "scope" FROM "machineScope" WHERE "clientId" = "oauthClient"."clientId" ORDER BY "scope")),
        "managementUserId" = NULL, "managementSessionId" = NULL, "managementAdministrator" = 1
    WHERE "clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" = OLD."clientId");
    DELETE FROM "oauthClientResource" WHERE "clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" = OLD."clientId")
        AND "resourceId" NOT IN (SELECT "resource" FROM "machineScope" WHERE "clientId" = "oauthClientResource"."clientId");
    INSERT OR IGNORE INTO "oauthClientResource" ("id", "clientId", "resourceId", "createdAt")
        SELECT lower(hex(randomblob(16))), s."clientId", s."resource", strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM "machineScope" s
        WHERE s."clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" = OLD."clientId");
END;

-- Role changes update native scope ceilings and invalidate every prior generation.
CREATE TRIGGER "machineRolePermission_insert_projection" AFTER INSERT ON "machineRolePermission"
BEGIN
    UPDATE "machineApp" SET "version" = "version" + 1 WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = NEW."roleId");
    UPDATE "oauthClient" SET "clientCredentialsScopes" = (SELECT json_group_array("scope") FROM (SELECT DISTINCT "scope" FROM "machineScope" WHERE "clientId" = "oauthClient"."clientId" ORDER BY "scope")),
        "managementUserId" = NULL, "managementSessionId" = NULL, "managementAdministrator" = 1
    WHERE "clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = NEW."roleId"));
    DELETE FROM "oauthClientResource" WHERE "clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = NEW."roleId"))
        AND "resourceId" NOT IN (SELECT "resource" FROM "machineScope" WHERE "clientId" = "oauthClientResource"."clientId");
    INSERT OR IGNORE INTO "oauthClientResource" ("id", "clientId", "resourceId", "createdAt")
        SELECT lower(hex(randomblob(16))), s."clientId", s."resource", strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM "machineScope" s
        WHERE s."clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = NEW."roleId"));
END;

-- Role changes update native scope ceilings and invalidate every prior generation.
CREATE TRIGGER "machineRolePermission_delete_projection" AFTER DELETE ON "machineRolePermission"
BEGIN
    UPDATE "machineApp" SET "version" = "version" + 1 WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = OLD."roleId");
    UPDATE "oauthClient" SET "clientCredentialsScopes" = (SELECT json_group_array("scope") FROM (SELECT DISTINCT "scope" FROM "machineScope" WHERE "clientId" = "oauthClient"."clientId" ORDER BY "scope")),
        "managementUserId" = NULL, "managementSessionId" = NULL, "managementAdministrator" = 1
    WHERE "clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = OLD."roleId"));
    DELETE FROM "oauthClientResource" WHERE "clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = OLD."roleId"))
        AND "resourceId" NOT IN (SELECT "resource" FROM "machineScope" WHERE "clientId" = "oauthClientResource"."clientId");
    INSERT OR IGNORE INTO "oauthClientResource" ("id", "clientId", "resourceId", "createdAt")
        SELECT lower(hex(randomblob(16))), s."clientId", s."resource", strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM "machineScope" s
        WHERE s."clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = OLD."roleId"));
END;

-- Role changes update native scope ceilings and invalidate every prior generation.
CREATE TRIGGER "machineRoleManagementScope_insert_projection" AFTER INSERT ON "machineRoleManagementScope"
BEGIN
    UPDATE "machineApp" SET "version" = "version" + 1 WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = NEW."roleId");
    UPDATE "oauthClient" SET "clientCredentialsScopes" = (SELECT json_group_array("scope") FROM (SELECT DISTINCT "scope" FROM "machineScope" WHERE "clientId" = "oauthClient"."clientId" ORDER BY "scope")),
        "managementUserId" = NULL, "managementSessionId" = NULL, "managementAdministrator" = 1
    WHERE "clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = NEW."roleId"));
    DELETE FROM "oauthClientResource" WHERE "clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = NEW."roleId"))
        AND "resourceId" NOT IN (SELECT "resource" FROM "machineScope" WHERE "clientId" = "oauthClientResource"."clientId");
    INSERT OR IGNORE INTO "oauthClientResource" ("id", "clientId", "resourceId", "createdAt")
        SELECT lower(hex(randomblob(16))), s."clientId", s."resource", strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM "machineScope" s
        WHERE s."clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = NEW."roleId"));
END;

-- Role changes update native scope ceilings and invalidate every prior generation.
CREATE TRIGGER "machineRoleManagementScope_delete_projection" AFTER DELETE ON "machineRoleManagementScope"
BEGIN
    UPDATE "machineApp" SET "version" = "version" + 1 WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = OLD."roleId");
    UPDATE "oauthClient" SET "clientCredentialsScopes" = (SELECT json_group_array("scope") FROM (SELECT DISTINCT "scope" FROM "machineScope" WHERE "clientId" = "oauthClient"."clientId" ORDER BY "scope")),
        "managementUserId" = NULL, "managementSessionId" = NULL, "managementAdministrator" = 1
    WHERE "clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = OLD."roleId"));
    DELETE FROM "oauthClientResource" WHERE "clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = OLD."roleId"))
        AND "resourceId" NOT IN (SELECT "resource" FROM "machineScope" WHERE "clientId" = "oauthClientResource"."clientId");
    INSERT OR IGNORE INTO "oauthClientResource" ("id", "clientId", "resourceId", "createdAt")
        SELECT lower(hex(randomblob(16))), s."clientId", s."resource", strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM "machineScope" s
        WHERE s."clientId" IN (SELECT "clientId" FROM "machineApp" WHERE "clientId" IN (SELECT "clientId" FROM "machineAppRole" WHERE "roleId" = OLD."roleId"));
END;

CREATE TRIGGER "machine_client_revoke" AFTER UPDATE OF "disabled", "clientSecret" ON "oauthClient"
WHEN NEW."disabled" IS NOT OLD."disabled" OR NEW."clientSecret" IS NOT OLD."clientSecret"
BEGIN UPDATE "machineApp" SET "version" = "version" + 1 WHERE "clientId" = NEW."clientId"; END;
CREATE TRIGGER "machine_resource_revoke" AFTER UPDATE OF "disabled", "allowedScopes" ON "oauthResource"
WHEN NEW."disabled" IS NOT OLD."disabled" OR NEW."allowedScopes" IS NOT OLD."allowedScopes"
BEGIN UPDATE "machineApp" SET "version" = "version" + 1 WHERE "clientId" IN (SELECT "clientId" FROM "oauthClientResource" WHERE "resourceId" = NEW."identifier"); END;
CREATE TRIGGER "machine_link_revoke" BEFORE DELETE ON "oauthClientResource"
BEGIN UPDATE "machineApp" SET "version" = "version" + 1 WHERE "clientId" = OLD."clientId"; END;

-- Extend the existing final-write boundary with a distinct machine principal.
-- Machine management never invents a user ID or a browser session.
DROP TRIGGER "oauthClient_management_create";
CREATE TRIGGER "oauthClient_management_create" BEFORE INSERT ON "oauthClient"
WHEN NEW."ownerId" IS NOT NULL OR NEW."managementUserId" IS NOT NULL OR EXISTS (SELECT 1 FROM "machineWrite")
BEGIN
    SELECT CASE WHEN NOT (
        EXISTS (
            SELECT 1 FROM "user" u JOIN "session" s ON s."userId" = u."id"
            WHERE u."id" = NEW."managementUserId" AND s."id" = NEW."managementSessionId"
            AND u."emailVerified" = 1 AND coalesce(u."banned", 0) = 0 AND s."oauthRevokedAt" IS NULL
            AND s."expiresAt" > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND ((NEW."managementAdministrator" = 1 AND u."role" = 'admin' AND NEW."ownerId" IS NULL)
                OR (NEW."managementAdministrator" = 0 AND NEW."ownerId" = u."id"))
        ) OR (NEW."ownerId" IS NULL AND NEW."managementUserId" IS NULL
            AND EXISTS (SELECT 1 FROM "machineWrite" WHERE "scope" = 'management:applications:write'))
    ) THEN RAISE(ABORT, 'APPLICATION_ACCESS_REVOKED') END;
    SELECT CASE WHEN NEW."ownerDisabled" <> 0 OR NEW."adminSuspended" <> 0 OR coalesce(NEW."disabled", 0) <> 0
        THEN RAISE(ABORT, 'APPLICATION_STATUS_CONFLICT') END;
END;
DROP TRIGGER "oauthClient_management_update";
CREATE TRIGGER "oauthClient_management_update" BEFORE UPDATE ON "oauthClient"
WHEN NEW."ownerId" IS NOT NULL OR NEW."managementUserId" IS NOT NULL OR EXISTS (SELECT 1 FROM "machineWrite")
BEGIN
    SELECT CASE WHEN NEW."managementAdministrator" = 0 AND OLD."adminSuspended" = 1
        THEN RAISE(ABORT, 'APPLICATION_SUSPENDED') END;
    SELECT CASE WHEN NOT (
        EXISTS (
            SELECT 1 FROM "user" u JOIN "session" s ON s."userId" = u."id"
            WHERE u."id" = NEW."managementUserId" AND s."id" = NEW."managementSessionId"
            AND u."emailVerified" = 1 AND coalesce(u."banned", 0) = 0 AND s."oauthRevokedAt" IS NULL
            AND s."expiresAt" > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND ((NEW."managementAdministrator" = 1 AND u."role" = 'admin' AND NEW."ownerDisabled" = OLD."ownerDisabled")
                OR (NEW."managementAdministrator" = 0 AND OLD."ownerId" = u."id" AND NEW."adminSuspended" = OLD."adminSuspended"))
        ) OR (NEW."managementUserId" IS NULL AND NEW."ownerDisabled" = OLD."ownerDisabled"
            AND EXISTS (SELECT 1 FROM "machineWrite" WHERE "scope" IN ('management:applications:write', 'management:resources:write')))
    ) THEN RAISE(ABORT, 'APPLICATION_ACCESS_REVOKED') END;
    SELECT CASE WHEN coalesce(NEW."disabled", 0) <> (NEW."ownerDisabled" OR NEW."adminSuspended")
        THEN RAISE(ABORT, 'APPLICATION_STATUS_CONFLICT') END;
END;
