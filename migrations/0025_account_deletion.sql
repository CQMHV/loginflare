ALTER TABLE "user" ADD COLUMN "deletionRequestedAt" INTEGER;
CREATE TABLE "accountDeletion" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "userId" TEXT NOT NULL UNIQUE,
    "applicationIds" TEXT NOT NULL,
    "requestedAt" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'complete')),
    "stage" INTEGER NOT NULL DEFAULT 0,
    "lease" TEXT,
    "leaseUntil" INTEGER NOT NULL DEFAULT 0,
    "completedAt" INTEGER,
    "expiresAt" INTEGER
);
CREATE INDEX "accountDeletion_pending_idx" ON "accountDeletion" ("status", "requestedAt", "id");
CREATE INDEX "accountDeletion_expiry_idx" ON "accountDeletion" ("expiresAt", "id");
CREATE INDEX "oauthGrantPolicy_client_deletion_idx" ON "oauthGrantPolicy" ("clientId", "authorizationCodeId");
CREATE INDEX "securityProof_user_deletion_idx" ON "securityProof" ("userId", "id");
CREATE INDEX "browserAccount_user_deletion_idx" ON "browserAccount" ("userId", "id");
CREATE INDEX "oauthAccountApplication_client_deletion_idx" ON "oauthAccountApplication" ("clientId", "userId");
CREATE TRIGGER "accountDeletion_accepted_audit" AFTER INSERT ON "accountDeletion"
BEGIN
    INSERT INTO "auditLog" ("id", "event", "outcome", "actorUserId", "targetUserId", "targetType", "targetId", "requestId", "createdAt", "expiresAt")
    VALUES ('requested:' || NEW."id", 'account.deletion_requested', 'success', NEW."userId", NEW."userId", 'accountDeletion', NEW."id", NEW."id",
        strftime('%Y-%m-%dT%H:%M:%fZ', NEW."requestedAt" / 1000.0, 'unixepoch'), NEW."requestedAt" + 7776000000);
END;
CREATE TRIGGER "accountDeletion_completed_audit" AFTER UPDATE OF "status" ON "accountDeletion"
WHEN OLD."status" = 'pending' AND NEW."status" = 'complete'
BEGIN
    INSERT INTO "auditLog" ("id", "event", "outcome", "targetUserId", "targetType", "targetId", "requestId", "createdAt", "expiresAt")
    VALUES ('completed:' || NEW."id", 'account.deleted', 'success', NEW."userId", 'accountDeletion', NEW."id", NEW."id",
        strftime('%Y-%m-%dT%H:%M:%fZ', NEW."completedAt" / 1000.0, 'unixepoch'), NEW."expiresAt");
END;

-- Ordinary suspension retains its existing immediate revocation behavior.
-- Deletion freezes eligibility first; its durable task removes rows in batches.
DROP TRIGGER "user_suspend_oauth_grants";
CREATE TRIGGER "user_suspend_oauth_grants" AFTER UPDATE OF "banned" ON "user"
WHEN NEW."banned" = 1 AND NEW."deletionRequestedAt" IS NULL
BEGIN
    UPDATE "session" SET "oauthRevokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE "userId" = NEW."id" AND "oauthRevokedAt" IS NULL;
    UPDATE "oauthGrantPolicy" SET "revokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE "userId" = NEW."id" AND "revokedAt" IS NULL;
END;
DROP TRIGGER "social_account_suspended";
CREATE TRIGGER "social_account_suspended" AFTER UPDATE OF "banned" ON "user"
WHEN NEW."banned" = 1 AND NEW."deletionRequestedAt" IS NULL
BEGIN
    DELETE FROM "verification" WHERE "identifier" LIKE '2fa-%' AND "value" = NEW."id";
    DELETE FROM "verification" WHERE "identifier" LIKE 'social-mfa:%' AND "value" IN (SELECT "id" FROM "socialFlow" WHERE "userId" = NEW."id");
    DELETE FROM "socialFlow" WHERE "userId" = NEW."id";
    DELETE FROM "securityProof" WHERE "userId" = NEW."id";
END;
DROP TRIGGER "browser_account_suspended";
CREATE TRIGGER "browser_account_suspended" AFTER UPDATE OF "banned" ON "user"
WHEN NEW."banned" = 1 AND NEW."deletionRequestedAt" IS NULL
BEGIN DELETE FROM "browserAuthFlow" WHERE "userId" = NEW."id" OR "targetUserId" = NEW."id"; END;
DROP TRIGGER "apiClient_disabled_revoke";
CREATE TRIGGER "apiClient_disabled_revoke" AFTER UPDATE OF "disabled" ON "oauthClient"
WHEN NEW."disabled" = 1 AND NOT EXISTS (SELECT 1 FROM "accountDeletion" WHERE "userId" = NEW."ownerId" AND "status" = 'pending')
BEGIN
    UPDATE "oauthGrantPolicy" SET "revokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE "clientId" = NEW."clientId" AND "revokedAt" IS NULL AND "authorizationCodeId" IN (SELECT "authorizationCodeId" FROM "apiGrantScope");
