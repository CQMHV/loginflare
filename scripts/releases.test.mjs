import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { buildMigrationBundle } from './migration-bundle.mjs';
import { release } from './releases.mjs';
import { migrateAvatarUrls } from './public-assets.mjs';

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

async function mediaFixture(t, count = 1) {
    const f = fixture(t);
    await release(f.options);
    const origin = 'https://auth.example.test', base = 'https://images.example.test', user = crypto.randomUUID();
    const ids = Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
    const now = new Date().toISOString();
    f.db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
        .run(user, 'Media fixture', 'media@example.test', now, now);
    for (const id of ids) f.db.prepare('INSERT INTO userAvatar (id, userId, url, createdAt, deleteAfter) VALUES (?, ?, ?, 1, 2)')
        .run(id, id === ids[0] ? user : null, `${origin}/avatars/${id}`);
    const original = `${origin}/avatars/${ids[0]}`;
    f.db.prepare('UPDATE "user" SET image = ? WHERE id = ?').run(original, user);
    return { ...f, original, base, ids, image: () => f.db.prepare('SELECT image FROM "user" WHERE id = ?').get(user).image };
}

test('a superseded public-media release leaves existing avatar URLs and lifecycle state unchanged', async (t) => {
    const f = await mediaFixture(t);
    let current = true, migrated = false;
    const before = f.db.prepare('SELECT * FROM userAvatar').all();
    const result = await release({ ...f.options, isCurrent: async () => current,
        prepare: async () => { current = false; },
        afterPublish: async () => { migrated = true; await migrateAvatarUrls(f.options.query, f.base); },
    });
    assert.equal(result, false); assert.equal(f.publishes(), 1); assert.equal(migrated, false);
    assert.equal(f.image(), f.original);
    assert.deepEqual(f.db.prepare('SELECT * FROM userAvatar').all(), before);
    // A subsequent ordinary release needs no repair of an unpublished URL.
    await release(f.options);
    assert.equal(f.image(), f.original);
});

test('failed or ambiguous publication cannot run the media migration', async (t) => {
    const f = await mediaFixture(t);
    let migrated = false;
    await assert.rejects(release({ ...f.options,
        publish: async () => { throw new Error('Publication could not be confirmed'); },
        afterPublish: async () => { migrated = true; await migrateAvatarUrls(f.options.query, f.base); },
    }), /Publication could not be confirmed/);
    assert.equal(migrated, false); assert.equal(f.image(), f.original);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM lfReleaseLock').get().n, 1);
});

test('media URLs change only after confirmed publication, and repeated completion is idempotent', async (t) => {
    const f = await mediaFixture(t);
    const steps = [];
    await release({ ...f.options,
        publish: async () => { steps.push('published'); assert.equal(f.image(), f.original); },
        afterPublish: async () => { steps.push('migrated'); await migrateAvatarUrls(f.options.query, f.base); },
    });
    assert.deepEqual(steps, ['published', 'migrated']);
    assert.equal(f.image(), `${f.base}/${f.ids[0]}`);
    assert.equal(f.db.prepare('SELECT deleteAfter FROM userAvatar WHERE id = ?').get(f.ids[0]).deleteAfter, null);
    const events = f.db.prepare('SELECT count(*) AS n FROM businessEvent').get().n;
    await release({ ...f.options, afterPublish: () => migrateAvatarUrls(f.options.query, f.base) });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM businessEvent').get().n, events);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM lfReleaseLock').get().n, 0);
});

test('an interrupted post-publication migration releases the lock and resumes remaining pages', async (t) => {
    const f = await mediaFixture(t, 205);
    let published = false, pages = 0;
    await assert.rejects(release({ ...f.options,
        publish: async () => { published = true; },
        afterPublish: () => migrateAvatarUrls(async (batch) => {
            assert.equal(published, true);
            if (batch.length === 3 && ++pages === 2) throw new Error('Migration interrupted');
            return f.options.query(batch);
        }, f.base),
    }), /Migration interrupted/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM lfReleaseLock').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM userAvatar WHERE url = ? || \'/\' || id').get(f.base).n, 200);
    let remaining;
    await release({ ...f.options, afterPublish: async () => { remaining = await migrateAvatarUrls(f.options.query, f.base); } });
    assert.equal(remaining, 5);
    assert.equal(f.image(), `${f.base}/${f.ids[0]}`);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM userAvatar WHERE deleteAfter = 2').get().n, 204);
    assert.equal(f.db.prepare('SELECT deleteAfter FROM userAvatar WHERE id = ?').get(f.ids[0]).deleteAfter, null);
});

test('slow publication renews the owned lease before post-publication data work', async (t) => {
    const f = await mediaFixture(t);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    await release({ ...f.options,
        prepare: async () => { t.mock.timers.tick(8 * 60_000); },
        publish: async () => { t.mock.timers.tick(5 * 60_000); },
        afterPublish: async () => {
            const lock = f.db.prepare('SELECT expiresAt FROM lfReleaseLock').get();
            assert.equal(lock.expiresAt - Date.now(), 15 * 60_000);
            t.mock.timers.tick(2 * 60_000);
            await migrateAvatarUrls(f.options.query, f.base);
        },
    });
    assert.equal(f.image(), `${f.base}/${f.ids[0]}`);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM lfReleaseLock').get().n, 0);
});
