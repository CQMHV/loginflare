-- Existing keys have no deadline. Allow a full rotation interval after upgrade;
-- do not invalidate already-issued tokens or change encrypted key material.
UPDATE "jwks" SET "expiresAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+90 days')
WHERE "expiresAt" IS NULL;
