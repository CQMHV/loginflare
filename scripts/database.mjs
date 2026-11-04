import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotLocal } from './local-snapshot.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localState = resolve(process.env.LOGINFLARE_LOCAL_STATE ?? resolve(projectRoot, '.cloudflare/state'));
const usage = [
    'Usage:',
    '  node scripts/database.mjs migrate --local [--confirm-key]',
    '  node scripts/database.mjs check --local [--confirm-key]',
    '  node scripts/database.mjs migrate --url https://accounts.example.com --cookie-file private-cookie.txt --backup-confirmed',
    '  node scripts/database.mjs check --url https://accounts.example.com --token-file private-token.txt',
    '  node scripts/database.mjs promote --email user@example.com --local',
    'Remote maintenance accepts --cookie-file or --token-file; secrets must never be passed as argument values.',
    'Promotion is local only. Remote SQL operations before deployment are not supported.',
].join('\n');

export function parseArguments(input) {
    const args = input.filter((argument) => argument !== '--');
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) return { help: true };
    const action = args.shift();
    if (!['migrate', 'promote', 'check'].includes(action)) throw new Error('Choose migrate or promote, or check.');
    const options = { action, local: false, environment: undefined, email: undefined };
    const seen = new Set();
    while (args.length > 0) {
        const argument = args.shift();
        if (seen.has(argument)) throw new Error(`Repeated option: ${argument}`);
        seen.add(argument);
        if (argument === '--local') {
            options.local = true;
        } else if (argument === '--backup-confirmed' || argument === '--confirm-key') {
            options[argument === '--backup-confirmed' ? 'backupConfirmed' : 'confirmUnverifiableKey'] = true;
        } else if (['--env', '--email', '--url', '--cookie-file', '--token-file'].includes(argument)) {
            const value = args.shift();
            if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
            if (argument === '--env') options.environment = value;
            else if (argument === '--email') options.email = value.trim().toLowerCase();
            else options[{ '--url': 'url', '--cookie-file': 'cookieFile', '--token-file': 'tokenFile' }[argument]] = value;
        } else {
            throw new Error(`Unknown option: ${argument}`);
        }
    }
    if (options.local === Boolean(options.environment || options.url)) {
        throw new Error('Choose exactly one target: --local or --url https://accounts.example.com.');
    }
    if (options.environment && !['staging', 'production'].includes(options.environment)) {
        throw new Error('Remote environments must be staging or production.');
    }
    if (action === 'promote' && (!options.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email))) {
        throw new Error('Promotion requires a valid --email address.');
    }
    if (action !== 'promote' && options.email) throw new Error('--email is only valid for promotion.');
    if (options.local && (options.cookieFile || options.tokenFile || options.backupConfirmed)) throw new Error('Maintenance credentials and backup confirmations require a remote --url.');
    if (options.cookieFile && options.tokenFile) throw new Error('Choose --cookie-file or --token-file, not both.');
    if (options.url) {
        let target;
        try { target = new URL(options.url); } catch { throw new Error('--url must be a public HTTPS origin.'); }
        if (target.origin !== options.url || target.protocol !== 'https:' || target.username || target.password || /^(localhost|127\.|\[::1\])/.test(target.hostname)) throw new Error('--url must be a public HTTPS origin.');
    }
    return options;
}

export function resolveDatabase(config, options) {
    const environment = options.local ? config : config.env?.[options.environment];
    const binding = environment?.d1_databases?.find((database) => database.binding === 'DB');
    if (!binding) throw new Error('The selected environment must configure a DB D1 binding.');
    const databaseId = binding.database_id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(databaseId ?? '')) {
        throw new Error('Configure a valid UUID v4 D1 database_id for the selected environment first.');
    }
    if (!options.local && databaseId === config.d1_databases?.find((database) => database.binding === 'DB')?.database_id) {
        throw new Error('A remote environment must not reuse the local D1 database ID.');
    }
    if (!options.local) {
        const otherEnvironment = options.environment === 'staging' ? 'production' : 'staging';
        const otherId = config.env?.[otherEnvironment]?.d1_databases?.find((database) => database.binding === 'DB')?.database_id;
        if (databaseId === otherId) throw new Error('Staging and production must use different D1 database IDs.');
    }
    return databaseId;
}

