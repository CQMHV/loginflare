import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test, installOfflineRoutes, switchArea } from './fixtures';
import { executeLocal, removeLocalApplications, removeLocalFixtures } from './database';
import { testOrigin } from './runtime';

const emails: string[] = [], clients: string[] = [];
const password = 'Developer-browser-password-751!';
const callback = 'https://developer-app.example.test/callback';
const logout = 'https://developer-app.example.test/signed-out';

test.afterEach(() => {
    removeLocalApplications(clients); clients.length = 0;
    removeLocalFixtures(emails); emails.length = 0;
});

async function account(role: 'user' | 'admin' = 'user') {
    const id = randomUUID(), email = `ui-${randomUUID()}@loginflare.test`;
    emails.push(email);
    const now = new Date().toISOString(), hash = await hashPassword(password);
    executeLocal(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned, locale)
        VALUES ('${id}', 'Developer browser fixture', '${email}', 1, '${now}', '${now}', '${role}', 0, 'en-US');
        INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
        VALUES ('${randomUUID()}', '${id}', 'credential', '${id}', '${hash}', '${now}', '${now}');`);
    return { id, email };
}

async function signin(page: Page, email: string, chinese = false) {
    await page.goto(`/${chinese ? 'zh-cn' : 'en-us'}/login`);
    await page.getByLabel(chinese ? '邮箱或用户名' : 'Email or username', { exact: true }).fill(email);
    await page.getByLabel(chinese ? '密码' : 'Password', { exact: true }).fill(password);
    const signIn = page.getByRole('button', { name: chinese ? '登录' : 'Sign in', exact: true });
    await expect(signIn).toBeEnabled(); await signIn.click();
    await expect(page).toHaveURL(`/${chinese ? 'zh-cn' : 'en-us'}/account`);
}

async function createApplication(page: Page, type: 'web' | 'spa', chinese = false) {
    const name = `ui-oauth-${randomUUID()}`;
    await page.getByRole('link', { name: chinese ? '创建应用' : 'Create application', exact: true }).click();
    await page.getByLabel(chinese ? '应用名称' : 'Application name', { exact: true }).fill(name);
    if (type === 'spa') {
        await page.getByRole('combobox', { name: chinese ? '应用类型' : 'Application type', exact: true }).click();
        await page.getByRole('option', { name: chinese ? '单页应用' : 'Single-page application', exact: true }).click();
    }
    await page.getByLabel(chinese ? '登录回调 URI' : 'Sign-in redirect URIs', { exact: true }).fill(callback);
    await page.getByLabel(chinese ? '退出回调 URI' : 'Sign-out redirect URIs', { exact: true }).fill(logout);
    const createdResponse = page.waitForResponse((response) => response.url().endsWith('/api/developer/applications') && response.request().method() === 'POST');
    await page.getByRole('button', { name: chinese ? '创建应用' : 'Create application', exact: true }).click();
    const response = await createdResponse;
    expect(response.status(), await response.text()).toBe(201);
    const created = await response.json() as { application: { clientId: string; name: string; type: string }; clientSecret?: string; issuer: string };
    clients.push(created.application.clientId);
    expect(created.application).toMatchObject({ name, type });
    return { ...created, name };
}

async function signedRequest(context: BrowserContext, method: 'get' | 'patch' | 'post', path: string, data?: unknown) {
    return context.request[method](`${testOrigin}${path}`, { headers: { Origin: testOrigin }, ...(data === undefined ? {} : { data }) });
}

async function workspace(page: Page, empty: boolean, chinese = false) {
    await expect(page.locator(empty ? '.developer-applications-empty' : '.developer-applications-grid')).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByLabel(chinese ? '查找应用' : 'Find an application', { exact: true })).toHaveCount(0);
    await expect(page.locator('.pagination')).toHaveCount(0);
    await expect(page.getByRole('link', { name: chinese ? '创建应用' : 'Create application', exact: true })).toHaveCount(1);
}

test('a verified ordinary developer manages a Web client and completes real OIDC authorization', async ({ page, context }) => {
    test.setTimeout(120_000);
    const owner = await account();
    await signin(page, owner.email);
    await switchArea(page, 'Developer center');
    await expect(page).toHaveURL('/en-us/developer/applications');
    await expect(page.getByRole('heading', { name: 'My applications', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Administration navigation', exact: true })).toHaveCount(0);
    await workspace(page, true);
    await page.screenshot({ path: test.info().outputPath('developer-workspace-empty.png'), fullPage: true });
    const created = await createApplication(page, 'web');
    const secretDialog = page.locator('md-dialog.form-dialog');
    await expect(secretDialog).toBeVisible();
    await expect(secretDialog.getByLabel('Client secret', { exact: true })).toHaveValue(created.clientSecret!);
    await secretDialog.getByRole('button', { name: 'I have saved the secret', exact: true }).click();
    await expect(secretDialog).toHaveCount(0);
    await page.goto('/en-us/developer/applications');
    await workspace(page, false);
    const card = page.getByRole('link', { name: created.name, exact: true });
    await expect(card).toHaveClass(/developer-application-card/);
    await expect(card.getByText(created.application.clientId, { exact: true })).toBeVisible();
    await expect(page.locator('.developer-application-card')).toHaveCount(1);
    const widths = await page.locator('.developer-applications-grid').evaluate((grid) => ({ grid: grid.getBoundingClientRect().width, card: grid.querySelector('.developer-application-card')!.getBoundingClientRect().width }));
    expect(widths.card).toBeLessThan(widths.grid * 0.75);
    await page.screenshot({ path: test.info().outputPath('developer-workspace-cards.png'), fullPage: true });
    await card.click();
    await expect(page.getByLabel('Client ID', { exact: true })).toHaveValue(created.application.clientId);
    await expect(page.getByLabel('Issuer', { exact: true })).toHaveValue(created.issuer);
    await expect(page.getByLabel('Discovery URL', { exact: true })).toHaveValue(`${created.issuer}/.well-known/openid-configuration`);
    await page.reload();
    await expect(page.getByLabel('Client secret', { exact: true })).toHaveCount(0);
    const detail = await signedRequest(context, 'get', `/api/developer/applications/${created.application.clientId}`);
    expect(detail.status()).toBe(200); expect(await detail.json()).not.toHaveProperty('clientSecret');

    await page.getByLabel('Application name', { exact: true }).fill(`${created.name}-edited`);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Application updated.');
    await page.getByRole('button', { name: 'Rotate client secret', exact: true }).click();
    const rotatedResponse = page.waitForResponse((response) => response.url().endsWith('/rotate-secret') && response.request().method() === 'POST');
    await page.locator('md-dialog.form-dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    const rotated = await rotatedResponse;
    expect(rotated.status()).toBe(200);
    const { clientSecret } = await rotated.json() as { clientSecret: string };
    expect(clientSecret).not.toBe(created.clientSecret);
    await expect(page.getByLabel('Client secret', { exact: true })).toHaveValue(clientSecret);
    await page.getByRole('button', { name: 'I have saved the secret', exact: true }).click();
    await page.reload(); await expect(page.getByLabel('Client secret', { exact: true })).toHaveCount(0);

    const verifier = randomBytes(32).toString('base64url'), nonce = randomUUID(), state = randomUUID();
    const authorization = `/api/auth/oauth2/authorize?${new URLSearchParams({ client_id: created.application.clientId, redirect_uri: callback, response_type: 'code', scope: 'openid profile email', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`;
    await page.route('https://developer-app.example.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Developer application callback</title><p>Local callback fixture.</p>' }));
    await page.goto(authorization);
    await expect(page.getByRole('heading', { name: 'Authorize application', exact: true })).toBeVisible();
    await expect(page.getByText(`${created.name}-edited wants to use your Loginflare account.`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page).toHaveURL(/^https:\/\/developer-app\.example\.test\/callback\?/);
    const returned = new URL(page.url()); expect(returned.searchParams.get('state')).toBe(state);
    const tokens = await context.request.post(`${created.issuer}/oauth2/token`, {
        headers: { Origin: testOrigin, Authorization: `Basic ${Buffer.from(`${created.application.clientId}:${clientSecret}`).toString('base64')}` },
        form: { grant_type: 'authorization_code', code: returned.searchParams.get('code')!, redirect_uri: callback, code_verifier: verifier },
    });
    expect(tokens.status(), await tokens.text()).toBe(200);
    const credentials = await tokens.json() as { id_token: string; access_token: string };
    const jwks = await (await context.request.get(`${created.issuer}/jwks`)).json();
    const verified = await jwtVerify(credentials.id_token, createLocalJWKSet(jwks), { issuer: created.issuer, audience: created.application.clientId });
    expect(verified.payload).toMatchObject({ sub: owner.id, nonce }); expect(verified.payload).not.toHaveProperty('role');
    const profile = await context.request.get(`${created.issuer}/oauth2/userinfo`, { headers: { Authorization: `Bearer ${credentials.access_token}` } });
    expect(profile.status()).toBe(200); expect(await profile.json()).toMatchObject({ sub: owner.id, email: owner.email });

    await page.goto(`/en-us/developer/applications/detail?clientId=${created.application.clientId}`);
    await page.getByRole('button', { name: 'Disable application', exact: true }).click();
    await page.locator('md-dialog.form-dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText('Disabled', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Enable application', exact: true }).click();
    await expect(page.getByText('Enabled', { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('developer-web-client.png'), fullPage: true });
});

test('isolates developer applications and prevents an owner from lifting administrator suspension on a narrow Chinese screen', async ({ page, context, browser }) => {
    test.setTimeout(150_000);
    const owner = await account(), other = await account(), administrator = await account('admin');
    await page.setViewportSize({ width: 375, height: 812 });
    await signin(page, owner.email, true);
    await switchArea(page, '开发者中心');
    await expect(page.getByRole('heading', { name: '我的应用', exact: true })).toBeVisible();
    await workspace(page, true, true);
    const created = await createApplication(page, 'spa', true);
    expect(created.clientSecret).toBeUndefined();
    await expect(page.getByLabel('客户端密钥', { exact: true })).toHaveCount(0);
    await page.goto('/zh-cn/developer/applications');
    await workspace(page, false, true);
    const card = page.getByRole('link', { name: created.name, exact: true });
    await expect(card).toHaveClass(/developer-application-card/);
    expect(await page.locator('.developer-application-card').evaluateAll((cards) => cards.every((card) => card.getBoundingClientRect().right <= document.documentElement.clientWidth + 1))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('developer-workspace-zh-cn-mobile.png'), fullPage: true });
    await card.click();
    await expect(page.getByRole('button', { name: '轮换客户端密钥', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('developer-spa-zh-cn-mobile.png'), fullPage: true });
    const second = await browser.newContext({ baseURL: testOrigin });
    await installOfflineRoutes(second);
    const admin = await browser.newContext({ baseURL: testOrigin });
    await installOfflineRoutes(admin);
    try {
        const stranger = await second.newPage(); await signin(stranger, other.email);
        await switchArea(stranger, 'Developer center');
        await workspace(stranger, true);
        await expect(stranger.getByRole('link', { name: created.name, exact: true })).toHaveCount(0);
        const base = `/api/developer/applications/${created.application.clientId}`;
        expect((await signedRequest(second, 'get', base)).status()).toBe(404);
        expect((await signedRequest(second, 'patch', base, { name: 'Unwanted rename' })).status()).toBe(404);
        expect((await signedRequest(second, 'post', `${base}/rotate-secret`, {})).status()).toBe(404);
        await stranger.goto(`/en-us/developer/applications/detail?clientId=${created.application.clientId}`);
        await expect(stranger.getByRole('alert')).toBeVisible();
        await expect(stranger.getByLabel('Application name', { exact: true })).toHaveCount(0);
        await stranger.goto('/en-us/admin/applications');
        await expect(stranger.getByRole('heading', { name: 'Access restricted', exact: true })).toBeVisible();

        const manager = await admin.newPage(); await signin(manager, administrator.email);
        await switchArea(manager, 'Administration');
        await manager.getByRole('navigation', { name: 'Administration navigation', exact: true }).getByRole('link', { name: 'Applications', exact: true }).click();
        await expect(manager.getByRole('heading', { name: 'Application management', exact: true })).toBeVisible();
        await expect(manager.getByRole('link', { name: 'Create application', exact: true })).toHaveCount(0);
        const ownedRow = manager.locator('tbody tr').filter({ has: manager.getByRole('link', { name: created.name, exact: true }) });
        await expect(ownedRow.getByRole('link', { name: owner.email, exact: true })).toHaveAttribute('href', `/en-us/admin/users/detail?id=${owner.id}`);
        const unavailable = await manager.goto('/en-us/admin/applications/new');
        expect(unavailable?.status()).toBe(404);
        await expect(manager.getByRole('link', { name: 'Create application', exact: true })).toHaveCount(0);
        await manager.goto('/en-us/admin/applications');
        await manager.getByRole('link', { name: created.name, exact: true }).click();
        await expect(manager.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
        await expect(manager.getByRole('button', { name: 'Rotate client secret', exact: true })).toHaveCount(0);
        await expect(manager.getByLabel('Discovery URL', { exact: true })).toHaveCount(0);
        await expect(manager.getByRole('link', { name: owner.email, exact: true })).toHaveAttribute('href', `/en-us/admin/users/detail?id=${owner.id}`);
        await manager.getByRole('button', { name: 'Restrict application', exact: true }).click();
        await manager.locator('md-dialog.form-dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect(manager.getByText('Disabled by administrator', { exact: true })).toBeVisible();
        await switchArea(manager, 'Developer center');
        await expect(manager.getByRole('link', { name: created.name, exact: true })).toHaveCount(0);
        await expect(manager.getByRole('heading', { name: 'My applications', exact: true })).toBeVisible();

        await page.reload();
        await expect(page.getByText('管理员已停用', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: '停用应用', exact: true })).toBeDisabled();
        await expect(page.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
        const enable = await signedRequest(context, 'patch', base, { disabled: false });
        expect(enable.status()).toBe(403);
        expect(await enable.json()).toMatchObject({ code: 'APPLICATION_SUSPENDED' });
        const saved = await (await signedRequest(context, 'get', base)).json();
        expect(saved.application.disabled).toBe(true);
    } finally { await second.close(); await admin.close(); }
});

for (const chinese of [false, true]) {
    test(`explains invalid application callbacks beside the field and creates after correction in ${chinese ? 'zh-cn' : 'en-us'}`, async ({ page, context }) => {
        test.setTimeout(90_000);
        const owner = await account();
        if (chinese) await page.setViewportSize({ width: 375, height: 812 });
        await signin(page, owner.email, chinese);
        await switchArea(page, chinese ? '开发者中心' : 'Developer center');
        await page.getByRole('link', { name: chinese ? '创建应用' : 'Create application', exact: true }).click();
        const name = `Callback validation ${randomUUID()}`;
        await page.getByLabel(chinese ? '应用名称' : 'Application name', { exact: true }).fill(name);
        await page.getByRole('combobox', { name: chinese ? '应用类型' : 'Application type', exact: true }).click();
        await page.getByRole('option', { name: chinese ? '单页应用' : 'Single-page application', exact: true }).click();
        const redirect = page.getByLabel(chinese ? '登录回调 URI' : 'Sign-in redirect URIs', { exact: true });
        const signout = page.getByLabel(chinese ? '退出回调 URI' : 'Sign-out redirect URIs', { exact: true });
        await signout.fill(logout);
        const submit = page.getByRole('button', { name: chinese ? '创建应用' : 'Create application', exact: true });
        let writes = 0;
        page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/api/developer/applications')) writes++; });
        const httpsError = chinese ? '请使用 HTTPS 回调地址，不支持 HTTP 地址。' : 'Use an HTTPS redirect URI. HTTP addresses are not supported.';
        const loopbackError = chinese ? '请使用域名，不能直接使用 localhost 或回环 IP。本地调试可使用 web.localhost 等 HTTPS 子域。' : 'Use a domain instead of localhost or a loopback IP. For local testing, use an HTTPS subdomain such as web.localhost.';
        const uriError = chinese ? '请填写完整地址，每个不超过 2048 个字符，不能包含通配符、账号密码或 # 片段。' : 'Enter complete URIs, up to 2048 characters each, without wildcards, credentials or # fragments.';
        for (const [uri, message] of [['http://app.example.test/callback', httpsError], ['https://localhost:3000/callback', loopbackError], ['https://app.example.test/callback#', uriError]]) {
            await redirect.fill(uri);
            await expect(page.locator('md-outlined-text-field[name="redirectUris"]')).toHaveJSProperty('error', false);
            await submit.click();
            await expect(redirect).toBeFocused();
            await expect(page.getByText(message, { exact: true })).toBeVisible();
            await expect(page.locator('md-outlined-text-field[name="redirectUris"]')).toHaveJSProperty('error', true);
            await expect(page.locator('.notice.error')).toHaveCount(0);
            expect(writes).toBe(0);
        }
        await page.screenshot({ path: test.info().outputPath(`callback-error-${chinese ? 'zh-cn' : 'en-us'}.png`), fullPage: true });
        await redirect.fill(callback);
        await signout.fill('http://app.example.test/signed-out');
        await submit.click();
        await expect(signout).toBeFocused();
        await expect(page.getByText(httpsError, { exact: true })).toBeVisible();
        expect(writes).toBe(0);
        await signout.fill(logout);
        await page.route(`${testOrigin}/api/developer/applications`, (route) => route.fulfill({ status: 400, json: { code: 'INVALID_INPUT', fieldErrors: { postLogoutRedirectUris: 'APPLICATION_URI_INVALID' } } }), { times: 1 });
        await submit.click();
        await expect(signout).toBeFocused();
        await expect(page.getByText(uriError, { exact: true })).toBeVisible();
        await expect(page.locator('.notice.error')).toHaveCount(0);
        expect(writes).toBe(1);
        await signout.fill(`${logout}?verified=1`);
        await expect(page.locator('md-outlined-text-field[name="postLogoutRedirectUris"]')).toHaveJSProperty('error', false);
        const response = page.waitForResponse((response) => response.url().endsWith('/api/developer/applications') && response.request().method() === 'POST');
        await submit.click();
        const created = await response;
        expect(created.status(), await created.text()).toBe(201);
        const data = await created.json() as { application: { clientId: string; postLogoutRedirectUris: string[] }; clientSecret?: string };
        clients.push(data.application.clientId);
        expect(data.application.postLogoutRedirectUris).toEqual([`${logout}?verified=1`]);
        expect(data.clientSecret).toBeUndefined();
        await expect(page.getByRole('status')).toContainText(chinese ? '应用已创建。' : 'Application created.');
        expect(writes).toBe(2);
        await expect(page.getByLabel(chinese ? '应用名称' : 'Application name', { exact: true })).toHaveCount(0);
    });
}
