CREATE TABLE "apiPermission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceId" TEXT NOT NULL REFERENCES "oauthResource" ("id") ON DELETE CASCADE,
    "scope" TEXT NOT NULL UNIQUE,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" DATE NOT NULL
);
CREATE INDEX "apiPermission_resource_idx" ON "apiPermission" ("resourceId", "createdAt" DESC, "id" DESC);
CREATE INDEX "apiPermission_page_idx" ON "apiPermission" ("createdAt" DESC, "id" DESC);
CREATE TABLE "apiRole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL UNIQUE,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" DATE NOT NULL
);
CREATE INDEX "apiRole_page_idx" ON "apiRole" ("createdAt" DESC, "id" DESC);
CREATE TABLE "apiRolePermission" (
    "roleId" TEXT NOT NULL REFERENCES "apiRole" ("id") ON DELETE CASCADE,
    "permissionId" TEXT NOT NULL REFERENCES "apiPermission" ("id") ON DELETE CASCADE,
    PRIMARY KEY ("roleId", "permissionId")
);
CREATE INDEX "apiRolePermission_permission_idx" ON "apiRolePermission" ("permissionId", "roleId");
CREATE TABLE "apiUserRole" (
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "roleId" TEXT NOT NULL REFERENCES "apiRole" ("id") ON DELETE CASCADE,
    PRIMARY KEY ("userId", "roleId")
);
CREATE INDEX "apiUserRole_role_idx" ON "apiUserRole" ("roleId", "userId");
CREATE INDEX "oauthResource_page_idx" ON "oauthResource" ("createdAt" DESC, "id" DESC);

-- Preserve the native authorization's scope ceiling across code consumption
-- and refresh rotation. This is policy metadata, never a copy of a token.
CREATE TABLE "apiGrantScope" (
    "authorizationCodeId" TEXT NOT NULL PRIMARY KEY REFERENCES "oauthGrantPolicy" ("authorizationCodeId") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    "scopes" TEXT NOT NULL,
    "resources" TEXT NOT NULL
);
CREATE TRIGGER "verification_api_grant_scope" AFTER INSERT ON "verification"
WHEN CASE WHEN json_valid(NEW."value") THEN json_extract(NEW."value", '$.type') END = 'authorization_code'
    AND json_type(NEW."value", '$.query.resource') IN ('text', 'array')
BEGIN
    INSERT INTO "apiGrantScope" ("authorizationCodeId", "scopes", "resources") VALUES (
        NEW."identifier", trim(json_extract(NEW."value", '$.query.scope')),
        CASE WHEN json_type(NEW."value", '$.query.resource') = 'array' THEN json_extract(NEW."value", '$.query.resource')
            ELSE json_array(json_extract(NEW."value", '$.query.resource')) END
    );
END;
CREATE TRIGGER "apiPermission_limit" BEFORE INSERT ON "apiPermission"
WHEN (SELECT COUNT(*) FROM "apiPermission" WHERE "resourceId" = NEW."resourceId") >= 100 OR (SELECT COUNT(*) FROM "apiPermission") >= 1000
BEGIN SELECT RAISE(ABORT, 'ACCESS_LIMIT'); END;

-- Permission reductions permanently retire affected API grants. Restoring a
-- role/link cannot resurrect a previously issued JWT or its refresh token.
CREATE TRIGGER "apiUserRole_revoke" BEFORE DELETE ON "apiUserRole"
BEGIN
    UPDATE "oauthGrantPolicy" SET "revokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE "userId" = OLD."userId" AND "revokedAt" IS NULL AND "authorizationCodeId" IN (SELECT "authorizationCodeId" FROM "apiGrantScope");
END;
CREATE TRIGGER "apiRolePermission_revoke" BEFORE DELETE ON "apiRolePermission"
BEGIN
    UPDATE "oauthGrantPolicy" SET "revokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE "revokedAt" IS NULL AND "userId" IN (SELECT "userId" FROM "apiUserRole" WHERE "roleId" = OLD."roleId")
        AND "authorizationCodeId" IN (SELECT g."authorizationCodeId" FROM "apiGrantScope" g
            WHERE instr(' ' || g."scopes" || ' ', ' ' || (SELECT "scope" FROM "apiPermission" WHERE "id" = OLD."permissionId") || ' ') > 0);
END;
CREATE TRIGGER "apiPermission_revoke" BEFORE DELETE ON "apiPermission"
BEGIN
    UPDATE "oauthGrantPolicy" SET "revokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE "revokedAt" IS NULL AND "authorizationCodeId" IN (SELECT "authorizationCodeId" FROM "apiGrantScope" WHERE instr(' ' || "scopes" || ' ', ' ' || OLD."scope" || ' ') > 0);
