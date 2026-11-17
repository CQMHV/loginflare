import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolveTarget, validateDeploymentConfiguration, verifyCheckout } from './deployment.mjs';
import { verifyMediaHeaders } from './public-assets.mjs';

const template = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const database = { uuid: '00000000-0000-4000-8000-000000000001', name: 'test-db' };
test('deployment requires the request limiter instead of silently dropping admission protection', () => {
    assert.throws(() => validateDeploymentConfiguration({ ...template, ratelimits: [] }), /REQUEST_LIMITER/);
    assert.equal(validateDeploymentConfiguration(template), template);
});
async function target(name, configuration = template, bindings) {
    return resolveTarget(async (path) => {
        if (path.startsWith('/workers/services/')) return bindings ? {} : null;
        if (path.endsWith('/settings')) return { bindings };
        if (path.startsWith('/d1/database?')) return [];
        if (path.startsWith('/d1/database')) return database;
        throw new Error('Unexpected API request: ' + path);
    }, configuration, 'test-account', name);
}
test('default bucket names remain distinct for long Worker names with a shared prefix', async () => {
    const prefix = 'a'.repeat(55);
    const first = (await target(prefix + '-one')).target, second = (await target(prefix + '-two')).target;
    for (const binding of ['avatars', 'privateBucket']) {
        assert.notEqual(first[binding], second[binding]);
        assert.match(first[binding], /^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
        assert.ok(first[binding].length <= 63);
        assert.equal((await target(prefix + '-one')).target[binding], first[binding]);
    }
    const boundary = (await target('a'.repeat(55))).target;
    assert.equal(boundary.avatars, 'a'.repeat(55) + '-avatars');
    assert.equal(boundary.privateBucket, 'a'.repeat(55) + '-private');
    const maximum = (await target('a'.repeat(63))).target;
    assert.equal(maximum.avatars.length, 63);
    assert.equal(maximum.privateBucket.length, 63);
});
test('resource naming preserves short defaults, explicit names and existing live bindings', async () => {
    const short = (await target('example')).target;
    assert.equal(short.avatars, 'example-avatars'); assert.equal(short.privateBucket, 'example-private');
    const configured = { ...template, r2_buckets: template.r2_buckets.map((item) => ({ ...item, bucket_name: item.binding.toLowerCase() })) };
    const explicit = (await target('a'.repeat(63), configured)).target;
    assert.equal(explicit.avatars, 'avatars'); assert.equal(explicit.privateBucket, 'private');
    const bindings = [{ name: 'DB', type: 'd1', id: database.uuid },
        { name: 'AVATARS', type: 'r2_bucket', bucket_name: 'previous-avatars' }, { name: 'PRIVATE', type: 'r2_bucket', bucket_name: 'previous-private' }];
    const existing = (await target('a'.repeat(63), template, bindings)).target;
    assert.equal(existing.avatars, 'previous-avatars'); assert.equal(existing.privateBucket, 'previous-private');
    await assert.rejects(target('example', configured, bindings), /differs from the active binding/);
});
test('public release template leaves resource IDs to Cloudflare and separates the private bucket', () => {
    assert.equal(validateDeploymentConfiguration(template), template);
    assert.equal(template.d1_databases[0].database_id, undefined);
    assert.equal(template.env, undefined);
    assert.deepEqual(Object.keys(template.vars), ['APP_ENV']);
    assert.equal(template.version_metadata.binding, 'CF_VERSION_METADATA');
    assert.deepEqual(template.r2_buckets.map(({ binding }) => binding), ['AVATARS', 'PRIVATE']);
});
test('deployment refuses wizard configuration conflicts and local builds', () => {
    assert.throws(() => validateDeploymentConfiguration({ ...template, vars: { ...template.vars, AUTH_URL: '' } }), /must not be declared/);
    assert.throws(() => validateDeploymentConfiguration({ ...template, env: { staging: { vars: { EMAIL_FROM: '' } } } }), /must not be declared/);
    assert.throws(() => validateDeploymentConfiguration({ ...template, vars: { APP_ENV: 'development' } }), /production or staging build/);
    assert.throws(() => validateDeploymentConfiguration({ ...template, secrets: { required: ['CF_SETUP_TOKEN'] } }), /only needed for first installation/);
});
test('deploy-button example requests exactly the three installation inputs', () => {
    const example = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8');
    const keys = [...example.matchAll(/^([A-Z_]+)=/gm)].map((match) => match[1]);
    assert.deepEqual(keys, ['SETUP_ORIGIN', 'SETUP_ADMIN_EMAIL', 'CF_SETUP_TOKEN']);
});

test('a branch-triggered first build can use the checked-out commit without a pin', () => {
    const commit = 'a'.repeat(40);
    verifyCheckout(commit, '', 'main');
    verifyCheckout(commit, '0'.repeat(40), 'main');
    verifyCheckout(commit, 'undefined', 'main');
    verifyCheckout(commit, commit, 'main');
    assert.throws(() => verifyCheckout(commit, 'b'.repeat(40), 'main'), /does not match/);
    assert.throws(() => verifyCheckout(commit, commit, 'preview'), /run from main/);
});

const mediaBase = 'https://images.example.test';
const mediaHeaders = {
    'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
};
test('public media deployment requires the exact domain while PRIVATE and r2.dev remain closed', async () => {
    const active = { domain: 'images.example.test', enabled: true, status: { ownership: 'active', ssl: 'active' } };
    async function resolve({ configured = mediaBase, previous, avatars = [active], privateDomains = [], privateManaged = false, avatarManaged = false } = {}) {
        const calls = [];
        const resolved = await resolveTarget(async (path, options) => {
            assert.ok(!options?.method || options.method === 'GET', 'existing resources require only read checks');
            calls.push(path);
            if (path.startsWith('/workers/services/')) return {};
            if (path.endsWith('/settings')) return { bindings: previous ? [{ name: 'PUBLIC_ASSETS_URL', type: 'plain_text', text: previous }] : [] };
            if (path.startsWith('/d1/database?')) return [{ ...database, name: 'test' }];
            if (path.startsWith('/d1/database')) return database;
            if (path.startsWith('/r2/buckets/')) {
                const privateBucket = path.includes('test-private');
                if (path.endsWith('/domains/managed')) return { enabled: privateBucket ? privateManaged : avatarManaged };
                if (path.endsWith('/domains/custom')) return { domains: privateBucket ? privateDomains : avatars };
                return {};
            }
            throw new Error('Unexpected request: ' + path);
        }, { ...template, vars: { ...template.vars, ...(configured === null ? {} : { PUBLIC_ASSETS_URL: configured }) } }, 'test-account', 'test', undefined,
        async (url, options) => {
            assert.equal(url, mediaBase + '/loginflare-deployment-header-check');
            assert.equal(options.method, 'HEAD'); assert.equal(options.redirect, 'manual');
            return new Response(null, { status: 404, headers: mediaHeaders });
        });
        return { resolved, calls };
    }
    const allowed = await resolve(); await allowed.resolved.ensureBuckets();
    assert.equal(allowed.resolved.config.vars.PUBLIC_ASSETS_URL, mediaBase);
    for (const options of [
        { privateDomains: [active] }, { privateManaged: true }, { avatarManaged: true },
        { avatars: [] }, { avatars: [{ ...active, enabled: false }] },
        { avatars: [{ ...active, domain: 'other.example.test' }] }, { avatars: [active, active] },
        { avatars: [{ ...active, status: { ownership: 'active', ssl: 'pending' } }] }, { configured: '' },
    ]) await assert.rejects((await resolve(options)).resolved.ensureBuckets(), /public access disabled|configured, active/);
    const inherited = await resolve({ configured: null, previous: mediaBase });
    await inherited.resolved.ensureBuckets(); assert.equal(inherited.resolved.config.vars.PUBLIC_ASSETS_URL, mediaBase);
    assert.throws(() => validateDeploymentConfiguration({ ...template, vars: { ...template.vars, PUBLIC_ASSETS_URL: 'http://images.example.test' } }), /PUBLIC_ASSETS_URL/);
    const privateDefault = await resolve({ configured: '', avatars: [] });
    await privateDefault.resolved.ensureBuckets();
    let queries = 0;
    await privateDefault.resolved.migrateMedia(async () => { queries++; throw new Error('Unnecessary D1 access'); });
    await privateDefault.resolved.verifyMediaConfiguration(async () => { queries++; throw new Error('Unnecessary D1 access'); });
    assert.equal(queries, 0);
    const reads = [];
    await allowed.resolved.verifyMediaConfiguration(async (batch) => {
        assert.ok(batch.every(({ sql }) => /^SELECT /.test(sql)), 'pre-publication media validation must be read-only');
        reads.push(...batch);
        return [{ results: [{ origin: 'https://auth.example.test' }] }];
    });
    assert.equal(reads.length, 2);
    await assert.rejects(allowed.resolved.verifyMediaConfiguration(async () => [{ results: [{ origin: mediaBase }] }]), /separate HTTPS origin/);
    await assert.rejects(allowed.resolved.migrateMedia(async () => [{ results: [{ origin: mediaBase }] }]), /separate HTTPS origin/);
    await allowed.resolved.migrateMedia(async () => [{ results: [] }]); // New installation has no user data.
});

test('public media security headers are checked without uploading probe objects or following redirects', async () => {
    await verifyMediaHeaders(mediaBase, async () => new Response(null, { status: 404, headers: mediaHeaders }));
    for (const key of Object.keys(mediaHeaders)) {
        const headers = { ...mediaHeaders }; delete headers[key];
        await assert.rejects(verifyMediaHeaders(mediaBase, async () => new Response(null, { status: 404, headers })), /security headers/);
    }
    for (const status of [200, 301, 403, 500]) await assert.rejects(verifyMediaHeaders(mediaBase, async () => new Response(null, { status, headers: mediaHeaders })), /security headers/);
});
