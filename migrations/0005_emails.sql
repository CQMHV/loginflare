-- user.email remains Better Auth's sole email login identifier. This registry
-- reserves both primary and auxiliary addresses with one case-insensitive key.
CREATE TABLE "userEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "email" TEXT NOT NULL COLLATE NOCASE UNIQUE,
    "verified" INTEGER NOT NULL DEFAULT 0 CHECK ("verified" IN (0, 1)),
    "createdAt" INTEGER NOT NULL,
    CHECK ("email" = lower(trim("email")))
);
CREATE INDEX "userEmail_userId_idx" ON "userEmail" ("userId");
INSERT INTO "userEmail" ("id", "userId", "email", "verified", "createdAt")
    SELECT 'primary:' || "id", "id", lower("email"), "emailVerified",
        CAST(unixepoch('now') * 1000 AS INTEGER) FROM "user";

CREATE TRIGGER "userEmail_limit_guard" BEFORE INSERT ON "userEmail"
WHEN NOT EXISTS (SELECT 1 FROM "userEmail" WHERE "email" = NEW."email")
    AND (SELECT COUNT(*) FROM "userEmail" WHERE "userId" = NEW."userId") >= 10
BEGIN
    SELECT RAISE(ABORT, 'EMAIL_LIMIT_REACHED');
END;

CREATE TABLE "emailChallenge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "emailId" TEXT NOT NULL REFERENCES "userEmail" ("id") ON DELETE CASCADE,
    "purpose" TEXT NOT NULL CHECK ("purpose" IN ('verify', 'recovery')),
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" INTEGER NOT NULL,
    "createdAt" INTEGER NOT NULL
);
CREATE INDEX "emailChallenge_userId_idx" ON "emailChallenge" ("userId");

-- Triggers run in the native write's transaction, including sign-up and native
-- verification. No asynchronous after-hook can leave an unreserved main email.
CREATE TRIGGER "user_email_register" AFTER INSERT ON "user"
BEGIN
    INSERT INTO "userEmail" ("id", "userId", "email", "verified", "createdAt")
        VALUES ('primary:' || NEW."id", NEW."id", lower(NEW."email"), NEW."emailVerified", CAST(unixepoch('now') * 1000 AS INTEGER));
END;
CREATE TRIGGER "user_email_owner_guard" BEFORE UPDATE OF "email" ON "user"
WHEN EXISTS (SELECT 1 FROM "userEmail" WHERE "email" = lower(NEW."email") AND "userId" <> NEW."id")
BEGIN
    SELECT RAISE(ABORT, 'EMAIL_ALREADY_EXISTS');
END;
CREATE TRIGGER "user_email_verified_target_guard" BEFORE UPDATE OF "email" ON "user"
WHEN lower(NEW."email") <> lower(OLD."email") AND NOT EXISTS (
    SELECT 1 FROM "userEmail" WHERE "email" = lower(NEW."email") AND "userId" = NEW."id" AND "verified" = 1
)
BEGIN
    SELECT RAISE(ABORT, 'EMAIL_NOT_VERIFIED');
END;
CREATE TRIGGER "user_email_sync" AFTER UPDATE OF "email", "emailVerified" ON "user"
BEGIN
    INSERT INTO "userEmail" ("id", "userId", "email", "verified", "createdAt")
        VALUES ('email:' || lower(hex(randomblob(16))), NEW."id", lower(NEW."email"), NEW."emailVerified", CAST(unixepoch('now') * 1000 AS INTEGER))
        ON CONFLICT ("email") DO UPDATE SET "verified" = NEW."emailVerified";
END;
CREATE TRIGGER "userEmail_primary_delete_guard" BEFORE DELETE ON "userEmail"
WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = OLD."userId" AND "email" = OLD."email" COLLATE NOCASE)
BEGIN
    SELECT RAISE(ABORT, 'PRIMARY_EMAIL_REQUIRED');
END;
CREATE TRIGGER "userEmail_address_immutable" BEFORE UPDATE OF "userId", "email" ON "userEmail"
WHEN NEW."userId" <> OLD."userId" OR NEW."email" <> OLD."email"
BEGIN
    SELECT RAISE(ABORT, 'EMAIL_ADDRESS_IMMUTABLE');
END;

-- Security changes invalidate every outstanding recovery proof, including a
-- short-lived native reset ticket already handed to the password form.
CREATE TRIGGER "user_email_invalidate_proofs" AFTER UPDATE OF "email", "banned" ON "user"
WHEN NEW."email" <> OLD."email" OR COALESCE(NEW."banned", 0) <> COALESCE(OLD."banned", 0)
BEGIN
    DELETE FROM "emailChallenge" WHERE "userId" = NEW."id";
    DELETE FROM "verification" WHERE "value" = NEW."id" AND "identifier" LIKE 'reset-password:%';
END;
CREATE TRIGGER "userEmail_remove_invalidate_proofs" AFTER DELETE ON "userEmail"
BEGIN
    DELETE FROM "verification" WHERE "value" = OLD."userId" AND "identifier" LIKE 'reset-password:%';
END;
CREATE TRIGGER "account_password_invalidate_proofs" AFTER UPDATE OF "password" ON "account"
WHEN NEW."password" IS NOT OLD."password"
BEGIN
    DELETE FROM "emailChallenge" WHERE "userId" = NEW."userId";
    DELETE FROM "verification" WHERE "value" = NEW."userId" AND "identifier" LIKE 'reset-password:%';
END;
