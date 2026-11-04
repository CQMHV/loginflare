import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validateDeploymentConfiguration } from './deployment.mjs';

const template = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
test('public release template provisions bindings without maintainer resources or wizard-managed vars', () => {
    assert.equal(validateDeploymentConfiguration(template), template);
    assert.equal(template.d1_databases[0].database_id, undefined);
    assert.equal(template.env, undefined);
    assert.deepEqual(Object.keys(template.vars), ['APP_ENV']);
    assert.equal(template.version_metadata.binding, 'CF_VERSION_METADATA');
});
test('deployment refuses wizard configuration conflicts and local builds', () => {
    assert.throws(() => validateDeploymentConfiguration({ ...template, vars: { ...template.vars, AUTH_URL: '' } }), /belongs to the installation wizard/);
    assert.throws(() => validateDeploymentConfiguration({ ...template, env: { staging: { vars: { EMAIL_FROM: '' } } } }), /belongs to the installation wizard/);
    assert.throws(() => validateDeploymentConfiguration({ ...template, vars: { APP_ENV: 'development' } }), /explicitly built/);
    assert.throws(() => validateDeploymentConfiguration({ ...template, secrets: { required: ['CF_SETUP_TOKEN'] } }), /only needed for first installation/);
});
test('deploy-button example requests only the one-time installation secret', () => {
    const example = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8');
    const keys = [...example.matchAll(/^([A-Z_]+)=/gm)].map((match) => match[1]);
    assert.deepEqual(keys, ['CF_SETUP_TOKEN']);
});
