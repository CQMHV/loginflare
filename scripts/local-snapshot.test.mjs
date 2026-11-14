import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { snapshotLocal, verifyLocalSnapshot } from './local-snapshot.mjs';

test('schedules indefinite signing keys without changing material or existing deadlines', async () => {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec(`CREATE TABLE jwks(id TEXT, publicKey TEXT, privateKey TEXT, expiresAt TEXT);
            INSERT INTO jwks VALUES ('old', 'public', 'encrypted-private', NULL), ('timed', 'other', 'other-private', '2030-01-01T00:00:00.000Z');`);
        db.exec(await readFile(new URL('../migrations/0024_signing_key_rotation.sql', import.meta.url), 'utf8'));
        const old = db.prepare("SELECT * FROM jwks WHERE id = 'old'").get();
        assert.equal(old.privateKey, 'encrypted-private');
        assert.ok(new Date(old.expiresAt).getTime() > Date.now() + 89 * 86400_000);
        assert.equal(db.prepare("SELECT expiresAt FROM jwks WHERE id = 'timed'").get().expiresAt, '2030-01-01T00:00:00.000Z');
    } finally { db.close(); }
});

test('verifies database, private R2 material and credentials and detects tampering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loginflare-snapshot-'));
    try {
        await writeFile(join(root, 'wrangler.local.jsonc'), JSON.stringify({ vars: { APP_ENV: 'development', AUTH_URL: 'http://localhost:5173' },
            d1_databases: [{ binding: 'DB', remote: false, database_id: 'fixture' }], r2_buckets: [{ remote: false }] }));
        await mkdir(join(root, '.cloudflare/state/v3/d1'), { recursive: true });
        await mkdir(join(root, '.cloudflare/state/v3/r2/PRIVATE'), { recursive: true });
        const db = new DatabaseSync(join(root, '.cloudflare/state/v3/d1/db.sqlite'));
        db.exec('CREATE TABLE fixture (id TEXT PRIMARY KEY); INSERT INTO fixture VALUES (\'account\')');
        db.close();
        await writeFile(join(root, '.cloudflare/state/v3/r2/PRIVATE/installation.json'), 'private-material');
        await writeFile(join(root, '.dev.vars'), 'private-secret');
        const snapshot = await snapshotLocal(root);
        assert.equal((await verifyLocalSnapshot(snapshot.destination)).integrity, 'ok');
        const manifest = JSON.parse(await readFile(join(snapshot.destination, 'manifest.json'), 'utf8'));
        assert.ok(manifest.sha256['r2/PRIVATE/installation.json']);
        await writeFile(join(snapshot.destination, '.dev.vars'), 'changed');
        await assert.rejects(verifyLocalSnapshot(snapshot.destination), /checksum mismatch/);
        manifest.files = ['../outside'];
        await writeFile(join(snapshot.destination, 'manifest.json'), JSON.stringify(manifest));
        await assert.rejects(verifyLocalSnapshot(snapshot.destination), /Invalid snapshot path/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