END;

CREATE TRIGGER "user_deletion_frozen" BEFORE UPDATE ON "user"
WHEN OLD."deletionRequestedAt" IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "session_deletion_insert" BEFORE INSERT ON "session"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "session_deletion_update" BEFORE UPDATE ON "session"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "account_deletion_insert" BEFORE INSERT ON "account"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "account_deletion_update" BEFORE UPDATE ON "account"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "email_deletion_insert" BEFORE INSERT ON "userEmail"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "email_deletion_update" BEFORE UPDATE ON "userEmail"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "client_deletion_frozen" BEFORE UPDATE ON "oauthClient"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = OLD."ownerId" AND "deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "client_deletion_insert" BEFORE INSERT ON "oauthClient"
WHEN EXISTS (SELECT 1 FROM "user" WHERE ("id" = NEW."ownerId" OR "id" = NEW."userId") AND "deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "access_deletion_client" BEFORE INSERT ON "oauthAccessToken"
WHEN EXISTS (SELECT 1 FROM "oauthClient" c JOIN "user" u ON u."id" = c."ownerId" WHERE c."clientId" = NEW."clientId" AND u."deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "refresh_deletion_client" BEFORE INSERT ON "oauthRefreshToken"
WHEN EXISTS (SELECT 1 FROM "oauthClient" c JOIN "user" u ON u."id" = c."ownerId" WHERE c."clientId" = NEW."clientId" AND u."deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;

DROP TRIGGER "user_email_invalidate_proofs";
CREATE TRIGGER "user_email_invalidate_proofs" AFTER UPDATE OF "email", "banned" ON "user"
WHEN NEW."deletionRequestedAt" IS NULL AND (NEW."email" <> OLD."email" OR coalesce(NEW."banned", 0) <> coalesce(OLD."banned", 0))
BEGIN
    DELETE FROM "emailChallenge" WHERE "userId" = NEW."id";
    DELETE FROM "verification" WHERE "value" = NEW."id" AND "identifier" LIKE 'reset-password:%';
END;
DROP TRIGGER "apiResource_unlinked";
CREATE TRIGGER "apiResource_unlinked" AFTER DELETE ON "oauthClientResource"
WHEN NOT EXISTS (SELECT 1 FROM "oauthClient" c JOIN "user" u ON u."id" = c."ownerId" WHERE c."clientId" = OLD."clientId" AND u."deletionRequestedAt" IS NOT NULL)
BEGIN
    UPDATE "oauthClient" SET "scopes" = (
        SELECT json_group_array(value) FROM json_each("oauthClient"."scopes")
        WHERE value NOT IN (SELECT "scope" FROM "apiPermission" WHERE "resourceId" = (SELECT "id" FROM "oauthResource" WHERE "identifier" = OLD."resourceId"))
    ), "managementUserId" = (SELECT "userId" FROM "apiAccessWrite" WHERE "id" = 'access'),
    "managementSessionId" = (SELECT "sessionId" FROM "apiAccessWrite" WHERE "id" = 'access'), "managementAdministrator" = 1
    WHERE "clientId" = OLD."clientId" AND EXISTS (SELECT 1 FROM "apiPermission" WHERE "resourceId" = (SELECT "id" FROM "oauthResource" WHERE "identifier" = OLD."resourceId"));
END;
CREATE TRIGGER "consent_deletion_insert" BEFORE INSERT ON "oauthConsent"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "deletionRequestedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "oauthClient" c JOIN "user" u ON u."id" = c."ownerId" WHERE c."clientId" = NEW."clientId" AND u."deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "consent_deletion_update" BEFORE UPDATE ON "oauthConsent"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "deletionRequestedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "oauthClient" c JOIN "user" u ON u."id" = c."ownerId" WHERE c."clientId" = NEW."clientId" AND u."deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "link_deletion_insert" BEFORE INSERT ON "oauthClientResource"
WHEN EXISTS (SELECT 1 FROM "oauthClient" c JOIN "user" u ON u."id" = c."ownerId" WHERE c."clientId" = NEW."clientId" AND u."deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "verification_deletion_insert" BEFORE INSERT ON "verification"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."value" AND "deletionRequestedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "socialFlow" f JOIN "user" u ON u."id" = f."userId" WHERE f."id" = NEW."value" AND u."deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "social_deletion_insert" BEFORE INSERT ON "socialFlow"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "social_deletion_update" BEFORE UPDATE ON "socialFlow"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "proof_deletion_insert" BEFORE INSERT ON "securityProof"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "grant_deletion_activation" BEFORE UPDATE OF "activatedAt" ON "oauthGrantPolicy"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "deletionRequestedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "oauthClient" c JOIN "user" u ON u."id" = c."ownerId" WHERE c."clientId" = NEW."clientId" AND u."deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "browser_flow_deletion_insert" BEFORE INSERT ON "browserAuthFlow"
WHEN EXISTS (SELECT 1 FROM "user" WHERE ("id" = NEW."userId" OR "id" = NEW."targetUserId") AND "deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "browser_flow_deletion_update" BEFORE UPDATE ON "browserAuthFlow"
WHEN EXISTS (SELECT 1 FROM "user" WHERE ("id" = NEW."userId" OR "id" = NEW."targetUserId") AND "deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;
CREATE TRIGGER "browser_account_deletion_insert" BEFORE INSERT ON "browserAccount"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "deletionRequestedAt" IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_DELETION_PENDING'); END;

-- Job stages remove the grant rows and summaries explicitly. Avoid normal
-- permission/consent fan-out while processing a permanently frozen principal.
DROP TRIGGER "apiUserRole_revoke";
CREATE TRIGGER "apiUserRole_revoke" BEFORE DELETE ON "apiUserRole"
WHEN NOT EXISTS (SELECT 1 FROM "user" WHERE "id" = OLD."userId" AND "deletionRequestedAt" IS NOT NULL)
BEGIN
    UPDATE "oauthGrantPolicy" SET "revokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE "userId" = OLD."userId" AND "revokedAt" IS NULL AND "authorizationCodeId" IN (SELECT "authorizationCodeId" FROM "apiGrantScope");
END;
DROP TRIGGER "apiResource_unlinked_revoke";
CREATE TRIGGER "apiResource_unlinked_revoke" BEFORE DELETE ON "oauthClientResource"
WHEN NOT EXISTS (SELECT 1 FROM "oauthClient" c JOIN "user" u ON u."id" = c."ownerId" WHERE c."clientId" = OLD."clientId" AND u."deletionRequestedAt" IS NOT NULL)
BEGIN
    UPDATE "oauthGrantPolicy" SET "revokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE "clientId" = OLD."clientId" AND "revokedAt" IS NULL AND "authorizationCodeId" IN (SELECT g."authorizationCodeId" FROM "apiGrantScope" g, json_each(g."resources") r WHERE r.value = OLD."resourceId");
END;
DROP TRIGGER "oauthConsent_account_delete";
CREATE TRIGGER "oauthConsent_account_delete" AFTER DELETE ON "oauthConsent"
WHEN NOT EXISTS (SELECT 1 FROM "user" WHERE "id" = OLD."userId" AND "deletionRequestedAt" IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM "oauthClient" c JOIN "user" u ON u."id" = c."ownerId" WHERE c."clientId" = OLD."clientId" AND u."deletionRequestedAt" IS NOT NULL)
BEGIN
    UPDATE "oauthGrantPolicy" SET "revokedAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE "userId" = OLD."userId" AND "clientId" = OLD."clientId" AND "revokedAt" IS NULL;
    DELETE FROM "verification" WHERE "identifier" IN (
        SELECT "authorizationCodeId" FROM "oauthGrantPolicy" WHERE "userId" = OLD."userId" AND "clientId" = OLD."clientId"
    );
    DELETE FROM "oauthAccountApplication" WHERE "userId" = OLD."userId" AND "clientId" = OLD."clientId"
        AND NOT EXISTS (SELECT 1 FROM "oauthConsent" WHERE "userId" = OLD."userId" AND "clientId" = OLD."clientId");
    INSERT INTO "oauthAccountApplication" ("userId", "clientId", "scopes", "createdAt")
    SELECT c."userId", c."clientId",
        (SELECT json_group_array("value") FROM (
            SELECT DISTINCT j."value" FROM "oauthConsent" other, json_each(other."scopes") j
            WHERE other."userId" = OLD."userId" AND other."clientId" = OLD."clientId" ORDER BY j."value"
        )), max(coalesce(c."updatedAt", c."createdAt"))
    FROM "oauthConsent" c WHERE c."userId" = OLD."userId" AND c."clientId" = OLD."clientId"
    GROUP BY c."userId", c."clientId"
    ON CONFLICT ("userId", "clientId") DO UPDATE SET "scopes" = excluded."scopes", "createdAt" = excluded."createdAt";
END;
