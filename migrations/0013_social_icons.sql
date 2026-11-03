CREATE TABLE "socialIcon" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "createdAt" INTEGER NOT NULL,
    "deleteAfter" INTEGER
);
CREATE INDEX "socialIcon_deleteAfter_id_idx" ON "socialIcon" ("deleteAfter", "id") WHERE "deleteAfter" IS NOT NULL;
ALTER TABLE "socialConnection" ADD COLUMN "iconId" TEXT REFERENCES "socialIcon" ("id");
CREATE INDEX "socialConnection_iconId_idx" ON "socialConnection" ("iconId") WHERE "iconId" IS NOT NULL;
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
