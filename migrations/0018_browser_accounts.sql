CREATE TABLE "browserAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "browserHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "sessionId" TEXT REFERENCES "session" ("id") ON DELETE SET NULL,
    "slot" INTEGER CHECK ("slot" BETWEEN 0 AND 4),
    "rememberMe" INTEGER NOT NULL DEFAULT 1 CHECK ("rememberMe" IN (0, 1)),
    "lastUsedAt" DATE NOT NULL,
    "expiresAt" INTEGER NOT NULL,
    UNIQUE ("browserHash", "userId"),
    UNIQUE ("browserHash", "slot")
);
CREATE INDEX "browserAccount_expiry_idx" ON "browserAccount" ("expiresAt", "id");
CREATE INDEX "browserAccount_session_idx" ON "browserAccount" ("sessionId");
CREATE TRIGGER "browser_session_deleted" BEFORE DELETE ON "session"
BEGIN
    UPDATE "browserAccount" SET "sessionId" = NULL, "slot" = NULL WHERE "sessionId" = OLD."id";
END;

CREATE TABLE "browserAuthFlow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "browserHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL CHECK ("kind" IN ('login', 'add', 'reauth', 'oauth')),
    "accountId" TEXT REFERENCES "browserAccount" ("id") ON DELETE CASCADE,
    "targetUserId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
    "originSessionId" TEXT,
    "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
    "sessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'authenticated', 'selected')),
    "locale" TEXT NOT NULL CHECK ("locale" IN ('en-US', 'zh-CN')),
    "oauthQuery" TEXT NOT NULL DEFAULT '',
    "upstreamState" TEXT UNIQUE,
    "expiresAt" INTEGER NOT NULL
);
CREATE INDEX "browserAuthFlow_expiry_idx" ON "browserAuthFlow" ("expiresAt", "id");
CREATE INDEX "browserAuthFlow_browser_idx" ON "browserAuthFlow" ("browserHash", "expiresAt");
CREATE INDEX "browserAuthFlow_user_idx" ON "browserAuthFlow" ("userId");
CREATE INDEX "browserAuthFlow_target_user_idx" ON "browserAuthFlow" ("targetUserId");
CREATE TRIGGER "browser_password_changed" AFTER UPDATE OF "password" ON "account"
WHEN OLD."password" IS NOT NEW."password"
BEGIN
    DELETE FROM "browserAuthFlow" WHERE "userId" = NEW."userId" OR "targetUserId" = NEW."userId";
END;
CREATE TRIGGER "browser_account_suspended" AFTER UPDATE OF "banned" ON "user"
WHEN NEW."banned" = 1
BEGIN
    DELETE FROM "browserAuthFlow" WHERE "userId" = NEW."id" OR "targetUserId" = NEW."id";
END;
