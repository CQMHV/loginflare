import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildMigrationBundle } from './migration-bundle.mjs';
import { release } from './releases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bootstrap = ['SETUP_ORIGIN', 'SETUP_ADMIN_EMAIL', 'CF_SETUP_TOKEN'];
export const managedConfiguration = ['AUTH_URL', 'EMAIL_FROM', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'BETTER_AUTH_SECRET', ...bootstrap];

export function validateDeploymentConfiguration(configuration) {
    if (!['production', 'staging'].includes(configuration.vars?.APP_ENV)) throw new Error('Deployment requires a production or staging build. Run pnpm build:deploy.');
    for (const [name, environment] of [['default', configuration], ...Object.entries(configuration.env ?? {})]) {
        for (const key of managedConfiguration) {
            if (Object.hasOwn(environment.vars ?? {}, key)) throw new Error(`${name}: ${key} must not be declared in the checked-in configuration.`);
        }
        if (environment.secrets?.required?.some((key) => bootstrap.includes(key))) throw new Error('Setup inputs are only needed for first installation and must not be required deployment secrets.');
    }
    if (configuration.d1_databases?.filter((binding) => binding.binding === 'DB').length !== 1) throw new Error('Missing or duplicate DB binding.');
    for (const name of ['AVATARS', 'PRIVATE']) {
        if (configuration.r2_buckets?.filter((binding) => binding.binding === name).length !== 1) throw new Error(`Missing or duplicate ${name} binding.`);
    }
    if (!configuration.send_email?.some((binding) => binding.name === 'EMAIL')) throw new Error('Missing EMAIL binding.');
    return configuration;
}

