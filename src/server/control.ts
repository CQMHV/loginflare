import type { Env } from './config';

// This schema is a separate, append-only protocol. Business migrations must
// never depend on it, rebuild it, or make it depend on business tables.
export const controlProtocol = 1;
export const controlCookie = 'loginflare.control';
const nowSql = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const leaseMs = 90_000;

export interface ControlRecord {
    id: number; protocolVersion: number; instanceId: string; accountId: string | null; workerName: string | null;
    installation: 'new' | 'installing' | 'complete' | 'legacy';
    mode: 'setup' | 'ready' | 'draining' | 'migrating' | 'checking' | 'failed' | 'adoption';
    taskId: string; generation: number; admissionGeneration: number; owner: string | null; leaseUntil: number;
    buildId: string; targetBuildId: string; buildTime: number; targetBuildTime: number; configRevision: string;
    candidateUserId: string | null; candidateEmail: string | null; cleanupPending: number;
    revision: number; legacyDrainConfirmed: number;
}
export interface ExecutionLease { taskId: string; owner: string; generation: number }
export interface ControlSession { hash: string; purpose: 'setup' | 'maintenance' | 'cleanup'; taskId: string | null; expiresAt: number }
export interface Permit { id: string; generation: number; buildId: string }
export class ControlError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status = 409) { super(code); this.code = code; this.status = status; }
}

const schema = [
    `CREATE TABLE IF NOT EXISTS "lfControl" (
        id INTEGER PRIMARY KEY CHECK(id=1), protocolVersion INTEGER NOT NULL, instanceId TEXT NOT NULL,
        accountId TEXT, workerName TEXT, installation TEXT NOT NULL, mode TEXT NOT NULL,
        taskId TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, admissionGeneration INTEGER NOT NULL DEFAULT 0, owner TEXT, leaseUntil INTEGER NOT NULL DEFAULT 0,
        buildId TEXT NOT NULL, targetBuildId TEXT NOT NULL, buildTime INTEGER NOT NULL DEFAULT 0, targetBuildTime INTEGER NOT NULL DEFAULT 0, configRevision TEXT NOT NULL DEFAULT '',
        candidateUserId TEXT, candidateEmail TEXT, cleanupPending INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 0, legacyDrainConfirmed INTEGER NOT NULL DEFAULT 0)`,
    'CREATE TABLE IF NOT EXISTS "lfControlValue" (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS "lfControlSession" (hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, taskId TEXT, expiresAt INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS "lfControlPermit" (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, buildId TEXT NOT NULL, createdAt INTEGER NOT NULL)',
    `CREATE TABLE IF NOT EXISTS "lfControlEffect" (id TEXT PRIMARY KEY, scopeId TEXT NOT NULL, generation INTEGER NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','done','failed')), createdAt INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS "lfControlEffect_pending" ON "lfControlEffect" (status, scopeId)',
    'CREATE TABLE IF NOT EXISTS "lfControlFence" (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1))',
];

export function applicationBuild(env: Env): string { return env.APP_ENV === 'development' ? 'development' : env.LOGINFLARE_BUILD_ID || 'unidentified-build'; }
export function applicationBuildTime(env: Env): number {
    const value = Number(env.LOGINFLARE_BUILD_TIME ?? 0);
    return env.APP_ENV === 'development' ? 0 : Number.isSafeInteger(value) && value > 0 ? value : 0;
}
export async function readControl(db: D1Database): Promise<ControlRecord> {
    const row = await db.prepare('SELECT * FROM "lfControl" WHERE id=1').first<ControlRecord>();
    if (!row) throw new ControlError('CONTROL_NOT_INITIALIZED', 503);
    if (row.protocolVersion !== controlProtocol) throw new ControlError('UNSUPPORTED_CONTROL_PROTOCOL', 503);
    return row;
}
export async function ensureControl(env: Env): Promise<ControlRecord> {
    let row: ControlRecord;
    try { row = await readControl(env.DB); }
    catch (error) {
        // Only bootstrap a genuinely absent control table, never hide a corrupt
        // schema, unsupported protocol, or an unavailable database.
        if (!(error instanceof Error) || (!(error instanceof ControlError && error.code === 'CONTROL_NOT_INITIALIZED')
            && !/no such table:\s*lfControl\b/.test(error.message))) throw error;
        await env.DB.batch(schema.map((sql) => env.DB.prepare(sql)));
        const existing = !!await env.DB.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='user'").first();
        const development = env.APP_ENV === 'development';
        const build = applicationBuild(env);
        await env.DB.prepare(`INSERT OR IGNORE INTO "lfControl"
            (id,protocolVersion,instanceId,accountId,workerName,installation,mode,taskId,buildId,targetBuildId,legacyDrainConfirmed,buildTime,targetBuildTime)
            VALUES (1,1,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), env.LOGINFLARE_ACCOUNT_ID || null,
                env.LOGINFLARE_WORKER_NAME || null, existing ? development ? 'complete' : 'legacy' : 'new',
                existing ? development ? 'ready' : 'adoption' : 'setup', crypto.randomUUID(), build, build, Number(development), applicationBuildTime(env), applicationBuildTime(env)).run();
        row = await readControl(env.DB);
    }
    if ((env.LOGINFLARE_ACCOUNT_ID && row.accountId && env.LOGINFLARE_ACCOUNT_ID !== row.accountId)
        || (env.LOGINFLARE_WORKER_NAME && row.workerName && env.LOGINFLARE_WORKER_NAME !== row.workerName)) {
        throw new ControlError('DEPLOYMENT_IDENTITY_MISMATCH', 503);
    }
    return row;
}

