-- One indexed summary per effective native consent, independent of token expiry.
CREATE TABLE "oauthAccountApplication" (
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
    "scopes" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    PRIMARY KEY ("userId", "clientId")
);
CREATE INDEX "oauthAccountApplication_user_page_idx" ON "oauthAccountApplication" ("userId", "createdAt" DESC, "clientId" DESC);
CREATE INDEX "oauthConsent_user_client_idx" ON "oauthConsent" ("userId", "clientId");
CREATE INDEX "oauthGrantPolicy_user_client_idx" ON "oauthGrantPolicy" ("userId", "clientId");

INSERT INTO "oauthAccountApplication" ("userId", "clientId", "scopes", "createdAt")
SELECT c."userId", c."clientId",
    (SELECT json_group_array("value") FROM (
        SELECT DISTINCT j."value" FROM "oauthConsent" other, json_each(other."scopes") j
        WHERE other."userId" = c."userId" AND other."clientId" = c."clientId" ORDER BY j."value"
    )),
    max(coalesce(c."updatedAt", c."createdAt"))
FROM "oauthConsent" c WHERE c."userId" IS NOT NULL GROUP BY c."userId", c."clientId";

-- A pending code must be registered before it is consumed, so revocation also
-- closes the interval between native verification consumption and token insertion.
-- Activation distinguishes it from an issued offline grant after ordinary logout.
ALTER TABLE "oauthGrantPolicy" ADD COLUMN "activatedAt" TEXT;
UPDATE "oauthGrantPolicy" SET "activatedAt" = '1970-01-01T00:00:00.000Z';

INSERT INTO "oauthGrantPolicy" ("authorizationCodeId", "userId", "clientId", "originalSessionId", "revokedAt", "gcAfter")
SELECT v."identifier", json_extract(CASE WHEN json_valid(v."value") THEN v."value" ELSE '{}' END, '$.userId'), json_extract(CASE WHEN json_valid(v."value") THEN v."value" ELSE '{}' END, '$.query.client_id'),
    json_extract(CASE WHEN json_valid(v."value") THEN v."value" ELSE '{}' END, '$.sessionId'),
    CASE WHEN EXISTS (SELECT 1 FROM "oauthConsent" c WHERE c."userId" = json_extract(CASE WHEN json_valid(v."value") THEN v."value" ELSE '{}' END, '$.userId')
        AND c."clientId" = json_extract(CASE WHEN json_valid(v."value") THEN v."value" ELSE '{}' END, '$.query.client_id')) THEN NULL
        ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END,
    v."expiresAt"
FROM "verification" v
WHERE json_valid(v."value") AND json_extract(CASE WHEN json_valid(v."value") THEN v."value" ELSE '{}' END, '$.type') = 'authorization_code'
    AND typeof(json_extract(CASE WHEN json_valid(v."value") THEN v."value" ELSE '{}' END, '$.sessionId')) = 'text'
    AND EXISTS (SELECT 1 FROM "user" WHERE "id" = json_extract(CASE WHEN json_valid(v."value") THEN v."value" ELSE '{}' END, '$.userId'))
    AND EXISTS (SELECT 1 FROM "oauthClient" WHERE "clientId" = json_extract(CASE WHEN json_valid(v."value") THEN v."value" ELSE '{}' END, '$.query.client_id'))
ON CONFLICT ("authorizationCodeId") DO NOTHING;

CREATE TRIGGER "verification_oauth_code_guard" BEFORE INSERT ON "verification"
WHEN CASE WHEN json_valid(NEW."value") THEN json_extract(NEW."value", '$.type') END = 'authorization_code'
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM "session" s JOIN "user" u ON u."id" = s."userId"
        JOIN "oauthClient" a ON a."clientId" = json_extract(NEW."value", '$.query.client_id')
        WHERE s."id" = json_extract(NEW."value", '$.sessionId')
            AND s."userId" = json_extract(NEW."value", '$.userId')
            AND s."oauthRevokedAt" IS NULL AND s."expiresAt" > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND u."emailVerified" = 1 AND coalesce(u."banned", 0) = 0 AND coalesce(a."disabled", 0) = 0
            AND EXISTS (SELECT 1 FROM "oauthConsent" c WHERE c."userId" = s."userId" AND c."clientId" = a."clientId")
            AND NOT EXISTS (
                SELECT 1 FROM json_each('[' || replace(json_quote(trim(json_extract(NEW."value", '$.query.scope'))), ' ', '","') || ']') requested
                WHERE requested."value" <> '' AND NOT EXISTS (
                    SELECT 1 FROM "oauthConsent" c, json_each(c."scopes") allowed
                    WHERE c."userId" = s."userId" AND c."clientId" = a."clientId" AND allowed."value" = requested."value"
                )
            )
    ) THEN RAISE(ABORT, 'OAUTH_GRANT_UNAVAILABLE') END;
END;

CREATE TRIGGER "verification_oauth_code_register" AFTER INSERT ON "verification"
WHEN CASE WHEN json_valid(NEW."value") THEN json_extract(NEW."value", '$.type') END = 'authorization_code'
BEGIN
    INSERT INTO "oauthGrantPolicy" ("authorizationCodeId", "userId", "clientId", "originalSessionId", "gcAfter")
    VALUES (NEW."identifier", json_extract(NEW."value", '$.userId'), json_extract(NEW."value", '$.query.client_id'),
        json_extract(NEW."value", '$.sessionId'), NEW."expiresAt");
END;

