import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArguments, promotionSql, queryRows, resolveDatabase, runRemoteMaintenance } from './database.mjs';

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

test('schema checks require an explicit target and reject promotion-only input', () => {
    assert.deepEqual(parseArguments(['check', '--local']), { action: 'check', local: true, environment: undefined, email: undefined });
    assert.deepEqual(parseArguments(['check', '--env', 'staging']), { action: 'check', local: false, environment: 'staging', email: undefined });
    assert.throws(() => parseArguments(['check']), /exactly one target/);
    assert.throws(() => parseArguments(['check', '--local', '--env', 'production']), /exactly one target/);
    assert.throws(() => parseArguments(['check', '--local', '--email', 'user@example.test']), /only valid for promotion/);
});

test('remote maintenance accepts only an HTTPS origin and file-based credentials', () => {
    assert.equal(parseArguments(['migrate', '--url', 'https://accounts.example.test', '--cookie-file', 'private.txt', '--backup-confirmed']).backupConfirmed, true);
    assert.throws(() => parseArguments(['migrate', '--url', 'http://accounts.example.test']), /HTTPS origin/);
    assert.throws(() => parseArguments(['migrate', '--url', 'https://accounts.example.test/path']), /HTTPS origin/);
    assert.throws(() => parseArguments(['migrate', '--url', 'https://accounts.example.test', '--local']), /exactly one target/);
    assert.throws(() => parseArguments(['migrate', '--url', 'https://accounts.example.test', '--cookie-file', 'one', '--token-file', 'two']), /not both/);
    assert.throws(() => parseArguments(['migrate', '--url', 'https://accounts.example.test', '--token', 'secret']), /Unknown option/);
});

