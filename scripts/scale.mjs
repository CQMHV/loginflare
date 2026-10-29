import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from 'better-auth/crypto';
import { snapshotLocal } from './local-snapshot.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = process.argv.slice(2).filter((argument) => argument !== '--');
const options = { sizes: [10, 100_000, 1_000_000], duration: 30 };
for (const argument of arguments_) {
    const match = /^--(sizes|duration)=(.+)$/.exec(argument);
    if (!match) throw new Error('Usage: pnpm test:scale [--sizes=10,100000,1000000] [--duration=30]');
    if (match[1] === 'sizes') options.sizes = match[2].split(',').map(Number);
    else options.duration = Number(match[2]);
}
if (options.sizes.some((size) => !Number.isSafeInteger(size) || size < 10 || size > 1_000_000) || !Number.isFinite(options.duration) || options.duration < 1 || options.duration > 300) throw new Error('Sizes must be 10..1000000; duration must be 1..300 seconds.');
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(3).toString('hex')}`;
const directory = resolve(root, 'work/scale', runId);
await mkdir(directory, { recursive: true });
const productionFile = resolve(root, 'dist/loginflare_local/index.js');
const sourceFiles = await readdir(join(root, 'src/server'), { recursive: true });
const latestSource = Math.max(...await Promise.all(sourceFiles.filter((file) => file.endsWith('.ts')).map(async (file) => (await stat(join(root, 'src/server', file))).mtimeMs)));
if ((await stat(productionFile)).mtimeMs < latestSource) throw new Error('Build bundle is older than server sources. Run pnpm build before test:scale.');
const require = createRequire(import.meta.url);
// Match the runtime already used by Worker integration tests. The separately
// pinned legacy Miniflare dependency cannot run this project's compatibility date.
const runtimeRequire = createRequire(await realpath(resolve(root, 'node_modules/@cloudflare/vitest-plugin/package.json')));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = runtimeRequire('miniflare');
const viteRequire = createRequire(require.resolve('vite/package.json'));
const { rolldown } = await import(pathToFileURL(viteRequire.resolve('rolldown')).href);
const bridgeDirectory = join(directory, 'bridge');
await mkdir(bridgeDirectory);
const build = await rolldown({
    input: join(root, 'scripts/scale-worker.ts'),
    external: (id) => id === 'loginflare:production' || id.startsWith('node:') || id.startsWith('cloudflare:'),
});
await build.write({ dir: bridgeDirectory, format: 'esm', entryFileNames: 'scale-worker.js' });
await build.close();
const bridgeFile = join(bridgeDirectory, 'scale-worker.js');
await writeFile(bridgeFile, (await readFile(bridgeFile, 'utf8')).replaceAll('loginflare:production', relative(bridgeDirectory, productionFile).replaceAll('\\', '/')));
const productionModules = (await readdir(dirname(productionFile), { recursive: true })).filter((file) => file.endsWith('.js'))
    .map((file) => ({ type: 'ESModule', path: join(dirname(productionFile), file) }));

const origin = 'http://localhost:5173';
const callback = 'https://scale-client.example.test/callback';
const fixturePassword = `Scale-only-${randomBytes(16).toString('base64url')}!1`;
const sharedHash = await hashPassword(fixturePassword);
const secret = `scale-fixture-only-${randomBytes(32).toString('base64url')}`;
const accessKey = randomBytes(32).toString('base64url');
const databaseId = '00000000-0000-4000-8000-000000000001';
const report = {
    runId, startedAt: new Date().toISOString(), configuration: options,
    hardware: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalProcessors: cpus().length, totalMemoryBytes: totalmem(), availableMemoryBytes: freemem(), node: process.version, miniflare: runtimeRequire('miniflare/package.json').version },
    productionBundle: { path: relative(root, productionFile), sha256: createHash('sha256').update(await readFile(productionFile)).digest('hex') },
    methodology: {
        environment: 'Isolated local Miniflare/workerd + SQLite; no staging or production bindings.',
        timing: 'Closed-loop requests per lane; reported latency includes dispatch, test SQL instrumentation and JSON decoding. No external network latency.',
        concurrency: [1, 10, 50], durationSecondsPerMixedStage: options.duration,
        workload: 'Deterministic round-robin mixed workload. Each lane visits all nine operations. Per-operation throughput is its contribution within the mixed stage, not isolated maximum throughput.',
        logging: 'The local test bridge suppresses production console.log to avoid terminal I/O dominating local timings; production source and deployed logging are unchanged.',
        rowsRead: 'unavailable: local Miniflare does not expose authoritative billed D1 rows_read; no bill or SLA estimate is derived.',
        rateLimits: 'Production HTTP requests use distinct synthetic trusted CF IPs to avoid saturating one-IP policy. The atomic limiter microbenchmark uses the actual helper with a high test-only maximum.',
        refresh: 'Native authorize/consent/PKCE exchange setup; one rotating refresh token per concurrent lane, never shared between lanes.',
        seed: 'One shared local-only Better Auth hash; native migrations, indexes and triggers remain enabled. Bulk seed is performed only with Miniflare closed.',
        permissions: 'The test bridge requires a random run key and exists only under work/scale. It is not built into production.',
    }, sizes: [], outbound: { captchaStubbed: 0, blocked: 0 },
};

function assertIsolated(path) {
    if (!resolve(path).startsWith(`${directory}${sep}`)) throw new Error('Refusing storage outside this isolated scale run.');
}
async function findSqlite(path) {
    const files = await readdir(path, { recursive: true });
    for (const file of files.filter((file) => file.endsWith('.sqlite'))) {
        const candidate = join(path, file);
        const database = new DatabaseSync(candidate, { readOnly: true });
        try { if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name = '__scaleBootstrap'").get()) return candidate; }
        finally { database.close(); }
    }
    throw new Error('Could not identify the isolated Miniflare D1 database.');
}
function miniflare(state, authenticationSecret = secret) {
    assertIsolated(state);
    return new Miniflare(convertV4MiniflareOptions({
        name: 'loginflare-isolated-scale', modules: [{ type: 'ESModule', path: bridgeFile }, ...productionModules], modulesRoot: root,
        compatibilityDate: '2026-10-26', compatibilityFlags: ['nodejs_compat'],
        host: '127.0.0.1', port: 0, log: new Log(LogLevel.NONE),
        d1Databases: { DB: databaseId }, resourcePersistencePath: state,
        bindings: { APP_ENV: 'development', AUTH_URL: origin, EMAIL_FROM: 'scale@example.test', TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', BETTER_AUTH_SECRET: authenticationSecret, SCALE_ACCESS_KEY: accessKey },
        outboundService: async (request) => {
            if (request.url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify' && request.method === 'POST') {
                report.outbound.captchaStubbed++;
                return Response.json({ success: true });
            }
            report.outbound.blocked++;
            throw new Error('Scale tests prohibit outbound network requests.');
        },
    }));
}
const userId = (index) => `scale-u-${String(index).padStart(9, '0')}`;
const clientId = (index) => `scale-c-${String(index).padStart(6, '0')}`;
function seed(path, size) {
    assertIsolated(path);
    const started = performance.now();
    const database = new DatabaseSync(path);
    try {
        database.exec('DROP TABLE __scaleBootstrap; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL');
        for (const file of require('node:fs').readdirSync(join(root, 'migrations')).filter((file) => file.endsWith('.sql')).sort()) database.exec(require('node:fs').readFileSync(join(root, 'migrations', file), 'utf8'));
        const insertUser = database.prepare('INSERT INTO "user" (id,name,username,email,emailVerified,createdAt,updatedAt,role,banned,locale) VALUES (?,?,?,?,?,?,?,?,?,?)');
        const insertAccount = database.prepare('INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)');
        const insertEmail = database.prepare('INSERT INTO userEmail (id,userId,email,verified,createdAt) VALUES (?,?,?,?,?)');
        const insertSession = database.prepare('INSERT INTO session (id,token,userId,createdAt,updatedAt,expiresAt,ipAddress,userAgent) VALUES (?,?,?,?,?,?,?,?)');
        const insertClient = database.prepare('INSERT INTO oauthClient (id,clientId,name,referenceId,redirectUris,postLogoutRedirectUris,metadata,tokenEndpointAuthMethod,disabled,scopes,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
        const insertRefresh = database.prepare('INSERT INTO oauthRefreshToken (id,token,clientId,sessionId,userId,authorizationCodeId,scopes,createdAt,expiresAt,rotatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)');
        const insertAccess = database.prepare('INSERT INTO oauthAccessToken (id,token,clientId,sessionId,userId,authorizationCodeId,refreshId,scopes,createdAt,expiresAt) VALUES (?,?,?,?,?,?,?,?,?,?)');
        const now = Date.now();
        const current = new Date(now).toISOString();
        const live = new Date(now + 7 * 86_400_000).toISOString();
        const expired = new Date(now - 2 * 86_400_000).toISOString();
        const appCount = Math.max(10, Math.min(10_000, Math.ceil(size / 100)));
        database.exec('BEGIN');
        for (let index = 0; index < appCount; index++) {
            const host = `https://scale-${index}.example.test`;
            insertClient.run(clientId(index), clientId(index), `Scale application ${index}`, 'loginflare', JSON.stringify([`${host}/callback`]), JSON.stringify([`${host}/signed-out`]), JSON.stringify({ loginflareRedirectOrigins: [host] }), index % 2 ? 'none' : 'client_secret_basic', index % 10 === 9 ? 1 : 0, '["openid","profile","email","offline_access"]', current, current);
        }
        for (let index = 0; index < size; index++) {
            const id = userId(index);
            const created = new Date(now - 3_600_000 - index * 1000).toISOString();
            insertUser.run(id, `Scale person ${index}`, `scale_${index}`, `scale-${index}@example.test`, index === 0 || index % 10 !== 0 ? 1 : 0, created, created, index === 0 ? 'admin' : 'user', index !== 0 && index % 25 === 0 ? 1 : 0, index % 2 ? 'en-US' : 'zh-CN');
            insertAccount.run(`credential-${id}`, id, 'credential', id, sharedHash, created, created);
            if (index % 4 === 0) insertEmail.run(`auxiliary-${id}`, id, `backup-${index}@example.test`, index % 8 === 0 ? 1 : 0, now);
            if (index === 0 || index % 5 === 1) insertSession.run(`session-${id}`, `fixture-token-${id}`, id, current, current, live, '192.0.2.10', 'Scale fixture');
            if (index % 20 === 0) insertSession.run(`expired-${id}`, `expired-token-${id}`, id, expired, expired, expired, '192.0.2.10', 'Expired scale fixture');
            if (index % 20 === 1) {
                const grant = `grant-${id}`;
                const client = clientId(index % appCount);
                for (let rotation = 0; rotation < 5; rotation++) insertRefresh.run(`refresh-${id}-${rotation}`, `fixture-refresh-token-${id}-${rotation}`, client, `session-${id}`, id, grant, 'openid profile email offline_access', current, rotation < 4 ? expired : live, rotation < 4 ? current : null);
                insertAccess.run(`access-${id}`, `fixture-access-token-${id}`, client, `session-${id}`, id, grant, `refresh-${id}-4`, 'openid profile email', current, live);
            }
            if ((index + 1) % 10_000 === 0) { database.exec('COMMIT; BEGIN'); if ((index + 1) % 100_000 === 0) console.log(`scale seed: ${index + 1}/${size}`); }
        }
        for (let index = 0; index < Math.min(250, Math.max(3, Math.ceil(size / 1000))); index++) insertSession.run(`admin-device-${index}`, `fixture-admin-token-${index}`, userId(0), current, current, live, '192.0.2.11', 'Scale administrator device');
        database.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
        const counts = Object.fromEntries(['user', 'userEmail', 'account', 'session', 'oauthClient', 'oauthGrantPolicy', 'oauthAccessToken', 'oauthRefreshToken'].map((table) => [table, database.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count]));
        const planQueries = {
            userFirst: 'SELECT id FROM user ORDER BY createdAt DESC,id DESC LIMIT 21',
            userSeek: `SELECT id FROM user WHERE (createdAt,id) < ('${current}','scale-u-000750000') ORDER BY createdAt DESC,id DESC LIMIT 21`,
            userLookup: "SELECT id FROM user WHERE email = 'scale-1@example.test'",
            session: "SELECT id FROM session WHERE token = 'fixture-token-scale-u-000000000'",
            origin: "SELECT 1 FROM oauthClientUri u JOIN oauthClient c ON c.clientId=u.clientId WHERE u.kind='redirect-origin' AND u.value='https://scale-1.example.test' AND c.tokenEndpointAuthMethod='none' AND COALESCE(c.disabled,0)=0 LIMIT 1",
        };
        const plans = Object.fromEntries(Object.entries(planQueries).map(([name, sql]) => [name, database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()]));
        if (database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Seed foreign-key check failed.');
        return { counts, plans, elapsedSeconds: (performance.now() - started) / 1000, nativeDates: 'ISO UTC milliseconds', sharedPasswordHash: true };
    } finally { database.close(); }
}

