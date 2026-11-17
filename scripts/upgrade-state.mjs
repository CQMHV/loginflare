export const releaseTables = ['lfReleaseLock', 'lfReleaseTarget', 'lfReleaseMigration', 'lfReleaseDeployment'];
const rows = async (query, sql, ...params) => (await query([{ sql, params }]))[0]?.results ?? [];

export function pendingMigrations(migrations, ledger) {
    if (ledger.length > migrations.length) throw new Error('Database migration history is ahead of this build.');
    for (const [index, entry] of ledger.entries()) {
        const expected = migrations[index];
        if (entry.name !== expected.name || entry.digest !== expected.hash) throw new Error(`Migration history mismatch: ${entry.name}.`);
    }
    return migrations.slice(ledger.length);
}

/** Read-only: even an empty database must not gain metadata during planning. */
export async function inspectUpgrade({ query, target, migrations, online, version, commit, waitForLock = false }) {
    const objects = await rows(query, "SELECT name FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_KV', '_cf_METADATA')");
    const tables = new Set(objects.map(({ name }) => name));
    const report = { targetVersion: version, sourceCommit: commit, target, installation: 'new', applied: 0, pending: [], deployment: null, blockers: [] };
    let ledger = [], initialized = false;
    if (tables.has('lfReleaseTarget')) {
        const [record] = await rows(query, 'SELECT identity, initialComplete FROM lfReleaseTarget WHERE id = 1');
        if (!record || record.identity !== JSON.stringify(target)) report.blockers.push('This database belongs to a different Worker or storage configuration.');
        initialized = Boolean(record?.initialComplete);
        report.installation = initialized ? 'existing' : 'incomplete';
        if (!tables.has('lfReleaseMigration')) report.blockers.push('The release migration ledger is missing.');
        else ledger = await rows(query, 'SELECT name, digest FROM lfReleaseMigration ORDER BY name');
    } else if (objects.some(({ name }) => !releaseTables.includes(name))) {
        report.blockers.push('This database is not empty and has no Loginflare release record.');
    }
    report.applied = ledger.length;
    try {
        report.pending = pendingMigrations(migrations, ledger).map(({ name, hash }) => ({ name, digest: hash, online: !initialized || online[name] === hash }));
        for (const migration of report.pending) {
            if (!migration.online) report.blockers.push(`${migration.name} has no matching online migration approval. Use the separate operations procedure.`);
        }
    } catch (error) { report.blockers.push(error.message); }
    if (tables.has('lfReleaseDeployment')) {
        [report.deployment] = await rows(query, 'SELECT version, commitSha, stage, updatedAt FROM lfReleaseDeployment WHERE id = 1');
        report.deployment ??= null;
    }
    if (tables.has('lfReleaseLock')) {
        const [lock] = await rows(query, 'SELECT expiresAt FROM lfReleaseLock WHERE id = 1');
        if (lock?.expiresAt > Date.now()) {
            report.lockExpiresAt = lock.expiresAt;
            if (!waitForLock) report.blockers.push('Another release may still be active. Check its deployment before retrying after the lease expires.');
        }
    }
    return report;
}

export function requireUpgrade(report) {
    if (report.blockers.length) throw new Error(report.blockers.join('\n'));
    return report;
}

export function verifyActiveWorker(active, report, expectedCommit) {
    if (!active?.build || active.version !== report.targetVersion || active.commit !== report.deployment?.commitSha
        || report.deployment?.version !== report.targetVersion || (expectedCommit && active.commit !== expectedCommit)) {
        throw new Error('Active Worker does not match the recorded target publication and source commit.');
    }
}

const canonical = (sql) => (sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\.[0-9]+)?|[^\s]/g) ?? [])
    .map((token) => token.startsWith("'") ? token : token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"').toLowerCase() : token.toLowerCase()).join(' ');

export async function verifyUpgradeSchema(query, bundle) {
    const actual = await rows(query, "SELECT name, type, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'");
    for (const expected of bundle.objects) {
        const found = actual.find(({ name, type }) => name === expected.name && type === expected.type);
        if (!found || canonical(found.sql) !== canonical(expected.sql)) throw new Error(`Database ${expected.type} differs from the target migrations: ${expected.name}.`);
    }
    if ((await rows(query, 'PRAGMA foreign_key_check')).length) throw new Error('Database foreign-key validation failed.');
}

/** The publication response must be from the intended build, not a healthy old Worker. */
export async function verifyPublished(origin, buildId, { request = fetch, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), installed = true } = {}) {
    for (let attempt = 0; attempt < 12; attempt++) {
        try {
            const response = await request(new URL(installed ? '/api/readiness' : '/api/health', origin), { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'Cache-Control': 'no-cache' } });
            if (response.ok && response.headers.get('X-Loginflare-Build') === buildId) {
                const body = await response.json();
                if (body.status === (installed ? 'ready' : 'ok')) return body.status;
            }
        } catch { /* propagation and transient network errors are bounded */ }
        if (attempt < 11) await pause(2000);
    }
    throw new Error('Worker was published, but target-build readiness could not be confirmed. Check active deployments and rerun upgrade:verify; do not assume a rollback occurred.');
}
