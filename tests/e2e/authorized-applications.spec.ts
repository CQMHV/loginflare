import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { executeLocal, removeLocalApplications, removeLocalFixtures } from './database';
import { testOrigin } from './runtime';

const emails: string[] = [], clients: string[] = [];
const password = 'Authorized-applications-browser-971!';
const callback = 'https://authorized.example.test/callback';

test.afterEach(() => {
    removeLocalApplications(clients); clients.length = 0;
    removeLocalFixtures(emails); emails.length = 0;
});

async function login(page: Page, chinese: boolean) {
    const id = randomUUID(), email = `ui-${randomUUID()}@loginflare.test`, now = new Date().toISOString();
    emails.push(email);
    const hash = await hashPassword(password);
    executeLocal(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned, locale)
        VALUES ('${id}', 'Authorized applications browser fixture', '${email}', 1, '${now}', '${now}', 'user', 0, '${chinese ? 'zh-CN' : 'en-US'}');
        INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
        VALUES ('${randomUUID()}', '${id}', 'credential', '${id}', '${hash}', '${now}', '${now}');`);
    await page.goto(`/${chinese ? 'zh-cn' : 'en-us'}/login`);
    await page.getByLabel(chinese ? '邮箱或用户名' : 'Email or username', { exact: true }).fill(email);
    await page.getByLabel(chinese ? '密码' : 'Password', { exact: true }).fill(password);
    const submit = page.getByRole('button', { name: chinese ? '登录' : 'Sign in', exact: true });
    await expect(submit).toBeEnabled(); await submit.click();
    await expect(page).toHaveURL(`/${chinese ? 'zh-cn' : 'en-us'}/account`);
    return id;
}

async function createApplication(context: BrowserContext) {
    const name = `ui-oauth-${randomUUID()}`;
    const response = await context.request.post(`${testOrigin}/api/developer/applications`, {
        headers: { Origin: testOrigin }, data: { name, type: 'spa', redirectUris: [callback], postLogoutRedirectUris: ['https://authorized.example.test/signed-out'], scopes: ['openid', 'profile', 'email', 'offline_access'] },
    });
    expect(response.status(), await response.text()).toBe(201);
    const { application } = await response.json() as { application: { clientId: string } };
    clients.push(application.clientId);
    return { name, clientId: application.clientId };
}

function authorization(clientId: string) {
    const verifier = randomBytes(32).toString('base64url'), state = randomUUID();
    const path = `/api/auth/oauth2/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code', scope: 'openid profile email offline_access', state, nonce: randomUUID(), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`;
    return { path, verifier, state };
}

async function exchange(context: BrowserContext, clientId: string, code: string, verifier: string) {
    return context.request.post(`${testOrigin}/api/auth/oauth2/token`, { headers: { Origin: testOrigin }, form: { client_id: clientId, grant_type: 'authorization_code', redirect_uri: callback, code, code_verifier: verifier } });
}

