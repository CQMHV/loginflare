import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolveTarget, validateDeploymentConfiguration, verifyCheckout } from './deployment.mjs';

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
