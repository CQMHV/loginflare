CREATE TABLE appSession (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, expiresAt INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 0, refreshingAt INTEGER
);
CREATE INDEX appSession_expiry ON appSession(expiresAt);
