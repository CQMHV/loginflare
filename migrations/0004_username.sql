-- Existing accounts choose their username through the account profile.
ALTER TABLE "user" ADD COLUMN "username" TEXT COLLATE NOCASE;
CREATE UNIQUE INDEX "user_username_unique" ON "user" ("username" COLLATE NOCASE);
