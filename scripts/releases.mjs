import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

const lockTime = 15 * 60_000;
const metadata = ['lfReleaseLock', 'lfReleaseTarget', 'lfReleaseMigration'];
const installationMigration = '0023_installation.sql';
const createLock = `CREATE TABLE IF NOT EXISTS lfReleaseLock (
    id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, expiresAt INTEGER NOT NULL)`;
const createTarget = `CREATE TABLE IF NOT EXISTS lfReleaseTarget (
    id INTEGER PRIMARY KEY CHECK (id = 1), identity TEXT NOT NULL, initialComplete INTEGER NOT NULL DEFAULT 0)`;
const createLedger = `CREATE TABLE IF NOT EXISTS lfReleaseMigration (
    name TEXT PRIMARY KEY, digest TEXT NOT NULL, appliedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`;

export const statement = (sql, ...params) => ({ sql, params });
const rows = async (query, sql, ...params) => (await query([statement(sql, ...params)]))[0]?.results ?? [];

export function pendingMigrations(migrations, ledger) {
    if (ledger.length > migrations.length) throw new Error('Database migration history is ahead of this build.');
    for (const [index, entry] of ledger.entries()) {
        const expected = migrations[index];
        if (entry.name !== expected.name || entry.digest !== expected.hash) throw new Error(`Migration history mismatch: ${entry.name}.`);
    }
    return migrations.slice(ledger.length);
}

/** query must execute each supplied batch as one D1 transaction. */
export async function release({ query, target, migrations, online, isCurrent, verify, prepare = async () => {}, publish, pause = wait }) {
    if (!await isCurrent()) return false;
    await query([statement(createLock)]);
    const owner = randomUUID();
    const deadline = Date.now() + 3 * 60_000;
    let expiresAt = 0;
    while (true) {
        if (!await isCurrent()) return false;
        expiresAt = Date.now() + lockTime;
        const acquired = await rows(query, `INSERT INTO lfReleaseLock (id, owner, expiresAt) VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expiresAt = excluded.expiresAt
            WHERE lfReleaseLock.expiresAt <= ? RETURNING owner`, owner, expiresAt, Date.now());
        if (acquired.length) break;
        if (Date.now() >= deadline) throw new Error('Another release owns this database. Retry the latest main build after it finishes.');
        await pause(3000);
    }
    let ambiguous = false;
    try {
        if (!await isCurrent()) return false;
        await verify();
        // Cloudflare exposes its reserved _cf_KV table even in a new D1.
        const objects = await rows(query, "SELECT name FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name <> '_cf_KV'");
        const identity = JSON.stringify(target);
        if (objects.some(({ name }) => name === 'lfReleaseTarget')) {
            const [record] = await rows(query, 'SELECT identity FROM lfReleaseTarget WHERE id = 1');
            if (record?.identity !== identity) throw new Error('This database belongs to a different Worker or storage configuration.');
        } else {
            if (objects.some(({ name }) => !metadata.includes(name))) throw new Error('This database is not empty and has no Loginflare release record.');
            await query([statement(createTarget), statement('INSERT INTO lfReleaseTarget (id, identity) VALUES (1, ?)', identity), statement(createLedger)]);
        }
        const [state] = await rows(query, 'SELECT initialComplete FROM lfReleaseTarget WHERE id = 1');
        const ledger = await rows(query, 'SELECT name, digest FROM lfReleaseMigration ORDER BY name');
        const pending = pendingMigrations(migrations, ledger);
        if (!migrations.some(({ name }) => name === installationMigration)) throw new Error(`Initial schema is missing ${installationMigration}.`);
        for (const migration of pending) {
            if (state.initialComplete && online[migration.name] !== migration.hash) {
                throw new Error(`${migration.name} has no matching online migration approval. Use the separate operations procedure.`);
            }
        }
        await prepare();
        for (const migration of pending) {
            if (!await isCurrent()) return false;
            if (Date.now() + 60_000 >= expiresAt) throw new Error('Release lock is about to expire; retry the latest main build.');
            try {
                await query([...migration.statements.map((sql) => statement(sql)),
                    statement('INSERT INTO lfReleaseMigration (name, digest) VALUES (?, ?)', migration.name, migration.hash)]);
            } catch (error) {
                throw new Error(`Migration ${migration.name} failed: ${error.message}`, { cause: error });
            }
            console.log(`Applied ${migration.name}.`);
        }
        if (!state.initialComplete) await query([statement('UPDATE lfReleaseTarget SET initialComplete = 1 WHERE id = 1')]);
        await verify();
        if (!await isCurrent()) return false;
        if (Date.now() + 6 * 60_000 >= expiresAt) throw new Error('Not enough time remains to publish under this lock; retry the latest main build.');
        ambiguous = true;
        await publish();
        ambiguous = false;
        return true;
    } finally {
        // An interrupted upload may still be accepted upstream. Retain the
        // lock until its deadline unless promotion was observed or never sent.
        if (!ambiguous) await query([statement('DELETE FROM lfReleaseLock WHERE id = 1 AND owner = ?', owner)]);
    }
}
