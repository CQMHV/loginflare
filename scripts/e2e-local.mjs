import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Match the installed Wrangler runtime and its D1 persistence format.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, Response, convertV4MiniflareOptions } = await import(pathToFileURL(wranglerRequire.resolve('miniflare')).href);

const origin = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';
const url = new URL(origin);
if (url.origin !== origin || url.hostname !== 'localhost' || url.protocol !== 'http:' || !url.port || url.port === '5173') throw new Error('E2E must use an isolated loopback origin.');
const state = resolve(process.env.LOGINFLARE_LOCAL_STATE || '');
const mailbox = resolve(process.env.LOGINFLARE_MAILBOX || '');
const allowed = resolve('work/e2e') + sep;
if (!state.startsWith(allowed) || !mailbox.startsWith(allowed)) throw new Error('E2E state and mail must stay inside work/e2e.');
await mkdir(state, { recursive: true });
await mkdir(mailbox, { recursive: true });
const workerPath = resolve(dirname(state), 'worker.mjs');
const entry = relative(dirname(workerPath), resolve('dist/loginflare_local/index.js')).replaceAll('\\', '/');
await writeFile(workerPath, `import worker from ${JSON.stringify(entry.startsWith('.') ? entry : './' + entry)};
export default {
    fetch(request, env, ctx) {
        if (new URL(request.url).pathname === '/api/health') return env.TEST_READY.fetch('http://ready.local/');
        const EMAIL = { send(message) { return env.TEST_MAILBOX.fetch('http://mailbox.local/', { method: 'POST', body: JSON.stringify(message) }).then(response => {
            if (!response.ok) throw new Error('Local capture failed');
            return response.json();
        }); } };
        return worker.fetch(request, { ...env, EMAIL }, ctx);
    }
};
`);
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const assets = resolve('dist/client');
const workerRoot = resolve('dist/loginflare_local');
const workerModules = (await readdir(workerRoot, { recursive: true })).filter((file) => file.endsWith('.js'))
    .map((file) => ({ type: 'ESModule', path: resolve(workerRoot, file) }));
let ready = false;
const options = convertV4MiniflareOptions({
    host: '127.0.0.1', port: Number(url.port),
    modules: [{ type: 'ESModule', path: workerPath }, ...workerModules], modulesRoot: resolve('.'),
    compatibilityDate: '2026-10-26', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    d1Databases: { DB: '00000000-0000-4000-8000-000000000001' },
    bindings: {
        APP_ENV: 'development', AUTH_URL: origin, EMAIL_FROM: 'no-reply@loginflare.test',
        TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        BETTER_AUTH_SECRET: 'isolated-browser-test-secret-with-more-than-32-characters',
    },
    serviceBindings: {
        TEST_READY: () => Response.json({ status: ready ? 'ok' : 'starting' }, { status: ready ? 200 : 503 }),
        async ASSETS(request) {
            const pathname = new URL(request.url).pathname;
            const file = pathname.startsWith('/assets/') || pathname === '/favicon.svg' ? resolve(assets, '.' + pathname) : resolve(assets, 'index.html');
            if (!file.startsWith(assets + sep)) return new Response('Not found', { status: 404 });
            try { return new Response(await readFile(file), { headers: { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream' } }); }
            catch (error) { if (error.code === 'ENOENT') return new Response('Not found', { status: 404 }); throw error; }
        },
        async TEST_MAILBOX(request) {
            const message = await request.json();
            await writeFile(resolve(mailbox, `${Date.now()}-${randomUUID()}-email-text.txt`), message.text || '', { mode: 0o600 });
            return Response.json({ messageId: randomUUID() });
        },
    },
    async outboundService(request) {
        const target = new URL(request.url);
        // Native ID-token logout verification fetches this instance's public keys.
        if (target.origin === origin && target.pathname === '/api/auth/jwks' && request.method === 'GET') return instance.dispatchFetch(request);
        if (request.url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify' && request.method === 'POST') {
            const body = await request.json();
            return Response.json({ success: body.response === 'isolated-e2e-captcha-token' });
        }
        throw new Error('E2E outbound network is disabled');
    },
});
options.resourcePersistencePath = resolve(state, 'v3');
options.telemetry = { enabled: false };
const instance = new Miniflare(options);
try {
    await instance.ready;
    const { DB: database } = await instance.getBindings();
    await database.prepare('CREATE TABLE IF NOT EXISTS "d1_migrations" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL UNIQUE, "applied_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP)').run();
    for (const migration of await readD1Migrations('migrations')) {
        if (await database.prepare('SELECT 1 FROM "d1_migrations" WHERE "name" = ?').bind(migration.name).first()) continue;
        await database.batch([...migration.queries.map((sql) => database.prepare(sql)), database.prepare('INSERT INTO "d1_migrations" ("name") VALUES (?)').bind(migration.name)]);
    }
    ready = true;
    console.log(`Isolated E2E ready: ${origin}`);
} catch (error) { await instance.dispose(); throw error; }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await instance.dispose(); process.exit(0); });
