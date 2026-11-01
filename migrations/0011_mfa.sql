ALTER TABLE "user" ADD COLUMN "twoFactorEnabled" integer NOT NULL DEFAULT 0;

-- Better Auth two-factor schema. Secrets and backup codes are encrypted by the plugin.
CREATE TABLE "twoFactor" (
    "id" text NOT NULL PRIMARY KEY,
    "secret" text NOT NULL,
    "backupCodes" text NOT NULL,
    "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "verified" integer DEFAULT 1,
    "failedVerificationCount" integer DEFAULT 0,
    "lockedUntil" date
);
CREATE UNIQUE INDEX "twoFactor_userId_idx" ON "twoFactor" ("userId");
CREATE INDEX "twoFactor_secret_idx" ON "twoFactor" ("secret");
CREATE INDEX "verification_value_identifier_idx" ON "verification" ("value", "identifier");
