import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRequire = createRequire(await realpath(join(root, 'node_modules/@cloudflare/vitest-plugin/package.json')));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = runtimeRequire('miniflare');
const production = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
const local = JSON.parse(await readFile(join(root, 'wrangler.local.jsonc'), 'utf8'));

test('public files bypass the Worker while HTML, API and protocol routes still invoke it', async (t) => {
    assert.deepEqual(local.assets.run_worker_first, production.assets.run_worker_first);
    await mkdir(join(root, 'work'), { recursive: true });
    const directory = await mkdtemp(join(root, 'work/static-assets-'));
    const assets = join(directory, 'public');
    await mkdir(join(assets, 'assets/nested'), { recursive: true });
    await mkdir(join(assets, 'api'), { recursive: true });
    const files = {
        'index.html': '<!doctype html><title>Static shell must not bypass HTML processing</title>',
        'assets/app-test.js': 'console.log("static fixture");',
        'assets/nested/app-test.js': 'export const nested = true;',
        'assets/app-test.css': 'body { color: black; }',
        'assets/font-test.woff2': 'local-font-fixture',
        'assets/theme.js': 'window.fixtureTheme = true;',
        'assets/standalone.html': '<!doctype html><title>Public static document</title>',
        'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        // Even an accidental asset collision must not bypass API handling.
        'api/collision.js': 'This file must not be served directly.',
    };
    await Promise.all(Object.entries(files).map(([path, body]) => writeFile(join(assets, path), body)));
    await writeFile(join(assets, '_headers'), await readFile(join(root, 'public/_headers')));
    const options = convertV4MiniflareOptions({
        name: 'isolated-static-routing', modules: true,
        script: `export default { fetch(request) {
            return Response.json({ path: new URL(request.url).pathname }, { headers: { 'X-Test-Worker-Invoked': 'true' } });
        } };`,
        host: '127.0.0.1', port: 0, compatibilityDate: production.compatibility_date,
        log: new Log(LogLevel.NONE),
        assets: { directory: assets, binding: 'ASSETS', run_worker_first: production.assets.run_worker_first,
            routerConfig: { has_user_worker: true },
            assetConfig: { not_found_handling: production.assets.not_found_handling } },
        outboundService: () => { throw new Error('Static routing tests prohibit outbound traffic'); },
    });
    options.resourcePersistencePath = join(directory, 'state');
    options.telemetry = { enabled: false };
    const runtime = new Miniflare(options);
    t.after(() => runtime.dispose());
    const origin = await runtime.ready;
    async function request(path, init) { return fetch(new URL(path, origin), { redirect: 'manual', ...init }); }

    await t.test('JS, CSS, fonts, public HTML and favicon are direct assets with security headers', async () => {
        for (const path of Object.keys(files).filter(path => path.startsWith('assets/') || path === 'favicon.svg')) {
            for (const method of ['GET', 'HEAD']) {
                let response = await request('/' + path, { method });
                if (path.endsWith('.html')) {
                    assert.equal(response.status, 307);
                    assert.equal(response.headers.get('X-Test-Worker-Invoked'), null);
                    const canonical = new URL(response.headers.get('Location'), origin);
                    assert.equal(canonical.pathname, '/' + path.slice(0, -5));
                    response = await request(canonical.pathname, { method });
                }
                assert.equal(response.status, 200, method + ' ' + path);
                assert.equal(response.headers.get('X-Test-Worker-Invoked'), null, path);
                assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer', path);
                assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', path);
                assert.equal(response.headers.get('X-Frame-Options'), 'DENY', path);
                if (path.endsWith('.html')) assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
                if (method === 'GET') assert.equal(await response.text(), files[path]);
                else assert.equal(await response.text(), '');
            }
        }
    });
    await t.test('unhashed scripts retain revalidation and conditional requests stay outside the Worker', async () => {
        const first = await request('/assets/theme.js');
        assert.match(first.headers.get('Cache-Control'), /max-age=0/);
        assert.match(first.headers.get('Cache-Control'), /must-revalidate/);
        const tag = first.headers.get('ETag');
        assert.ok(tag);
        await first.text();
        const unchanged = await request('/assets/theme.js', { headers: { 'If-None-Match': tag } });
        assert.equal(unchanged.status, 304);
        assert.equal(unchanged.headers.get('X-Test-Worker-Invoked'), null);
        assert.equal(unchanged.headers.get('X-Content-Type-Options'), 'nosniff');
    });
    await t.test('missing scripts and unsupported static methods do not invoke application code', async () => {
        const missing = await request('/assets/missing.js');
        assert.equal(missing.status, 404);
        assert.equal(missing.headers.get('X-Test-Worker-Invoked'), null);
        for (const method of ['POST', 'PUT', 'DELETE']) {
            const response = await request('/assets/theme.js', { method });
            assert.equal(response.status, 405);
            assert.equal(response.headers.get('X-Test-Worker-Invoked'), null);
        }
    });
    await t.test('HTML processing, installation, auth and R2 routes retain Worker routing', async () => {
        for (const path of ['/', '/index.html', '/en-us/login', '/zh-cn/account', '/setup', '/en-us/setup',
            '/api', '/api/auth/get-session', '/api/collision.js', '/api/health', '/api/readiness',
            '/.well-known/oauth-authorization-server/api/auth', '/avatars/example', '/branding/logos/example', '/unknown']) {
            const response = await request(path, { headers: { 'Sec-Fetch-Mode': 'navigate' } });
            assert.equal(response.headers.get('X-Test-Worker-Invoked'), 'true', path);
            assert.deepEqual(await response.json(), { path });
        }
        const metadata = await request('/_headers');
        assert.equal(metadata.headers.get('X-Test-Worker-Invoked'), 'true');
        assert.deepEqual(await metadata.json(), { path: '/_headers' });
    });
});
