import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { buildMigrationBundle } from './migration-bundle.mjs';
import { release } from './releases.mjs';

const { migrations } = buildMigrationBundle();
const lastNumber = migrations.at(-1).name.split('_', 1)[0];
const extraNumber = String(Number(lastNumber) + 1).padStart(lastNumber.length, '0');
const extra = { name: `${extraNumber}_test.sql`, hash: 'reviewed-test-file', statements: ['CREATE TABLE example (id INTEGER PRIMARY KEY)'] };

function fixture(t) {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON; CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID');
    t.after(() => db.close());
    const target = { account: 'test-account', name: 'test-worker', database: 'test-database', avatars: 'test-avatars', privateBucket: 'test-private' };
    let publishes = 0;
    const query = async (batch) => {
        db.exec('BEGIN');
        try {
            const result = batch.map(({ sql, params }) => ({ results: db.prepare(sql).all(...params) }));
            db.exec('COMMIT');
            return result;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    const options = { query, target, migrations, online: {}, isCurrent: async () => true, verify: async () => {},
        publish: async () => { publishes++; }, pause: () => wait(5) };
    return { db, options, publishes: () => publishes };
}

test('a clean release applies the complete history, then code-only releases do no migrations', async (t) => {
    const f = fixture(t);
    const history = [...migrations, extra];
    f.options.migrations = history;
    await release(f.options);
    const ledger = () => f.db.prepare('SELECT name, digest, appliedAt FROM lfReleaseMigration ORDER BY name').all();
    const before = ledger();
    assert.deepEqual(before.map(({ name, digest }) => ({ name, digest })), history.map(({ name, hash }) => ({ name, digest: hash })));
    const statements = [];
    await release({ ...f.options, query: (batch) => { statements.push(...batch.map(({ sql }) => sql)); return f.options.query(batch); } });
    assert.deepEqual(ledger(), before);
    assert.equal(statements.filter((sql) => /^INSERT INTO lfReleaseMigration|^ALTER TABLE/.test(sql)).length, 0);
    assert.equal(f.publishes(), 2);
    await assert.rejects(release({ ...f.options, target: { ...f.options.target, name: 'other' } }), /different Worker/);
    await assert.rejects(release({ ...f.options, migrations: [{ ...history[0], hash: 'modified' }, ...history.slice(1)] }), /history mismatch/);
});

test('a database with an unmanaged schema is not used for a first release', async (t) => {
    const f = fixture(t);
    f.db.exec('CREATE VIEW unrelated AS SELECT 1');
    await assert.rejects(release(f.options), /database is not empty/);
    assert.equal(f.publishes(), 0);
});

test('only approved migrations run on existing data; a failed migration rolls back and can be retried', async (t) => {
    const f = fixture(t);
    await release(f.options);
    await assert.rejects(release({ ...f.options, migrations: [...migrations, extra] }), /no matching online migration approval/);
    const failing = { ...extra, statements: [...extra.statements, 'SELECT missing_function()'] };
    const online = { [extra.name]: extra.hash };
    await assert.rejects(release({ ...f.options, online, migrations: [...migrations, failing] }), /Migration \d+_test\.sql failed/);
    assert.equal(f.db.prepare("SELECT name FROM sqlite_schema WHERE name='example'").get(), undefined);
    assert.equal(f.db.prepare('SELECT name FROM lfReleaseMigration WHERE name = ?').get(extra.name), undefined);
    assert.equal(f.publishes(), 1);
    assert.equal(await release({ ...f.options, online, migrations: [...migrations, extra] }), true);
    assert.equal(f.db.prepare('SELECT digest FROM lfReleaseMigration WHERE name = ?').get(extra.name).digest, extra.hash);
    assert.equal(f.publishes(), 2);
});

test('the current build waits for the database lock and a superseded build cannot publish', async (t) => {
    const f = fixture(t);
    let head = 'old';
    let resume, entered, waiting;
    const hold = new Promise((resolve) => { resume = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const waitingOnLock = new Promise((resolve) => { waiting = resolve; });
    const promotions = [];
    const old = release({ ...f.options, isCurrent: async () => head === 'old',
        prepare: async () => { entered(); await hold; }, publish: async () => promotions.push('old') });
    await started;
    head = 'new';
    const latest = release({ ...f.options, isCurrent: async () => head === 'new',
        pause: async () => { waiting(); await wait(5); }, publish: async () => promotions.push('new') });
    await waitingOnLock;
    assert.deepEqual(promotions, []);
    resume();
    assert.deepEqual(await Promise.all([old, latest]), [false, true]);
    assert.deepEqual(promotions, ['new']);
});
