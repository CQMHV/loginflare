import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments } from './database.mjs';

test('database commands remain available only against the local target', () => {
    assert.deepEqual(parseArguments(['check', '--local']), { action: 'check' });
    assert.deepEqual(parseArguments(['promote', '--', '--email', ' User@Example.Test ', '--local']),
        { action: 'promote', email: 'user@example.test' });
    assert.throws(() => parseArguments(['migrate', '--url', 'https://login.example.test']), /requires --local/);
    assert.throws(() => parseArguments(['migrate', '--local', '--backup-confirmed']), /Local development only/);
});