END;
CREATE TRIGGER "apiResource_disabled_revoke" AFTER UPDATE OF "disabled" ON "oauthResource"
WHEN NEW."disabled" = 1
BEGIN
    UPDATE "oauthGrantPolicy" SET "revokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE "revokedAt" IS NULL AND "authorizationCodeId" IN (SELECT g."authorizationCodeId" FROM "apiGrantScope" g, json_each(g."resources") r WHERE r.value = NEW."identifier");
END;
CREATE TRIGGER "apiResource_deleted_revoke" BEFORE DELETE ON "oauthResource"
BEGIN
    UPDATE "oauthGrantPolicy" SET "revokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE "revokedAt" IS NULL AND "authorizationCodeId" IN (SELECT g."authorizationCodeId" FROM "apiGrantScope" g, json_each(g."resources") r WHERE r.value = OLD."identifier");
END;
CREATE TRIGGER "apiResource_unlinked_revoke" BEFORE DELETE ON "oauthClientResource"
BEGIN
    UPDATE "oauthGrantPolicy" SET "revokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE "clientId" = OLD."clientId" AND "revokedAt" IS NULL AND "authorizationCodeId" IN (SELECT g."authorizationCodeId" FROM "apiGrantScope" g, json_each(g."resources") r WHERE r.value = OLD."resourceId");
END;
CREATE TRIGGER "apiClient_disabled_revoke" AFTER UPDATE OF "disabled" ON "oauthClient"
WHEN NEW."disabled" = 1
BEGIN
    UPDATE "oauthGrantPolicy" SET "revokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE "clientId" = NEW."clientId" AND "revokedAt" IS NULL AND "authorizationCodeId" IN (SELECT "authorizationCodeId" FROM "apiGrantScope");
END;

-- A transaction-local authorization checkpoint. Every management batch creates
-- and removes this row atomically; it cannot outlive a successful transaction.
CREATE TABLE "apiAccessWrite" (
    "id" TEXT NOT NULL PRIMARY KEY CHECK ("id" = 'access'),
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL
);
CREATE TRIGGER "apiAccessWrite_authorize" BEFORE INSERT ON "apiAccessWrite"
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM "session" s JOIN "user" u ON u."id" = s."userId"
        WHERE s."id" = NEW."sessionId" AND u."id" = NEW."userId" AND u."role" = 'admin'
        AND u."emailVerified" = 1 AND coalesce(u."banned", 0) = 0 AND s."oauthRevokedAt" IS NULL
        AND s."expiresAt" > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ) THEN RAISE(ABORT, 'ACCESS_MANAGEMENT_FORBIDDEN') END;
END;
CREATE TRIGGER "apiPermission_immutable" BEFORE UPDATE OF "scope", "resourceId" ON "apiPermission"
WHEN OLD."scope" IS NOT NEW."scope" OR OLD."resourceId" IS NOT NEW."resourceId"
BEGIN SELECT RAISE(ABORT, 'ACCESS_IDENTIFIER_IMMUTABLE'); END;
CREATE TRIGGER "oauthResource_identifier_immutable" BEFORE UPDATE OF "identifier" ON "oauthResource"
WHEN OLD."identifier" IS NOT NEW."identifier"
BEGIN SELECT RAISE(ABORT, 'ACCESS_IDENTIFIER_IMMUTABLE'); END;

-- The native provider remains authoritative for resource/audience and client
-- capability validation. Project business scopes into its existing tables.
CREATE TRIGGER "apiPermission_created" AFTER INSERT ON "apiPermission"
BEGIN
    UPDATE "oauthResource" SET "allowedScopes" = (
        SELECT json_group_array("scope") FROM (
            SELECT value AS "scope" FROM json_each('["openid","profile","email","offline_access"]')
            UNION SELECT "scope" FROM "apiPermission" WHERE "resourceId" = NEW."resourceId"
        )
    ) WHERE "id" = NEW."resourceId";
    UPDATE "oauthClient" SET "scopes" = (
        SELECT json_group_array(value) FROM (SELECT value FROM json_each("oauthClient"."scopes") UNION SELECT NEW."scope")
    ), "managementUserId" = (SELECT "userId" FROM "apiAccessWrite" WHERE "id" = 'access'),
    "managementSessionId" = (SELECT "sessionId" FROM "apiAccessWrite" WHERE "id" = 'access'), "managementAdministrator" = 1
    WHERE "clientId" IN (SELECT "clientId" FROM "oauthClientResource" WHERE "resourceId" = (SELECT "identifier" FROM "oauthResource" WHERE "id" = NEW."resourceId"));
