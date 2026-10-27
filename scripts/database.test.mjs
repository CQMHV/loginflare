import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments, promotionSql, queryRows, resolveDatabase } from './database.mjs';

const localId = '00000000-0000-4000-8000-000000000001';
const stagingId = '00000000-0000-4000-8000-000000000002';
const productionId = '00000000-0000-4000-8000-000000000003';
const config = {
    d1_databases: [{ binding: 'DB', database_id: localId }],
    env: {
        staging: { d1_databases: [{ binding: 'DB', database_id: stagingId }] },
        production: { d1_databases: [{ binding: 'DB', database_id: productionId }] },
    },
};

test('promotion requires an explicit and unambiguous environment', () => {
    assert.throws(() => parseArguments(['promote', '--email', 'user@example.invalid']), /exactly one target/);
    assert.throws(() => parseArguments(['promote', '--email', 'user@example.invalid', '--local', '--env', 'staging']), /exactly one target/);
    assert.throws(() => parseArguments(['promote', '--email', 'user@example.invalid', '--env', 'other']), /staging or production/);
});

test('promotion normalizes the email and accepts pnpm argument separators', () => {
    assert.deepEqual(parseArguments(['promote', '--', '--email', ' User@Example.Invalid ', '--local']), {
        action: 'promote', local: true, environment: undefined, email: 'user@example.invalid',
    });
});

test('invalid input and repeated flags are rejected before executing a tool', () => {
    assert.throws(() => parseArguments(['promote', '--local']), /valid --email/);
    assert.throws(() => parseArguments(['promote', '--email', 'invalid', '--local']), /valid --email/);
    assert.throws(() => parseArguments(['promote', '--email', '--local']), /Missing value/);
    assert.throws(() => parseArguments(['migrate', '--local', '--local']), /Repeated option/);
    assert.throws(() => parseArguments(['migrate', '--local', '--email', 'user@example.invalid']), /only valid for promotion/);
    assert.throws(() => parseArguments(['migrate', '--local', '--unknown']), /Unknown option/);
    assert.throws(() => parseArguments(['delete', '--local']), /Choose migrate or promote/);
});

test('database targets are selected from the explicit environment', () => {
    assert.equal(resolveDatabase(config, { local: true }), localId);
    assert.equal(resolveDatabase(config, { local: false, environment: 'staging' }), stagingId);
    assert.equal(resolveDatabase(config, { local: false, environment: 'production' }), productionId);
});

test('missing, placeholder, reused and ambiguous database IDs are rejected', () => {
    assert.throws(() => resolveDatabase({}, { local: true }), /DB D1 binding/);
    assert.throws(() => resolveDatabase({ d1_databases: [{ binding: 'DB', database_id: 'REPLACE_ME' }] }, { local: true }), /UUID v4/);
    const reused = structuredClone(config);
    reused.env.staging.d1_databases[0].database_id = localId;
    assert.throws(() => resolveDatabase(reused, { local: false, environment: 'staging' }), /local D1/);
    reused.env.staging.d1_databases[0].database_id = productionId;
    assert.throws(() => resolveDatabase(reused, { local: false, environment: 'staging' }), /different D1/);
});

test('D1 response parser accepts CLI responses and rejects errors or unknown shapes', () => {
    const rows = [{ id: 'one', email: 'user@example.invalid', role: 'admin' }];
    assert.deepEqual(queryRows(JSON.stringify([{ success: true, results: rows }])), rows);
    assert.deepEqual(queryRows(JSON.stringify({ result: [{ success: true, results: rows }] })), rows);
    assert.deepEqual(queryRows(JSON.stringify([{ success: true, results: [] }])), []);
    assert.throws(() => queryRows('{"result":{}}'), /Unexpected D1 query response/);
    assert.throws(() => queryRows('[{"success":false}]'), /failed query/);
});

test('promotion is conditional on a verified active account and parameterized by email', () => {
    assert.match(promotionSql, /"emailVerified" = 1/);
    assert.match(promotionSql, /COALESCE\("banned", 0\) = 0/);
    assert.equal((promotionSql.match(/\?/g) ?? []).length, 1);
    assert.match(promotionSql, /RETURNING "id", "email", "role"/);
});
