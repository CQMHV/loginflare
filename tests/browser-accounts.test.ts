import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { harness, mailCode, mailUrl, origin, password } from './helpers';
import { authenticatorCode } from './totp';

interface Account {
    id: string;
    user: { id: string; email: string; name: string; role?: string | null };
    status: 'active' | 'signed-out';
}
interface Identity { user: Account['user']; session: { id: string }; browserAccountId?: string }
type FlowKind = 'login' | 'add' | 'reauth' | 'oauth';
type Client = ReturnType<typeof harness>;
let address = 0;

function browser(client: Client) {
    const jar = new Map<string, string>();
    async function request(path: string, options: {
        body?: Record<string, unknown>;
        method?: string;
        accountId?: string;
        flowId?: string;
        headers?: Record<string, string>;
    } = {}) {
        const response = await client.request(path, {
            body: options.body, method: options.method,
            cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
            headers: {
                'CF-Connecting-IP': `198.51.100.${++address}`,
                ...(options.accountId ? { 'X-Loginflare-Account': options.accountId } : {}),
                ...(options.flowId ? { 'X-Loginflare-Flow': options.flowId } : {}),
                ...options.headers,
            },
        });
        for (const cookie of response.headers.getSetCookie()) {
            const [pair, ...attributes] = cookie.split(';');
            const separator = pair.indexOf('=');
            const name = pair.slice(0, separator), value = pair.slice(separator + 1);
            const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute)
                || /^\s*expires=/i.test(attribute) && Date.parse(attribute.slice(attribute.indexOf('=') + 1)) <= Date.now());
            if (!value || expired) jar.delete(name);
            else jar.set(name, value);
        }
        return response;
    }
    async function accounts() {
        const response = await request('/api/browser/accounts');
        expect(response.status, await response.clone().text()).toBe(200);
        return response.json<{ accounts: Account[]; maximumAccounts: number }>();
    }
    async function begin(kind: FlowKind, targetAccountId?: string, currentAccountId?: string) {
        const response = await request('/api/browser/auth-flows', {
            body: { kind, locale: 'en-US', ...(targetAccountId ? { accountId: targetAccountId } : {}) },
            accountId: currentAccountId,
        });
        expect(response.status, await response.clone().text()).toBe(200);
        const { flowId } = await response.json<{ flowId: string }>();
        expect(flowId).toBeTruthy();
        return flowId;
    }
    async function login(email: string, currentAccountId?: string) {
        const flowId = await begin(currentAccountId ? 'add' : 'login', undefined, currentAccountId);
        const response = await request('/api/auth/sign-in/email', { flowId, body: { email, password } });
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).not.toMatchObject({ twoFactorRedirect: true });
        const account = (await accounts()).accounts.find((entry) => entry.user.email === email);
        expect(account?.status).toBe('active');
        return account!;
    }
    async function identity(accountId: string) {
        const response = await request('/api/auth/get-session', { accountId });
        expect(response.status, await response.clone().text()).toBe(200);
        return response.json<Identity>();
    }
    function loseLoginCookies() {
        for (const name of jar.keys()) if (name.startsWith('better-auth.session_token') || name.startsWith('better-auth.session_data')) jar.delete(name);
    }
    return { request, accounts, begin, login, identity, loseLoginCookies };
}

