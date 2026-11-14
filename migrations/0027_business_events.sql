CREATE TABLE "businessEvent" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "type" TEXT NOT NULL CHECK ("type" IN ('user.created','email.verified','user.updated','user.suspended','user.restored','user.deleted')),
    "subjectId" TEXT NOT NULL,
    "data" TEXT NOT NULL CHECK (json_valid("data")),
    "createdAt" TEXT NOT NULL,
    "expiresAt" INTEGER NOT NULL
);
CREATE INDEX "businessEvent_expiry_idx" ON "businessEvent" ("expiresAt", "id");
CREATE TABLE "webhookSubscription" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT NOT NULL CHECK (json_valid("events")),
    "secret" TEXT NOT NULL,
    "enabled" INTEGER NOT NULL DEFAULT 0 CHECK ("enabled" IN (0,1)),
    "version" INTEGER NOT NULL DEFAULT 1,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TEXT NOT NULL
);
CREATE INDEX "webhookSubscription_created_idx" ON "webhookSubscription" ("createdAt", "id");
CREATE TRIGGER "webhookSubscription_limit_insert" BEFORE INSERT ON "webhookSubscription"
WHEN (SELECT count(*) FROM "webhookSubscription") >= 100 OR (NEW."enabled" = 1 AND (SELECT count(*) FROM "webhookSubscription" WHERE "enabled" = 1) >= 20)
BEGIN SELECT RAISE(ABORT, 'WEBHOOK_LIMIT_REACHED'); END;
CREATE TRIGGER "webhookSubscription_limit_update" BEFORE UPDATE OF "enabled" ON "webhookSubscription"
WHEN NEW."enabled" = 1 AND OLD."enabled" = 0 AND (SELECT count(*) FROM "webhookSubscription" WHERE "enabled" = 1) >= 20
BEGIN SELECT RAISE(ABORT, 'WEBHOOK_LIMIT_REACHED'); END;
CREATE TABLE "webhookDelivery" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "eventId" TEXT NOT NULL REFERENCES "businessEvent" ("id") ON DELETE RESTRICT,
    "subscriptionId" TEXT NOT NULL REFERENCES "webhookSubscription" ("id") ON DELETE RESTRICT,
    "generation" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','succeeded','failed','cancelled')),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "totalAttempts" INTEGER NOT NULL DEFAULT 0,
    "cycle" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" INTEGER NOT NULL,
    "lease" TEXT,
    "leaseUntil" INTEGER NOT NULL DEFAULT 0,
    "lastCode" TEXT,
    "httpStatus" INTEGER,
    "createdAt" TEXT NOT NULL,
    "completedAt" INTEGER,
    "expiresAt" INTEGER,
    UNIQUE ("eventId", "subscriptionId")
);
CREATE INDEX "webhookDelivery_due_idx" ON "webhookDelivery" ("status", "nextAttemptAt", "id");
CREATE INDEX "webhookDelivery_claim_idx" ON "webhookDelivery" ("status", "leaseUntil", "nextAttemptAt", "id");
CREATE INDEX "webhookDelivery_scan_idx" ON "webhookDelivery" ("status", "createdAt", "id");
CREATE INDEX "webhookDelivery_created_idx" ON "webhookDelivery" ("createdAt", "id");
CREATE INDEX "webhookDelivery_subscription_idx" ON "webhookDelivery" ("subscriptionId", "createdAt", "id");
CREATE INDEX "webhookDelivery_expiry_idx" ON "webhookDelivery" ("expiresAt", "id");
CREATE TABLE "webhookAttempt" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "deliveryId" TEXT NOT NULL REFERENCES "webhookDelivery" ("id") ON DELETE RESTRICT,
    "number" INTEGER NOT NULL,
    "cycle" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'pending' CHECK ("outcome" IN ('pending','succeeded','failed','uncertain')),
    "code" TEXT,
    "httpStatus" INTEGER,
    "createdAt" TEXT NOT NULL,
    "completedAt" INTEGER,
    "expiresAt" INTEGER,
    UNIQUE ("deliveryId", "number")
);
CREATE INDEX "webhookAttempt_delivery_idx" ON "webhookAttempt" ("deliveryId", "number");
CREATE INDEX "webhookAttempt_expiry_idx" ON "webhookAttempt" ("expiresAt", "id");
CREATE TRIGGER "businessEvent_immutable" BEFORE UPDATE ON "businessEvent"
BEGIN SELECT RAISE(ABORT, 'BUSINESS_EVENT_IMMUTABLE'); END;
CREATE TRIGGER "businessEvent_fanout" AFTER INSERT ON "businessEvent"
BEGIN
    INSERT INTO "webhookDelivery" ("id","eventId","subscriptionId","generation","nextAttemptAt","createdAt")
    SELECT lower(hex(randomblob(16))), NEW."id", s."id", s."generation", unixepoch('subsec') * 1000, NEW."createdAt"
    FROM "webhookSubscription" s WHERE s."enabled" = 1 AND EXISTS (SELECT 1 FROM json_each(s."events") WHERE value = NEW."type");