async function approveConsent(page: Page, chinese: boolean) {
    await expect(page.getByRole('heading', { name: 'Authorize application', exact: true })).toBeVisible();
    if (chinese) {
        await page.getByRole('button', { name: 'Language', exact: true }).click();
        await page.getByRole('menuitem', { name: '简体中文', exact: true }).click();
        await expect(page.getByRole('heading', { name: '授权应用', exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: chinese ? '允许' : 'Allow', exact: true }).click();
}

for (const chinese of [false, true]) {
    test(`manages consent, revokes tokens and pending codes, and requires consent again in ${chinese ? 'zh-cn mobile' : 'en-us'}`, async ({ page, context }) => {
        test.setTimeout(120_000);
        const locale = chinese ? 'zh-cn' : 'en-us';
        if (chinese) await page.setViewportSize({ width: 375, height: 812 });
        const userId = await login(page, chinese), app = await createApplication(context);
        const label = chinese ? '已授权应用' : 'Authorized applications', revokeLabel = chinese ? '撤销授权' : 'Revoke access';
        const empty = chinese ? '暂无已授权应用' : 'No authorized applications yet.';
        await page.getByRole('navigation', { name: chinese ? '账号导航' : 'Account navigation', exact: true }).getByRole('link', { name: label, exact: true }).click();
        await expect(page).toHaveURL(`/${locale}/account/applications`);
        await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
        await expect(page.getByText(empty, { exact: true })).toBeVisible();
        await expect(page.getByText(app.name, { exact: true })).toHaveCount(0);
        await page.route('https://authorized.example.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local application callback</title><p>Callback fixture.</p>' }));
        const first = authorization(app.clientId);
        await page.goto(first.path);
        await approveConsent(page, chinese);
        await expect(page).toHaveURL(/^https:\/\/authorized\.example\.test\/callback\?/);
        const returned = new URL(page.url()); expect(returned.searchParams.get('state')).toBe(first.state);
        const tokenResponse = await exchange(context, app.clientId, returned.searchParams.get('code')!, first.verifier);
        expect(tokenResponse.status(), await tokenResponse.text()).toBe(200);
        const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
        expect(tokens.refresh_token).toBeTruthy();
        const userInfo = () => context.request.get(`${testOrigin}/api/auth/oauth2/userinfo`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
        expect((await userInfo()).status()).toBe(200);

        // Obtain an unredeemed code through the provider's JSON navigation response,
        // without navigating the simulated external application a second time.
        const pending = authorization(app.clientId);
        const pendingResponse = await context.request.get(`${testOrigin}${pending.path}`, { headers: { Accept: 'application/json' } });
        expect(pendingResponse.status(), await pendingResponse.text()).toBe(200);
        const pendingNavigation = await pendingResponse.json() as { redirect: boolean; url: string };
        expect(pendingNavigation.redirect).toBe(true);
        const pendingCode = new URL(pendingNavigation.url).searchParams.get('code')!;
        await page.goto(`/${locale}/account/applications`);
        const row = page.locator('.authorized-application-card');
        await expect(row).toHaveCount(1);
        await expect(row.getByRole('heading', { name: app.name, exact: true })).toBeVisible();
        await expect(row).toContainText(chinese ? '读取你的邮箱地址与验证状态' : 'Read your email address and verification status');
        await expect(row.locator('time')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await expect(page.getByRole('table')).toHaveCount(0);
        await page.screenshot({ path: test.info().outputPath(`authorized-applications-${locale}.png`), fullPage: true });
        const mirror = await context.newPage();
        try {
            await mirror.goto(`/${locale}/account/applications`);
            await expect(mirror.locator('.authorized-application-card')).toHaveCount(1);
            await mirror.getByRole('button', { name: revokeLabel, exact: true }).click();
            await expect(mirror.locator('md-dialog.form-dialog')).toBeVisible();
            await page.bringToFront();
            await row.getByRole('button', { name: revokeLabel, exact: true }).click();
            const dialog = page.locator('md-dialog.form-dialog');
            await expect(dialog).toBeVisible();
            await expect(page.getByRole('dialog', { name: revokeLabel, exact: true })).toBeVisible();
            await expect(dialog).toContainText(app.name);
            await dialog.getByRole('button', { name: chinese ? '取消' : 'Cancel', exact: true }).click();
            await expect(dialog).toHaveCount(0);
            expect((await userInfo()).status()).toBe(200);

            await page.route(`${testOrigin}/api/account/applications/${app.clientId}/revoke`, (route) => route.fulfill({ status: 503, json: { code: 'REQUEST_FAILED' } }), { times: 1 });
            await row.getByRole('button', { name: revokeLabel, exact: true }).click();
            await dialog.getByRole('button', { name: revokeLabel, exact: true }).click();
            await expect(dialog.getByRole('alert')).toBeVisible();
            await expect(page.locator('.feedback-toast.error')).toHaveCount(0);
            await expect(row).toHaveCount(1);
            await dialog.getByRole('button', { name: revokeLabel, exact: true }).click();
            await expect(dialog).toHaveCount(0);
            await expect(page.getByText(empty, { exact: true })).toBeVisible();
            await mirror.bringToFront();
            await expect(mirror.getByText(empty, { exact: true })).toBeVisible();
            await expect(mirror.locator('md-dialog.form-dialog')).toHaveCount(0);
            expect((await userInfo()).status()).toBe(401);
            const refresh = await context.request.post(`${testOrigin}/api/auth/oauth2/token`, { headers: { Origin: testOrigin }, form: { client_id: app.clientId, grant_type: 'refresh_token', refresh_token: tokens.refresh_token } });
            expect(refresh.status()).toBe(400);
            expect((await exchange(context, app.clientId, pendingCode, pending.verifier)).status()).toBe(400);
            const session = await context.request.get(`${testOrigin}/api/auth/get-session`);
            expect((await session.json()).user.id).toBe(userId);
        } finally { await mirror.close(); }

        const renewed = authorization(app.clientId);
        await page.goto(renewed.path);
        await approveConsent(page, chinese);
        await expect(page).toHaveURL(/^https:\/\/authorized\.example\.test\/callback\?/);
        expect((await exchange(context, app.clientId, new URL(page.url()).searchParams.get('code')!, renewed.verifier)).status()).toBe(200);
        await page.goto(`/${locale}/account/applications`);
        await expect(page.locator('.authorized-application-card')).toHaveCount(1);
        const disabled = await context.request.patch(`${testOrigin}/api/developer/applications/${app.clientId}`, { headers: { Origin: testOrigin }, data: { disabled: true } });
        expect(disabled.status()).toBe(200);
        await page.reload();
        await expect(page.getByText(chinese ? '已停用' : 'Disabled', { exact: true })).toBeVisible();
        await expect(row.getByRole('button', { name: revokeLabel, exact: true })).toBeEnabled();
        await row.getByRole('button', { name: revokeLabel, exact: true }).click();
        await page.locator('md-dialog.form-dialog').getByRole('button', { name: revokeLabel, exact: true }).click();
        await expect(page.getByText(empty, { exact: true })).toBeVisible();
    });
}
