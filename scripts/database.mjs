import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareDatabase, checkDatabase } from './database-schema.mjs';
import { snapshotLocal } from './local-snapshot.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localState = resolve(process.env.LOGINFLARE_LOCAL_STATE ?? resolve(projectRoot, '.cloudflare/state'));
const usage = [
    'Usage:',
    '  node scripts/database.mjs migrate --local',
    '  node scripts/database.mjs migrate --env staging|production',
    '  node scripts/database.mjs check --local',
    '  node scripts/database.mjs check --env staging|production',
    '  node scripts/database.mjs promote --email user@example.com --local',
    '  node scripts/database.mjs promote --email user@example.com --env staging|production',
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
        } else if (argument === '--env' || argument === '--email') {
            const value = args.shift();
            if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
            if (argument === '--env') options.environment = value;
            else options.email = value.trim().toLowerCase();
        } else {
            throw new Error(`Unknown option: ${argument}`);
        }
    }
    if (options.local === Boolean(options.environment)) {
        throw new Error('Choose exactly one target: --local or --env staging|production.');
    }
    if (options.environment && !['staging', 'production'].includes(options.environment)) {
        throw new Error('Remote environments must be staging or production.');
    }
    if (action === 'promote' && (!options.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email))) {
        throw new Error('Promotion requires a valid --email address.');
    }
    if (action !== 'promote' && options.email) throw new Error('--email is only valid for promotion.');
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

function runTool(packageName, arguments_, captureOutput = false) {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve(`${packageName}/package.json`);
    const packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8'));
    const executable = resolve(dirname(packagePath), packageMetadata.bin[packageName]);
    const environment = { ...process.env };
    if (arguments_.includes('--local')) {
        const toolConfig = process.env.LOGINFLARE_LOCAL_STATE ? resolve(localState, '../tool-config') : resolve(projectRoot, '.cloudflare/tool-config');
        environment.XDG_CONFIG_HOME = toolConfig;
        environment.MINIFLARE_REGISTRY_PATH = resolve(toolConfig, 'registry');
        environment.WRANGLER_REGISTRY_PATH = resolve(toolConfig, 'registry');
        environment.WRANGLER_LOG_PATH = resolve(toolConfig, 'wrangler.log');
    }
    const result = spawnSync(process.execPath, [executable, ...arguments_], {
        cwd: projectRoot,
        env: environment,
        encoding: 'utf8',
        shell: false,
        stdio: captureOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit',
        maxBuffer: 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        if (captureOutput && result.stderr) process.stderr.write(result.stderr);
        throw new Error(`${packageName} exited with status ${result.status ?? 'unknown'}. Inspect the target state before retrying an uncertain write.`);
    }
    if (captureOutput && result.stderr) process.stderr.write(result.stderr);
    return result.stdout;
}

export function queryRows(output) {
    const data = JSON.parse(output);
    const statements = Array.isArray(data) ? data : data.result;
    if (!Array.isArray(statements)) throw new Error('Unexpected D1 query response; inspect the target state before retrying.');
    if (statements.some((statement) => statement.success === false)) throw new Error('D1 reported a failed query.');
    return statements.flatMap((statement) => statement.results ?? []);
}

export async function main(input) {
    const options = parseArguments(input);
    if (options.help) {
        console.log(usage);
        return;
    }
    const config = JSON.parse(readFileSync(resolve(projectRoot, 'wrangler.jsonc'), 'utf8'));
    const databaseId = resolveDatabase(config, options);
    const targetArguments = options.local
        ? ['--local', '--persist-to', localState]
        : ['--mode', options.environment];
    console.log(`Target: ${options.local ? 'local' : options.environment}; D1 database: ${databaseId}`);
    const query = (sql) => queryRows(options.local
        ? runTool('wrangler', ['d1', 'execute', 'DB', '--local', '--persist-to', localState, '--command', sql, '--json'], true)
        : runTool('cf', ['d1', 'query', databaseId, '--body', JSON.stringify({ sql }), ...targetArguments], true));
    if (options.action === 'check') {
        console.log(JSON.stringify({ schema: 'ok', ...checkDatabase(projectRoot, query) }));
        return;
    }
    if (options.action === 'migrate') {
        if (options.local) console.log(JSON.stringify({ backup: await snapshotLocal(projectRoot, undefined, localState) }));
        const tables = query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'");
        const prepared = tables.length && query("SELECT name FROM d1_migrations WHERE name = '0006_management.sql'").length;
        if (!prepared) prepareDatabase(projectRoot, query);
        runTool('cf', ['d1', 'migrations', 'apply', databaseId, '--dir', resolve(projectRoot, 'migrations'), ...targetArguments]);
        console.log(JSON.stringify({ schema: 'ok', ...checkDatabase(projectRoot, query) }));
        return;
    }
    let output;
    if (options.local) {
        // cf 1.0.0-beta.22 has no local D1 query implementation. Wrangler's
        // official local D1 command shares the Vite plugin's persistence format.
        const sql = promotionSql.replace('?', `'${options.email.replaceAll("'", "''")}'`);
        output = runTool('wrangler', ['d1', 'execute', 'DB', '--local', '--persist-to', localState, '--command', sql, '--json'], true);
    } else {
        const body = JSON.stringify({ sql: promotionSql, params: [options.email] });
        output = runTool('cf', ['d1', 'query', databaseId, '--body', body, ...targetArguments], true);
    }
    const rows = queryRows(output);
    if (rows.length !== 1 || rows[0].role !== 'admin' || rows[0].email !== options.email) {
        throw new Error('No verified, active account matched that email. Register and verify it first; suspended accounts cannot be promoted.');
    }
    console.log(`Administrator ready: ${rows[0].email}. Sign out and sign in again.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        await main(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : 'Database operation failed.');
        process.exitCode = 1;
    }
}