async function verified(client: Client, email: string, role = 'user') {
    const response = await client.request('/api/auth/sign-up/email', {
        headers: { 'CF-Connecting-IP': `198.51.100.${++address}` },
        body: { email, name: email.split('@')[0], password, locale: 'en-US', callbackURL: `${origin}/en-us/verified` },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect([200, 302]).toContain((await client.request(mailUrl(client.messages.at(-1)))).status);
    if (role !== 'user') await env.DB.prepare('UPDATE "user" SET "role" = ? WHERE "email" = ?').bind(role, email).run();
}

async function enroll(client: Client, email: string) {
    const device = browser(client);
    const account = await device.login(email);
    const started = await device.request('/api/auth/two-factor/enable', { accountId: account.id, body: { password } });
    expect(started.status, await started.clone().text()).toBe(200);
    const enrollment = await started.json<{ totpURI: string; backupCodes: string[] }>();
    const completed = await device.request('/api/auth/two-factor/verify-totp', {
        accountId: account.id, body: { code: await authenticatorCode(enrollment.totpURI) },
    });
    expect(completed.status, await completed.clone().text()).toBe(200);
    return enrollment;
}

beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    address = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        if (new Request(input).url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected network request');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

it.each(['site_preference=dark', 'site_preference=dark; language=zh-CN'])(
    'starts the first login flow with unrelated browser cookies: %s', async (cookie) => {
        const client = harness();
        const response = await client.request('/api/browser/auth-flows', {
            cookie, body: { kind: 'login', locale: 'en-US' },
        });
        expect(response.status, await response.clone().text()).toBe(200);
        const { flowId } = await response.json<{ flowId: string }>();
        const browserCookie = response.headers.getSetCookie().find((value) => value.startsWith('loginflare.browser='))!;
        expect(browserCookie).toBeTruthy();
        const next = await client.request(`/api/browser/auth-flows/${flowId}`, {
            cookie: `${cookie}; ${browserCookie.split(';', 1)[0]}`,
        });
        expect(next.status, await next.clone().text()).toBe(200);
        expect(await next.json()).toMatchObject({ flowId, status: 'pending' });
    },
);

it('resolves each selected account independently and rejects a selector from another browser', async () => {
    const client = harness();
    await verified(client, 'administrator@example.test', 'admin');
    await verified(client, 'member@example.test');
    const device = browser(client);
    const administrator = await device.login('administrator@example.test');
    const member = await device.login('member@example.test', administrator.id);
    expect((await device.identity(administrator.id)).user.email).toBe(administrator.user.email);
    expect((await device.identity(member.id)).user.email).toBe(member.user.email);
    const updates = await Promise.all([
        device.request('/api/auth/update-user', { accountId: administrator.id, body: { name: 'Administrator tab' } }),
        device.request('/api/auth/update-user', { accountId: member.id, body: { name: 'Member tab' } }),
    ]);
    expect(updates.map((response) => response.status)).toEqual([200, 200]);
    expect((await device.identity(administrator.id)).user.name).toBe('Administrator tab');
    expect((await device.identity(member.id)).user.name).toBe('Member tab');
    expect((await device.request(`/api/auth/admin/get-user?id=${administrator.user.id}`, { accountId: member.id })).status).toBe(403);
    const selection = await device.request('/api/browser/accounts/select', { body: { accountId: administrator.id } });
    expect(selection.status).toBe(200);
    expect(await selection.json()).toMatchObject({ accountId: administrator.id, identity: { user: { id: administrator.user.id } } });
    expect((await device.identity(member.id)).user.email).toBe(member.user.email);
    const summaries = await device.accounts();
    expect(summaries.maximumAccounts).toBe(5);
    expect(JSON.stringify(summaries)).not.toMatch(/sessionToken|"token"|"password"/);
    expect((await device.request('/api/auth/multi-session/list-device-sessions')).status).toBe(404);
    expect((await device.request('/api/auth/multi-session/set-active', { body: { sessionToken: 'untrusted' } })).status).toBe(404);
    expect((await device.request('/api/browser/accounts/select', {
        body: { accountId: administrator.id }, headers: { Origin: 'https://other.test' },
    })).status).toBe(403);
    const stranger = browser(client);
    const forged = await stranger.request('/api/auth/get-session', { accountId: administrator.id });
    expect([401, 403]).toContain(forged.status);
    expect((await stranger.accounts()).accounts).toEqual([]);
});

it('retains expired accounts, refuses another identity during reauthentication, and removes only signed-out entries', async () => {
    const client = harness();
    await verified(client, 'expired@example.test');
    await verified(client, 'available@example.test');
    const device = browser(client);
    const expired = await device.login('expired@example.test');
    const available = await device.login('available@example.test', expired.id);
    const old = await device.identity(expired.id);
    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "id" = ?').bind(new Date(Date.now() - 1000).toISOString(), old.session.id).run();
    expect((await device.accounts()).accounts).toEqual(expect.arrayContaining([expect.objectContaining({ id: expired.id, status: 'signed-out' })]));
    expect([401, 403]).toContain((await device.request('/api/auth/get-session', { accountId: expired.id })).status);
    expect((await device.identity(available.id)).user.email).toBe(available.user.email);
    const availableSession = (await device.identity(available.id)).session.id;
    const flowId = await device.begin('reauth', expired.id, available.id);
    const wrong = await device.request('/api/auth/sign-in/email', { flowId, body: { email: available.user.email, password } });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect((await device.identity(available.id)).session.id).toBe(availableSession);
    const retry = await device.begin('reauth', expired.id, available.id);
    const restored = await device.request('/api/auth/sign-in/email', { flowId: retry, body: { email: expired.user.email, password } });
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect((await device.accounts()).accounts.find((entry) => entry.user.id === expired.user.id)).toMatchObject({ id: expired.id, status: 'active' });
    expect((await device.request(`/api/browser/accounts/${expired.id}/sign-out`, { body: {} })).status).toBe(200);
    expect((await device.request(`/api/browser/accounts/${available.id}`, { method: 'DELETE' })).status).toBeGreaterThanOrEqual(400);
    const removed = await device.request(`/api/browser/accounts/${expired.id}`, { method: 'DELETE' });
    expect([200, 204]).toContain(removed.status);
    expect((await device.accounts()).accounts.map((entry) => entry.id)).toEqual([available.id]);
});

it('cancels an added login without affecting the original account and rejects reuse of its flow', async () => {
    const client = harness();
    await verified(client, 'original@example.test');
    await verified(client, 'cancelled@example.test');
    const device = browser(client);
    const original = await device.login('original@example.test');
    const flowId = await device.begin('add', undefined, original.id);
    const stranger = browser(client);
    await stranger.request(`/api/browser/auth-flows/${flowId}`, { method: 'DELETE' });
    expect((await device.request(`/api/browser/auth-flows/${flowId}`)).status).toBe(200);
    expect([401, 403]).toContain((await stranger.request(`/api/browser/auth-flows/${flowId}`)).status);
    const cancellation = await device.request(`/api/browser/auth-flows/${flowId}`, { method: 'DELETE' });
    expect([200, 204]).toContain(cancellation.status);
    const replay = await device.request('/api/auth/sign-in/email', { flowId, body: { email: 'cancelled@example.test', password } });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect((await device.identity(original.id)).user.id).toBe(original.user.id);
    expect((await device.accounts()).accounts).toHaveLength(1);
});

it('cancels only the switching tab authentication flow and preserves another tab flow', async () => {
    const client = harness();
    await verified(client, 'switch-source@example.test');
    await verified(client, 'switch-target@example.test');
    const device = browser(client);
    const source = await device.login('switch-source@example.test');
    const target = await device.login('switch-target@example.test', source.id);
    const localFlow = await device.begin('reauth', source.id, source.id);
    const switched = await device.request('/api/browser/accounts/select', {
        accountId: source.id, flowId: localFlow, body: { accountId: target.id },
    });
    expect(switched.status, await switched.clone().text()).toBe(200);
    expect(await switched.json()).toMatchObject({ identity: { user: { id: target.user.id } } });
    expect((await device.request(`/api/browser/auth-flows/${localFlow}`)).status).toBe(401);
    const otherTabFlow = await device.begin('reauth', source.id, source.id);
    expect((await device.request('/api/browser/accounts/select', {
        accountId: target.id, body: { accountId: target.id },
    })).status).toBe(200);
    expect((await device.request(`/api/browser/auth-flows/${otherTabFlow}`)).status).toBe(200);
    expect((await device.identity(source.id)).user.id).toBe(source.user.id);
});

it('recovers a signed-out account with stale tab headers while preserving another active account', async () => {
    const client = harness();
    await verified(client, 'recover-stale@example.test');
    await verified(client, 'recover-bystander@example.test');
    const device = browser(client);
    const target = await device.login('recover-stale@example.test');
    const bystander = await device.login('recover-bystander@example.test', target.id);
    const bystanderSession = (await device.identity(bystander.id)).session.id;
    const flowId = await device.begin('reauth', target.id, target.id);
    expect((await device.request(`/api/browser/accounts/${target.id}/sign-out`, { body: {} })).status).toBe(200);
    expect((await device.request(`/api/browser/auth-flows/${flowId}`)).status).toBe(401);
    const started = await device.request('/api/auth/emails/recovery/start', {
        accountId: target.id, flowId, body: { identifier: target.user.email, email: target.user.email },
    });
    expect(started.status, await started.clone().text()).toBe(200);
    const { challengeId } = await started.json<{ challengeId: string }>();
    const verifiedRecovery = await device.request('/api/auth/emails/recovery/verify', {
        accountId: target.id, flowId, body: { challengeId, code: mailCode(client.messages.at(-1)) },
    });
    expect(verifiedRecovery.status, await verifiedRecovery.clone().text()).toBe(200);
    const { token } = await verifiedRecovery.json<{ token: string }>();
    const newPassword = 'Recovered-browser-account-password-923!';
    const recovered = await device.request('/api/auth/reset-password', {
        accountId: target.id, flowId, body: { token, newPassword },
    });
    expect(recovered.status, await recovered.clone().text()).toBe(200);
    expect((await device.identity(bystander.id)).session.id).toBe(bystanderSession);
    expect((await device.accounts()).accounts.find((entry) => entry.id === target.id)?.status).toBe('signed-out');
    const freshFlow = await device.begin('reauth', target.id, bystander.id);
    const login = await device.request('/api/auth/sign-in/email', {
        flowId: freshFlow, body: { email: target.user.email, password: newPassword },
    });
    expect(login.status, await login.clone().text()).toBe(200);
    expect((await device.identity(target.id)).user.id).toBe(target.user.id);
    expect((await device.identity(bystander.id)).session.id).toBe(bystanderSession);
});

it('honors remember-me independently for each account cookie', async () => {
    const client = harness();
    await verified(client, 'remembered@example.test');
    await verified(client, 'temporary@example.test');
    const device = browser(client);
    const remembered = await device.login('remembered@example.test');
    const flowId = await device.begin('add', undefined, remembered.id);
    const response = await device.request('/api/auth/sign-in/email', {
        flowId, body: { email: 'temporary@example.test', password, rememberMe: false },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const accountCookies = response.headers.getSetCookie().filter((cookie) => /^better-auth\.session_token(?:_multi-[^=]+)?=/.test(cookie));
    expect(accountCookies.length).toBeGreaterThanOrEqual(2);
    for (const cookie of accountCookies) expect(cookie).not.toMatch(/;\s*(?:max-age|expires)=/i);
    const accounts = (await device.accounts()).accounts;
    expect(accounts.filter((entry) => entry.status === 'active')).toHaveLength(2);
    const temporary = accounts.find((entry) => entry.user.email === 'temporary@example.test')!;
    expect((await device.request(`/api/browser/auth-flows/${flowId}`, { method: 'DELETE' })).status).toBe(200);
    const temporaryIdentity = await device.identity(temporary.id);
    const shortenedExpiry = new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString();
    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "id" = ?').bind(shortenedExpiry, temporaryIdentity.session.id).run();
    const unremembered = await device.request('/api/auth/get-session', { accountId: temporary.id });
    expect(unremembered.status).toBe(200);
    for (const cookie of unremembered.headers.getSetCookie().filter((value) => /^better-auth\.session_token(?:_multi-[^=]+)?=/.test(value))) {
        expect(cookie).not.toMatch(/;\s*(?:max-age|expires)=/i);
    }
    expect(unremembered.headers.getSetCookie().some((cookie) => cookie.startsWith('better-auth.dont_remember='))).toBe(false);
    expect(await env.DB.prepare('SELECT "expiresAt" FROM "session" WHERE "id" = ?').bind(temporaryIdentity.session.id).first('expiresAt')).toBe(shortenedExpiry);
    const rememberedIdentity = await device.identity(remembered.id);
    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "id" = ?').bind(shortenedExpiry, rememberedIdentity.session.id).run();
    const persistent = await device.request('/api/auth/get-session', { accountId: remembered.id });
    expect(persistent.status).toBe(200);
    const persistentCookies = persistent.headers.getSetCookie().filter((cookie) => /^better-auth\.session_token(?:_multi-[^=]+)?=/.test(cookie));
    expect(persistentCookies.length).toBeGreaterThanOrEqual(2);
    for (const cookie of persistentCookies) expect(cookie).toMatch(/;\s*(?:max-age|expires)=/i);
    const enabled = await device.request('/api/auth/two-factor/enable', { accountId: temporary.id, body: { password } });
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const enrollment = await enabled.json<{ totpURI: string }>();
    const rotated = await device.request('/api/auth/two-factor/verify-totp', {
        accountId: temporary.id, body: { code: await authenticatorCode(enrollment.totpURI) },
    });
    expect(rotated.status, await rotated.clone().text()).toBe(200);
    const rotatedCookies = rotated.headers.getSetCookie().filter((cookie) => /^better-auth\.session_token(?:_multi-[^=]+)?=/.test(cookie) && !/max-age=0/i.test(cookie));
    expect(rotatedCookies.length).toBeGreaterThanOrEqual(2);
    for (const cookie of rotatedCookies) expect(cookie).not.toMatch(/;\s*(?:max-age|expires)=/i);
    const rotatedIdentity = await device.identity(temporary.id);
    expect(rotatedIdentity.session.id).not.toBe(temporaryIdentity.session.id);
    await env.DB.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "id" = ?').bind(shortenedExpiry, rotatedIdentity.session.id).run();
    const afterRotation = await device.request('/api/auth/get-session', { accountId: temporary.id });
    expect(afterRotation.status).toBe(200);
    for (const cookie of afterRotation.headers.getSetCookie().filter((value) => /^better-auth\.session_token(?:_multi-[^=]+)?=/.test(value))) {
        expect(cookie).not.toMatch(/;\s*(?:max-age|expires)=/i);
    }
    expect(await env.DB.prepare('SELECT "expiresAt" FROM "session" WHERE "id" = ?').bind(rotatedIdentity.session.id).first('expiresAt')).toBe(shortenedExpiry);
    expect((await device.identity(remembered.id)).user.id).toBe(remembered.user.id);
});

it('keeps sign-out method and origin checks and refuses expired authentication flows', async () => {
    const client = harness();
    await verified(client, 'protected@example.test');
    const device = browser(client);
    const account = await device.login('protected@example.test');
    expect((await device.request('/api/auth/sign-out', { accountId: account.id })).status).toBe(405);
    expect((await device.request('/api/auth/sign-out', {
        accountId: account.id, body: {}, headers: { Origin: 'https://other.test' },
    })).status).toBe(403);
    expect((await device.request('/api/auth/sign-out', { accountId: account.id, body: { userId: 'untrusted' } })).status).toBe(400);
    expect((await device.identity(account.id)).user.id).toBe(account.user.id);
    expect((await device.request('/api/browser/auth-flows', {
        accountId: account.id, body: { kind: 'reauth', locale: 'en-US' },
    })).status).toBe(400);
    const flowId = await device.begin('add', undefined, account.id);
    await env.DB.prepare('UPDATE "browserAuthFlow" SET "expiresAt" = ? WHERE "id" = ?').bind(Date.now() - 1000, flowId).run();
    expect([401, 403]).toContain((await device.request('/api/auth/get-session', { flowId })).status);
    const expired = await device.request('/api/auth/sign-in/email', { flowId, body: { email: account.user.email, password } });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ code: 'BROWSER_FLOW_EXPIRED' });
    expect((await device.identity(account.id)).user.id).toBe(account.user.id);
});

it('admits only one of two concurrent logins competing for the fifth account', async () => {
    const client = harness();
    const emails = Array.from({ length: 6 }, (_, index) => `capacity-${index}@example.test`);
    for (const email of emails) await verified(client, email);
    const device = browser(client);
    let current: Account | undefined;
    for (const email of emails.slice(0, 4)) current = await device.login(email, current?.id);
    const flows = await Promise.all([device.begin('add', undefined, current!.id), device.begin('add', undefined, current!.id)]);
    const outcomes = await Promise.all(flows.map((flowId, index) => device.request('/api/auth/sign-in/email', {
        flowId, body: { email: emails[index + 4], password },
    })));
    expect(outcomes.filter((response) => response.status === 200)).toHaveLength(1);
    expect(outcomes.filter((response) => response.status >= 400)).toHaveLength(1);
    expect((await device.accounts()).accounts.filter((entry) => entry.status === 'active')).toHaveLength(5);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "session" WHERE "expiresAt" > ?').bind(new Date().toISOString()).first('n')).toBe(5);
});

it('keeps one usable account after simultaneous first logins for the same user', async () => {
    const client = harness();
    await verified(client, 'same-user-race@example.test');
    const device = browser(client);
    const first = await device.begin('login');
    const second = await device.begin('login');
    const responses = await Promise.all([first, second].map((flowId) => device.request('/api/auth/sign-in/email', {
        flowId, body: { email: 'same-user-race@example.test', password },
    })));
    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => response.status < 500)).toBe(true);
    const accounts = (await device.accounts()).accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ user: { email: 'same-user-race@example.test' }, status: 'active' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "browserAccount"').first('n')).toBe(1);
    const identity = await device.identity(accounts[0].id);
    expect(identity.user.id).toBe(accounts[0].user.id);
    const selected = await device.request('/api/browser/accounts/select', { body: { accountId: accounts[0].id } });
    expect(selected.status, await selected.clone().text()).toBe(200);
    expect(await selected.json()).toMatchObject({ accountId: accounts[0].id, identity: { user: { id: accounts[0].user.id } } });
});

it('signs out one or all browser accounts without revoking a separate device', async () => {
    const client = harness();
    await verified(client, 'first@example.test');
    await verified(client, 'second@example.test');
    const device = browser(client), otherDevice = browser(client);
    const first = await device.login('first@example.test');
    const second = await device.login('second@example.test', first.id);
    const independent = await otherDevice.login('first@example.test');
    const response = await device.request(`/api/browser/accounts/${first.id}/sign-out`, { body: {} });
    expect(response.status).toBe(200);
    expect((await device.accounts()).accounts.find((entry) => entry.id === first.id)?.status).toBe('signed-out');
    expect((await device.identity(second.id)).user.id).toBe(second.user.id);
    expect((await otherDevice.identity(independent.id)).user.id).toBe(first.user.id);
    const pending = await device.begin('reauth', first.id, second.id);
    const all = await device.request('/api/browser/accounts/sign-out-all', { body: {} });
    expect(all.status).toBe(200);
    expect((await device.accounts()).accounts).toHaveLength(2);
    expect((await device.accounts()).accounts.every((entry) => entry.status === 'signed-out')).toBe(true);
    expect((await device.request('/api/auth/sign-in/email', { flowId: pending, body: { email: first.user.email, password } })).status).toBeGreaterThanOrEqual(400);
    expect((await otherDevice.identity(independent.id)).user.id).toBe(first.user.id);
});

it('bounds remembered accounts without hiding any of the five active accounts', async () => {
    const client = harness();
    const emails = Array.from({ length: 12 }, (_, index) => `remembered-${index}@example.test`);
    for (const email of emails) await verified(client, email);
    const device = browser(client);
    const active: Account[] = [];
    for (const email of emails.slice(0, 5)) active.push(await device.login(email, active.at(-1)?.id));
    for (const email of emails.slice(5)) {
        const removed = active.shift()!;
        expect((await device.request(`/api/browser/accounts/${removed.id}/sign-out`, { body: {} })).status).toBe(200);
        active.push(await device.login(email, active.at(-1)!.id));
    }
    const summaries = await device.accounts();
    expect(summaries.accounts).toHaveLength(10);
    expect(summaries.accounts.filter((entry) => entry.status === 'active').map((entry) => entry.id).sort()).toEqual(active.map((entry) => entry.id).sort());
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "browserAccount"').first('n')).toBe(10);
    for (const account of active) expect((await device.identity(account.id)).user.id).toBe(account.user.id);
});

it('expires old signed-out hints while keeping a still-authenticated account available', async () => {
    const client = harness();
    await verified(client, 'old-hint@example.test');
    await verified(client, 'continuously-active@example.test');
    const device = browser(client);
    const inactive = await device.login('old-hint@example.test');
    const active = await device.login('continuously-active@example.test', inactive.id);
    expect((await device.request(`/api/browser/accounts/${inactive.id}/sign-out`, { body: {} })).status).toBe(200);
    await env.DB.prepare('UPDATE "browserAccount" SET "expiresAt" = ? WHERE "id" IN (?, ?)').bind(Date.now() - 1000, inactive.id, active.id).run();
    expect((await device.accounts()).accounts).toEqual([expect.objectContaining({ id: active.id, status: 'active' })]);
    expect((await device.identity(active.id)).user.id).toBe(active.user.id);
});

it('atomically bounds parallel pending authentication flows and frees a cancelled slot', async () => {
    const client = harness();
    await verified(client, 'flow-owner@example.test');
    const device = browser(client);
    const account = await device.login('flow-owner@example.test');
    const responses = await Promise.all(Array.from({ length: 8 }, () => device.request('/api/browser/auth-flows', {
        accountId: account.id, body: { kind: 'add', locale: 'en-US' },
    })));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(3);
    const admitted = await responses.find((response) => response.status === 200)!.json<{ flowId: string }>();
    expect((await device.request(`/api/browser/auth-flows/${admitted.flowId}`, { method: 'DELETE' })).status).toBe(200);
    await device.begin('add', undefined, account.id);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "browserAuthFlow" WHERE "status" = ?').bind('pending').first('n')).toBe(5);
    expect((await device.identity(account.id)).user.id).toBe(account.user.id);
});

it('releases capacity when the browser no longer has its login cookies', async () => {
    const client = harness();
    const emails = Array.from({ length: 6 }, (_, index) => `lost-cookie-${index}@example.test`);
    for (const email of emails) await verified(client, email);
    const device = browser(client);
    let current: Account | undefined;
    for (const email of emails.slice(0, 5)) current = await device.login(email, current?.id);
    device.loseLoginCookies();
    expect((await device.accounts()).accounts).toHaveLength(5);
    expect((await device.accounts()).accounts.every((entry) => entry.status === 'signed-out')).toBe(true);
    const replacement = await device.login(emails[5]);
    expect((await device.accounts()).accounts.filter((entry) => entry.status === 'active')).toHaveLength(1);
    expect((await device.identity(replacement.id)).user.email).toBe(emails[5]);
});

it('reauthenticates a signed-out MFA account without using another active account as the MFA actor', async () => {
    const client = harness();
    await verified(client, 'reauth-factor@example.test');
    await verified(client, 'reauth-bystander@example.test');
    const device = browser(client);
    const target = await device.login('reauth-factor@example.test');
    const enabled = await device.request('/api/auth/two-factor/enable', { accountId: target.id, body: { password } });
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const enrollment = await enabled.json<{ totpURI: string }>();
    expect((await device.request('/api/auth/two-factor/verify-totp', {
        accountId: target.id, body: { code: await authenticatorCode(enrollment.totpURI) },
    })).status).toBe(200);
    const bystander = await device.login('reauth-bystander@example.test', target.id);
    const bystanderSession = (await device.identity(bystander.id)).session.id;
    expect((await device.request(`/api/browser/accounts/${target.id}/sign-out`, { body: {} })).status).toBe(200);
    const flowId = await device.begin('reauth', target.id, bystander.id);
    const challenge = await device.request('/api/auth/sign-in/email', { flowId, body: { email: target.user.email, password } });
    expect(challenge.status, await challenge.clone().text()).toBe(200);
    expect(await challenge.json()).toMatchObject({ twoFactorRedirect: true });
    expect((await device.identity(bystander.id)).session.id).toBe(bystanderSession);
    const completed = await device.request('/api/auth/two-factor/verify-totp', { flowId, body: { code: await authenticatorCode(enrollment.totpURI) } });
    expect(completed.status, await completed.clone().text()).toBe(200);
    expect((await device.identity(target.id)).user.id).toBe(target.user.id);
    expect((await device.identity(bystander.id)).session.id).toBe(bystanderSession);
});

it('isolates parallel MFA challenges from each other and from the already signed-in account', async () => {
    const client = harness();
    await verified(client, 'existing@example.test');
    await verified(client, 'factor-one@example.test');
    await verified(client, 'factor-two@example.test');
    const factors = [await enroll(client, 'factor-one@example.test'), await enroll(client, 'factor-two@example.test')];
    const device = browser(client);
    const existing = await device.login('existing@example.test');
    const flows = await Promise.all([device.begin('add', undefined, existing.id), device.begin('add', undefined, existing.id)]);
    for (const [index, flowId] of flows.entries()) {
        const response = await device.request('/api/auth/sign-in/email', { flowId, body: { email: `factor-${index ? 'two' : 'one'}@example.test`, password } });
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
    }
    expect((await device.accounts()).accounts.filter((entry) => entry.status === 'active')).toHaveLength(1);
    expect((await device.identity(existing.id)).user.id).toBe(existing.user.id);
    for (const [index, flowId] of flows.entries()) {
        const code = await authenticatorCode(factors[index].totpURI);
        const response = await device.request('/api/auth/two-factor/verify-totp', { flowId, body: { code } });
        expect(response.status, await response.clone().text()).toBe(200);
        const replay = await device.request('/api/auth/two-factor/verify-totp', { flowId, body: { code } });
        expect(replay.status).toBeGreaterThanOrEqual(400);
    }
    expect((await device.accounts()).accounts.filter((entry) => entry.status === 'active')).toHaveLength(3);
    expect((await device.identity(existing.id)).user.id).toBe(existing.user.id);
});
