import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { buildMigrationBundle } from './migration-bundle.mjs';
import { inspectUpgrade, requireUpgrade, verifyActiveWorker, verifyPublished, verifyUpgradeSchema } from './upgrade-state.mjs';
import { parseUpgradeArguments } from './upgrade.mjs';
import { release } from './releases.mjs';
import { validateLocalState } from './local-upgrade.mjs';
import { resolveTarget } from './deployment.mjs';
import { loadRelease } from './release-manifest.mjs';

const bundle = buildMigrationBundle();
const target = { account: 'test', name: 'worker', database: 'db', avatars: 'avatars', privateBucket: 'private' };
function fixture(t) {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON; CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)');
    t.after(() => db.close());
    const writes = [];
    const query = async (batch) => {
        db.exec('BEGIN');
        try {
            const result = batch.map(({ sql, params }) => {
                if (!/^SELECT|^PRAGMA/i.test(sql)) writes.push(sql);
                return { results: db.prepare(sql).all(...params) };
            });
            db.exec('COMMIT'); return result;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    const options = { query, target, migrations: bundle.migrations, online: {}, version: '0.2.0', commit: '1'.repeat(40) };
    const apply = (extra = {}) => release({ ...options, deployment: { version: options.version, commit: options.commit },
        verify: async () => {}, isCurrent: async () => true, publish: async () => {}, ...extra });
    return { db, writes, options, apply };
}

test('planning is read-only for new and initialized databases and blocks unsafe histories', async (t) => {
    const f = fixture(t);
    assert.equal(requireUpgrade(await inspectUpgrade(f.options)).pending.length, bundle.migrations.length);
    assert.equal(f.writes.length, 0);
    await f.apply();
    f.writes.length = 0;
    assert.equal(requireUpgrade(await inspectUpgrade(f.options)).pending.length, 0);
    assert.equal(f.writes.length, 0);
    await assert.rejects(async () => requireUpgrade(await inspectUpgrade({ ...f.options, target: { ...target, name: 'other' } })), /different Worker/);
    f.db.prepare('UPDATE lfReleaseMigration SET digest = ? WHERE name = ?').run('changed', bundle.migrations[0].name);
    assert.match((await inspectUpgrade(f.options)).blockers.join(), /history mismatch/);
    assert.equal(f.writes.length, 0);
});

test('preflight separates upstream approvals, downstream migrations and unknown databases', async (t) => {
    const f = fixture(t);
    await f.apply();
    const extra = { name: '0028_fork.sql', hash: 'fork-hash', statements: ['CREATE TABLE forkData (id INTEGER PRIMARY KEY)'] };
    const options = { ...f.options, migrations: [...bundle.migrations, extra] };
    assert.match((await inspectUpgrade(options)).blockers.join(), /no matching online/);
    assert.equal(requireUpgrade(await inspectUpgrade({ ...options, online: { [extra.name]: extra.hash } })).pending.length, 1);
    f.db.exec('DROP TABLE lfReleaseTarget');
    assert.match((await inspectUpgrade(f.options)).blockers.join(), /not empty/);
});

test('publication stage survives verification failure and a retry completes without repeating migrations', async (t) => {
    const f = fixture(t);
    await assert.rejects(f.apply({ checkPublished: async () => { throw new Error('readiness unavailable'); } }), /readiness unavailable/);
    assert.equal((await inspectUpgrade(f.options)).deployment.stage, 'verifying');
    const before = f.db.prepare('SELECT * FROM lfReleaseMigration ORDER BY name').all();
    await f.apply({ checkPublished: () => verifyUpgradeSchema(f.options.query, bundle) });
    assert.equal((await inspectUpgrade(f.options)).deployment.stage, 'verified');
    assert.deepEqual(f.db.prepare('SELECT * FROM lfReleaseMigration ORDER BY name').all(), before);
});

test('ambiguous publication retains both lease and publishing stage', async (t) => {
    const f = fixture(t);
    await assert.rejects(f.apply({ publish: async () => { throw new Error('unknown upload result'); } }), /unknown upload/);
    const report = await inspectUpgrade(f.options);
    assert.equal(report.deployment.stage, 'publishing');
    assert.match(report.blockers.join(), /lease expires/);
    assert.ok(requireUpgrade(await inspectUpgrade({ ...f.options, waitForLock: true })).lockExpiresAt > Date.now());
});

test('structural verification detects missing security triggers', async (t) => {
    const f = fixture(t);
    await f.apply();
    await verifyUpgradeSchema(f.options.query, bundle);
    f.db.exec('DROP TRIGGER user_email_owner_guard');
    await assert.rejects(verifyUpgradeSchema(f.options.query, bundle), /user_email_owner_guard/);
});

test('schema validation failure prevents publication, and partial migration retry preserves prior ledger entries', async (t) => {
    const f = fixture(t);
    let published = false;
    await assert.rejects(f.apply({ checkSchema: async () => { throw new Error('schema drift'); }, publish: async () => { published = true; } }), /schema drift/);
    assert.equal(published, false);
    const lastMigration = bundle.migrations.at(-1).name.slice(0, -'.sql'.length);
    const extra = { name: `${lastMigration}_test_1.sql`, hash: 'fork', statements: ['CREATE TABLE forkData (id INTEGER PRIMARY KEY)'] };
    const failing = { name: `${lastMigration}_test_2.sql`, hash: 'fail', statements: ['INSERT INTO absent VALUES (1)'] };
    const old = f.db.prepare('SELECT * FROM lfReleaseMigration ORDER BY name').all();
    await assert.rejects(f.apply({ migrations: [...bundle.migrations, extra, failing], online: { [extra.name]: extra.hash, [failing.name]: failing.hash } }),
        (error) => error.message.includes(failing.name));
    assert.deepEqual(f.db.prepare('SELECT * FROM lfReleaseMigration ORDER BY name LIMIT ?').all(old.length), old);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM lfReleaseMigration WHERE name = ?').get(extra.name).n, 1);
});

test('acceptance-style immutable probe remains in the complete history across upstream and code-only updates', async (t) => {
    const f = fixture(t);
    const officialNames = new Set(loadRelease(process.cwd(), bundle).manifest.migrations.map(({ name }) => name));
    const official = bundle.migrations.filter(({ name }) => officialNames.has(name));
    const first = official.filter(({ name }) => name <= '0023_installation.sql');
    await f.apply({ migrations: first });
    const source = 'CREATE TABLE lfAcceptanceProbe (id INTEGER PRIMARY KEY);\nINSERT INTO lfAcceptanceProbe (id) VALUES (1);\n';
    const probe = { name: '0024_acceptance_probe.sql', hash: createHash('sha256').update(source).digest('hex'), statements: ['CREATE TABLE lfAcceptanceProbe (id INTEGER PRIMARY KEY)', 'INSERT INTO lfAcceptanceProbe (id) VALUES (1)'] };
    const history = [...official, probe].sort((a, b) => a.name.localeCompare(b.name));
    const approvals = Object.fromEntries(official.slice(first.length).map(({ name, hash }) => [name, hash]));
    await assert.rejects(f.apply({ migrations: history, online: approvals }), /0024_acceptance_probe.sql has no matching/);
    approvals[probe.name] = probe.hash;
    await f.apply({ migrations: history, online: approvals });
    const before = f.db.prepare('SELECT * FROM lfReleaseMigration ORDER BY name').all();
    await f.apply({ migrations: history, online: approvals });
    assert.deepEqual(f.db.prepare('SELECT * FROM lfReleaseMigration ORDER BY name').all(), before);
    assert.equal(f.db.prepare('SELECT digest FROM lfReleaseMigration WHERE name = ?').get(probe.name).digest, probe.hash);
    assert.deepEqual(f.db.prepare('SELECT id FROM lfAcceptanceProbe').all().map(({ id }) => id), [1]);
});

test('a fresh deployment attempt resumes interrupted avatar backfill after the active Worker clears direct delivery', async (t) => {
    const f = fixture(t);
    await f.apply();
    const origin = 'https://auth.example.test', media = 'https://images.example.test';
    f.db.prepare(`INSERT INTO lfInstallation (id, instanceId, origin, adminEmail, step) VALUES (1, 'test', ?, 'owner@example.test', 'target')`).run(origin);
    const insert = f.db.prepare('INSERT INTO userAvatar (id, url, createdAt, deleteAfter) VALUES (?, ?, 1, 2)');
    for (let index = 0; index < 201; index++) {
        const id = `image-${String(index).padStart(3, '0')}`;
        insert.run(id, `${media}/${id}`);
    }
    let activeMedia = media;
    const config = { vars: { PUBLIC_ASSETS_URL: '' }, d1_databases: [{ binding: 'DB', database_name: 'worker' }],
        r2_buckets: [{ binding: 'AVATARS', bucket_name: 'loginflare-avatars' }, { binding: 'PRIVATE', bucket_name: 'loginflare-private' }] };
    const resolve = () => resolveTarget(async (path) => {
        if (path === '/workers/services/worker') return {};
        if (path.endsWith('/settings')) return { bindings: [{ name: 'PUBLIC_ASSETS_URL', type: 'plain_text', text: activeMedia }] };
        if (path.startsWith('/d1/database?')) return [{ name: 'worker', uuid: '00000000-0000-4000-8000-000000000001' }];
        throw new Error(`Unexpected API call ${path}`);
    }, config, 'test', 'worker');
    const first = await resolve();
    let pages = 0;
    await assert.rejects(f.apply({
        publish: async () => { activeMedia = first.config.vars.PUBLIC_ASSETS_URL; },
        afterPublish: () => first.migrateMedia((batch) => {
            if (batch.length === 3 && ++pages === 2) throw new Error('Interrupted after one page');
            return f.options.query(batch);
        }),
    }), /Interrupted after one page/);
    assert.equal(activeMedia, '');
    assert.equal((await inspectUpgrade(f.options)).deployment.stage, 'post-processing');
    const pending = () => f.db.prepare('SELECT count(*) AS n FROM userAvatar WHERE url <> ? || id').get(`${origin}/avatars/`).n;
    assert.equal(pending(), 1);
    const retry = await resolve();
    await f.apply({ afterPublish: () => retry.migrateMedia(f.options.query) });
    assert.equal(pending(), 0);
    assert.equal((await inspectUpgrade(f.options)).deployment.stage, 'verified');
    f.writes.length = 0;
    await retry.migrateMedia(f.options.query);
    assert.deepEqual(f.writes, []);
});

test('health verification rejects old builds, errors and redirects, and permits setup-only health', async () => {
    const report = { targetVersion: '0.2.0', deployment: { version: '0.2.0', commitSha: 'old-fork-commit' } };
    const active = { build: 'build', version: '0.2.0', commit: 'old-fork-commit' };
    verifyActiveWorker(active, report, 'old-fork-commit');
    assert.throws(() => verifyActiveWorker(active, report, 'new-fork-commit'), /source commit/);
    let attempts = 0;
    await verifyPublished('https://example.test', 'new', { pause: async () => {}, request: async (url, options) => {
        assert.equal(url.pathname, '/api/readiness'); assert.equal(options.redirect, 'error');
        attempts++;
        return Response.json({ status: 'ready' }, { headers: { 'X-Loginflare-Build': attempts < 3 ? 'old' : 'new' } });
    } });
    assert.equal(attempts, 3);
    await verifyPublished('https://example.test', 'new', { installed: false, pause: async () => {}, request: async (url) => {
        assert.equal(url.pathname, '/api/health');
        return Response.json({ status: 'ok' }, { headers: { 'X-Loginflare-Build': 'new' } });
    } });
    await assert.rejects(verifyPublished('https://example.test', 'new', { pause: async () => {}, request: async () => Response.json({ status: 'ready' }) }), /could not be confirmed/);
});

test('CLI requires explicit mode and target, and rejects credentials and ambiguous arguments', () => {
    assert.deepEqual(parseUpgradeArguments(['plan', '--local', '--state', 'work/demo', '--json']), { action: 'plan', local: true, state: 'work/demo', json: true });
    for (const args of [['plan'], ['plan', '--local', '--remote'], ['apply', '--remote'], ['apply', '--local', '--state', 'work/demo', '--json'], ['plan', '--local', '--state', 'work/demo', '--token', 'secret'], ['plan', '--remote', '--account', 'a'.repeat(32), '--worker', '--json']]) {
        assert.throws(() => parseUpgradeArguments(args));
    }
    for (const directory of ['work', '.cloudflare/state', 'work/../../outside']) assert.throws(() => validateLocalState(process.cwd(), directory), /isolated child/);
    assert.ok(validateLocalState(process.cwd(), 'work/upgrade-argument-test'));
});
