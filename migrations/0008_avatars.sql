-- File lifecycle metadata; Better Auth's user.image remains the profile field.
CREATE TABLE "userAvatar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT REFERENCES "user" ("id") ON DELETE SET NULL,
    "url" TEXT NOT NULL UNIQUE,
    "createdAt" INTEGER NOT NULL,
    "deleteAfter" INTEGER
);
CREATE INDEX "userAvatar_userId_idx" ON "userAvatar" ("userId");
CREATE INDEX "userAvatar_deleteAfter_id_idx" ON "userAvatar" ("deleteAfter", "id") WHERE "deleteAfter" IS NOT NULL;

CREATE TRIGGER "user_avatar_changed" AFTER UPDATE OF "image" ON "user"
WHEN OLD."image" IS NOT NEW."image"
BEGIN
    UPDATE "userAvatar" SET "deleteAfter" = CAST(unixepoch('subsec') * 1000 AS INTEGER)
        WHERE "userId" = NEW."id" AND "url" = OLD."image";
    UPDATE "userAvatar" SET "deleteAfter" = NULL
        WHERE "userId" = NEW."id" AND "url" = NEW."image";
END;

CREATE TRIGGER "user_avatar_deleted" BEFORE DELETE ON "user"
BEGIN
    UPDATE "userAvatar" SET "deleteAfter" = CAST(unixepoch('subsec') * 1000 AS INTEGER)
        WHERE "userId" = OLD."id";
END;