END;

-- Outbox rows and their bounded subscription fan-out commit with the native write.
CREATE TRIGGER "business_user_created" AFTER INSERT ON "user"
BEGIN
    INSERT INTO "businessEvent" ("id","type","subjectId","data","createdAt","expiresAt") SELECT lower(hex(randomblob(16))), 'user.created', NEW."id", json_object('emailVerified', json(CASE WHEN NEW."emailVerified" = 1 THEN 'true' ELSE 'false' END)), strftime('%Y-%m-%dT%H:%M:%fZ','now'), unixepoch('subsec') * 1000 + 604800000 ;
    INSERT INTO "businessEvent" ("id","type","subjectId","data","createdAt","expiresAt") SELECT lower(hex(randomblob(16))), 'email.verified', NEW."id", json_object('primary', json('true')), strftime('%Y-%m-%dT%H:%M:%fZ','now'), unixepoch('subsec') * 1000 + 604800000 WHERE NEW."emailVerified" = 1;
END;
CREATE TRIGGER "business_email_verified" AFTER UPDATE OF "verified" ON "userEmail"
WHEN OLD."verified" = 0 AND NEW."verified" = 1
BEGIN INSERT INTO "businessEvent" ("id","type","subjectId","data","createdAt","expiresAt") SELECT lower(hex(randomblob(16))), 'email.verified', NEW."userId", json_object('primary', json(CASE WHEN EXISTS (SELECT 1 FROM "user" WHERE "id" = NEW."userId" AND "email" = NEW."email" COLLATE NOCASE) THEN 'true' ELSE 'false' END)), strftime('%Y-%m-%dT%H:%M:%fZ','now'), unixepoch('subsec') * 1000 + 604800000 ;
END;
CREATE TRIGGER "business_user_updated" AFTER UPDATE OF "name","username","email","image","locale" ON "user"
WHEN NEW."deletionRequestedAt" IS NULL AND (OLD."name" IS NOT NEW."name" OR OLD."username" IS NOT NEW."username" OR OLD."email" IS NOT NEW."email" OR OLD."image" IS NOT NEW."image" OR OLD."locale" IS NOT NEW."locale")
BEGIN INSERT INTO "businessEvent" ("id","type","subjectId","data","createdAt","expiresAt") SELECT lower(hex(randomblob(16))), 'user.updated', NEW."id", json_object('fields', json((SELECT json_group_array(field) FROM (SELECT 'name' AS field WHERE OLD."name" IS NOT NEW."name" UNION ALL SELECT 'username' WHERE OLD."username" IS NOT NEW."username" UNION ALL SELECT 'email' WHERE OLD."email" IS NOT NEW."email" UNION ALL SELECT 'image' WHERE OLD."image" IS NOT NEW."image" UNION ALL SELECT 'locale' WHERE OLD."locale" IS NOT NEW."locale")))), strftime('%Y-%m-%dT%H:%M:%fZ','now'), unixepoch('subsec') * 1000 + 604800000 ;
END;
CREATE TRIGGER "business_user_suspension" AFTER UPDATE OF "banned" ON "user"
WHEN NEW."deletionRequestedAt" IS NULL AND coalesce(OLD."banned",0) <> coalesce(NEW."banned",0)
BEGIN
    INSERT INTO "businessEvent" ("id","type","subjectId","data","createdAt","expiresAt") SELECT lower(hex(randomblob(16))), 'user.suspended', NEW."id", json('{}'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), unixepoch('subsec') * 1000 + 604800000 WHERE NEW."banned" = 1;
    INSERT INTO "businessEvent" ("id","type","subjectId","data","createdAt","expiresAt") SELECT lower(hex(randomblob(16))), 'user.restored', NEW."id", json('{}'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), unixepoch('subsec') * 1000 + 604800000 WHERE coalesce(NEW."banned",0) = 0;
END;
-- No user foreign keys: deletion notifications survive the deleted subject.
CREATE TRIGGER "business_user_deleted" AFTER DELETE ON "user"
BEGIN INSERT INTO "businessEvent" ("id","type","subjectId","data","createdAt","expiresAt") SELECT lower(hex(randomblob(16))), 'user.deleted', OLD."id", json('{}'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), unixepoch('subsec') * 1000 + 604800000 ;
END;
