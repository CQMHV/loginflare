import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const runtimeRequire = createRequire(await realpath('node_modules/@cloudflare/vitest-plugin/package.json'));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = runtimeRequire('miniflare');
test('native public R2 reads bypass the application Worker and cannot write objects', async (t) => {
    await mkdir('work', { recursive: true });
    const state = await mkdtemp(resolve('work/public-r2-'));
    const options = convertV4MiniflareOptions({
        host: '127.0.0.1', port: 0, modules: true, compatibilityDate: '2026-10-26',
        script: `export default { fetch() { return new Response('Application Worker', { headers: { 'X-Test-Worker-Invoked': '1' } }); } };`,
        log: new Log(LogLevel.NONE), r2Buckets: { AVATARS: 'isolated-public-media' },
        outboundService: () => { throw new Error('Public R2 tests prohibit outbound traffic'); },
    });
    options.resourcePersistencePath = join(state, 'state'); options.telemetry = { enabled: false };
    const runtime = new Miniflare(options); t.after(() => runtime.dispose());
    const origin = await runtime.ready, bucket = await runtime.getR2Bucket('AVATARS');
    const body = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>';
    const root = new URL('/cdn-cgi/local/r2/public/isolated-public-media/', origin);
    for (const key of [crypto.randomUUID(), `branding/${crypto.randomUUID()}`, `social-icons/${crypto.randomUUID()}`]) {
        await bucket.put(key, body, { httpMetadata: { contentType: 'image/svg+xml', contentDisposition: 'attachment', cacheControl: 'public, max-age=300' } });
        const url = new URL(key, root);
        const get = await fetch(url, { headers: { Origin: 'http://localhost:5174' } });
        assert.equal(get.status, 200); assert.equal(get.headers.get('X-Test-Worker-Invoked'), null);
        assert.equal(get.headers.get('Access-Control-Allow-Origin'), '*');
        assert.equal(get.headers.get('Content-Type'), 'image/svg+xml');
        assert.equal(get.headers.get('Cache-Control'), 'public, max-age=300');
        assert.equal(await get.text(), body);
        const etag = get.headers.get('ETag'); assert.ok(etag);
        for (const method of ['GET', 'HEAD']) {
            const unchanged = await fetch(url, { method, headers: { 'If-None-Match': etag } });
            assert.equal(unchanged.status, 304); assert.equal(unchanged.headers.get('X-Test-Worker-Invoked'), null);
        }
        const head = await fetch(url, { method: 'HEAD' });
        assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(head.headers.get('Content-Length'), String(Buffer.byteLength(body)));
        const range = await fetch(url, { headers: { Range: 'bytes=0-3' } });
        assert.equal(range.status, 206); assert.equal(await range.text(), body.slice(0, 4));
        for (const method of ['POST', 'PUT', 'DELETE']) {
            const rejected = await fetch(url, { method });
            assert.equal(rejected.status, 401); assert.equal(rejected.headers.get('X-Test-Worker-Invoked'), null);
        }
        assert.equal(await (await bucket.get(key)).text(), body);
        await bucket.delete(key);
        const missing = await fetch(url);
        assert.equal(missing.status, 404); assert.equal(missing.headers.get('X-Test-Worker-Invoked'), null);
    }
    assert.equal((await fetch(origin)).headers.get('X-Test-Worker-Invoked'), '1');
});
