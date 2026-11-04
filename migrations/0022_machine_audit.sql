-- Machine identities are independent actors. Keep audit references after a
-- client is removed, just as human audit actors survive user deletion.
ALTER TABLE "auditLog" ADD COLUMN "actorClientId" TEXT
    CHECK ("actorClientId" IS NULL OR "actorUserId" IS NULL);
CREATE INDEX "auditLog_actor_client_idx" ON "auditLog" ("actorClientId", "createdAt", "id");