END;
CREATE TRIGGER "apiPermission_removed" AFTER DELETE ON "apiPermission"
BEGIN
    UPDATE "oauthResource" SET "allowedScopes" = (
        SELECT json_group_array("scope") FROM (
            SELECT value AS "scope" FROM json_each('["openid","profile","email","offline_access"]')
            UNION SELECT "scope" FROM "apiPermission" WHERE "resourceId" = OLD."resourceId"
        )
    ) WHERE "id" = OLD."resourceId";
    UPDATE "oauthClient" SET "scopes" = (SELECT json_group_array(value) FROM json_each("oauthClient"."scopes") WHERE value <> OLD."scope"),
    "managementUserId" = (SELECT "userId" FROM "apiAccessWrite" WHERE "id" = 'access'),
    "managementSessionId" = (SELECT "sessionId" FROM "apiAccessWrite" WHERE "id" = 'access'), "managementAdministrator" = 1
    WHERE "clientId" IN (SELECT "clientId" FROM "oauthClientResource" WHERE "resourceId" = (SELECT "identifier" FROM "oauthResource" WHERE "id" = OLD."resourceId"));
END;
CREATE TRIGGER "apiResource_linked" AFTER INSERT ON "oauthClientResource"
BEGIN
    UPDATE "oauthClient" SET "scopes" = (
        SELECT json_group_array(value) FROM (SELECT value FROM json_each("oauthClient"."scopes")
            UNION SELECT "scope" FROM "apiPermission" WHERE "resourceId" = (SELECT "id" FROM "oauthResource" WHERE "identifier" = NEW."resourceId"))
    ), "managementUserId" = (SELECT "userId" FROM "apiAccessWrite" WHERE "id" = 'access'),
    "managementSessionId" = (SELECT "sessionId" FROM "apiAccessWrite" WHERE "id" = 'access'), "managementAdministrator" = 1
    WHERE "clientId" = NEW."clientId" AND EXISTS (SELECT 1 FROM "apiPermission" WHERE "resourceId" = (SELECT "id" FROM "oauthResource" WHERE "identifier" = NEW."resourceId"));
END;
CREATE TRIGGER "apiResource_unlinked" AFTER DELETE ON "oauthClientResource"
BEGIN
    UPDATE "oauthClient" SET "scopes" = (
        SELECT json_group_array(value) FROM json_each("oauthClient"."scopes")
        WHERE value NOT IN (SELECT "scope" FROM "apiPermission" WHERE "resourceId" = (SELECT "id" FROM "oauthResource" WHERE "identifier" = OLD."resourceId"))
    ), "managementUserId" = (SELECT "userId" FROM "apiAccessWrite" WHERE "id" = 'access'),
    "managementSessionId" = (SELECT "sessionId" FROM "apiAccessWrite" WHERE "id" = 'access'), "managementAdministrator" = 1
    WHERE "clientId" = OLD."clientId" AND EXISTS (SELECT 1 FROM "apiPermission" WHERE "resourceId" = (SELECT "id" FROM "oauthResource" WHERE "identifier" = OLD."resourceId"));
END;

-- A developer's identity-scope update and an administrator's resource change
-- may race. Resolve capabilities from the committed links in the same write,
-- rather than letting a stale application form erase an administrator grant.
CREATE TRIGGER "apiClient_scopes_project" AFTER UPDATE OF "scopes" ON "oauthClient"
WHEN EXISTS (
    SELECT 1 FROM "apiPermission" p JOIN "oauthResource" r ON r."id" = p."resourceId"
    JOIN "oauthClientResource" link ON link."resourceId" = r."identifier"
    WHERE link."clientId" = NEW."clientId" AND p."scope" NOT IN (SELECT value FROM json_each(NEW."scopes"))
)
BEGIN
    UPDATE "oauthClient" SET "scopes" = (
        SELECT json_group_array(value) FROM (
            SELECT value FROM json_each(NEW."scopes")
            UNION SELECT p."scope" AS value FROM "apiPermission" p JOIN "oauthResource" r ON r."id" = p."resourceId"
                JOIN "oauthClientResource" link ON link."resourceId" = r."identifier" WHERE link."clientId" = NEW."clientId"
        )
    ) WHERE "clientId" = NEW."clientId";
END;
