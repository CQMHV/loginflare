import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validateDeploymentConfiguration, verifyCheckout } from './deployment.mjs';

const template = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
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