export async function readValue<T = unknown>(db: D1Database, key: string): Promise<T | null> {
    const row = await db.prepare('SELECT value FROM "lfControlValue" WHERE key=?').bind(key).first<{ value: string }>();
    return row ? JSON.parse(row.value) as T : null;
}
export function valueStatement(db: D1Database, key: string, value: unknown): D1PreparedStatement {
    return db.prepare('INSERT INTO "lfControlValue" (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .bind(key, JSON.stringify(value));
}
export async function writeValue(db: D1Database, lease: ExecutionLease, key: string, value: unknown): Promise<void> {
    await fencedBatch(db, lease, [valueStatement(db, key, value)]);
}

export async function acquireLease(db: D1Database, taskId: string): Promise<ExecutionLease> {
    const owner = crypto.randomUUID();
    const row = await db.prepare(`UPDATE "lfControl" SET owner=?,generation=generation+1,leaseUntil=${nowSql}+?,revision=revision+1
        WHERE id=1 AND protocolVersion=1 AND taskId=? AND (owner IS NULL OR leaseUntil<=${nowSql}) RETURNING generation`)
        .bind(owner, leaseMs, taskId).first<{ generation: number }>();
    if (!row) throw new ControlError('EXECUTOR_BUSY');
    return { taskId, owner, generation: row.generation };
}
export async function renewLease(db: D1Database, lease: ExecutionLease): Promise<void> {
    const row = await db.prepare(`UPDATE "lfControl" SET leaseUntil=${nowSql}+? WHERE id=1 AND taskId=? AND owner=?
        AND generation=? AND leaseUntil>${nowSql} RETURNING id`).bind(leaseMs, lease.taskId, lease.owner, lease.generation).first();
    if (!row) throw new ControlError('EXECUTION_LEASE_LOST');
}
export async function releaseLease(db: D1Database, lease: ExecutionLease): Promise<void> {
    await db.prepare('UPDATE "lfControl" SET owner=NULL,leaseUntil=0 WHERE id=1 AND taskId=? AND owner=? AND generation=?')
        .bind(lease.taskId, lease.owner, lease.generation).run();
}
function executionGuard(db: D1Database, lease: ExecutionLease, id: string): D1PreparedStatement {
    return db.prepare(`INSERT INTO "lfControlFence" (id,valid) SELECT ?,CASE WHEN EXISTS
        (SELECT 1 FROM "lfControl" WHERE id=1 AND protocolVersion=1 AND taskId=? AND owner=? AND generation=? AND leaseUntil>${nowSql})
        THEN 1 ELSE 0 END`).bind(id, lease.taskId, lease.owner, lease.generation);
}
export async function fencedBatch<T = Record<string, unknown>>(db: D1Database, lease: ExecutionLease, statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const id = crypto.randomUUID();
    try {
        const result = await db.batch<T>([executionGuard(db, lease, id), ...statements,
            db.prepare('DELETE FROM "lfControlFence" WHERE id=?').bind(id)]);
        return result.slice(1, -1);
    } catch (error) {
        if (error instanceof Error && /CHECK constraint failed.*valid/i.test(error.message)) throw new ControlError('EXECUTION_LEASE_LOST');
        throw error;
    }
}

export async function beginEffect(db: D1Database, lease: ExecutionLease, kind: string, payload: unknown, id: string = crypto.randomUUID()): Promise<string> {
    // A recovery proof uses its own Secret namespace. It must remain available
    // to inspect an uncertain R2/configuration operation; it cannot bypass the
    // global drain barrier below. Pending proofs/cleanup still conflict with it.
    const conflicts = kind === 'maintenance-challenge'
        ? "kind IN ('maintenance-challenge','setup-cleanup')"
        : "kind NOT LIKE 'r2:%'";
    const pending = await db.prepare(`SELECT id FROM "lfControlEffect" WHERE status='pending' AND (${conflicts}) LIMIT 1`).first();
    if (pending) throw new ControlError('EXTERNAL_RESULT_UNCONFIRMED');
    await fencedBatch(db, lease, [db.prepare(`INSERT INTO "lfControlEffect" (id,scopeId,generation,kind,payload,status,createdAt)
        VALUES (?,?,?,?,?,'pending',${nowSql})`).bind(id, lease.taskId, lease.generation, kind, JSON.stringify(payload))]);
    return id;
}
export async function finishEffect(db: D1Database, lease: ExecutionLease, id: string, status: 'done' | 'failed'): Promise<void> {
    await fencedBatch(db, lease, [db.prepare('UPDATE "lfControlEffect" SET status=? WHERE id=? AND scopeId=?')
        .bind(status, id, lease.taskId)]);
}
export async function pendingEffects(db: D1Database): Promise<number> {
    return (await db.prepare('SELECT COUNT(*) AS n FROM "lfControlEffect" WHERE status=\'pending\'').first<number>('n')) ?? 0;
}

export async function hashToken(token: string): Promise<string> {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))]
        .map((value) => value.toString(16).padStart(2, '0')).join('');
}
export async function issueSession(db: D1Database, purpose: ControlSession['purpose'], taskId: string | null): Promise<string> {
    const token = crypto.randomUUID() + crypto.randomUUID();
    await db.prepare(`INSERT INTO "lfControlSession" (hash,purpose,taskId,expiresAt) VALUES (?,?,?,${nowSql}+1800000)`)
        .bind(await hashToken(token), purpose, taskId).run();
    return token;
}
export async function readSession(db: D1Database, request: Request): Promise<ControlSession | null> {
    const token = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim())
        .find((part) => part.startsWith(controlCookie + '='))?.slice(controlCookie.length + 1);
    if (!token || token.length > 200) return null;
    return db.prepare(`SELECT * FROM "lfControlSession" WHERE hash=? AND expiresAt>${nowSql}`).bind(await hashToken(token)).first<ControlSession>();
}

