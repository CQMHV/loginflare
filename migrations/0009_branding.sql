CREATE TABLE "brandLogo" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "createdAt" INTEGER NOT NULL,
    "deleteAfter" INTEGER
);
CREATE INDEX "brandLogo_deleteAfter_id_idx" ON "brandLogo" ("deleteAfter", "id") WHERE "deleteAfter" IS NOT NULL;
CREATE TABLE "siteBranding" (
    "id" INTEGER PRIMARY KEY NOT NULL CHECK ("id" = 1),
    "name" TEXT NOT NULL CHECK (length("name") BETWEEN 1 AND 100),
    "primaryColor" TEXT NOT NULL,
    "logoId" TEXT REFERENCES "brandLogo" ("id"),
    "revision" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "siteBranding" ("id", "name", "primaryColor") VALUES (1, 'Loginflare', '#f38020');
CREATE TRIGGER "site_branding_logo_changed" AFTER UPDATE OF "logoId" ON "siteBranding"
WHEN OLD."logoId" IS NOT NEW."logoId"
BEGIN
    UPDATE "brandLogo" SET "deleteAfter" = CAST(unixepoch('subsec') * 1000 AS INTEGER) + 3600000 WHERE "id" = OLD."logoId";
    UPDATE "brandLogo" SET "deleteAfter" = NULL WHERE "id" = NEW."logoId";
END;
