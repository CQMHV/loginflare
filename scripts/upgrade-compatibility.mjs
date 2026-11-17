import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildMigrationBundle } from './migration-bundle.mjs';
import { loadRelease } from './release-manifest.mjs';
import { release } from './releases.mjs';
import { verifyUpgradeSchema } from './upgrade-state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = resolve(root, 'work', 'upgrade-compatibility', randomUUID());
mkdirSync(run, { recursive: true });
function command(binary, args, cwd, extra = {}) {
    const result = spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, WORKERS_CI: '0', LOGINFLARE_CONFIG: 'wrangler.local.jsonc', WRANGLER_SEND_METRICS: 'false',
            WRANGLER_LOG_PATH: resolve(run, 'logs'), WRANGLER_REGISTRY_PATH: resolve(run, 'registry'), MINIFLARE_REGISTRY_PATH: resolve(run, 'registry') }, ...extra });
    if (result.error || result.status !== 0) throw new Error(`${binary} ${args[0]} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
    return result.stdout;
}
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, Response, convertV4MiniflareOptions } = await import(pathToFileURL(wranglerRequire.resolve('miniflare')).href);
const { manifest, bundle, online } = loadRelease(root);
const runtimeDependencies = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).dependencies;
const origin = 'https://auth.example.test', password = 'Upgrade-isolated-password-823!';
const target = { account: 'a'.repeat(32), name: 'compatibility', database: 'isolated-db', avatars: 'isolated-avatars', privateBucket: 'isolated-private' };
const results = [];

for (const baseline of manifest.upgradeFrom) {
    const checkout = resolve(run, baseline.id);
    mkdirSync(checkout);
    const archive = command('git', ['archive', baseline.commit], root, { encoding: null });
    command('tar', ['-xf', '-', '-C', checkout], root, { input: archive });
    const previousDependencies = JSON.parse(readFileSync(resolve(checkout, 'package.json'), 'utf8')).dependencies;
    for (const [name, version] of Object.entries(previousDependencies)) {
        assert.equal(runtimeDependencies[name], version, `Historical runtime dependency ${name} differs. Install its pinned dependency tree in isolation before claiming compatibility.`);
    }
    command(process.execPath, [resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', '--logLevel', 'warn'], checkout);
    const before = buildMigrationBundle(checkout);
    assert.equal(before.migrations.at(-1).name, baseline.through);
    const messages = [];
    const wrapper = resolve(checkout, 'worker.mjs');
    const writeWrapper = (workerRoot) => {
        const entry = relative(dirname(wrapper), resolve(workerRoot, 'index.js')).replaceAll('\\', '/');
        writeFileSync(wrapper, `import worker from ${JSON.stringify(entry.startsWith('.') ? entry : './' + entry)};
export default { fetch(request, env, ctx) { return worker.fetch(request, { ...env, EMAIL: { send(message) { return env.MAIL.fetch('http://mail.local/', {method:'POST',body:JSON.stringify(message)}).then(r => r.json()); } } }, ctx); } };`);
        return workerRoot;
    };
    const options = (workerRoot) => {
        writeWrapper(workerRoot);
        const files = readdirSync(workerRoot, { recursive: true }).filter((file) => file.endsWith('.js'));
        const config = convertV4MiniflareOptions({
            modules: [{ type: 'ESModule', path: wrapper }, ...files.map((file) => ({ type: 'ESModule', path: resolve(workerRoot, file) }))], modulesRoot: root,
            compatibilityDate: '2026-10-26', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
            d1Databases: { DB: 'isolated-db' }, r2Buckets: ['AVATARS', 'PRIVATE'],
            ratelimits: { REQUEST_LIMITER: { namespace_id: '1001', simple: { limit: 600, period: 60 } } },
            bindings: { APP_ENV: 'production', AUTH_URL: origin, EMAIL_FROM: 'no-reply@loginflare.test',
                LOGINFLARE_ACCOUNT_ID: target.account, LOGINFLARE_WORKER_NAME: target.name, LOGINFLARE_BUILD_ID: 'isolated-upgrade-build',
                TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
                BETTER_AUTH_SECRET: 'isolated-upgrade-test-secret-with-more-than-32-characters' },
            serviceBindings: { MAIL: async (request) => { messages.push(await request.json()); return Response.json({ messageId: randomUUID() }); } },
            async outboundService(request) {
                if (request.url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return Response.json({ success: true });
                if (request.url === origin + '/api/auth/jwks') return runtime.dispatchFetch(request);
                throw new Error('Upgrade compatibility tests disable outbound networking.');
            },
        });
        config.resourcePersistencePath = resolve(checkout, 'state/v3'); config.telemetry = { enabled: false };
        return config;
    };
    let runtime = new Miniflare(options(resolve(checkout, 'dist/loginflare_local')));
    try {
        const db = await runtime.getD1Database('DB');
        const query = (batch) => db.batch(batch.map(({ sql, params }) => db.prepare(sql).bind(...params)));
        const deploy = (migrations, approvals, extra = {}) => release({ query, target, migrations, online: approvals,
            isCurrent: async () => true, verify: async () => {}, publish: async () => {}, ...extra });
        await deploy(before.migrations, {});
        const material = JSON.stringify({ instanceId: randomUUID(), origin, emailFrom: 'noreply@notify.example.test',
            authSecret: 'a'.repeat(96), siteKey: 'isolated-site-key', turnstileSecret: 'isolated-site-secret' });
        const fingerprint = createHash('sha256').update(material).digest('hex');
        await (await runtime.getR2Bucket('PRIVATE')).put('installation.json', material);
        await db.prepare(`INSERT INTO lfInstallation (id, instanceId, origin, adminEmail, step, accountId, workerName, zoneId, zoneName, fingerprint, completedAt)
            VALUES (1, ?, ?, ?, 'ready', ?, ?, ?, 'example.test', ?, ?)`).bind(JSON.parse(material).instanceId, origin, 'owner@example.test', target.account, target.name, 'b'.repeat(32), fingerprint, Date.now()).run();
        const request = (path, { body, cookie, form, headers = {} } = {}) => runtime.dispatchFetch(new URL(path, origin), {
            method: body || form ? 'POST' : 'GET', redirect: 'manual',
            headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.123', 'x-captcha-response': 'isolated-upgrade-token',
                ...(cookie ? { Cookie: cookie } : {}), ...(body || form ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}), ...headers },
            body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
        });
        const ok = async (response, status = 200) => { assert.equal(response.status, status, await response.clone().text()); return response; };
        const cookies = (response) => response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
        const email = 'upgrade@example.test';
        await ok(await request('/api/auth/sign-up/email', { body: { name: 'Upgrade fixture', username: 'upgrade_fixture', email, password, callbackURL: origin + '/en-us/verified' } }));
        const verification = messages.at(-1)?.text.match(/https:\/\/auth\.example\.test\/api\/auth\/verify-email[^\s<>]*/)?.[0];
        assert.ok(verification, 'verification email captured locally');
        const verified = await request(verification);
        assert.ok([200, 302].includes(verified.status), await verified.text());
        let cookie = cookies(await ok(await request('/api/auth/sign-in/email', { body: { email, password } })));
        const identity = await (await ok(await request('/api/auth/get-session', { cookie }))).json();
        await db.prepare('UPDATE "user" SET role = ? WHERE email = ?').bind('admin', email).run();
        cookie = cookies(await ok(await request('/api/auth/sign-in/email', { body: { email, password } })));
        const callback = 'https://client.example.test/callback';
        const registration = await (await ok(await request('/api/admin/applications', { cookie, body: {
            name: 'Upgrade client', type: 'spa', redirectUris: [callback], postLogoutRedirectUris: ['https://client.example.test/'], scopes: ['openid', 'profile', 'email', 'offline_access'],
        } }), 201)).json();
        const oidc = async () => {
            const verifier = 'isolated-upgrade-pkce-verifier-with-more-than-43-characters';
            const params = new URLSearchParams({ client_id: registration.application.clientId, redirect_uri: callback, response_type: 'code', scope: 'openid profile email offline_access',
                code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: randomUUID(), nonce: randomUUID() });
            const location = async (response) => new URL(response.headers.get('Location') ?? (await response.json()).url, origin);
            let redirect = await location(await request('/api/auth/oauth2/authorize?' + params, { cookie }));
            if (redirect.pathname.endsWith('/consent')) redirect = await location(await ok(await request('/api/auth/oauth2/consent', { cookie, body: { accept: true, oauth_query: redirect.search.slice(1) } })));
            assert.equal(redirect.origin, new URL(callback).origin);
            const tokens = await (await ok(await request('/api/auth/oauth2/token', { headers: { Origin: new URL(callback).origin }, form: {
                grant_type: 'authorization_code', client_id: registration.application.clientId, redirect_uri: callback, code: redirect.searchParams.get('code'), code_verifier: verifier,
            } }))).json();
            assert.ok(tokens.id_token); assert.ok(tokens.refresh_token);
            const user = await (await ok(await request('/api/auth/oauth2/userinfo', { headers: { Authorization: 'Bearer ' + tokens.access_token } }))).json();
            assert.equal(user.sub, identity.user.id);
            const refreshed = await (await ok(await request('/api/auth/oauth2/token', { headers: { Origin: new URL(callback).origin }, form: {
                grant_type: 'refresh_token', client_id: registration.application.clientId, refresh_token: tokens.refresh_token,
            } }))).json();
            assert.ok(refreshed.access_token);
        };
        await oidc();
        // Gate approval evidence by executing the exact candidate digests, before committing approvals.
        const approvals = { ...online, ...Object.fromEntries(bundle.migrations.filter(({ name }) => name > baseline.through).map(({ name, hash }) => [name, hash])) };
        await deploy(bundle.migrations, approvals, { checkSchema: () => verifyUpgradeSchema(query, bundle) });
        await ok(await request('/api/auth/sign-in/email', { body: { email, password } }));
        assert.equal((await (await ok(await request('/api/auth/get-session', { cookie }))).json()).user.id, identity.user.id);
        await oidc();
        // Promote the new code against the same database; exercise retained sessions and issuer.
        await runtime.setOptions(options(resolve(root, 'dist/loginflare_local')));
        await ok(await request('/api/auth/sign-in/email', { body: { email, password } }));
        assert.equal((await (await ok(await request('/api/auth/get-session', { cookie }))).json()).user.id, identity.user.id);
        await oidc();
        assert.equal(await (await (await runtime.getR2Bucket('PRIVATE')).get('installation.json')).text(), material);
        await ok(await request('/api/readiness'));
        const discovery = await (await ok(await request('/api/auth/.well-known/openid-configuration'))).json();
        assert.equal(discovery.issuer, origin + '/api/auth');
        results.push({ baseline: baseline.id, source: baseline.commit, runtime: 'production-bindings-local-only', oldWorkerAfterMigration: 'passed', promotedWorker: 'passed', privateMaterial: 'unchanged', flows: ['password', 'retained-session', 'OIDC-PKCE', 'userinfo', 'refresh', 'readiness'] });
    } finally { await runtime.dispose(); }
}
writeFileSync(resolve(run, 'results.json'), JSON.stringify(results, null, 4) + '\n');
console.log(JSON.stringify({ result: 'passed', evidence: resolve(run, 'results.json'), scenarios: results }));
