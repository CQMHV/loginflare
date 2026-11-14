CREATE TABLE "webhookInbox" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL CHECK (json_valid("payload")),
    "receivedAt" TEXT NOT NULL
);