export async function admit(db: D1Database, buildId: string): Promise<Permit> {
    const id = crypto.randomUUID();
    const row = await db.prepare(`INSERT INTO "lfControlPermit" (id,generation,buildId,createdAt)
        SELECT ?,admissionGeneration,?,${nowSql} FROM "lfControl" WHERE id=1 AND protocolVersion=1 AND mode='ready'
        AND installation='complete' AND buildId=? RETURNING generation`).bind(id, buildId, buildId).first<{ generation: number }>();
    if (!row) throw new ControlError('MAINTENANCE_REQUIRED', 503);
    return { id, generation: row.generation, buildId };
}
/** Ordinary admin authentication can authorize a newly deployed upgrade only
 * before the drain barrier, while the existing authentication schema is intact.
 * This permit never grants the new build ordinary business admission. */
export async function admitAuthorization(db: D1Database, buildId: string): Promise<Permit> {
    const id = crypto.randomUUID();
    const row = await db.prepare(`INSERT INTO "lfControlPermit" (id,generation,buildId,createdAt)
        SELECT ?,admissionGeneration,?,${nowSql} FROM "lfControl" c WHERE id=1 AND protocolVersion=1
        AND mode IN ('ready','draining') AND installation='complete' AND buildId=?
        AND NOT EXISTS (SELECT 1 FROM "lfControlValue" WHERE key='drained:'||c.taskId)
        RETURNING generation`).bind(id, buildId, buildId).first<{ generation: number }>();
    if (!row) throw new ControlError('MAINTENANCE_RECOVERY_REQUIRED', 401);
    return { id, generation: row.generation, buildId };
}
export async function releasePermit(db: D1Database, permit: Permit): Promise<void> {
    await db.prepare('DELETE FROM "lfControlPermit" WHERE id=?').bind(permit.id).run();
}
export async function enterMaintenance(db: D1Database, buildId: string, sessionHash?: string, buildTime = 0): Promise<ControlRecord> {
    const task = crypto.randomUUID();
    const statements = [db.prepare(`UPDATE "lfControl" SET mode='draining',taskId=?,targetBuildId=?,targetBuildTime=?,
        owner=NULL,leaseUntil=0,generation=generation+1,revision=revision+1
        WHERE id=1 AND mode='ready' AND cleanupPending=0 AND (owner IS NULL OR leaseUntil<=${nowSql})
        AND (buildId=? OR buildTime<?)`).bind(task, buildId, buildTime, buildId, buildTime)];
    if (sessionHash) statements.push(db.prepare(`UPDATE "lfControlSession" SET taskId=? WHERE hash=? AND EXISTS
        (SELECT 1 FROM "lfControl" WHERE id=1 AND taskId=? AND mode='draining')`).bind(task, sessionHash, task));
    await db.batch(statements);
    return readControl(db);
}
export async function drain(db: D1Database, lease: ExecutionLease): Promise<void> {
    // Closing admission precedes this epoch change. Old D1 requests are fenced
    // transactionally; old cross-service requests have durable pending intents.
    const assertion = crypto.randomUUID();
    try {
        await fencedBatch(db, lease, [db.prepare(`INSERT INTO "lfControlFence" (id,valid) SELECT ?,CASE WHEN NOT EXISTS
            (SELECT 1 FROM "lfControlEffect" WHERE status='pending') THEN 1 ELSE 0 END`).bind(assertion),
            db.prepare('UPDATE "lfControl" SET admissionGeneration=admissionGeneration+1,mode=\'migrating\',revision=revision+1 WHERE id=1 AND mode IN (\'draining\',\'failed\')'),
            valueStatement(db, `drained:${lease.taskId}`, true),
            db.prepare('DELETE FROM "lfControlPermit"'), db.prepare('DELETE FROM "lfControlFence" WHERE id=?').bind(assertion)]);
    } catch (error) {
        if (error instanceof ControlError && error.code === 'EXECUTION_LEASE_LOST' && await pendingEffects(db)) throw new ControlError('EXTERNAL_RESULT_UNCONFIRMED');
        throw error;
    }
}

