CREATE TABLE "auditArchive" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "payload" TEXT NOT NULL CHECK (json_valid("payload")),
    "createdAt" TEXT NOT NULL,
    "exportedAt" TEXT NOT NULL
);
CREATE INDEX "auditArchive_created_idx" ON "auditArchive" ("createdAt", "id");
CREATE TABLE "exportCheckpoint" (
    "id" INTEGER PRIMARY KEY CHECK ("id" = 1),
    "source" TEXT NOT NULL,
    "cursor" TEXT,
    "lease" TEXT,
    "leaseUntil" INTEGER NOT NULL DEFAULT 0
);