function credentialFile(t, name, value) {
    const directory = mkdtempSync(join(tmpdir(), 'loginflare-maintenance-cli-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, name);
    writeFileSync(file, value, { mode: 0o600 });
    return file;
}

test('remote CLI advances the shared maintenance endpoint without executing direct D1 commands', async (t) => {
    const cookieFile = credentialFile(t, 'cookie.txt', 'loginflare.control=synthetic-cli-session');
    const calls = [];
    let ready = false;
    const transport = async (url, request) => {
        calls.push({ path: url.pathname, method: request.method, body: request.body });
        assert.equal(request.headers.Cookie, 'loginflare.control=synthetic-cli-session');
        if (url.pathname.endsWith('/status')) return Response.json({ mode: ready ? 'ready' : 'draining', migrations: { ready }, backupConfirmed: true });
        assert.equal(url.pathname, '/api/maintenance/advance');
        ready = true;
        return Response.json({ progress: { phase: 'complete' } });
    };
    const result = await runRemoteMaintenance({ action: 'migrate', url: 'https://accounts.example.test', cookieFile }, transport);
    assert.equal(result.mode, 'ready');
    assert.deepEqual(calls.map(({ path }) => path), ['/api/maintenance/status', '/api/maintenance/advance', '/api/maintenance/status']);
});

test('read-only check never enters maintenance or performs a write challenge when a session exists', async (t) => {
    const cookieFile = credentialFile(t, 'cookie.txt', 'loginflare.control=synthetic-cli-session');
    let calls = 0;
    const result = await runRemoteMaintenance({ action: 'check', url: 'https://accounts.example.test', cookieFile }, async (url, request) => {
        calls++;
        assert.equal(url.pathname, '/api/maintenance/status');
        assert.equal(request.method, 'GET');
        return Response.json({ mode: 'failed', progress: { phase: 'migrations' } });
    });
    assert.equal(calls, 1);
    assert.equal(result.mode, 'failed');
});

test('CLI recovery uses a write challenge and consumes the resulting session cookie', async (t) => {
    const tokenFile = credentialFile(t, 'token.txt', 'synthetic-user-api-token');
    const paths = [];
    let nonce;
    await runRemoteMaintenance({ action: 'check', url: 'https://accounts.example.test', tokenFile }, async (url, request) => {
        paths.push(url.pathname);
        if (url.pathname.endsWith('/challenge')) {
            const body = JSON.parse(request.body);
            assert.equal(body.token, 'synthetic-user-api-token');
            assert.match(body.nonce, /^[A-Za-z0-9_-]{43}$/);
            nonce = body.nonce;
            return Response.json({ challengeId: 'bound-to-current-instance' });
        }
        if (url.pathname.endsWith('/verify')) {
            assert.equal(JSON.parse(request.body).nonce, nonce);
            return Response.json({ authenticated: true }, { headers: { 'Set-Cookie': 'loginflare.control=recovered; Path=/; Secure; HttpOnly' } });
        }
        assert.equal(request.headers.Cookie, 'loginflare.control=recovered');
        return Response.json({ mode: 'ready' });
    });
    assert.deepEqual(paths, ['/api/maintenance/challenge', '/api/maintenance/verify', '/api/maintenance/status']);
});

test('a remote write failure is not retried without inspecting durable state', async (t) => {
    const cookieFile = credentialFile(t, 'cookie.txt', 'loginflare.control=synthetic-cli-session');
    let advances = 0;
    await assert.rejects(runRemoteMaintenance({ action: 'migrate', url: 'https://accounts.example.test', cookieFile }, async (url) => {
        if (url.pathname.endsWith('/status')) return Response.json({ mode: 'migrating', backupConfirmed: true });
        advances++;
        throw new Error('Synthetic network failure after possible commit');
    }), /Synthetic network failure/);
    assert.equal(advances, 1);
});

test('pending recovery observation does not authorize CLI, and its temporary credential is cleaned before proceeding', async (t) => {
    const tokenFile = credentialFile(t, 'token.txt', 'synthetic-user-api-token');
    const paths = [];
    let verifies = 0, cleaned = false;
    await runRemoteMaintenance({ action: 'check', url: 'https://accounts.example.test', tokenFile }, async (url, request) => {
        paths.push(url.pathname);
        if (url.pathname.endsWith('/challenge')) return Response.json({ challengeId: 'current-runtime' }, { status: 202 });
        if (url.pathname.endsWith('/verify')) {
            verifies++;
            return verifies === 1 ? Response.json({ pending: true }, { status: 202 })
                : Response.json({ authenticated: true }, { headers: { 'Set-Cookie': 'loginflare.control=bound; Path=/; Secure; HttpOnly' } });
        }
        assert.equal(request.headers.Cookie, 'loginflare.control=bound');
        if (url.pathname === '/api/setup/cleanup') {
            assert.equal(JSON.parse(request.body).token, 'synthetic-user-api-token');
            cleaned = true;
            return Response.json({ cleanupPending: false });
        }
        return Response.json({ mode: 'ready', cleanupPending: !cleaned });
    });
    assert.equal(verifies, 2);
    assert.equal(cleaned, true);
    assert.deepEqual(paths.slice(-3), ['/api/maintenance/status', '/api/setup/cleanup', '/api/maintenance/status']);
});

test('a session without API credentials cannot bypass pending credential cleanup', async (t) => {
    const cookieFile = credentialFile(t, 'cookie.txt', 'loginflare.control=synthetic-cli-session');
    const paths = [];
    await assert.rejects(runRemoteMaintenance({ action: 'migrate', url: 'https://accounts.example.test', cookieFile, backupConfirmed: true }, async (url) => {
        paths.push(url.pathname);
        return Response.json({ mode: 'ready', cleanupPending: true });
    }), /cleanup is pending/);
    assert.deepEqual(paths, ['/api/maintenance/status']);
});

for (const mode of ['draining', 'failed']) {
    test(`an automatically ${mode} task cannot advance without its own persisted backup confirmation`, async (t) => {
        const cookieFile = credentialFile(t, 'cookie.txt', 'loginflare.control=synthetic-cli-session');
        const paths = [];
        await assert.rejects(runRemoteMaintenance({ action: 'migrate', url: 'https://accounts.example.test', cookieFile }, async (url) => {
            paths.push(url.pathname);
            return Response.json({ mode, backupConfirmed: false });
        }), /--backup-confirmed/);
        assert.deepEqual(paths, ['/api/maintenance/status']);
    });

    test(`CLI persists recovery-point confirmation through enter before resuming a ${mode} task`, async (t) => {
        const cookieFile = credentialFile(t, 'cookie.txt', 'loginflare.control=synthetic-cli-session');
        const paths = [];
        let confirmed = false, ready = false;
        const result = await runRemoteMaintenance({ action: 'migrate', url: 'https://accounts.example.test', cookieFile, backupConfirmed: true }, async (url, request) => {
            paths.push(url.pathname);
            if (url.pathname.endsWith('/status')) return Response.json({ mode: ready ? 'ready' : mode, backupConfirmed: confirmed });
            if (url.pathname.endsWith('/enter')) {
                assert.deepEqual(JSON.parse(request.body), { backupConfirmed: true });
                confirmed = true;
                return Response.json({ mode });
            }
            assert.equal(confirmed, true);
            assert.equal(url.pathname, '/api/maintenance/advance');
            ready = true;
            return Response.json({ progress: { phase: 'complete' } });
        });
        assert.equal(result.mode, 'ready');
        assert.deepEqual(paths, ['/api/maintenance/status', '/api/maintenance/enter', '/api/maintenance/status', '/api/maintenance/advance', '/api/maintenance/status']);
    });
}

test('CLI refuses advance when enter did not persist confirmation for the current task', async (t) => {
    const cookieFile = credentialFile(t, 'cookie.txt', 'loginflare.control=synthetic-cli-session');
    const paths = [];
    await assert.rejects(runRemoteMaintenance({ action: 'migrate', url: 'https://accounts.example.test', cookieFile, backupConfirmed: true }, async (url) => {
        paths.push(url.pathname);
        return Response.json({ mode: 'draining', backupConfirmed: false });
    }), /has not confirmed/);
    assert.deepEqual(paths, ['/api/maintenance/status', '/api/maintenance/enter', '/api/maintenance/status']);
});