/** Every statement, including Better Auth's statements, checks its permit in
 * the same transaction as the actual SQL. No check-then-write race is allowed. */
export function guardedDatabase(db: D1Database, permit: Permit): D1Database {
    const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
    const batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
        const id = crypto.randomUUID();
        const guard = db.prepare(`INSERT INTO "lfControlFence" (id,valid) SELECT ?,CASE WHEN EXISTS (
            SELECT 1 FROM "lfControlPermit" p JOIN "lfControl" c ON c.id=1 WHERE p.id=? AND p.generation=c.admissionGeneration
            AND p.buildId=c.buildId AND c.protocolVersion=1 AND c.mode IN ('ready','draining')) THEN 1 ELSE 0 END`).bind(id, permit.id);
        try {
            return (await db.batch<T>([guard, ...statements.map((statement) => originals.get(statement) ?? statement),
                db.prepare('DELETE FROM "lfControlFence" WHERE id=?').bind(id)])).slice(1, -1);
        } catch (error) {
            if (error instanceof Error && /CHECK constraint failed.*valid/i.test(error.message)) throw new ControlError('MAINTENANCE_REQUIRED', 503);
            throw error;
        }
    };
    return databaseAdapter(db, batch, originals);
}

export function leaseDatabase(db: D1Database, lease: ExecutionLease): D1Database {
    const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
    return databaseAdapter(db, <T>(statements: D1PreparedStatement[]) => fencedBatch<T>(db, lease,
        statements.map((statement) => originals.get(statement) ?? statement)), originals);
}

