import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { symmetricEncrypt } from 'better-auth/crypto';
import { snapshotLocal, verifyLocalSnapshot } from './local-snapshot.mjs';

const root = resolve('.'), run = resolve('work/events-recovery', randomUUID());
await mkdir(run, { recursive: true });
const require = createRequire(import.meta.url), runtime = createRequire(await realpath(resolve('node_modules/@cloudflare/vitest-plugin/package.json')));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = runtime('miniflare');
const vite = createRequire(require.resolve('vite/package.json'));
const { rolldown } = await import(pathToFileURL(vite.resolve('rolldown')).href);
const bundle = await rolldown({ input: resolve('scripts/events-recovery-worker.ts'), external: (id) => id.startsWith('node:') || id.startsWith('cloudflare:') });
const bridge = join(run, 'bridge');
await bundle.write({ dir: bridge, format: 'esm', entryFileNames: 'worker.js' }); await bundle.close();
const modules = (await readdir(bridge, { recursive: true })).filter((file) => file.endsWith('.js')).map((file) => ({ type: 'ESModule', path: join(bridge, file) }));
const recoveryKey = randomBytes(32).toString('hex'), secret = randomBytes(32).toString('hex'), signingKey = 'lfwh_' + randomBytes(32).toString('hex');
const configuration = { AUTH_ISSUER: 'https://audit-source.example.com/api/auth', MACHINE_CLIENT_ID: 'isolated-archive', MACHINE_CLIENT_SECRET: 'isolated-archive-secret' };
const databaseId = '00000000-0000-4000-8000-000000000051';
await writeFile(join(run, 'wrangler.local.jsonc'), JSON.stringify({ vars: { APP_ENV: 'development', AUTH_URL: 'http://localhost:5173' }, d1_databases: [{ binding: 'DB', database_id: databaseId, remote: false }] }));
await writeFile(join(run, '.dev.vars'), `BETTER_AUTH_SECRET=${secret}\n`, { mode: 0o600 });
let failOlderPage = true, mf;
const report = { outboundBlocked: 0, receiverRequests: 0, auditPages: 0 };
function start(state, restoredSecret = secret) {
    if (!resolve(state).startsWith(run + '\\') && !resolve(state).startsWith(run + '/')) throw new Error('Recovery state must remain isolated');
    return new Miniflare(convertV4MiniflareOptions({
        modules, modulesRoot: root, compatibilityDate: '2026-10-27', compatibilityFlags: ['nodejs_compat'],
        host: '127.0.0.1', port: 0, log: new Log(LogLevel.NONE), resourcePersistencePath: state,
        d1Databases: { DB: databaseId, INBOX: '00000000-0000-4000-8000-000000000052', ARCHIVE: '00000000-0000-4000-8000-000000000053' },
        bindings: { APP_ENV: 'development', AUTH_URL: 'http://localhost:5173', BETTER_AUTH_SECRET: restoredSecret, RECOVERY_KEY: recoveryKey, WEBHOOK_SECRET: signingKey, ...configuration },
        outboundService: async (request) => {
            const url = new URL(request.url);
            if (url.href === 'https://93.184.216.34/inbox' && request.method === 'POST') {
                report.receiverRequests++;
                const headers = new Headers(request.headers); headers.set('X-Recovery-Key', recoveryKey);
                return mf.dispatchFetch('http://localhost:5173/__receive', { method: 'POST', headers, body: await request.arrayBuffer() });
            }
            if (url.href === configuration.AUTH_ISSUER + '/oauth2/token' && request.method === 'POST') {
                assert.equal(new URLSearchParams(await request.text()).get('scope'), 'management:audit:read');
                return Response.json({ access_token: 'local.access.token', token_type: 'Bearer', expires_in: 300, scope: 'management:audit:read' });
            }
            if (url.origin === 'https://audit-source.example.com' && url.pathname === '/api/management/v1/audit-logs' && request.method === 'GET') {
                report.auditPages++;
                const older = url.searchParams.has('cursor');
                if (older && failOlderPage) return Response.json({ code: 'TEMPORARY_FAILURE' }, { status: 503 });
                return Response.json({ items: [{ id: older ? 'older-audit' : 'head-audit', event: 'account.deleted', outcome: 'success', targetUserId: 'recovery-subject', createdAt: '2026-11-14T00:00:00.000Z' }], pageInfo: { nextCursor: older ? null : 'older-page', previousCursor: null } });
            }
            report.outboundBlocked++; throw new Error('Recovery prohibits external network requests');
        },
    }));
}
const call = (path) => mf.dispatchFetch('http://localhost:5173' + path, { method: 'POST', headers: { 'X-Recovery-Key': recoveryKey } });
try {
    mf = start(join(run, 'state/v3/d1'));
    const db = await mf.getD1Database('DB');
    for (const migration of await readD1Migrations(resolve('migrations'))) await db.batch(migration.queries.map((sql) => db.prepare(sql)));
    for (const [binding, file] of [['INBOX', 'examples/webhook-receiver/migrations/0001_inbox.sql'], ['ARCHIVE', 'examples/audit-export/migrations/0001_archive.sql']]) {
        const database = await mf.getD1Database(binding);
        await database.batch((await readFile(file, 'utf8')).split(';').filter((sql) => sql.trim()).map((sql) => database.prepare(sql)));
    }
    await db.prepare('INSERT INTO webhookSubscription (id,name,url,events,secret,enabled,createdAt) VALUES (?,?,?,?,?,1,?)')
        .bind(randomUUID(), 'Isolated recovery', 'https://93.184.216.34/inbox', '["user.created"]', await symmetricEncrypt({ key: secret, data: signingKey }), new Date().toISOString()).run();
    await db.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,0,?,?)').bind('recovery-subject', 'Local fixture', 'recovery@example.com', new Date().toISOString(), new Date().toISOString()).run();
    const eventId = await db.prepare('SELECT id FROM businessEvent').first('id');
    assert.equal((await call('/__lost-completion')).status, 503);
    assert.equal(await (await mf.getD1Database('INBOX')).prepare('SELECT count(*) n FROM webhookInbox').first('n'), 1);
    assert.equal(await db.prepare('SELECT outcome FROM webhookAttempt').first('outcome'), 'pending');
    // Simulate elapsed wall time without waiting thirty seconds in the test.
    await db.prepare('UPDATE webhookDelivery SET leaseUntil = 1').run();
    assert.equal((await call('/__archive')).status, 503);
    assert.equal(await (await mf.getD1Database('ARCHIVE')).prepare('SELECT cursor FROM exportCheckpoint').first('cursor'), 'older-page');
    await mf.dispose(); mf = undefined;
    const snapshot = await snapshotLocal(run, join(run, 'snapshot'), join(run, 'state'));
    assert.equal((await verifyLocalSnapshot(snapshot.destination)).integrity, 'ok');
    const manifest = JSON.parse(await readFile(join(snapshot.destination, 'manifest.json'), 'utf8'));
    const restored = join(run, 'restored');
    for (const file of manifest.files) { const target = join(restored, file); await mkdir(dirname(target), { recursive: true }); await copyFile(join(snapshot.destination, file), target); }
    const restoredSecret = /^BETTER_AUTH_SECRET=(.+)$/m.exec(await readFile(join(restored, '.dev.vars'), 'utf8'))?.[1];
    assert.equal(restoredSecret, secret);
    failOlderPage = false; mf = start(join(restored, 'd1'), restoredSecret);
    assert.equal((await call('/__deliver')).status, 200); assert.equal((await call('/__archive')).status, 200);
    const restoredDb = await mf.getD1Database('DB'), inbox = await mf.getD1Database('INBOX'), archive = await mf.getD1Database('ARCHIVE');
    assert.equal(await restoredDb.prepare('SELECT eventId FROM webhookDelivery').first('eventId'), eventId);
    assert.equal(await restoredDb.prepare('SELECT status FROM webhookDelivery').first('status'), 'succeeded');
    assert.deepEqual((await restoredDb.prepare('SELECT outcome FROM webhookAttempt ORDER BY number').all()).results.map((row) => row.outcome), ['uncertain', 'succeeded']);
    assert.equal(await inbox.prepare('SELECT count(*) n FROM webhookInbox').first('n'), 1); assert.equal(report.receiverRequests, 2);
    assert.equal(await archive.prepare('SELECT count(*) n FROM auditArchive').first('n'), 2); assert.equal(await archive.prepare('SELECT cursor FROM exportCheckpoint').first('cursor'), null);
    for (const database of [restoredDb, inbox, archive]) assert.deepEqual((await database.prepare('PRAGMA foreign_key_check').all()).results, []);
    assert.equal(report.outboundBlocked, 0);
    await writeFile(join(run, 'report.json'), JSON.stringify({ ...report, snapshotFiles: manifest.files.length, eventIdPreserved: true, receiverDeduplicated: true, uncertainAttemptRecovered: true, archiveResumed: true, integrity: 'ok' }, null, 2));
    console.log(JSON.stringify({ result: 'passed', report: relative(root, join(run, 'report.json')) }));
} finally { if (mf) await mf.dispose(); }