DROP TRIGGER "oauthAccessToken_policy_guard";
CREATE TRIGGER "oauthAccessToken_policy_guard" BEFORE INSERT ON "oauthAccessToken"
WHEN NEW."authorizationCodeId" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND coalesce("banned", 0) = 0 AND "emailVerified" = 1)
    OR EXISTS (SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId"
        AND ("revokedAt" IS NOT NULL OR "userId" <> NEW."userId" OR "clientId" <> NEW."clientId"))
    OR (NOT EXISTS (SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId" AND "activatedAt" IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM "session" WHERE "id" = coalesce(NEW."sessionId",
            (SELECT "originalSessionId" FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId"))
            AND "userId" = NEW."userId" AND "oauthRevokedAt" IS NULL AND "expiresAt" > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
BEGIN
    SELECT RAISE(ABORT, 'OAUTH_GRANT_UNAVAILABLE');
END;

DROP TRIGGER "oauthAccessToken_policy_register";
CREATE TRIGGER "oauthAccessToken_policy_register" AFTER INSERT ON "oauthAccessToken"
BEGIN
    INSERT INTO "oauthGrantPolicy" ("authorizationCodeId", "userId", "clientId", "originalSessionId", "gcAfter", "activatedAt")
    VALUES (NEW."authorizationCodeId", NEW."userId", NEW."clientId", coalesce(NEW."sessionId",
        (SELECT "originalSessionId" FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId")),
        NEW."expiresAt", NEW."createdAt")
    ON CONFLICT ("authorizationCodeId") DO UPDATE SET "gcAfter" = max("gcAfter", excluded."gcAfter"),
        "activatedAt" = coalesce("activatedAt", excluded."activatedAt");
END;

DROP TRIGGER "oauthRefreshToken_policy_guard";
CREATE TRIGGER "oauthRefreshToken_policy_guard" BEFORE INSERT ON "oauthRefreshToken"
WHEN NEW."authorizationCodeId" IS NULL
    OR NOT EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND coalesce("banned", 0) = 0 AND "emailVerified" = 1)
    OR EXISTS (SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId"
        AND ("revokedAt" IS NOT NULL OR "userId" <> NEW."userId" OR "clientId" <> NEW."clientId"))
    OR (NOT EXISTS (SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId" AND "activatedAt" IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM "session" WHERE "id" = coalesce(NEW."sessionId",
            (SELECT "originalSessionId" FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId"))
            AND "userId" = NEW."userId" AND "oauthRevokedAt" IS NULL AND "expiresAt" > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
BEGIN
    SELECT RAISE(ABORT, 'OAUTH_GRANT_UNAVAILABLE');
END;

DROP TRIGGER "oauthRefreshToken_policy_register";
CREATE TRIGGER "oauthRefreshToken_policy_register" AFTER INSERT ON "oauthRefreshToken"
BEGIN
    INSERT INTO "oauthGrantPolicy" ("authorizationCodeId", "userId", "clientId", "originalSessionId", "gcAfter", "activatedAt")
    VALUES (NEW."authorizationCodeId", NEW."userId", NEW."clientId", coalesce(NEW."sessionId",
        (SELECT "originalSessionId" FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = NEW."authorizationCodeId")),
        NEW."expiresAt", NEW."createdAt")
    ON CONFLICT ("authorizationCodeId") DO UPDATE SET "gcAfter" = max("gcAfter", excluded."gcAfter"),
        "activatedAt" = coalesce("activatedAt", excluded."activatedAt");
END;

CREATE TRIGGER "oauthConsent_account_insert" AFTER INSERT ON "oauthConsent"
WHEN NEW."userId" IS NOT NULL
BEGIN
    INSERT INTO "oauthAccountApplication" ("userId", "clientId", "scopes", "createdAt")
    SELECT c."userId", c."clientId",
        (SELECT json_group_array("value") FROM (
            SELECT DISTINCT j."value" FROM "oauthConsent" other, json_each(other."scopes") j
            WHERE other."userId" = NEW."userId" AND other."clientId" = NEW."clientId" ORDER BY j."value"
        )), max(coalesce(c."updatedAt", c."createdAt"))
    FROM "oauthConsent" c WHERE c."userId" = NEW."userId" AND c."clientId" = NEW."clientId"
    GROUP BY c."userId", c."clientId"
    ON CONFLICT ("userId", "clientId") DO UPDATE SET "scopes" = excluded."scopes", "createdAt" = excluded."createdAt";
END;

CREATE TRIGGER "oauthConsent_account_update" AFTER UPDATE ON "oauthConsent"
BEGIN
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
    INSERT INTO "oauthAccountApplication" ("userId", "clientId", "scopes", "createdAt")
    SELECT c."userId", c."clientId",
        (SELECT json_group_array("value") FROM (
            SELECT DISTINCT j."value" FROM "oauthConsent" other, json_each(other."scopes") j
            WHERE other."userId" = NEW."userId" AND other."clientId" = NEW."clientId" ORDER BY j."value"
        )), max(coalesce(c."updatedAt", c."createdAt"))
    FROM "oauthConsent" c WHERE c."userId" = NEW."userId" AND c."clientId" = NEW."clientId"
    GROUP BY c."userId", c."clientId"
    ON CONFLICT ("userId", "clientId") DO UPDATE SET "scopes" = excluded."scopes", "createdAt" = excluded."createdAt";
END;

CREATE TRIGGER "oauthConsent_account_delete" AFTER DELETE ON "oauthConsent"
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
