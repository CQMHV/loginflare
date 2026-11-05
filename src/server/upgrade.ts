import { symmetricDecrypt } from 'better-auth/crypto';
import bundle from './migration-bundle.json' with { type: 'json' };

export const bundleHash = bundle.hash;
export const expectedMigrationNames = bundle.migrations.map(({ name }) => name);
const pageSize = 25;
const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const canonicalSql = (sql: string) => (sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\.[0-9]+)?|[^\s]/g) ?? [])
    .map((token) => token.startsWith("'") ? token : token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"').toLowerCase() : token.toLowerCase()).join(' ');

export class UpgradeError extends Error {
    code: string;
    migration: string | null;
    constructor(code: string, migration: string | null = null) {
        super(code);
        this.code = code;
        this.migration = migration;
    }
}

export interface UpgradeProgress {
    phase: 'keys' | 'prepare-origins' | 'prepare-dates' | 'prepare-created' | 'migrations' | 'schema' | 'columns' | 'rows' | 'avatars' | 'origins' | 'complete';
    bundleHash: string;
    index: number;
    cursor: string;
    row: number;
    decrypted: number;
    keyEvidence: 'pending' | 'verified' | 'empty' | 'operator-confirmed';
    committed: string[];
    currentFile: string | null;
}

export interface UpgradeExecutor {
    db: D1Database;
    progress: UpgradeProgress;
    /** Must fence and commit statements and next progress in the SAME D1 transaction. */
    commit: (statements: D1PreparedStatement[], next: UpgradeProgress) => Promise<D1Result[]>;
    confirmUnverifiableKey?: boolean;
    readOnly?: boolean;
}

export function initialUpgradeProgress(): UpgradeProgress {
    return { phase: 'keys', bundleHash, index: 0, cursor: '', row: 0, decrypted: 0, keyEvidence: 'pending', committed: [], currentFile: null };
}

async function hasTable(db: D1Database, table: string): Promise<boolean> {
    return !!await db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").bind(table).first();
}

export async function migrationStatus(db: D1Database) {
    const applied = await hasTable(db, 'd1_migrations')
        ? (await db.prepare('SELECT name FROM d1_migrations ORDER BY id LIMIT 1001').all<{ name: string }>()).results.map(({ name }) => name) : [];
    if (applied.length > 1000) throw new UpgradeError('UNKNOWN_MIGRATIONS');
    const known = new Set(expectedMigrationNames);
    const unknown = applied.filter((name) => !known.has(name));
    if (unknown.length) throw new UpgradeError('UNKNOWN_MIGRATIONS');
    const appliedSet = new Set(applied);
    if (new Set(applied).size !== applied.length || applied.some((name, index) => name !== expectedMigrationNames[index])) {
        throw new UpgradeError('MIGRATION_HISTORY_NOT_A_PREFIX');
    }
    if (await hasTable(db, 'lfMigrationDigest')) {
        const digests = (await db.prepare('SELECT name, digest FROM lfMigrationDigest LIMIT 1001').all<{ name: string; digest: string }>()).results;
        if (digests.length > 1000 || digests.some((item) => !appliedSet.has(item.name) || bundle.migrations.find(({ name }) => name === item.name)?.hash !== item.digest)) {
            throw new UpgradeError('MIGRATION_DIGEST_MISMATCH');
        }
    }
    return { ready: applied.length === expectedMigrationNames.length, applied, pending: expectedMigrationNames.filter((name) => !appliedSet.has(name)), bundleHash };
}

const encryptedFields = [
    { table: 'jwks', field: 'privateKey' },
    { table: 'twoFactor', field: 'secret' },
    { table: 'twoFactor', field: 'backupCodes' },
    { table: 'socialConnection', field: 'secret' },
    { table: 'socialFlow', field: 'data' },
] as const;
const tables = bundle.objects.filter(({ type }) => type === 'table').map(({ name }) => name);
const dateTables = [...new Set(bundle.columns.filter(({ type }) => type.toLowerCase() === 'date').map(({ tableName }) => tableName))];

/** One bounded step. The caller serializes steps and persists progress under its current lease. */
export async function advanceUpgrade(executor: UpgradeExecutor, secret?: string): Promise<UpgradeProgress> {
    const { db, progress, commit } = executor;
    if (progress.bundleHash !== bundleHash) throw new UpgradeError('UPGRADE_BUILD_CHANGED');
    const next = structuredClone(progress);
    const move = (phase: UpgradeProgress['phase']) => { next.phase = phase; next.index = 0; next.cursor = ''; next.row = 0; next.currentFile = null; };
    const save = async (statements: D1PreparedStatement[] = []) => { await commit(statements, next); return next; };

    if (progress.phase === 'complete') return progress;
    if (progress.phase === 'keys') {
        const field = encryptedFields[progress.index];
        if (!field) {
            const populated = await hasTable(db, 'user') && !!await db.prepare('SELECT 1 FROM "user" LIMIT 1').first();
            if (!progress.decrypted && populated && !executor.confirmUnverifiableKey) throw new UpgradeError('KEY_CONFIRMATION_REQUIRED');
            next.keyEvidence = progress.decrypted ? 'verified' : populated ? 'operator-confirmed' : 'empty';
            const status = await migrationStatus(db);
            move(status.applied.includes('0006_management.sql') ? 'migrations' : 'prepare-origins');
            return save();
        }
        if (!await hasTable(db, field.table)) { next.index++; next.cursor = ''; return save(); }
        const rows = (await db.prepare(`SELECT id, ${quoteIdentifier(field.field)} AS value FROM ${quoteIdentifier(field.table)} WHERE id > ? ORDER BY id LIMIT ?`)
            .bind(progress.cursor, pageSize).all<{ id: string; value: string | null }>()).results;
        for (const row of rows) if (row.value) {
            if (!secret || secret.length < 32 || secret.startsWith('replace-')) throw new UpgradeError('AUTH_KEY_REQUIRED');
            try { await symmetricDecrypt({ key: secret, data: row.value }); }
            catch { throw new UpgradeError('AUTH_KEY_MISMATCH_OR_CORRUPT_DATA'); }
            next.decrypted++;
        }
        next.cursor = rows.at(-1)?.id ?? progress.cursor;
        if (rows.length < pageSize) { next.index++; next.cursor = ''; }
        return save();
    }
    if (progress.phase === 'prepare-origins') {
        if (!await hasTable(db, 'oauthClient')) { move('prepare-dates'); return save(); }
        const rows = (await db.prepare('SELECT id, "redirectUris", metadata FROM "oauthClient" WHERE id > ? ORDER BY id LIMIT ?')
            .bind(progress.cursor, pageSize).all<{ id: string; redirectUris: string; metadata: string | null }>()).results;
        const statements: D1PreparedStatement[] = [];
        for (const row of rows) {
            let origins: string[];
            let metadata: Record<string, unknown>;
            try {
                const redirects: unknown = JSON.parse(row.redirectUris);
                if (!Array.isArray(redirects)) throw new Error();
                origins = [...new Set(redirects.map((value: unknown) => {
                    if (typeof value !== 'string') throw new Error();
                    const url = new URL(value);
                    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
                    return url.origin;
                }))];
                metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>;
                if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error();
            } catch { throw new UpgradeError('INVALID_STORED_CALLBACK'); }
            if (JSON.stringify(metadata.loginflareRedirectOrigins) !== JSON.stringify(origins)) {
                metadata.loginflareRedirectOrigins = origins;
                statements.push(db.prepare('UPDATE "oauthClient" SET metadata = ? WHERE id = ?').bind(JSON.stringify(metadata), row.id));
            }
        }
        next.cursor = rows.at(-1)?.id ?? progress.cursor;
        if (rows.length < pageSize) move('prepare-dates');
        return save(statements);
    }
    if (progress.phase === 'prepare-dates') {
        const table = dateTables[progress.index];
        if (!table) { move('prepare-created'); return save(); }
        if (!await hasTable(db, table)) { next.index++; return save(); }
        const actual = (await db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all<{ name: string }>()).results;
        const fields = bundle.columns.filter(({ tableName, type, name }) => tableName === table && type.toLowerCase() === 'date' && actual.some((field) => field.name === name)).map(({ name }) => name);
        if (!fields.length) { next.index++; return save(); }
        const condition = fields.map((field) => `typeof(${quoteIdentifier(field)}) IN ('integer', 'real')`).join(' OR ');
        const updates = fields.map((field) => `${quoteIdentifier(field)} = CASE WHEN typeof(${quoteIdentifier(field)}) IN ('integer', 'real') THEN strftime('%Y-%m-%dT%H:%M:%fZ', ${quoteIdentifier(field)} / 1000.0, 'unixepoch') ELSE ${quoteIdentifier(field)} END`).join(', ');
        const ids = (await db.prepare(`SELECT id FROM ${quoteIdentifier(table)} WHERE (${condition}) LIMIT 100`).all<{ id: string }>()).results;
        if (ids.length < 100) next.index++;
        return save(ids.length ? [db.prepare(`UPDATE ${quoteIdentifier(table)} SET ${updates} WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids.map(({ id }) => id))] : []);
    }
    if (progress.phase === 'prepare-created') {
        if (!await hasTable(db, 'oauthClient')) { move('migrations'); return save(); }
        const ids = (await db.prepare('SELECT id FROM "oauthClient" WHERE "createdAt" IS NULL LIMIT 100').all<{ id: string }>()).results;
        if (ids.length < 100) move('migrations');
        return save(ids.length ? [db.prepare(`UPDATE "oauthClient" SET "createdAt" = coalesce("updatedAt", '1970-01-01T00:00:00.000Z') WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids.map(({ id }) => id))] : []);
    }
    if (progress.phase === 'migrations') {
        const status = await migrationStatus(db);
        const migration = bundle.migrations.find(({ name }) => name === status.pending[0]);
        if (!migration) { move('schema'); return save(); }
        if (executor.readOnly) throw new UpgradeError('PENDING_MIGRATIONS');
        next.currentFile = migration.name;
        next.committed = [...progress.committed, migration.name];
        const statements = [
            db.prepare('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)'),
            db.prepare('CREATE TABLE IF NOT EXISTS lfMigrationDigest (name TEXT PRIMARY KEY, digest TEXT NOT NULL)'),
            ...migration.statements.map((sql) => db.prepare(sql)),
            db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(migration.name),
            db.prepare('INSERT INTO lfMigrationDigest (name, digest) VALUES (?, ?)').bind(migration.name, migration.hash),
        ];
        try { return await save(statements); }
        catch (error) {
            if (error instanceof Error && /fenc|lease|control|lock|generation/i.test(error.message)) throw error;
            let observed: Awaited<ReturnType<typeof migrationStatus>>;
            try { observed = await migrationStatus(db); }
            catch { throw new UpgradeError('MIGRATION_COMMIT_UNCONFIRMED', migration.name); }
            // The migration record and caller's checkpoint share the file's
            // transaction. A primary read settles an otherwise lost response.
            if (observed.applied.includes(migration.name)) return next;
            throw new UpgradeError('MIGRATION_FILE_ROLLED_BACK', migration.name);
        }
    }
    if (progress.phase === 'schema') {
        const expected = bundle.objects.slice(progress.index, progress.index + 10);
        if (!expected.length) { move('columns'); return save(); }
        const objects = (await db.prepare(`SELECT name, type, sql FROM sqlite_schema WHERE name IN (${expected.map(() => '?').join(',')})`)
            .bind(...expected.map(({ name }) => name)).all<{ name: string; type: string; sql: string }>()).results;
        for (const object of expected) {
            const actual = objects.find(({ name, type }) => object.name === name && object.type === type);
            if (!actual || canonicalSql(actual.sql) !== canonicalSql(object.sql)) throw new UpgradeError(`SCHEMA_MISMATCH:${object.name}`);
        }
        next.index += expected.length;
        return save();
    }
    if (progress.phase === 'columns') {
        const table = tables[progress.index];
        if (!table) { move('rows'); return save(); }
        const actual = (await db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all<{ name: string; type: string; notnull: number; pk: number }>()).results;
        for (const column of bundle.columns.filter(({ tableName }) => tableName === table)) {
            const found = actual.find(({ name }) => name === column.name);
            if (!found || found.type.toLowerCase() !== column.type.toLowerCase() || found.notnull !== column.notnull || found.pk !== column.pk) throw new UpgradeError(`COLUMN_MISMATCH:${table}.${column.name}`);
        }
        next.index++;
        return save();
    }
    if (progress.phase === 'rows') {
        const table = tables[progress.index];
        if (!table) { move('avatars'); return save(); }
        const dates = bundle.columns.filter(({ tableName, type }) => tableName === table && type.toLowerCase() === 'date').map(({ name }) => name);
        const keys = bundle.foreignKeys.filter(({ tableName }) => tableName === table);
        const groups = [...new Set(keys.map(({ id }) => id))].map((id) => keys.filter((key) => key.id === id).sort((a, b) => a.seq - b.seq));
        const checks = groups.map((group, index) => {
            const nullable = group.map((key) => `c.${quoteIdentifier(key.from)} IS NULL`).join(' OR ');
            const match = group.map((key) => `p.${quoteIdentifier(key.to)} = c.${quoteIdentifier(key.from)}`).join(' AND ');
            return `CASE WHEN ${nullable} THEN 1 ELSE EXISTS (SELECT 1 FROM ${quoteIdentifier(group[0]!.table)} p WHERE ${match}) END AS "_fk${index}"`;
        });
        if (!dates.length && !groups.length) { next.index++; next.row = 0; return save(); }
        const selections = [...dates.map((field) => `c.${quoteIdentifier(field)}`), ...checks];
        const rows = (await db.prepare(`SELECT c.rowid AS "_row", ${selections.join(', ')} FROM ${quoteIdentifier(table)} c WHERE c.rowid > ? ORDER BY c.rowid LIMIT ?`)
            .bind(progress.row, pageSize).all<Record<string, unknown>>()).results;
        for (const row of rows) {
            for (const field of dates) if (row[field] !== null) {
                const value = row[field];
                if (typeof value !== 'string' || value.length !== 24 || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new UpgradeError(`NONCANONICAL_DATE:${table}.${field}`);
            }
            if (groups.some((_group, index) => row[`_fk${index}`] !== 1)) throw new UpgradeError(`FOREIGN_KEY_MISMATCH:${table}`);
        }
        next.row = Number(rows.at(-1)?._row ?? progress.row);
        if (rows.length < pageSize) { next.index++; next.row = 0; }
        return save();
    }
    if (progress.phase === 'avatars') {
        const rows = (await db.prepare(`SELECT a.rowid AS position, a."deleteAfter", a.url, u.image, u.id AS userId FROM "userAvatar" a
            LEFT JOIN "user" u ON u.id = a."userId" WHERE a.rowid > ? ORDER BY a.rowid LIMIT ?`)
            .bind(progress.row, pageSize).all<{ position: number; deleteAfter: number | null; url: string; image: string | null; userId: string | null }>()).results;
        if (rows.some((row) => (row.deleteAfter === null && (!row.userId || row.image !== row.url)) || (row.image === row.url && row.deleteAfter !== null))) throw new UpgradeError('AVATAR_LIFECYCLE_MISMATCH');
        next.row = rows.at(-1)?.position ?? progress.row;
        if (rows.length < pageSize) move('origins');
        return save();
    }
    if (progress.phase === 'origins') {
        const rows = (await db.prepare('SELECT id, "clientId", "redirectUris", "postLogoutRedirectUris", metadata, "createdAt" FROM "oauthClient" WHERE id > ? ORDER BY id LIMIT ?')
            .bind(progress.cursor, pageSize).all<{ id: string; clientId: string; redirectUris: string; postLogoutRedirectUris: string | null; metadata: string | null; createdAt: string | null }>()).results;
        for (const row of rows) {
            const expected: { kind: string; value: string }[] = [];
            try {
                if (!row.createdAt) throw new Error();
                const redirects: string[] = JSON.parse(row.redirectUris);
                const origins = [...new Set(redirects.map((uri) => new URL(uri).origin))].sort();
                const registered = JSON.parse(row.metadata ?? '{}').loginflareRedirectOrigins;
                if (!Array.isArray(registered) || JSON.stringify([...new Set(registered)].sort()) !== JSON.stringify(origins)) throw new Error();
                expected.push(...origins.map((value) => ({ kind: 'redirect-origin', value })));
                expected.push(...[...new Set<string>(JSON.parse(row.postLogoutRedirectUris ?? '[]'))].map((value) => ({ kind: 'post-logout-uri', value })));
            } catch { throw new UpgradeError('CALLBACK_METADATA_MISMATCH'); }
            const actual = (await db.prepare('SELECT kind, value FROM "oauthClientUri" WHERE "clientId" = ? LIMIT 1001').bind(row.clientId).all<{ kind: string; value: string }>()).results;
            if (actual.length !== expected.length || actual.some((item) => !expected.some((candidate) => item.kind === candidate.kind && item.value === candidate.value))) throw new UpgradeError('CALLBACK_INDEX_MISMATCH');
        }
        next.cursor = rows.at(-1)?.id ?? progress.cursor;
        if (rows.length < pageSize) {
            move('complete');
            if (executor.readOnly) return save();
            return save([
                db.prepare('CREATE TABLE IF NOT EXISTS lfMigrationDigest (name TEXT PRIMARY KEY, digest TEXT NOT NULL)'),
                ...bundle.migrations.map(({ name, hash }) => db.prepare('INSERT INTO lfMigrationDigest (name, digest) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').bind(name, hash)),
            ]);
        }
        return save();
    }
    throw new UpgradeError('INVALID_UPGRADE_PHASE');
}