function databaseAdapter(db: D1Database, batch: <T>(statements: D1PreparedStatement[]) => Promise<D1Result<T>[]>,
    originals: WeakMap<D1PreparedStatement, D1PreparedStatement>): D1Database {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
        const wrapped = new Proxy(statement, { get(target, property) {
            if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
            if (property === 'run' || property === 'all') return async () => (await batch([target]))[0];
            if (property === 'first') return async (column?: string) => {
                const result = (await batch<Record<string, unknown>>([target]))[0]!.results[0];
                if (!result) return null;
                if (column !== undefined && !Object.hasOwn(result, column)) throw new Error('D1_COLUMN_NOTFOUND');
                return column === undefined ? result : result[column];
            };
            if (property === 'raw') return async (options?: { columnNames?: boolean }) => {
                const rows = (await batch<Record<string, unknown>>([target]))[0]!.results;
                return [...(options?.columnNames && rows[0] ? [Object.keys(rows[0])] : []), ...rows.map(Object.values)];
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        originals.set(wrapped, statement);
        return wrapped;
    };
    return new Proxy(db, { get(target, property) {
        if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql));
        if (property === 'batch') return batch;
        if (property === 'exec' || property === 'withSession' || property === 'dump') return () => { throw new ControlError('UNGUARDED_DATABASE_OPERATION'); };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
}

export function guardedBucket(bucket: R2Bucket, db: D1Database, permit: Permit): R2Bucket {
    return new Proxy(bucket, { get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (property !== 'put' && property !== 'delete' && property !== 'createMultipartUpload' && property !== 'resumeMultipartUpload') return value.bind(target);
        if (property === 'createMultipartUpload' || property === 'resumeMultipartUpload') return () => { throw new ControlError('UNGUARDED_STORAGE_OPERATION'); };
        return async (...args: unknown[]) => {
            const id = crypto.randomUUID();
            // The permit check and intent registration share one D1 transaction.
            await guardedDatabase(db, permit).prepare(`INSERT INTO "lfControlEffect" (id,scopeId,generation,kind,payload,status,createdAt)
                VALUES (?,?,?,?,?,'pending',${nowSql})`).bind(id, permit.id, permit.generation, `r2:${String(property)}`, JSON.stringify({ key: args[0] })).run();
            const result = await Reflect.apply(value, target, args);
            // A successful platform response is terminal evidence even if the
            // permit has since been fenced. Errors remain unresolved, not guessed.
            await db.prepare('UPDATE "lfControlEffect" SET status=\'done\' WHERE id=? AND scopeId=?').bind(id, permit.id).run();
            return result;
        };
    } });
}
