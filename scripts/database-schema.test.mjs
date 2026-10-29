import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { checkDatabase, expectedSchema, prepareDatabase } from './database-schema.mjs';
import { snapshotLocal } from './local-snapshot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationFiles = readdirSync(join(root, 'migrations')).filter((file) => file.endsWith('.sql')).sort();
const localId = '00000000-0000-4000-8000-000000000001';
const iso = '2025-01-02T03:04:05.678Z';
const timestamp = Date.parse(iso);

function migrate(database) {
    for (const file of migrationFiles) database.exec(readFileSync(join(root, 'migrations', file), 'utf8'));
}
function fixture(t) {
    const database = new DatabaseSync(':memory:');
    migrate(database);
    t.after(() => database.close());
    const queries = [];
    const query = (sql) => { queries.push(sql); return database.prepare(sql).all(); };
    return { database, query, queries };
}
function addUser(database, id = 'fixture-user', createdAt = iso, updatedAt = createdAt) {
    database.prepare('INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "role", "username") VALUES (?, ?, ?, 1, ?, ?, ?, ?)')
        .run(id, 'Local fixture', `${id}@example.test`, createdAt, updatedAt, 'user', id.replaceAll('-', '_'));
}
function addClient(database, { id = 'fixture-client', redirects = ['https://example.test/callback'], metadata = { unrelated: { retained: true } }, createdAt = iso } = {}) {
    database.prepare('INSERT INTO "oauthClient" ("id", "clientId", "name", "referenceId", "redirectUris", "postLogoutRedirectUris", "metadata", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, id, 'Local fixture application', 'loginflare', JSON.stringify(redirects), '["https://example.test/signed-out?exact=%2F"]', JSON.stringify(metadata), createdAt, createdAt);
}

test('migration preparation aborts when a callback edit wins its compare-and-set', (t) => {
    const { database, query } = fixture(t);
    addClient(database);
    let raced = false;
    const racingQuery = (sql) => {
        if (!raced && /^UPDATE "oauthClient" SET metadata/.test(sql)) {
            raced = true;
            database.prepare('UPDATE "oauthClient" SET "redirectUris" = ? WHERE id = ?').run('["https://changed.example/callback"]', 'fixture-client');
        }
        return query(sql);
    };
    assert.throws(() => prepareDatabase(root, racingQuery), /changed during migration/);
    assert.equal(JSON.parse(database.prepare('SELECT metadata FROM "oauthClient"').get().metadata).loginflareRedirectOrigins, undefined);
});

test('schema gate rejects stale callback metadata and missing URI projections', (t) => {
    const { database, query } = fixture(t);
    addClient(database, { metadata: { loginflareRedirectOrigins: ['https://obsolete.example'] } });
    assert.throws(() => checkDatabase(root, query), /Origin metadata is inconsistent/);
    prepareDatabase(root, query);
    checkDatabase(root, query);
    database.exec('DELETE FROM "oauthClientUri"');
    assert.throws(() => checkDatabase(root, query), /registry is inconsistent/);
});

test('all committed migrations produce a schema accepted by the same structural check', (t) => {
    const { database, query } = fixture(t);
    const expected = expectedSchema(root);
    const report = checkDatabase(root, query);
    assert.ok(report.tables >= 15);
    assert.ok(report.indexes >= 25);
    assert.ok(report.triggers >= 10);
    assert.equal(report.tables, expected.objects.filter((object) => object.type === 'table').length);
    assert.equal(report.indexes, expected.objects.filter((object) => object.type === 'index').length);
    assert.equal(report.triggers, expected.objects.filter((object) => object.type === 'trigger').length);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('missing columns, indexes, and triggers are rejected before normal use', async (t) => {
    await t.test('missing user column', (t) => {
        const { database, query } = fixture(t);
        database.exec('ALTER TABLE "user" DROP COLUMN "image"');
        assert.throws(() => checkDatabase(root, query), /column differs: user\.image|table differs.*user/);
    });
    await t.test('missing list seek index', (t) => {
        const { database, query } = fixture(t);
        database.exec('DROP INDEX "user_createdAt_id_idx"');
        assert.throws(() => checkDatabase(root, query), /Missing database index: user_createdAt_id_idx/);
    });
    await t.test('missing security trigger', (t) => {
        const { database, query } = fixture(t);
        database.exec('DROP TRIGGER "user_email_owner_guard"');
        assert.throws(() => checkDatabase(root, query), /Missing database trigger: user_email_owner_guard/);
    });
});

test('a same-named index or trigger with different behavior is rejected', async (t) => {
    await t.test('incorrect index order', (t) => {
        const { database, query } = fixture(t);
        database.exec('DROP INDEX "user_createdAt_id_idx"; CREATE INDEX "user_createdAt_id_idx" ON "user" ("id", "createdAt")');
        assert.throws(() => checkDatabase(root, query), /index differs.*user_createdAt_id_idx/);
    });
    await t.test('security trigger replaced with a no-op', (t) => {
        const { database, query } = fixture(t);
        database.exec('DROP TRIGGER "user_email_owner_guard"; CREATE TRIGGER "user_email_owner_guard" BEFORE UPDATE OF "email" ON "user" BEGIN SELECT 1; END');
        assert.throws(() => checkDatabase(root, query), /trigger differs.*user_email_owner_guard/);
    });
});

test('foreign-key corruption is rejected even when tables and indexes exist', (t) => {
    const { database, query } = fixture(t);
    database.exec('PRAGMA foreign_keys = OFF');
    database.prepare('INSERT INTO "userEmail" ("id", "userId", "email", "verified", "createdAt") VALUES (?, ?, ?, 0, ?)')
        .run('orphan-email', 'missing-user', 'orphan@example.test', timestamp);
    database.exec('PRAGMA foreign_keys = ON');
    assert.throws(() => checkDatabase(root, query), /foreign-key validation failed/);
});

test('preparation normalizes native numeric dates in bounded batches and leaves application epoch fields alone', (t) => {
    const { database, query, queries } = fixture(t);
    database.exec('BEGIN');
    for (let index = 0; index < 501; index++) addUser(database, `fixture-${String(index).padStart(3, '0')}`, timestamp, timestamp + 0.25);
    database.exec('COMMIT');
    database.prepare('INSERT INTO "session" ("id", "token", "userId", "createdAt", "updatedAt", "expiresAt") VALUES (?, ?, ?, ?, ?, ?)')
        .run('fixture-session', 'test-only-session-token', 'fixture-000', timestamp, timestamp, timestamp + 86_400_000);
    database.prepare('INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt", "password") VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('fixture-credential', 'fixture-000', 'credential', 'fixture-000', timestamp, timestamp, 'test-only-hash');
    const registryDate = database.prepare('SELECT "createdAt" FROM "userEmail" WHERE "userId" = ?').get('fixture-000').createdAt;
    assert.throws(() => checkDatabase(root, query), /Native database dates/);
    prepareDatabase(root, query);
    const row = database.prepare('SELECT "createdAt", "updatedAt", typeof("createdAt") AS dateType FROM "user" WHERE "id" = ?').get('fixture-000');
    assert.equal(row.createdAt, iso);
    assert.equal(row.updatedAt, iso);
    assert.equal(row.dateType, 'text');
    assert.equal(database.prepare('SELECT "expiresAt" FROM "session" WHERE "id" = ?').get('fixture-session').expiresAt, '2025-01-03T03:04:05.678Z');
    assert.equal(database.prepare('SELECT "createdAt" FROM "account" WHERE "id" = ?').get('fixture-credential').createdAt, iso);
    const address = database.prepare('SELECT "createdAt", typeof("createdAt") AS dateType FROM "userEmail" WHERE "userId" = ?').get('fixture-000');
    assert.equal(address.createdAt, registryDate);
    assert.equal(address.dateType, 'integer');
    assert.ok(queries.filter((sql) => sql.startsWith('UPDATE "user" SET')).length >= 2);
    assert.doesNotThrow(() => checkDatabase(root, query));
    const changes = database.prepare('SELECT total_changes() AS count').get().count;
    prepareDatabase(root, query);
    assert.equal(database.prepare('SELECT count(*) AS count FROM "user"').get().count, 501);
    assert.equal(database.prepare('SELECT total_changes() AS count').get().count, changes);
});

test('noncanonical native text dates are rejected rather than accommodated by runtime query fallbacks', async (t) => {
    for (const value of ['not-a-date', '2025-01-02T03:04:05Z', '2025-01-02T04:04:05.678+01:00', '2025-02-31T03:04:05.678Z']) {
        await t.test(value, (t) => {
            const { database, query } = fixture(t);
            addUser(database, 'fixture-user', value);
            assert.throws(() => checkDatabase(root, query), /date|ISO/i);
        });
    }
});

test('callback metadata uses URL-standard origins without rewriting complete URIs or other metadata', (t) => {
    const { database, query, queries } = fixture(t);
    const redirects = ['https://BÜCHER.example:443/callback?next=%2Fhome', 'https://xn--bcher-kva.example/another', 'https://example.test:8443/path'];
    for (let index = 0; index < 51; index++) addClient(database, { id: `client-${String(index).padStart(3, '0')}`, redirects, metadata: { vendor: { key: 'preserve-me' }, loginflareRedirectOrigins: ['https://obsolete.example'] } });
    prepareDatabase(root, query);
    const row = database.prepare('SELECT "redirectUris", "postLogoutRedirectUris", "metadata" FROM "oauthClient" WHERE "id" = ?').get('client-000');
    assert.equal(row.redirectUris, JSON.stringify(redirects));
    assert.equal(row.postLogoutRedirectUris, '["https://example.test/signed-out?exact=%2F"]');
    assert.deepEqual(JSON.parse(row.metadata), { vendor: { key: 'preserve-me' }, loginflareRedirectOrigins: ['https://xn--bcher-kva.example', 'https://example.test:8443'] });
    assert.ok(queries.filter((sql) => sql.startsWith('SELECT id, "redirectUris", metadata')).length >= 3);
    const registry = database.prepare('SELECT "value" FROM "oauthClientUri" WHERE "clientId" = ? AND "kind" = ? ORDER BY "value"').all('client-000', 'redirect-origin');
    assert.deepEqual(registry.map((entry) => entry.value), ['https://example.test:8443', 'https://xn--bcher-kva.example']);
    const before = queries.filter((sql) => sql.startsWith('UPDATE "oauthClient" SET metadata')).length;
    prepareDatabase(root, query);
    assert.equal(queries.filter((sql) => sql.startsWith('UPDATE "oauthClient" SET metadata')).length, before);
    assert.doesNotThrow(() => checkDatabase(root, query));
});

test('unsafe or malformed stored callbacks stop preparation instead of granting an origin', async (t) => {
    for (const uri of ['http://example.test/callback', 'https://user:password@example.test/callback', 'https://example.test/callback#fragment', 'not a URL']) {
        await t.test(uri, (t) => {
            const { database, query } = fixture(t);
            addClient(database, { redirects: [uri] });
            const before = database.prepare('SELECT "metadata" FROM "oauthClient"').get().metadata;
            assert.throws(() => prepareDatabase(root, query));
            assert.equal(database.prepare('SELECT "metadata" FROM "oauthClient"').get().metadata, before);
        });
    }
});

function temporaryRoot(t) {
    const base = resolve(tmpdir());
    const directory = mkdtempSync(join(base, 'loginflare-schema-test-'));
    const closers = [];
    t.after(() => {
        for (const close of closers.reverse()) close();
        const target = resolve(directory);
        if (!target.startsWith(`${base}${sep}`) || !basename(target).startsWith('loginflare-schema-test-')) throw new Error('Refusing to clean an unexpected test directory.');
        rmSync(target, { recursive: true, force: true });
    });
    return { directory, closers };
}
function localConfiguration(directory, overrides = {}) {
    const configuration = {
        vars: { APP_ENV: 'development', AUTH_URL: 'http://localhost:5173' },
        d1_databases: [{ binding: 'DB', database_id: localId, remote: false }],
        ...overrides,
    };
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'wrangler.jsonc'), JSON.stringify(configuration));
}

test('an online WAL snapshot restores independently with complete rows, schema and local-only secrets', async (t) => {
    const { directory, closers } = temporaryRoot(t);
    const source = join(directory, 'source');
    localConfiguration(source);
    const relativeDatabase = 'miniflare-D1DatabaseObject/fixture.sqlite';
    const sourceFile = join(source, '.cloudflare/state/v3/d1', relativeDatabase);
    mkdirSync(dirname(sourceFile), { recursive: true });
    const database = new DatabaseSync(sourceFile);
    closers.push(() => database.close());
    database.exec('PRAGMA journal_mode = WAL');
    migrate(database);
    addUser(database, 'first-user');
    addUser(database, 'second-user');
    writeFileSync(join(source, '.dev.vars'), 'BETTER_AUTH_SECRET=test-only-local-secret\n');
    writeFileSync(join(source, '.dev.vars.staging.json'), '{"BETTER_AUTH_SECRET":"must-never-copy-staging-secret"}');
    mkdirSync(join(source, 'work'));
    writeFileSync(join(source, 'work/local-preview-accounts.json'), '{"accounts":[{"password":"test-only-preview-password"}]}');
    writeFileSync(join(source, 'work/local-expanded-preview-accounts.json'), '{"accounts":[{"password":"test-only-extra-password"}]}');
    const destination = join(directory, 'snapshot');
    const report = await snapshotLocal(source, destination);
    assert.equal(report.integrity, 'ok');
    assert.equal(report.destination, destination);
    assert.equal(existsSync(join(destination, '.dev.vars.staging.json')), false);
    assert.equal(readFileSync(join(destination, '.gitignore'), 'utf8'), '*\n');
    const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8'));
    assert.equal(manifest.databaseId, localId);
    assert.equal(manifest.files.length, 4);
    assert.ok(manifest.files.includes(`d1/${relativeDatabase}`));
    assert.ok(!JSON.stringify(manifest).includes('test-only-local-secret'));
    addUser(database, 'created-after-snapshot');
    const restored = join(directory, 'isolated-restore');
    for (const file of manifest.files) {
        const target = file.startsWith('d1/') ? join(restored, '.cloudflare/state/v3', file) : join(restored, file);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(destination, file), target);
    }
    const snapshot = new DatabaseSync(join(restored, '.cloudflare/state/v3/d1', relativeDatabase), { readOnly: true });
    closers.push(() => snapshot.close());
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(snapshot.prepare('SELECT count(*) AS count FROM "user"').get().count, 2);
    assert.equal(snapshot.prepare('SELECT count(*) AS count FROM "userEmail"').get().count, 2);
    assert.equal(database.prepare('SELECT count(*) AS count FROM "user"').get().count, 3);
    assert.doesNotThrow(() => checkDatabase(root, (sql) => snapshot.prepare(sql).all()));
    assert.equal(readFileSync(join(restored, '.dev.vars'), 'utf8'), 'BETTER_AUTH_SECRET=test-only-local-secret\n');
    assert.equal(existsSync(join(restored, '.dev.vars.staging.json')), false);
    assert.equal(readFileSync(join(restored, 'work/local-preview-accounts.json'), 'utf8'), readFileSync(join(source, 'work/local-preview-accounts.json'), 'utf8'));
});

test('snapshots refuse non-local bindings before creating output', async (t) => {
    const { directory } = temporaryRoot(t);
    const source = join(directory, 'source');
    const cases = [
        { vars: { APP_ENV: 'staging', AUTH_URL: 'http://localhost:5173' } },
        { vars: { APP_ENV: 'development', AUTH_URL: 'https://production.example.test' } },
        { d1_databases: [{ binding: 'DB', database_id: localId, remote: true }] },
        { d1_databases: [] },
    ];
    for (const [index, configuration] of cases.entries()) {
        localConfiguration(source, configuration);
        const output = join(directory, `forbidden-output-${index}`);
        await assert.rejects(snapshotLocal(source, output), /Local snapshots require/);
        assert.equal(existsSync(output), false);
    }
});
