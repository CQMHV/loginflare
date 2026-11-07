import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotLocal } from './local-snapshot.mjs';
import { buildMigrationBundle } from './migration-bundle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localState = resolve(process.env.LOGINFLARE_LOCAL_STATE ?? resolve(root, '.cloudflare/state'));
const usage = `Local development only:
  pnpm db:migrate
  pnpm db:check
  pnpm admin:promote --local --email user@example.com`;

export function parseArguments(input) {
    const args = input.filter((argument) => argument !== '--');
    if (!args.length || args.includes('--help') || args.includes('-h')) return { help: true };
    const action = args.shift();
    if (!['migrate', 'check', 'promote'].includes(action)) throw new Error('Choose migrate, check or promote.');
    if (!args.includes('--local')) throw new Error('This tool requires --local.');
    args.splice(args.indexOf('--local'), 1);
    if (action !== 'promote' && args.length === 0) return { action };
    if (action === 'promote' && args.length === 2 && args[0] === '--email') {
        const email = args[1].trim().toLowerCase();
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { action, email };
    }
    throw new Error(usage);
}

export async function main(input) {
    const options = parseArguments(input);
    if (options.help) { console.log(usage); return; }
    const config = JSON.parse(readFileSync(resolve(root, 'wrangler.local.jsonc'), 'utf8'));
    const databaseId = config.d1_databases?.find(({ binding }) => binding === 'DB')?.database_id;
    if (config.vars?.APP_ENV !== 'development' || !databaseId) throw new Error('The local development database is not configured.');
    if (options.action === 'migrate') await snapshotLocal(root, undefined, localState);
    const wranglerRequire = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
    const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(wranglerRequire.resolve('miniflare')).href);
    const runtime = convertV4MiniflareOptions({
        modules: true, script: 'export default { fetch() { return new Response("Local database operation"); } };',
        compatibilityDate: '2026-10-26', compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: databaseId },
    });
    runtime.resourcePersistencePath = resolve(localState, 'v3');
    const instance = new Miniflare(runtime);
    try {
        const db = await instance.getD1Database('DB');
        if (options.action === 'promote') {
            const result = await db.prepare(`UPDATE "user" SET role = 'admin'
                WHERE email = ? AND emailVerified = 1 AND COALESCE(banned, 0) = 0 RETURNING id`).bind(options.email).first();
            if (!result) throw new Error('No verified, active account matched that email.');
            console.log(`Administrator ready: ${options.email}. Sign out and sign in again.`);
            return;
        }
        const { migrations } = buildMigrationBundle(root);
        if (options.action === 'migrate') {
            await db.prepare(`CREATE TABLE IF NOT EXISTS d1_migrations
                (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).run();
        }
        const applied = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results;
        if (applied.length > migrations.length || applied.some(({ name }, index) => name !== migrations[index]?.name)) {
            throw new Error('Local migration history differs from the repository.');
        }
        const pending = migrations.slice(applied.length);
        if (options.action === 'check' && pending.length) throw new Error(`Pending migration: ${pending[0].name}.`);
        for (const migration of pending) {
            try {
                await db.batch([...migration.statements.map((sql) => db.prepare(sql)),
                    db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(migration.name)]);
            } catch (error) { throw new Error(`Migration ${migration.name} failed: ${error.message}`, { cause: error }); }
        }
        const violations = await db.prepare('PRAGMA foreign_key_check').all();
        if (violations.results.length) throw new Error('The local database contains invalid foreign keys.');
        console.log(JSON.stringify({ schema: 'ok', applied: pending.map(({ name }) => name) }));
    } finally { await instance.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { await main(process.argv.slice(2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
