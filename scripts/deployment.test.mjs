import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDeploymentConfig, resolveTarget, validateDeploymentConfiguration, verifyCheckout, verifyBuild } from './deployment.mjs';
import { verifyMediaHeaders } from './public-assets.mjs';

const template = {
    name: 'loginflare', vars: { APP_ENV: 'production' },
    d1_databases: [{ binding: 'DB', database_name: 'loginflare' }],
    r2_buckets: [{ binding: 'AVATARS', bucket_name: 'loginflare-avatars' }, { binding: 'PRIVATE', bucket_name: 'loginflare-private' }],
    send_email: [{ name: 'EMAIL' }],
    ratelimits: [{ name: 'REQUEST_LIMITER', namespace_id: '1001', simple: { limit: 600, period: 60 } }],
};
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

test('preflight selects and normalizes the same custom Wrangler file and environment as the deployment build', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'loginflare-config-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const environments = { ...process.env };
    t.after(() => {
        for (const key of ['LOGINFLARE_CONFIG', 'CLOUDFLARE_ENV']) {
            if (environments[key] === undefined) delete process.env[key]; else process.env[key] = environments[key];
        }
    });
    delete process.env.CLOUDFLARE_ENV;
    process.env.LOGINFLARE_CONFIG = 'fork.jsonc';
    const path = join(root, 'fork.jsonc');
    const customDb = '00000000-0000-4000-8000-000000000002';
    const staging = { ...template, name: 'fork-staging', vars: { APP_ENV: 'staging', PUBLIC_ASSETS_URL: mediaBase },
        d1_databases: [{ ...template.d1_databases[0], database_id: customDb }] };
    writeFileSync(path, '// Custom JSONC\n' + JSON.stringify({ ...template, env: { staging } }));
    writeFileSync(join(root, '.env.deployment'), 'CLOUDFLARE_ENV=staging\n');
    const { source, configuration } = readDeploymentConfig(root);
    assert.equal(source.path, path);
    assert.equal(source.environment, 'staging');
    assert.equal(configuration.vars.PUBLIC_ASSETS_URL, mediaBase);
    assert.equal(configuration.d1_databases[0].database_id, customDb);
    await assert.rejects(target('fork-staging', configuration, [{ name: 'DB', type: 'd1', id: database.uuid }]), /differs from the active DB binding/);
    process.env.CLOUDFLARE_ENV = 'staging';
    assert.equal(readDeploymentConfig(root).source.digest, source.digest);
    writeFileSync(path, JSON.stringify({ ...template, env: { staging: { ...staging, vars: { APP_ENV: 'staging' } } } }));
    assert.notEqual(readDeploymentConfig(root).source.digest, source.digest);
});

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

test('read-only resource resolution never creates a missing database or bucket', async () => {
    const calls = [];
    const api = async (path, options = {}) => {
        calls.push([path, options.method ?? 'GET']);
        if (path.startsWith('/workers/services/')) return null;
        if (path.startsWith('/d1/database?')) return [];
        throw new Error('Unexpected API request: ' + path);
    };
    await assert.rejects(resolveTarget(api, template, 'account', 'test', undefined, fetch, { readOnly: true }), /does not create resources/);
    assert.ok(calls.every(([, method]) => method === 'GET'));
    const resolved = await resolveTarget(async (path, options = {}) => {
        assert.equal(options.method ?? 'GET', 'GET');
        if (path.startsWith('/workers/services/')) return null;
        if (path.startsWith('/d1/database?')) return [{ ...database, name: 'test' }];
        if (path.startsWith('/r2/buckets/')) return null;
        throw new Error('Unexpected API request: ' + path);
    }, template, 'account', 'test', undefined, fetch, { readOnly: true });
    await assert.rejects(resolved.verifyBuckets(), /does not create resources/);
});

test('publication rejects a build from another commit, version, migration bundle or deployment configuration', () => {
    const vars = { LOGINFLARE_SOURCE_COMMIT: 'commit', LOGINFLARE_RELEASE_VERSION: '0.2.0', LOGINFLARE_MIGRATION_HASH: 'bundle', LOGINFLARE_CONFIG_DIGEST: 'config' };
    verifyBuild({ vars }, 'commit', { version: '0.2.0' }, { hash: 'bundle' }, 'config');
    for (const name of Object.keys(vars)) assert.throws(() => verifyBuild({ vars: { ...vars, [name]: 'other' } }, 'commit', { version: '0.2.0' }, { hash: 'bundle' }, 'config'), /does not match/);
});
