import { createServer } from 'node:https';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readExampleTls } from '../setup-tls.mjs';

// Local HTTPS bridge. Production deploys src/index.ts directly to Workers.
const state = resolve(process.env.LOGINFLARE_WEB_STATE ?? 'work/server-web-state');
await mkdir(state, { recursive: true });
let sessionKey = process.env.LOGINFLARE_SESSION_KEY;
if (!sessionKey) {
    const file = resolve(state, 'session-key');
    try { sessionKey = await readFile(file, 'utf8'); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        sessionKey = randomBytes(32).toString('hex');
        await writeFile(file, sessionKey, { flag: 'wx', mode: 0o600 });
    }
}
await build({ configFile: false, ssr: { noExternal: true }, build: {
    ssr: 'examples/server-web/src/index.ts', outDir: 'work/server-web-build', emptyOutDir: true, minify: false,
} });
const wranglerRequire = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(wranglerRequire.resolve('miniflare')).href);
const options = convertV4MiniflareOptions({
    modules: true, scriptPath: resolve('work/server-web-build/index.js'),
    compatibilityDate: '2026-10-26', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { SESSIONS: 'loginflare-example-sessions' },
    bindings: {
        LOGINFLARE_ORIGIN: 'https://web.localhost:5181',
        LOGINFLARE_ISSUER: process.env.LOGINFLARE_ISSUER ?? 'http://localhost:5173/api/auth',
        LOGINFLARE_CLIENT_ID: process.env.LOGINFLARE_CLIENT_ID ?? '',
        LOGINFLARE_CLIENT_SECRET: process.env.LOGINFLARE_CLIENT_SECRET ?? '', LOGINFLARE_SESSION_KEY: sessionKey,
    },
});
options.resourcePersistencePath = resolve(state, 'v3');
const runtime = new Miniflare(options);
const database = await runtime.getD1Database('SESSIONS');
await database.prepare('CREATE TABLE IF NOT EXISTS appSession (id TEXT PRIMARY KEY, data TEXT NOT NULL, expiresAt INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0, refreshingAt INTEGER)').run();
await database.prepare('CREATE INDEX IF NOT EXISTS appSession_expiry ON appSession(expiresAt)').run();
const server = createServer(readExampleTls(), async (request, response) => {
    try {
        if (request.headers.host !== 'web.localhost:5181') { response.writeHead(400).end(); return; }
        const chunks = []; let length = 0;
        for await (const chunk of request) {
            length += chunk.length;
            if (length > 8192) { response.writeHead(413).end(); return; }
            chunks.push(chunk);
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        const result = await runtime.dispatchFetch(`https://web.localhost:5181${request.url}`, {
            method: request.method, headers, ...(length ? { body: Buffer.concat(chunks) } : {}), redirect: 'manual',
        });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
    } catch { response.writeHead(503).end('Local application unavailable'); }
});
async function stop() { server.close(); await runtime.dispose(); process.exit(0); }
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
server.listen(5181, '127.0.0.1', () => console.log('Web Worker example: https://web.localhost:5181'));
