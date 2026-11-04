CREATE TABLE "auditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "event" TEXT NOT NULL,
    "outcome" TEXT NOT NULL CHECK ("outcome" IN ('success', 'failure')),
    "actorUserId" TEXT,
    "targetUserId" TEXT,
    "clientId" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "reason" TEXT,
    "requestId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" DATE NOT NULL,
    "expiresAt" INTEGER NOT NULL
);
CREATE INDEX "auditLog_created_idx" ON "auditLog" ("createdAt", "id");
CREATE INDEX "auditLog_event_idx" ON "auditLog" ("event", "createdAt", "id");
CREATE INDEX "auditLog_outcome_idx" ON "auditLog" ("outcome", "createdAt", "id");
CREATE INDEX "auditLog_actor_idx" ON "auditLog" ("actorUserId", "createdAt", "id");
CREATE INDEX "auditLog_target_user_idx" ON "auditLog" ("targetUserId", "createdAt", "id");
CREATE INDEX "auditLog_client_idx" ON "auditLog" ("clientId", "createdAt", "id");
CREATE INDEX "auditLog_expiry_idx" ON "auditLog" ("expiresAt", "id");
