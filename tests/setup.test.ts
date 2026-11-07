import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/server/index';
import type { Env } from '../src/server/config';
import { advanceInstallation, instanceEnv, readInstallation } from '../src/server/setup';
import { SetupCloudflare } from '../src/server/setup-cloudflare';
import { cookies } from './helpers';

const canonical = 'https://auth.example.test';
const progress = 'https://instance.account.workers.dev';
const accountId = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);
const version = crypto.randomUUID();
const adminEmail = 'owner@example.test';
const password = 'Example test password only';

beforeEach(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

function fixture() {
    const messages: { to: string; text: string }[] = [];
    const deployment: Env = {
        ...env, APP_ENV: 'production', LOGINFLARE_ACCOUNT_ID: accountId, LOGINFLARE_WORKER_NAME: 'instance',
        CF_VERSION_METADATA: { id: version, tag: 'fixture', timestamp: new Date().toISOString() }, CF_SETUP_TOKEN: 'isolated-test-token',
        SETUP_ORIGIN: 'auth.example.test', SETUP_ADMIN_EMAIL: adminEmail,
        EMAIL: { send: vi.fn(async (message) => { messages.push(message); return { messageId: 'fixture' }; }) } as Env['EMAIL'],
    };
    const domains: { hostname: string; service: string }[] = [];
    const secrets = ['CF_SETUP_TOKEN', 'SETUP_ORIGIN', 'SETUP_ADMIN_EMAIL', 'UNRELATED'];
    const patches: unknown[] = [];
    const dns: { type: string; name: string; content: string; id: string; priority?: number }[] = [];
    const expected = [
        { type: 'MX', name: 'bounce.notify.example.test', content: 'route1.mx.cloudflare.net.', priority: 10 },
        { type: 'MX', name: 'bounce.notify.example.test', content: 'route2.mx.cloudflare.net.', priority: 20 },
        { type: 'MX', name: 'bounce.notify.example.test', content: 'route3.mx.cloudflare.net.', priority: 30 },
        { type: 'TXT', name: 'key.notify.example.test', content: 'v=DKIM1;p=testing' },
    ];
    let widgets = 0;
    const api = new SetupCloudflare(deployment.CF_SETUP_TOKEN!, async (url, init) => {
        const { pathname: path, searchParams } = new URL(String(url));
        const method = init?.method;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const ok = (result: unknown) => Response.json({ success: true, result });
        if (path.endsWith('/tokens/verify')) return ok({ status: 'active' });
        if (path.endsWith('/versions/' + version)) return ok({ id: version });
        if (path.endsWith('/zones')) return ok([{ id: zoneId, name: 'example.test', status: 'active', account: { id: accountId } }]);
        if (path.endsWith('/workers/domains') && method === 'GET') return ok(domains);
        if (path.endsWith('/workers/domains') && method === 'PUT') { domains.push(body); return ok(body); }
        if (path.endsWith('/email/sending/subdomains')) return ok([{ name: 'notify.example.test', tag: 'mail-tag', enabled: dns.length >= expected.length }]);
        if (path.endsWith('/mail-tag/dns')) return ok(expected);
        if (path.endsWith('/dns_records') && method === 'GET') return ok(dns.filter(({ name }) => name === searchParams.get('name')));
        if (path.endsWith('/dns_records') && method === 'POST') {
            dns.push({ ...body, id: crypto.randomUUID(),
                content: body.type === 'MX' ? body.content.replace(/\.$/, '') : '"v=DKIM1;" "p=testing"' });
            return ok(body);
        }
        if (path.endsWith('/challenges/widgets') && method === 'GET') return ok([]);
        if (path.endsWith('/challenges/widgets') && method === 'POST') {
            widgets++;
            return ok({ sitekey: 'isolated-site-key', secret: 'isolated-site-secret' });
        }
        if (path.endsWith('/secrets')) return ok(secrets.map((name) => ({ name, type: 'secret_text' })));
        if (path.endsWith('/secrets-bulk')) {
            patches.push(body);
            for (const name of Object.keys(body.secrets)) secrets.splice(secrets.indexOf(name), 1);
            return ok({});
        }
        throw new Error(`Unexpected test request: ${method} ${path}`);
    });
    const advance = () => advanceInstallation(deployment, api);
    const initialize = async () => {
        await env.DB.prepare('CREATE TABLE lfReleaseLock (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expiresAt INTEGER NOT NULL)').run();
        await Promise.all([advance(), advance()]);
        for (let i = 0; i < 8 && (await readInstallation(env.DB))?.step !== 'ready'; i++) {
            await env.DB.prepare('UPDATE lfInstallation SET retryAt = 0').run();
            await advance();
        }
        expect((await readInstallation(env.DB))?.step).toBe('ready');
    };
    const request = (path: string, body?: object, origin = canonical, runtime = deployment, headers: Record<string, string> = {}) => worker.fetch(new Request(origin + path, {
        method: body ? 'POST' : 'GET',
        headers: { ...(body ? { Origin: origin, 'Content-Type': 'application/json', 'x-captcha-response': 'test-solution' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
    }), runtime, createExecutionContext());
    const invite = async () => {
        expect((await request('/api/setup/invite', { locale: 'en-US' })).status).toBe(202);
        const token = messages.at(-1)?.text.match(/#([0-9a-f]{64})/)?.[1];
        expect(token).toHaveLength(64);
        return token!;
    };
    return { deployment, request, invite, advance, initialize, dns, messages, secrets, patches, widgetCount: () => widgets };
}

it('continues setup across Worker builds, creates one key, and removes only the installation secrets', async () => {
    const f = fixture();
    await f.initialize();
    expect(f.widgetCount()).toBe(1);
    const initial = await readInstallation(env.DB);
    expect(initial?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    await Promise.all([f.advance(), f.advance()]);
    expect(f.patches).toEqual([{ secrets: { CF_SETUP_TOKEN: null, SETUP_ORIGIN: null, SETUP_ADMIN_EMAIL: null } }]);
    expect(f.secrets).toEqual(['UNRELATED']);
    const rebuilt = { ...f.deployment, CF_SETUP_TOKEN: undefined, SETUP_ORIGIN: undefined, SETUP_ADMIN_EMAIL: undefined, LOGINFLARE_BUILD_ID: 'new-build' };
    expect((await f.request('/api/health', undefined, canonical, rebuilt)).status).toBe(503);
    expect((await f.request('/', undefined, progress, rebuilt)).headers.get('Location')).toBe(canonical + '/setup');
    expect((await instanceEnv(rebuilt, initial!)).BETTER_AUTH_SECRET).toBe((await instanceEnv(f.deployment, initial!)).BETTER_AUTH_SECRET);
    expect((await f.request('/api/setup/status', undefined, progress, rebuilt)).status).toBe(200);
    expect((await f.request('/api/maintenance/status')).status).toBe(404);
});

it('reports a conflicting DNS record without overwriting it', async () => {
    const f = fixture();
    f.dns.push({ id: 'record-a', type: 'CNAME', name: 'auth.example.test', content: 'unrelated.example.test' });
    await f.advance();
    await f.advance();
    const response = await f.request('/api/setup/status', undefined, progress);
    expect(await response.json()).toMatchObject({ step: 'domain', error: 'DNS_CONFLICT', detail: 'CNAME auth.example.test (record-a)' });
    expect(f.dns).toHaveLength(1);
    expect(f.widgetCount()).toBe(0);
});

it('accepts the expected MX siblings but stops on an unexpected mail exchanger', async () => {
    const f = fixture();
    const name = 'bounce.notify.example.test';
    f.dns.push(
        { id: 'expected', type: 'MX', name, content: 'route1.mx.cloudflare.net', priority: 10 },
        { id: 'unexpected', type: 'MX', name, content: 'mx.other.example.test', priority: 10 },
    );
    await f.advance();
    await f.advance();
    await f.advance();
    const response = await f.request('/api/setup/status', undefined, progress);
    expect(await response.json()).toMatchObject({ step: 'sending', error: 'DNS_CONFLICT', detail: `MX ${name} (unexpected)` });
    expect(f.dns).toHaveLength(2);
});

it('sends only to the deployment mailbox, then atomically creates a sign-in capable administrator once', async () => {
    const f = fixture();
    await f.initialize();
    expect((await f.request('/api/setup/invite', { email: 'attacker@example.test' })).status).toBe(400);
    expect((await f.request('/api/setup/invite', {}, progress)).status).toBe(404);
    expect((await f.request('/api/auth/.well-known/openid-configuration')).status).toBe(503);
    expect((await f.request('/api/auth/oauth2/authorize')).status).toBe(503);
    expect((await f.request('/api/auth/sign-up/email', { email: adminEmail, password })).status).toBe(503);
    const token = await f.invite();
    await f.invite();
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]?.to).toBe(adminEmail);
    const before = await readInstallation(env.DB);
    expect(before?.invitationHash).not.toBe(token);
    expect(await env.DB.prepare('SELECT count(*) AS count FROM "user"').first('count')).toBe(0);

    await env.DB.prepare(`CREATE TRIGGER reject_setup_account BEFORE INSERT ON account
        BEGIN SELECT RAISE(ABORT, 'TEST_ROLLBACK'); END`).run();
    const input = { token, username: 'First_Admin', password };
    expect((await f.request('/api/setup/claim', input)).status).toBe(503);
    expect((await readInstallation(env.DB))?.invitationHash).toBe(before?.invitationHash);
    expect(await env.DB.prepare('SELECT count(*) AS count FROM "user"').first('count')).toBe(0);
    await env.DB.prepare('DROP TRIGGER reject_setup_account').run();
    const outcomes = await Promise.all([f.request('/api/setup/claim', input), f.request('/api/setup/claim', input)]);
    expect(outcomes.filter(({ ok }) => ok)).toHaveLength(1);
    expect(await env.DB.prepare('SELECT username, email, emailVerified, role FROM "user"').all()).toMatchObject({
        results: [{ username: 'first_admin', email: adminEmail, emailVerified: 1, role: 'admin' }],
    });
    expect((await readInstallation(env.DB))?.invitationHash).toBeNull();
    expect((await f.request('/api/setup/invite', {})).status).toBe(404);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        expect(new URL(input instanceof Request ? input.url : String(input)).origin).toBe('https://challenges.cloudflare.com');
        return Response.json({ success: true });
    });
    const firstFlow = await f.request('/api/browser/auth-flows', { kind: 'login', locale: 'en-US' }, canonical, f.deployment, { Cookie: 'site_preference=dark; __Secure-loginflare.browser=stale.invalid; language=en-US' });
    expect(firstFlow.status, await firstFlow.clone().text()).toBe(200);
    expect(firstFlow.headers.getSetCookie().some((cookie) => cookie.startsWith('__Secure-loginflare.browser=') && cookie.includes('Secure'))).toBe(true);
    const signedIn = await f.request('/api/auth/sign-in/email', { email: adminEmail, password }, canonical, f.deployment, { Cookie: 'site_preference=dark; __Secure-loginflare.browser=stale.invalid' });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const signedInHeaders = { Cookie: cookies(signedIn) };
    const signedOut = await f.request('/api/auth/sign-out', {}, canonical, f.deployment, signedInHeaders);
    expect(signedOut.status, await signedOut.clone().text()).toBe(200);
    expect(await (await f.request('/api/auth/get-session', undefined, canonical, f.deployment, signedInHeaders)).json()).toBeNull();
    const signedInByUsername = await f.request('/api/auth/sign-in/username', { username: input.username, password, rememberMe: false });
    expect(signedInByUsername.status, await signedInByUsername.clone().text()).toBe(200);
    const session = await f.request('/api/auth/get-session', undefined, canonical, f.deployment, { Cookie: cookies(signedInByUsername) });
    expect(session.status, await session.clone().text()).toBe(200);
    expect(await session.json()).toMatchObject({ user: { username: 'first_admin' } });
    const discovery = await f.request('/api/auth/.well-known/openid-configuration');
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ issuer: canonical + '/api/auth' });
    expect((await f.request('/api/auth/.well-known/openid-configuration', undefined, progress)).status).toBe(503);
});

it('fails closed when a rebuilt Worker has no matching private material', async () => {
    const f = fixture();
    await f.initialize();
    const row = (await readInstallation(env.DB))!;
    const source = await f.deployment.PRIVATE!.get('installation.json');
    expect(source).toBeTruthy();
    await expect(instanceEnv({ ...f.deployment, PRIVATE: undefined }, row)).rejects.toThrow('INSTANCE_KEYS_MISSING');
    await f.deployment.PRIVATE!.put('installation.json', 'wrong data');
    await expect(instanceEnv(f.deployment, row)).rejects.toThrow('INSTANCE_KEYS_MISMATCH');
    expect(await f.deployment.PRIVATE!.get('installation.json').then((object) => object?.text())).toBe('wrong data');
});