export const promotionSql = [
    'UPDATE "user" SET "role" = \'admin\'',
    'WHERE "email" = ? AND "emailVerified" = 1 AND COALESCE("banned", 0) = 0',
    'RETURNING "id", "email", "role"',
].join(' ');

export function queryRows(output) {
    const data = JSON.parse(output);
    const statements = Array.isArray(data) ? data : data.result;
    if (!Array.isArray(statements)) throw new Error('Unexpected D1 query response; inspect the target state before retrying.');
    if (statements.some((statement) => statement.success === false)) throw new Error('D1 reported a failed query.');
    return statements.flatMap((statement) => statement.results ?? []);
}

/** Remote operations use the Worker's durable maintenance protocol, never direct D1 writes. */
export async function runRemoteMaintenance(options, transport = fetch) {
    if (!options.url) throw new Error('Remote database operations require --url and --cookie-file or --token-file. They no longer run SQL before deployment.');
    if (options.action === 'promote') throw new Error('Remote SQL promotion is disabled. Use the installation flow to create the first administrator.');
    if (!options.cookieFile && !options.tokenFile) throw new Error('Provide maintenance credentials through --cookie-file or --token-file; never put secrets in command arguments.');
    let cookie = options.cookieFile ? readFileSync(resolve(options.cookieFile), 'utf8').trim() : '';
    if (cookie.length > 8192 || /[\r\n]/.test(cookie)) throw new Error('The cookie file must contain one raw Cookie header value.');
    let recoveryToken;
    const call = async (path, body) => {
        const endpoint = path.startsWith('/api/') ? path : `/api/maintenance/${path}`;
        const response = await transport(new URL(endpoint, options.url), {
            method: body === undefined ? 'GET' : 'POST', redirect: 'error',
            headers: { Origin: options.url, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(40_000),
        });
        const updated = response.headers.getSetCookie?.() ?? [];
        if (updated.length) cookie = updated.map((value) => value.split(';', 1)[0]).join('; ');
        let result;
        try { result = await response.json(); } catch { throw new Error('Maintenance returned an invalid response. Inspect its status before retrying an uncertain write.'); }
        if (!response.ok) {
            const error = new Error(`Maintenance request failed: ${typeof result.code === 'string' ? result.code : response.status}. Inspect status before retrying.`);
            error.code = result.code; error.status = response.status;
            throw error;
        }
        return result;
    };
    if (options.tokenFile) {
        const token = readFileSync(resolve(options.tokenFile), 'utf8').trim();
        if (!token || /\s/.test(token)) throw new Error('The token file must contain only the User API Token secret.');
        recoveryToken = token;
        const nonce = randomBytes(32).toString('base64url');
        const challenge = await call('challenge', { token, nonce });
        let authenticated = false;
        for (let attempt = 0; attempt < 30; attempt++) {
            try {
                const verified = await call('verify', { challengeId: challenge.challengeId, nonce });
                if (verified.authenticated === true) { authenticated = true; break; }
            }
            catch (error) { if (error.code !== 'CONFIGURATION_NOT_OBSERVED') throw error; }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (!authenticated) throw new Error('The write challenge has not been observed by the target runtime. Retry recovery after checking deployment state.');
    }
    let status = await call('status');
    if (status.authenticated === false) throw new Error('The maintenance session is unavailable or expired. Authorize through the maintenance page or use --token-file.');
    const cleanupPending = (value) => Boolean(value.cleanupPending ?? value.control?.cleanupPending);
    if (cleanupPending(status)) {
        if (!recoveryToken) throw new Error('Temporary credential cleanup is pending. Finish it in the installation page, or use --token-file with a valid User API Token before upgrading.');
        for (let attempt = 0; attempt < 30 && cleanupPending(status); attempt++) {
            await call('/api/setup/cleanup', { token: recoveryToken });
            status = await call('status');
            if (cleanupPending(status)) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (cleanupPending(status)) throw new Error('Temporary credential cleanup is not yet confirmed. The installation remains complete; resume cleanup before upgrading.');
    }
    if (options.action === 'check') return status;
    const mode = (value) => value.mode ?? value.control?.mode;
    if (mode(status) === 'ready' && (status.progress?.phase === 'complete' || status.migrations?.ready || status.migrationStatus?.ready)) return status;
    if (mode(status) === 'ready' || mode(status) === 'adoption' || !status.backupConfirmed) {
        if (!options.backupConfirmed) throw new Error('Verify the target D1/R2 recovery point and add --backup-confirmed before entering maintenance. Existing untracked instances must be transitioned through the documented stopped upgrade.');
        await call('enter', { backupConfirmed: true });
        status = await call('status');
        if (!status.backupConfirmed) throw new Error('The server has not confirmed the recovery point for the current upgrade task. Inspect maintenance status before continuing.');
    }
    for (let step = 0; step < 10_000; step++) {
        const result = await call('advance', options.confirmUnverifiableKey ? { confirmUnverifiableKey: true } : {});
        const progress = result.progress ?? result.upgrade ?? result;
        if (mode(result) === 'ready' || progress.phase === 'complete') return call('status');
    }
    throw new Error('Upgrade step budget exhausted. The durable checkpoint is retained; inspect status before continuing.');
}

async function operateLocal(databaseId, action, confirmUnverifiableKey = false, email) {
    // Share Wrangler's runtime version and persistence format, as the isolated
    // browser harness does; the separately pinned benchmark runtime is older.
    const wranglerRequire = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
    const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(wranglerRequire.resolve('miniflare')).href);
    const { advanceUpgrade, initialUpgradeProgress, migrationStatus } = await import('../src/server/upgrade.ts');
    const { ensureControl, enterMaintenance, readControl, acquireLease, renewLease, releaseLease, drain, fencedBatch, readValue, valueStatement,
        admit, guardedDatabase, releasePermit } = await import('../src/server/control.ts');
    try { process.loadEnvFile(resolve(projectRoot, '.dev.vars')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const runtimeOptions = convertV4MiniflareOptions({
        modules: true, script: 'export default { fetch() { return new Response("Local database operation"); } };',
        compatibilityDate: '2026-10-26', compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: databaseId },
    });
    runtimeOptions.resourcePersistencePath = resolve(localState, 'v3');
    const instance = new Miniflare(runtimeOptions);
    let db; let lease;
    try {
        db = await instance.getD1Database('DB');
        if (action === 'check') {
            if (!(await migrationStatus(db)).ready) throw new Error('PENDING_MIGRATIONS');
            let progress = initialUpgradeProgress();
            for (let step = 0; progress.phase !== 'complete' && step < 100_000; step++) {
                progress = await advanceUpgrade({ db, progress, readOnly: true, confirmUnverifiableKey,
                    commit: async (statements) => {
                        if (statements.length) throw new Error('Read-only checks cannot perform database writes.');
                        return [];
                    },
                }, process.env.BETTER_AUTH_SECRET);
            }
            if (progress.phase !== 'complete') throw new Error('Local check step budget exhausted.');
            console.log(JSON.stringify({ schema: 'ok', bundleHash: progress.bundleHash, keyEvidence: progress.keyEvidence }));
            return;
        }
        let control = await ensureControl({ DB: db, APP_ENV: 'development' });
        if (action === 'promote') {
            const permit = await admit(db, 'development');
            try {
                const result = await guardedDatabase(db, permit).prepare(promotionSql).bind(email).all();
                if (result.results.length !== 1 || result.results[0].role !== 'admin' || result.results[0].email !== email) {
                    throw new Error('No verified, active account matched that email. Register and verify it first; suspended accounts cannot be promoted.');
                }
                console.log(`Administrator ready: ${email}. Sign out and sign in again.`);
                return;
            } finally { await releasePermit(db, permit); }
        }
        if (control.mode === 'ready') control = await enterMaintenance(db, 'development');
        lease = await acquireLease(db, control.taskId);
        // main() completed the combined local snapshot before opening this
        // operation. Persist its acknowledgement under the same task fence.
        await fencedBatch(db, lease, [valueStatement(db, `backup:${control.taskId}`, true)]);
        if (control.mode === 'setup') await fencedBatch(db, lease, [db.prepare('UPDATE lfControl SET mode=\'draining\' WHERE id=1 AND mode=\'setup\'')]);
        control = await readControl(db);
        if (control.mode === 'failed' && !await readValue(db, `drained:${control.taskId}`)) {
            await fencedBatch(db, lease, [db.prepare("UPDATE lfControl SET mode='draining' WHERE id=1 AND mode='failed'")]);
            control = await readControl(db);
        }
        if (control.mode === 'draining') await drain(db, lease);
        if (!['migrating', 'checking', 'failed'].includes((await readControl(db)).mode)) throw new Error('The local database cannot enter the migration phase.');
        const key = `upgrade:${control.taskId}`;
        let progress = await readValue(db, key) ?? initialUpgradeProgress();
        let renewed = Date.now();
        for (let step = 0; progress.phase !== 'complete' && step < 100_000; step++) {
            if (Date.now() - renewed >= 15_000) { await renewLease(db, lease); renewed = Date.now(); }
            progress = await advanceUpgrade({ db, progress, confirmUnverifiableKey,
                commit: async (statements, next) => {
                    const results = await fencedBatch(db, lease, [...statements, valueStatement(db, key, next)]);
                    return results.slice(0, -1);
                },
            }, process.env.BETTER_AUTH_SECRET);
        }
        if (progress.phase !== 'complete') throw new Error('Local upgrade step budget exhausted. The checkpoint is retained.');
        await fencedBatch(db, lease, [db.prepare(`UPDATE lfControl SET mode='ready',installation='complete',buildId='development',targetBuildId='development',revision=revision+1 WHERE id=1`)]);
        console.log(JSON.stringify({ schema: 'ok', bundleHash: progress.bundleHash, applied: progress.committed }));
    } catch (error) {
        if (db && lease) {
            try { await fencedBatch(db, lease, [db.prepare("UPDATE lfControl SET mode='failed',revision=revision+1 WHERE id=1")]); } catch { /* A newer executor owns the task. */ }
        }
        throw error;
    } finally {
        if (db && lease) await releaseLease(db, lease);
        await instance.dispose();
    }
}

export async function main(input) {
    const options = parseArguments(input);
    if (options.help) {
        console.log(usage);
        return;
    }
    if (!options.local) {
        const result = await runRemoteMaintenance(options);
        console.log(JSON.stringify(result));
        return;
    }
    const configPath = resolve(projectRoot, 'wrangler.local.jsonc');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const databaseId = resolveDatabase(config, options);
    console.log(`Target: local; D1 database: ${databaseId}`);
    if (options.action === 'check') {
        await operateLocal(databaseId, 'check', options.confirmUnverifiableKey);
        return;
    }
    if (options.action === 'migrate') {
        console.log(JSON.stringify({ backup: await snapshotLocal(projectRoot, undefined, localState) }));
        await operateLocal(databaseId, 'migrate', options.confirmUnverifiableKey);
        return;
    }
    await operateLocal(databaseId, 'promote', false, options.email);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        await main(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : 'Database operation failed.');
        process.exitCode = 1;
    }
}