function percentile(values, fraction) { return values.length ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))] : null; }
function summarize(samples, errors, elapsed, sql, statuses) {
    samples.sort((a, b) => a - b);
    return { requests: samples.length, errors, elapsedSeconds: elapsed / 1000, throughputPerSecond: samples.length / (elapsed / 1000), latencyMs: { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), p99: percentile(samples, 0.99) }, sqlStatements: { total: sql, perRequest: samples.length ? sql / samples.length : null }, statuses };
}
async function save() {
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
    const lines = ['# Local scale benchmark', '', `Run: ${runId}`, '', 'Local Miniflare/SQLite results only; not a Cloudflare latency SLA or billed-read estimate.', '', 'Deterministic round-robin mixed workload; operation requests/s are contributions within the mixed stage, not isolated maximum throughputs.', '', `Node: ${report.hardware.node}; CPU: ${report.hardware.cpu}; logical CPUs: ${report.hardware.logicalProcessors}; RAM: ${(report.hardware.totalMemoryBytes / 2 ** 30).toFixed(1)} GiB.`, '', '| Users | Operation | Concurrency | Mixed requests/s | p50 ms | p95 ms | p99 ms | Errors | SQL/request |', '|---:|---|---:|---:|---:|---:|---:|---:|---:|'];
    for (const size of report.sizes) for (const row of size.operations ?? []) lines.push(`| ${size.users} | ${row.operation} | ${row.concurrency} | ${row.throughputPerSecond.toFixed(2)} | ${row.latencyMs.p50?.toFixed(2)} | ${row.latencyMs.p95?.toFixed(2)} | ${row.latencyMs.p99?.toFixed(2)} | ${row.errors} | ${row.sqlStatements.perRequest?.toFixed(2)} |`);
    lines.push('', 'See report.json for fixture counts, query plans, database sizes, maintenance, snapshot restoration and methodology.', '', `D1 billed rows_read: **unavailable**. Outbound requests blocked: ${report.outbound.blocked}.`);
    if (report.failure) lines.push('', `Run failed: ${report.failure}`);
    await writeFile(join(directory, 'report.md'), lines.join('\n'));
}

