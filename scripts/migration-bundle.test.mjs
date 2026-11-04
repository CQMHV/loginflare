import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildMigrationBundle, migrationStatements } from './migration-bundle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = buildMigrationBundle(root);

test('Wrangler SQL parsing preserves trigger bodies, comments and quoted semicolons', () => {
    const statements = migrationStatements(`-- CREATE TRIGGER is only a comment.
        BEGIN TRANSACTION;
        CREATE TABLE items (id TEXT, value TEXT);
        CREATE TRIGGER items_insert AFTER INSERT ON items BEGIN
            UPDATE items SET value = CASE WHEN NEW.value = 'a;b' THEN 'BEGIN;END' ELSE NEW.value END WHERE id = NEW.id;
            SELECT 1;
        END;
        COMMIT;`);
    assert.equal(statements.length, 2);
    const db = new DatabaseSync(':memory:');
    try {
        for (const sql of statements) db.exec(sql);
        db.prepare('INSERT INTO items VALUES (?, ?)').run('one', 'a;b');
        assert.equal(db.prepare('SELECT value FROM items').get().value, 'BEGIN;END');
    } finally { db.close(); }
    assert.throws(() => migrationStatements('BEGIN; CREATE TABLE x(id);'), /unbalanced/);
    assert.throws(() => migrationStatements('CREATE TABLE x(id); SAVEPOINT nested;'), /unsupported/);
    assert.throws(() => migrationStatements('INSERT INTO x VALUES (?);'), /unbound parameters/);
});

test('bundle is deterministic and preserves foreign-key PRAGMA order', () => {
    assert.deepEqual(buildMigrationBundle(root), bundle);
    for (const name of ['0014_social_provider_presets.sql', '0015_social_x_telegram.sql']) {
        const migration = bundle.migrations.find((item) => item.name === name);
        assert.match(migration.statements[0], /PRAGMA defer_foreign_keys = ON/i);
        assert.match(migration.statements.at(-1), /PRAGMA defer_foreign_keys = OFF/i);
        assert.equal(migration.statements.filter((sql) => /CREATE TRIGGER/i.test(sql)).length, 6);
    }
});

function fixtureBefore(name) {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE);');
    for (const migration of bundle.migrations) {
        if (migration.name === name) break;
        db.exec(readFileSync(resolve(root, 'migrations', migration.name), 'utf8'));
        db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(migration.name);
    }
    db.prepare('INSERT INTO socialConnection (id,name,type,config,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
        .run('existing', 'Existing connector', 'google', '{"clientId":"preserved"}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    return db;
}

const snapshot = (db) => ({
    schema: db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all(),
    connections: db.prepare('SELECT * FROM socialConnection').all(),
    migrations: db.prepare('SELECT * FROM d1_migrations ORDER BY id').all(),
});

for (const name of ['0014_social_provider_presets.sql', '0015_social_x_telegram.sql']) {
    test(`${name} rolls back data, rebuilt schema, triggers and migration registration together`, async (t) => {
        const migration = bundle.migrations.find((item) => item.name === name);
        const points = migration.statements.flatMap((sql, index) => /INSERT INTO .*_next|DROP TABLE|ALTER TABLE|CREATE TRIGGER/i.test(sql) ? [index] : []);
        points.push(migration.statements.length);
        for (const failAfter of points) await t.test(`failure after statement ${failAfter}`, () => {
            const db = fixtureBefore(name);
            try {
                const before = snapshot(db);
                db.exec('BEGIN');
                assert.throws(() => {
                    for (let index = 0; index < migration.statements.length; index++) {
                        db.exec(migration.statements[index]);
                        if (index === failAfter) db.exec('SELECT deliberately_missing_function()');
                    }
                    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
                    db.exec('SELECT deliberately_missing_function()');
                }, /missing_function/);
                db.exec('ROLLBACK');
                assert.deepEqual(snapshot(db), before);
            } finally { db.close(); }
        });
    });
}

test('the migration package rejects a statement above the D1 size limit', () => {
    assert.throws(() => migrationStatements(`INSERT INTO x VALUES ('${'x'.repeat(100_001)}');`, 'oversized.sql'), /100 KB/);
});
