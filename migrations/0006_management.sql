-- List reads seek by one stable ordering instead of OFFSET or exact total scans.
CREATE INDEX "user_createdAt_id_idx" ON "user" ("createdAt" DESC, "id" DESC);
CREATE INDEX "session_userId_createdAt_id_idx" ON "session" ("userId", "createdAt" DESC, "id" DESC);
CREATE INDEX "oauthClient_referenceId_createdAt_clientId_idx" ON "oauthClient" ("referenceId", "createdAt" DESC, "clientId" DESC);
CREATE INDEX "oauthClient_referenceId_name_createdAt_clientId_idx" ON "oauthClient" ("referenceId", "name", "createdAt" DESC, "clientId" DESC);

-- Origins are parsed with the URL standard in the application and stored in
-- oauthClient.metadata.loginflareRedirectOrigins. Complete callback strings
-- remain authoritative and unchanged in the native OAuth fields.
CREATE TABLE "oauthClientUri" (
    "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('redirect-origin', 'post-logout-uri')),
    "value" TEXT NOT NULL,
    PRIMARY KEY ("kind", "value", "clientId")
);
CREATE INDEX "oauthClientUri_clientId_idx" ON "oauthClientUri" ("clientId");

INSERT OR IGNORE INTO "oauthClientUri" ("clientId", "kind", "value")
    SELECT c."clientId", 'redirect-origin', j.value FROM "oauthClient" c,
        json_each(COALESCE(json_extract(c."metadata", '$.loginflareRedirectOrigins'), '[]')) j;
INSERT OR IGNORE INTO "oauthClientUri" ("clientId", "kind", "value")
    SELECT c."clientId", 'post-logout-uri', j.value FROM "oauthClient" c,
        json_each(COALESCE(c."postLogoutRedirectUris", '[]')) j;

CREATE TRIGGER "oauthClient_uri_register" AFTER INSERT ON "oauthClient"
BEGIN
    INSERT OR IGNORE INTO "oauthClientUri" ("clientId", "kind", "value")
        SELECT NEW."clientId", 'redirect-origin', value
        FROM json_each(COALESCE(json_extract(NEW."metadata", '$.loginflareRedirectOrigins'), '[]'));
    INSERT OR IGNORE INTO "oauthClientUri" ("clientId", "kind", "value")
        SELECT NEW."clientId", 'post-logout-uri', value
        FROM json_each(COALESCE(NEW."postLogoutRedirectUris", '[]'));
END;

CREATE TRIGGER "oauthClient_uri_sync" AFTER UPDATE OF "metadata", "postLogoutRedirectUris" ON "oauthClient"
BEGIN
    DELETE FROM "oauthClientUri" WHERE "clientId" = NEW."clientId";
    INSERT OR IGNORE INTO "oauthClientUri" ("clientId", "kind", "value")
        SELECT NEW."clientId", 'redirect-origin', value
        FROM json_each(COALESCE(json_extract(NEW."metadata", '$.loginflareRedirectOrigins'), '[]'));
    INSERT OR IGNORE INTO "oauthClientUri" ("clientId", "kind", "value")
        SELECT NEW."clientId", 'post-logout-uri', value
        FROM json_each(COALESCE(NEW."postLogoutRedirectUris", '[]'));
END;