try {
    for (const size of options.sizes) {
        const sizeDirectory = join(directory, `users-${size}`);
        await mkdir(sizeDirectory);
        const state = join(sizeDirectory, '.cloudflare/state/v3/d1');
        await writeFile(join(sizeDirectory, 'wrangler.jsonc'), JSON.stringify({ vars: { APP_ENV: 'development', AUTH_URL: origin }, d1_databases: [{ binding: 'DB', database_id: databaseId, remote: false }] }));
        await writeFile(join(sizeDirectory, '.dev.vars'), `BETTER_AUTH_SECRET=${secret}\n`, { mode: 0o600 });
        let mf = miniflare(state);
        let sequence = 0;
        try {
            const binding = await mf.getD1Database('DB');
            await binding.exec('CREATE TABLE __scaleBootstrap (id INTEGER)');
            await mf.dispose();
            const databaseFile = await findSqlite(state);
            const fixture = seed(databaseFile, size);
            const result = { users: size, fixture, databaseBytes: (await stat(databaseFile)).size, operations: [] };
            report.sizes.push(result);
            mf = miniflare(state);
            const send = async (path, { method = 'GET', body, cookie, form, headers = {} } = {}) => {
                const id = sequence++;
                return mf.dispatchFetch(new URL(path, origin), {
                    method, redirect: 'manual', headers: { Origin: origin, 'x-scale-key': accessKey, 'CF-Connecting-IP': `198.18.${Math.floor(id / 250) % 250}.${id % 250 + 1}`, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers },
                    body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
                });
            };
            const checked = async (path, options = {}) => {
                const response = await send(path, options);
                if (!response.ok && response.status !== 302) throw new Error(`Scale setup request ${path.split('?')[0]} returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
                return response;
            };
            const signedIn = await checked('/api/auth/sign-in/email', { method: 'POST', body: { email: 'scale-0@example.test', password: fixturePassword }, headers: { 'x-captcha-response': 'isolated-scale-test-token' } });
            const cookie = signedIn.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
            await signedIn.arrayBuffer();
            const created = await (await checked('/api/admin/applications', { method: 'POST', cookie, body: { name: 'Scale native refresh client', type: 'spa', redirectUris: [callback], postLogoutRedirectUris: ['https://scale-client.example.test/'], scopes: ['openid', 'profile', 'email', 'offline_access'] } })).json();
            const nativeClient = created.application.clientId;
            const redirect = async (response) => {
                const location = response.headers.get('location');
                if (location) { await response.arrayBuffer(); return new URL(location, origin); }
                const body = await response.json();
                return new URL(body.url ?? body.redirect_uri, origin);
            };
            const refreshTokens = [];
            for (let lane = 0; lane < 50; lane++) {
                const verifier = randomBytes(32).toString('base64url');
                const query = new URLSearchParams({ client_id: nativeClient, redirect_uri: callback, response_type: 'code', scope: 'openid profile email offline_access', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: `scale-lane-${lane}`, nonce: `scale-nonce-${lane}` });
                let location = await redirect(await checked(`/api/auth/oauth2/authorize?${query}`, { cookie }));
                if (location.origin === origin && location.pathname.endsWith('/consent')) location = await redirect(await checked('/api/auth/oauth2/consent', { method: 'POST', cookie, body: { accept: true, oauth_query: location.search.slice(1) } }));
                const code = location.searchParams.get('code');
                if (location.origin !== new URL(callback).origin || !code) throw new Error('Native authorization did not issue the expected code.');
                const token = await (await checked('/api/auth/oauth2/token', { method: 'POST', headers: { Origin: new URL(callback).origin }, form: { grant_type: 'authorization_code', client_id: nativeClient, redirect_uri: callback, code, code_verifier: verifier } })).json();
                if (!token.refresh_token) throw new Error('Native grant has no refresh token.');
                refreshTokens.push(token.refresh_token);
            }
            const anchor = userId(Math.max(0, Math.floor(size * 0.75) - 21));
            const deep = await (await checked(`/__scale/deep-cursor?id=${anchor}`)).json();
            const userPath = deep.pageInfo.nextCursor ? `/api/admin/users?cursor=${encodeURIComponent(deep.pageInfo.nextCursor)}` : '/api/admin/users';
            result.deepSeek = { cursorAvailable: !!deep.pageInfo.nextCursor, note: deep.pageInfo.nextCursor ? 'Signed seek cursor prepared near the 75% fixture boundary; no OFFSET query or HTTP page walk.' : 'The dataset fits on one page; this operation repeats the first page.' };
            const operations = {
                userFirst: () => send('/api/admin/users', { cookie }),
                userDeepSeek: () => send(userPath, { cookie }),
                userExactLookup: () => send('/api/admin/users?lookupField=email&lookupValue=scale-1%40example.test', { cookie }),
                sessionValidation: () => send('/api/auth/get-session', { cookie }),
                sessionList: () => send('/api/account/sessions', { cookie }),
                applicationList: () => send('/api/admin/applications', { cookie }),
                applicationOrigin: () => send('/api/auth/oauth2/token', { method: 'OPTIONS', headers: { Origin: 'https://scale-1.example.test', 'Access-Control-Request-Method': 'POST' } }),
                atomicRateLimit: (lane) => send(`/__scale/rate?lane=${lane}`),
                refreshProtocol: (lane) => send('/api/auth/oauth2/token', { method: 'POST', headers: { Origin: new URL(callback).origin }, form: { grant_type: 'refresh_token', client_id: nativeClient, refresh_token: refreshTokens[lane] } }),
            };
            const operationNames = Object.keys(operations);
            const invoke = async (operation, lane) => {
                const response = await operations[operation](lane);
                const sql = Number(response.headers.get('x-scale-sql-count') ?? 0);
                const body = response.status === 204 ? (await response.arrayBuffer(), null) : await response.json();
                let valid = response.ok;
                if (['userFirst', 'userDeepSeek', 'userExactLookup', 'sessionList', 'applicationList'].includes(operation)) valid &&= Array.isArray(body?.items) && body.items.length <= 20;
                if (operation === 'userExactLookup') valid &&= body?.items?.length === 1;
                if (operation === 'sessionValidation') valid &&= body?.user?.id === userId(0);
                if (operation === 'atomicRateLimit') valid &&= body?.allowed === true;
                if (operation === 'refreshProtocol') {
                    valid &&= typeof body?.refresh_token === 'string';
                    if (valid) refreshTokens[lane] = body.refresh_token;
                }
                return { status: response.status, valid, sql };
            };
            for (const operation of operationNames) {
                const probe = await invoke(operation, 0);
                if (!probe.valid) throw new Error(`Correctness/warmup probe failed: ${operation} (${probe.status}).`);
            }
            result.correctnessProbes = { operations: operationNames, passed: true };
            result.stages = [];
            for (const concurrency of [1, 10, 50]) {
                const started = performance.now();
                const counters = Object.fromEntries(operationNames.map((name) => [name, { samples: [], errors: 0, sql: 0, statuses: {} }]));
                await Promise.all(Array.from({ length: concurrency }, async (_, lane) => {
                    let iteration = lane;
                    while (performance.now() - started < options.duration * 1000) {
                        const operation = operationNames[iteration++ % operationNames.length];
                        const counter = counters[operation];
                        const before = performance.now();
                        try {
                            const response = await invoke(operation, lane);
                            counter.sql += response.sql;
                            counter.statuses[response.status] = (counter.statuses[response.status] ?? 0) + 1;
                            if (!response.valid) counter.errors++;
                        } catch { counter.errors++; counter.statuses.transportError = (counter.statuses.transportError ?? 0) + 1; }
                        counter.samples.push(performance.now() - before);
                    }
                }));
                const elapsed = performance.now() - started;
                for (const [operation, counter] of Object.entries(counters)) result.operations.push({ operation, concurrency, ...summarize(counter.samples, counter.errors, elapsed, counter.sql, counter.statuses) });
                const requests = Object.values(counters).reduce((sum, counter) => sum + counter.samples.length, 0);
                const errors = Object.values(counters).reduce((sum, counter) => sum + counter.errors, 0);
                result.stages.push({ concurrency, elapsedSeconds: elapsed / 1000, requests, errors, throughputPerSecond: requests / (elapsed / 1000) });
                console.log(`scale ${size}: mixed c=${concurrency} requests=${requests} errors=${errors}`);
                await save();
                if (errors) throw new Error(`Mixed workload failed at ${size} users / concurrency ${concurrency}: ${errors} invalid or failed request(s).`);
            }
            result.maintenance = await (await checked('/__scale/maintenance')).json();
            const stillSignedIn = await (await checked('/api/auth/get-session', { cookie })).json();
            if (!stillSignedIn?.user) throw new Error('Maintenance invalidated the active benchmark session.');
            const refreshed = await (await checked('/api/auth/oauth2/token', { method: 'POST', headers: { Origin: new URL(callback).origin }, form: { grant_type: 'refresh_token', client_id: nativeClient, refresh_token: refreshTokens[0] } })).json();
            if (!refreshed.refresh_token) throw new Error('Maintenance invalidated the live OAuth grant.');
            refreshTokens[0] = refreshed.refresh_token;
            result.maintenance.liveSessionAndGrantPreserved = true;
            await mf.dispose();
            const snapshot = await snapshotLocal(sizeDirectory, join(sizeDirectory, 'snapshot'));
            const manifest = JSON.parse(await readFile(join(snapshot.destination, 'manifest.json'), 'utf8'));
            const restored = join(sizeDirectory, 'restored');
            for (const file of manifest.files) {
                const target = join(restored, file);
                await mkdir(dirname(target), { recursive: true });
                await copyFile(join(snapshot.destination, file), target);
            }
            const databaseRelative = relative(state, databaseFile).replaceAll('\\', '/');
            const restoredDatabase = new DatabaseSync(join(restored, 'd1', databaseRelative), { readOnly: true });
            try {
                const integrity = restoredDatabase.prepare('PRAGMA integrity_check').get().integrity_check;
                const users = restoredDatabase.prepare('SELECT count(*) AS count FROM user').get().count;
                const foreignKeys = restoredDatabase.prepare('PRAGMA foreign_key_check').all().length;
                if (integrity !== 'ok' || users !== size || foreignKeys) throw new Error('Independent snapshot restore failed.');
                const secretMatched = (await readFile(join(restored, '.dev.vars'), 'utf8')) === (await readFile(join(sizeDirectory, '.dev.vars'), 'utf8'));
                if (!secretMatched) throw new Error('Restored local authentication secret differs from the snapshot source.');
                result.restore = { integrity, users, foreignKeys, secretMatched };
            } finally { restoredDatabase.close(); }
            const restoredSecret = /^BETTER_AUTH_SECRET=(.+)$/m.exec(await readFile(join(restored, '.dev.vars'), 'utf8'))?.[1];
            if (!restoredSecret) throw new Error('Restored local authentication secret is missing.');
            mf = miniflare(join(restored, 'd1'), restoredSecret);
            const restoredIdentity = await (await checked('/api/auth/get-session', { cookie })).json();
            if (restoredIdentity?.user?.id !== userId(0) || restoredIdentity?.session?.id !== stillSignedIn.session.id) throw new Error('Restored database did not accept the original signed session cookie.');
            const restoredTokens = await (await checked('/api/auth/oauth2/token', { method: 'POST', headers: { Origin: new URL(callback).origin }, form: { grant_type: 'refresh_token', client_id: nativeClient, refresh_token: refreshTokens[0] } })).json();
            if (!restoredTokens.refresh_token || restoredTokens.refresh_token === refreshTokens[0]) throw new Error('Restored database did not rotate the saved native refresh token.');
            result.restore.restoredAuth = true;
            result.restore.refreshRotated = true;
            result.databaseBytesAfter = (await stat(databaseFile)).size;
            await save();
        } finally { await mf.dispose(); }
    }
    report.completedAt = new Date().toISOString();
} catch (error) {
    report.failure = error.message;
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await save();
    console.log(`Scale report: ${join(directory, 'report.md')}`);
}
