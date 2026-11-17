import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cloudflare, deploy, readDeploymentConfig, resolveTarget } from './deployment.mjs';
import { loadRelease, sourceCommit } from './release-manifest.mjs';
import { inspectUpgrade, requireUpgrade, verifyActiveWorker, verifyPublished, verifyUpgradeSchema } from './upgrade-state.mjs';
import { release } from './releases.mjs';
import { localUpgrade } from './local-upgrade.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Upgrade tools (remote credentials: CLOUDFLARE_API_TOKEN):
  pnpm upgrade:plan --remote --account ACCOUNT_ID --worker WORKER [--json]
  pnpm upgrade:status --remote --account ACCOUNT_ID --worker WORKER [--json]
  pnpm upgrade:apply --remote --account ACCOUNT_ID --worker WORKER
  pnpm upgrade:verify --remote --account ACCOUNT_ID --worker WORKER [--json]
  pnpm upgrade:plan --local --state work/upgrade-demo [--json]
Local apply simulates the database release only; it does not publish or start a Worker.
Remote apply requires pnpm build:deploy, a clean main checkout, and the latest origin/main.`;

export function parseUpgradeArguments(input) {
    const args = input.filter((value) => value !== '--');
    if (args.includes('--help') || args.includes('-h')) return { help: true };
    const action = args.shift();
    if (!['status', 'plan', 'apply', 'verify'].includes(action)) throw new Error(usage);
    const options = { action };
    for (let index = 0; index < args.length; index++) {
        const key = args[index];
        if (!['--local', '--remote', '--json', '--state', '--account', '--worker'].includes(key) || Object.hasOwn(options, key.slice(2))) throw new Error(`Unknown or repeated option: ${key}.`);
        options[key.slice(2)] = ['--local', '--remote', '--json'].includes(key) ? true : args[++index];
        if (!options[key.slice(2)] || String(options[key.slice(2)]).startsWith('--')) throw new Error(`Missing value: ${key}.`);
    }
    if (Boolean(options.local) === Boolean(options.remote)) throw new Error('Choose exactly one of --local and --remote.');
    if (options.local && (!options.state || options.account || options.worker)) throw new Error('Local operations require --state and reject remote targets.');
    if (options.remote && (options.state || !/^[0-9a-f]{32}$/.test(options.account ?? '') || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(options.worker ?? ''))) throw new Error('Remote operations require an explicit valid --account and --worker.');
    if (options.action === 'apply' && options.json) throw new Error('Apply streams publication progress. Use upgrade:status --json or upgrade:verify --json for a machine-readable report.');
    return options;
}

export async function main(input) {
    const options = parseUpgradeArguments(input);
    if (options.help) { console.log(usage); return; }
    const { manifest, bundle, online } = loadRelease(root);
    const commit = sourceCommit(root);
    if (options.action === 'apply' && options.remote) {
        if (commit === 'source-archive') throw new Error('Remote apply requires a Git checkout of this source directory. Use the downstream Fork.');
        const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' });
        if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error('Remote apply requires a clean tracked checkout. Commit reviewed changes first.');
        await deploy([], options); return;
    }
    let context, resolved, configSource;
    if (options.local) context = await localUpgrade(root, options.state);
    else {
        const token = process.env.CLOUDFLARE_API_TOKEN;
        if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN; credentials are never accepted as command arguments.');
        const { source, configuration: config } = readDeploymentConfig(root);
        configSource = source;
        if (config.account_id && config.account_id !== options.account) throw new Error('The configuration account differs from --account.');
        const api = cloudflare(token, options.account);
        resolved = await resolveTarget(api, config, options.account, options.worker, undefined, fetch, { readOnly: true });
        await resolved.verifyBuckets();
        context = { target: resolved.target, query: (batch) => api(`/d1/database/${resolved.target.database}/query`, {
            method: 'POST', body: { batch: batch.map(({ sql, params }) => ({ sql, params: params.map(String) })) },
        }), dispose: async () => {} };
        await resolved.verifyMediaConfiguration(context.query);
    }
    try {
        const report = await inspectUpgrade({ ...context, migrations: bundle.migrations, online, version: manifest.version, commit, waitForLock: options.action === 'apply' });
        report.mode = options.local ? 'local-database-simulation' : 'remote';
        if (configSource) report.configuration = { path: configSource.path, environment: configSource.environment ?? null };
        report.activeWorker = resolved ? { version: resolved.activeVersion ?? null, commit: resolved.activeCommit ?? null, build: resolved.activeBuild ?? null } : null;
        if (options.action !== 'status') requireUpgrade(report);
        if (options.action === 'apply') {
            await release({ ...context, migrations: bundle.migrations, online, deployment: { version: manifest.version, commit },
                isCurrent: async () => true, verify: async () => {}, publish: async () => {},
                checkSchema: () => verifyUpgradeSchema(context.query, bundle) });
        }
        if (options.action === 'verify') {
            if (report.pending.length) throw new Error('Required migrations have not been applied.');
            await verifyUpgradeSchema(context.query, bundle);
            if (resolved) {
                verifyActiveWorker(report.activeWorker, report, commit === 'source-archive' ? undefined : commit);
                report.sourceVerification = commit === 'source-archive' ? 'archive-version-only' : 'commit-matched';
                const row = (await context.query([{ sql: 'SELECT origin, completedAt FROM lfInstallation WHERE id = 1', params: [] }]))[0]?.results?.[0];
                if (!row?.origin) throw new Error('Installation origin is missing; finish installation before remote verification.');
                await verifyPublished(row.origin, resolved.activeBuild, { installed: Boolean(row.completedAt) });
            }
            report.verification = 'passed';
        }
        const result = options.action === 'apply' ? await inspectUpgrade({ ...context, migrations: bundle.migrations, online, version: manifest.version, commit }) : report;
        result.mode = report.mode;
        result.activeWorker = report.activeWorker;
        if (options.json) console.log(JSON.stringify(result));
        else {
            console.log(`Loginflare ${manifest.version} (${commit.slice(0, 12)}): ${report.mode}`);
            console.log(JSON.stringify(result, null, 4));
        }
    } finally { await context.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { await main(process.argv.slice(2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
