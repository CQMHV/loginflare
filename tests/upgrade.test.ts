import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { symmetricEncrypt } from 'better-auth/crypto';
import { advanceUpgrade, bundleHash, initialUpgradeProgress, migrationStatus, type UpgradeExecutor, type UpgradeProgress } from '../src/server/upgrade';
import migrationBundle from '../src/server/migration-bundle.json';

afterEach(async () => { await reset(); });

function runner(secret?: string, database = env.DB) {
    let progress = initialUpgradeProgress();
    const executor: UpgradeExecutor = {
        db: database,
        get progress() { return progress; },
        commit: async (statements, next) => {
            const result = statements.length ? await database.batch(statements) : [];
            progress = structuredClone(next);
            return result;
        },
    };
    return {
        executor,
        step: () => advanceUpgrade(executor, secret),
        progress: () => progress,
        setProgress(value: UpgradeProgress) { progress = value; },
        async finish() {
            for (let step = 0; progress.phase !== 'complete' && step < 1000; step++) await advanceUpgrade(executor, secret);
            expect(progress.phase).toBe('complete');
            return progress;
        },
    };
}

function labelledStatements(database: D1Database) {
    const labels = new WeakMap<D1PreparedStatement, string>();
    const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
        const wrapped = new Proxy(statement, { get(target, property) {
            if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        labels.set(wrapped, sql);
        originals.set(wrapped, statement);
        return wrapped;
    };
    const db = new Proxy(database, { get(target, property) {
        if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
        if (property === 'batch') return <T>(statements: D1PreparedStatement[]) => target.batch<T>(statements.map((statement) => originals.get(statement) ?? statement));
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { db, sql: (statement: D1PreparedStatement) => labels.get(statement) ?? '' };
}

it('initializes an empty D1 through the same bounded migration core without requiring an auth secret', async () => {
    const run = runner();
    const progress = await run.finish();
    expect(progress.keyEvidence).toBe('empty');
    expect(progress.committed).toHaveLength(env.TEST_MIGRATIONS.length);
    expect(await migrationStatus(env.DB)).toMatchObject({ ready: true, pending: [], bundleHash });
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});

it('rejects a valid-length authentication secret that cannot decrypt existing database material', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const key = 'correct-original-secret-at-least-32-characters';
    const privateKey = await symmetricEncrypt({ key, data: '{"private":"existing-material"}' });
    await env.DB.prepare('INSERT INTO jwks (id, "publicKey", "privateKey", "createdAt") VALUES (?, ?, ?, ?)')
        .bind('existing', '{}', privateKey, '2026-01-01T00:00:00.000Z').run();
    const run = runner('different-but-valid-length-secret-for-testing');
    await expect(run.step()).rejects.toMatchObject({ code: 'AUTH_KEY_MISMATCH_OR_CORRUPT_DATA' });
    expect(run.progress().committed).toEqual([]);
    expect(await env.DB.prepare('SELECT "privateKey" FROM jwks WHERE id=?').bind('existing').first('privateKey')).toBe(privateKey);
});

it('requires explicit confirmation when an old populated database has no verifiable encrypted material', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt")
        VALUES ('old-user','Existing','existing@example.test',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
    const run = runner();
    for (let index = 0; index < 5; index++) await run.step();
    await expect(run.step()).rejects.toMatchObject({ code: 'KEY_CONFIRMATION_REQUIRED' });
    run.executor.confirmUnverifiableKey = true;
    await run.step();
    expect(run.progress().keyEvidence).toBe('operator-confirmed');
});

it.each(['0014_social_provider_presets.sql', '0015_social_x_telegram.sql'])('%s rolls back rebuilt tables, triggers, data and registration in a real D1 batch', async (name) => {
    const index = env.TEST_MIGRATIONS.findIndex((migration) => migration.name === name);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, index));
    await env.DB.prepare(`INSERT INTO "socialConnection" (id,name,type,config,"createdAt","updatedAt")
        VALUES ('existing','Existing connector','google','{}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
    const objects = async () => (await env.DB.prepare("SELECT name,type,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all()).results;
    const before = await objects();
    const data = (await env.DB.prepare('SELECT * FROM "socialConnection"').all()).results;
    const history = (await env.DB.prepare('SELECT * FROM d1_migrations ORDER BY id').all()).results;
    expect(history.map((row) => row.name)).toEqual(env.TEST_MIGRATIONS.slice(0, index).map((migration) => migration.name));
    const packaged = migrationBundle.migrations.find((migration) => migration.name === name)!;
    const copy = packaged.statements.findIndex((sql) => /^INSERT INTO "socialConnection_next" SELECT/.test(sql));
    const drop = packaged.statements.findIndex((sql) => /^DROP TABLE "socialConnection"/.test(sql));
    const rename = packaged.statements.findIndex((sql) => /^ALTER TABLE "socialConnection_next" RENAME TO/.test(sql));
    const triggers = packaged.statements.flatMap((sql, position) => /^CREATE TRIGGER/.test(sql) ? [position] : []);
    expect(copy).toBeGreaterThanOrEqual(0); expect(drop).toBeGreaterThan(copy); expect(rename).toBeGreaterThan(drop);
    expect(triggers).toHaveLength(6);
    const landmarks = [copy, drop, rename, ...triggers].map((position) => ({ label: `packaged SQL ${position}`, sql: packaged.statements[position]! }));
    landmarks.push({ label: 'migration registration', sql: '' });
    for (const landmark of landmarks) for (const after of [false, true]) {
        const location = `${after ? 'after' : 'before'} ${landmark.label}`;
        const labelled = labelledStatements(env.DB);
        const run = runner(undefined, labelled.db);
        run.setProgress({ ...initialUpgradeProgress(), phase: 'migrations' });
        let injected = false;
        run.executor.commit = async (statements) => {
            const sources = statements.map(labelled.sql);
            // The production step still sends every packaged statement, with
            // PRAGMAs and whole triggers in source order, in this SAME batch.
            expect(sources.filter((sql) => packaged.statements.includes(sql)), location).toEqual(packaged.statements);
            const selected = sources.flatMap((sql, position) => (landmark.sql ? sql === landmark.sql : /^INSERT INTO d1_migrations\b/.test(sql)) ? [position] : []);
            expect(selected, location).toHaveLength(1);
            const boundary = selected[0]! + Number(after);
            injected = true;
            return labelled.db.batch([...statements.slice(0, boundary), env.DB.prepare('SELECT deliberately_missing_migration_function()'), ...statements.slice(boundary)]);
        };
        await expect(run.step(), location).rejects.toMatchObject({ code: 'MIGRATION_FILE_ROLLED_BACK', migration: name });
        expect(injected, location).toBe(true);
        expect(await objects(), location).toEqual(before);
        expect((await env.DB.prepare('SELECT * FROM "socialConnection"').all()).results, location).toEqual(data);
        expect((await env.DB.prepare('SELECT * FROM d1_migrations ORDER BY id').all()).results, location).toEqual(history);
        expect(await env.DB.prepare('SELECT name FROM d1_migrations WHERE name=?').bind(name).first(), location).toBeNull();
        expect(run.progress().committed, location).toEqual([]);
        expect(await migrationStatus(env.DB), location).toMatchObject({ ready: false, applied: history.map((row) => row.name), pending: expect.arrayContaining([name]) });
    }
});

it('rejects unknown migrations and changed committed source digests', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind('9999_unknown.sql').run();
    await expect(migrationStatus(env.DB)).rejects.toMatchObject({ code: 'UNKNOWN_MIGRATIONS' });
    await env.DB.prepare('DELETE FROM d1_migrations WHERE name=?').bind('9999_unknown.sql').run();
    await env.DB.prepare('CREATE TABLE lfMigrationDigest (name TEXT PRIMARY KEY, digest TEXT NOT NULL)').run();
    await env.DB.prepare('INSERT INTO lfMigrationDigest (name,digest) VALUES (?,?)').bind(env.TEST_MIGRATIONS[0]!.name, 'altered-source').run();
    await expect(migrationStatus(env.DB)).rejects.toMatchObject({ code: 'MIGRATION_DIGEST_MISMATCH' });
});

it('read-only validation uses the shared checker without writing migration digest records', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const run = runner();
    run.executor.readOnly = true;
    const original = run.executor.commit;
    run.executor.commit = async (statements, next) => {
        expect(statements).toHaveLength(0);
        return original(statements, next);
    };
    await run.finish();
    expect(await env.DB.prepare("SELECT 1 FROM sqlite_schema WHERE name='lfMigrationDigest'").first()).toBeNull();
});

it('validates populated native dates, parent references and callback projections in bounded pages', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt")
        VALUES ('page-user','Existing','page@example.test',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
    await env.DB.prepare(`INSERT INTO "oauthClient" (id,"clientId","redirectUris","postLogoutRedirectUris",metadata,"createdAt","updatedAt")
        VALUES ('page-client','page-client','["https://app.example.test/callback"]','["https://app.example.test/logout"]',
        '{"loginflareRedirectOrigins":["https://app.example.test"]}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
    const run = runner();
    run.executor.confirmUnverifiableKey = true;
    await run.finish();
    await env.DB.prepare('UPDATE "user" SET "createdAt"=? WHERE id=?').bind('2026-02-31T00:00:00.000Z', 'page-user').run();
    const invalid = runner();
    invalid.executor.confirmUnverifiableKey = true;
    await expect(invalid.finish()).rejects.toMatchObject({ code: 'NONCANONICAL_DATE:user.createdAt' });
});