function cloudflare(token, account) {
    return async (path, { method = 'GET', body, allowMissing = false } = {}) => {
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
            method, redirect: 'error', signal: AbortSignal.timeout(30_000),
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const value = await response.json();
        if (allowMissing && response.status === 404) return null;
        if (!response.ok || value.success !== true || value.result?.some?.((item) => item?.success === false)) {
            const codes = (value.errors ?? []).map(({ code }) => code).filter(Number.isInteger);
            // D1 errors include SQLite's reason and the failed statement. Keep
            // that in build logs, but never output headers or raw API bodies.
            const reason = path.startsWith('/d1/database/') && path.endsWith('/query')
                ? value.errors?.map(({ message }) => message).filter(Boolean).join('; ').slice(0, 600) : '';
            throw new Error(`Cloudflare ${method} ${path.split('?')[0]} failed (HTTP ${response.status}${codes.length ? `; ${codes.join(', ')}` : ''})${reason ? `: ${reason}` : ''}.`);
        }
        return value.result;
    };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slug = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
function resourceName(value, worker, template, suffix = '') {
    const selected = !value || value === template ? worker.slice(0, 63 - suffix.length).replace(/-+$/, '') + suffix : value;
    if (!slug.test(selected) || selected.length > 63) throw new Error(`Invalid Cloudflare resource name: ${selected}.`);
    return selected;
}

export async function resolveTarget(api, configuration, account, name, expectedTag) {
    const workerPath = `/workers/scripts/${name}`, servicePath = `/workers/services/${name}`;
    const dbBinding = configuration.d1_databases.find(({ binding }) => binding === 'DB');
    const avatarBinding = configuration.r2_buckets.find(({ binding }) => binding === 'AVATARS');
    const privateBinding = configuration.r2_buckets.find(({ binding }) => binding === 'PRIVATE');
    const settings = async () => {
        const service = await api(servicePath, { allowMissing: true });
        if (expectedTag && service?.default_environment?.script?.tag !== expectedTag) throw new Error('The Worker does not match the Cloudflare Builds target.');
        return service ? api(`${workerPath}/settings`) : null;
    };
    const initial = await settings();
    const remoteBinding = (current, binding) => current?.bindings?.find((item) => item.name === binding);
    const remoteDb = remoteBinding(initial, 'DB');
    if (remoteDb && (remoteDb.type !== 'd1' || !uuid.test(remoteDb.id))) throw new Error('The active DB binding is not a D1 database.');
    if (dbBinding.database_id && remoteDb && dbBinding.database_id !== remoteDb.id) throw new Error('The configured D1 ID differs from the active DB binding.');

    const dbName = resourceName(dbBinding.database_name, name, 'loginflare');
    const getDb = async () => (await api(`/d1/database?name=${encodeURIComponent(dbName)}&per_page=100`)).find((item) => item.name === dbName);
    let database;
    if (dbBinding.database_id || remoteDb) {
        const id = dbBinding.database_id ?? remoteDb.id;
        if (!uuid.test(id)) throw new Error('The D1 binding does not have a valid database ID.');
        database = await api(`/d1/database/${id}`);
    } else {
        database = await getDb();
        if (!database) {
            try { database = await api('/d1/database', { method: 'POST', body: { name: dbName } }); }
            catch (error) {
                database = await getDb();
                if (!database) throw error;
            }
        }
    }
    if (!uuid.test(database?.uuid)) throw new Error('Cloudflare did not return a D1 database ID.');

    const getBucketName = (binding, suffix) => {
        const live = remoteBinding(initial, binding.binding);
        if (live && (live.type !== 'r2_bucket' || !live.bucket_name)) throw new Error(`The active ${binding.binding} binding is not an R2 bucket.`);
        const desired = resourceName(binding.bucket_name, name, `loginflare${suffix}`, suffix);
        if (live && desired !== live.bucket_name && binding.bucket_name !== `loginflare${suffix}`) throw new Error(`The configured ${binding.binding} bucket differs from the active binding.`);
        return live?.bucket_name ?? desired;
    };
    const avatars = getBucketName(avatarBinding, '-avatars'), privateBucket = getBucketName(privateBinding, '-private');
    if (avatars === privateBucket) throw new Error('Private installation material and public assets require separate buckets.');

    const target = { account, name, database: database.uuid, avatars, privateBucket };
    const ensureBucket = async (bucket) => {
        const path = `/r2/buckets/${bucket}`;
        if (!await api(path, { allowMissing: true })) {
            try { await api('/r2/buckets', { method: 'POST', body: { name: bucket } }); }
            catch (error) { if (!await api(path, { allowMissing: true })) throw error; }
        }
        const managed = await api(`${path}/domains/managed`);
        const custom = await api(`${path}/domains/custom`);
        if (managed?.enabled !== false || !Array.isArray(custom?.domains) || custom.domains.length) {
            throw new Error(`R2 bucket ${bucket} must have public access disabled.`);
        }
    };
    const verify = async () => {
        const current = await settings();
        for (const [binding, type, property, expected] of [['DB', 'd1', 'id', target.database],
            ['AVATARS', 'r2_bucket', 'bucket_name', avatars], ['PRIVATE', 'r2_bucket', 'bucket_name', privateBucket]]) {
            const item = remoteBinding(current, binding);
            if (item && (item.type !== type || item[property] !== expected)) throw new Error(`The active ${binding} binding changed during the release.`);
            if (!item && remoteBinding(initial, binding)) throw new Error(`The active ${binding} binding disappeared during the release.`);
        }
    };
    return { target, verify, ensureBuckets: async () => { await ensureBucket(avatars); await ensureBucket(privateBucket); },
        config: { ...configuration, name, account_id: account,
            vars: { ...configuration.vars, LOGINFLARE_ACCOUNT_ID: account, LOGINFLARE_WORKER_NAME: name },
            d1_databases: configuration.d1_databases.map((item) => item === dbBinding ? { ...item, database_name: database.name, database_id: database.uuid } : item),
            r2_buckets: configuration.r2_buckets.map((item) => item === avatarBinding ? { ...item, bucket_name: avatars }
                : item === privateBinding ? { ...item, bucket_name: privateBucket } : item),
        } };
}

function git(args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (result.error || result.status !== 0) throw new Error(`Could not verify Git ${args[0]} for the release.`);
    return result.stdout.trim();
}

export function verifyCheckout(commit, expected, branch) {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('The checkout has no valid Git commit.');
    // Cloudflare's dashboard can start the first build by branch without a
    // pinned commit. In that case the actual checkout and remote main still
    // have to agree before any release work starts.
    if (/^[0-9a-f]{40}$/i.test(expected ?? '') && !/^0{40}$/.test(expected) && expected.toLowerCase() !== commit) {
        throw new Error(`The checkout ${commit.slice(0, 12)} does not match the Cloudflare Builds commit ${expected.slice(0, 12)}.`);
    }
    if (branch && branch !== 'main' && branch !== 'refs/heads/main') throw new Error('Releases must run from main.');
}

export async function deploy(input = process.argv.slice(2)) {
    input = input.filter((argument) => argument !== '--');
    if (input.some((argument) => argument !== '--dry-run')) throw new Error('Deployment accepts only --dry-run.');
    const pointer = resolve(root, '.wrangler/deploy/config.json');
    let build;
    try { build = resolve(dirname(pointer), JSON.parse(readFileSync(pointer, 'utf8')).configPath); }
    catch { throw new Error('No built Worker configuration was found. Run pnpm build:deploy first.'); }
    const configuration = validateDeploymentConfiguration(JSON.parse(readFileSync(build, 'utf8')));
    const packagePath = createRequire(import.meta.url).resolve('wrangler/package.json');
    const wrangler = JSON.parse(readFileSync(packagePath, 'utf8'));
    const deployWorker = () => {
        const result = spawnSync(process.execPath, [resolve(dirname(packagePath), wrangler.bin.wrangler), 'deploy', ...input], {
            cwd: root, env: process.env, stdio: 'inherit', timeout: 5 * 60_000, shell: false,
        });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Worker deployment exited with ${result.status ?? 'unknown'}. Check active deployments before retrying.`);
    };
    if (input.includes('--dry-run')) { deployWorker(); return; }

    const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? configuration.account_id;
    const name = process.env.WRANGLER_CI_OVERRIDE_NAME ?? configuration.name;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!/^[0-9a-f]{32}$/.test(account ?? '') || !slug.test(name ?? '') || name.length > 63 || !token
        || (configuration.account_id && configuration.account_id !== account)) {
        throw new Error('Cloudflare Builds must provide an account, deployment credentials and Worker target.');
    }
    const commit = git(['rev-parse', 'HEAD']);
    verifyCheckout(commit, process.env.WORKERS_CI_COMMIT_SHA, process.env.WORKERS_CI_BRANCH);
    const isCurrent = async () => {
        const head = git(['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).split(/\s/)[0];
        if (head === commit) return true;
        console.log('A newer main commit is available; skipping this release.');
        return false;
    };
    if (!await isCurrent()) return;
    const api = cloudflare(token, account);
    const resolved = await resolveTarget(api, configuration, account, name, process.env.WRANGLER_CI_MATCH_TAG);
    const { migrations } = buildMigrationBundle(root);
    const online = JSON.parse(readFileSync(resolve(root, 'migrations/online.json'), 'utf8'));
    const published = await release({
        query: (batch) => api(`/d1/database/${resolved.target.database}/query`, {
            method: 'POST', body: { batch: batch.map(({ sql, params }) => ({ sql, params: params.map(String) })) },
        }),
        target: resolved.target, migrations, online, isCurrent, verify: resolved.verify,
        publish: async () => {
            writeFileSync(build, JSON.stringify(resolved.config) + '\n');
            deployWorker();
        },
        prepare: resolved.ensureBuckets,
    });
    if (published) console.log(`Released ${commit.slice(0, 12)} to ${name} using D1 ${resolved.target.database}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { await deploy(); }
    catch (error) { console.error(error instanceof Error ? error.message : 'Deployment failed.'); process.exitCode = 1; }
}
