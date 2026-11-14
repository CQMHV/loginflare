import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import { testOrigin } from './runtime';
import type { BrowserContext, Page } from '@playwright/test';
import type { Identity } from '../../src/client/api';
import type { BrowserAccountSummary } from '../../src/client/browser-account-actions';
import { defaultBranding } from '../../src/shared/branding';
import { hashPassword } from 'better-auth/crypto';
import { executeLocal, removeLocalFixtures } from './database';

const fixtureEmails: string[] = [];
test.afterEach(() => { removeLocalFixtures(fixtureEmails); fixtureEmails.length = 0; });

async function mockBrowser(context: BrowserContext) {
    const identities = new Map<string, Identity>();
    const accounts: BrowserAccountSummary[] = ['Alpha', 'Beta', 'Gamma'].map((name) => {
        const id = randomUUID(), userId = randomUUID(), now = new Date().toISOString();
        const identity: Identity = {
            browserAccountId: id,
            user: { id: userId, name, email: `${name.toLowerCase()}@loginflare.test`, role: name === 'Alpha' ? 'admin' : 'user', emailVerified: true, createdAt: now, locale: 'en-US' },
            session: { id: randomUUID(), token: 'mock-session-not-used-for-authentication', userId, createdAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
        };
        identities.set(id, identity);
        return { id, user: identity.user, status: 'active', lastUsedAt: now };
    });
    const flows = new Set<string>();
    const writes: { accountId: string; name: string }[] = [];
    await context.route(`${testOrigin}/api/**`, async (route) => {
        const req = route.request(), path = new URL(req.url()).pathname;
        const selected = req.headers()['x-loginflare-account'] ?? '';
        const account = accounts.find((item) => item.id === selected);
        const flowId = req.headers()['x-loginflare-flow'];
        let result: unknown = {}, status = 200;
        if (path === '/api/browser/accounts') result = { accounts, maximumAccounts: 5 };
        else if (path === '/api/browser/accounts/select') {
            const target = accounts.find((item) => item.id === req.postDataJSON().accountId && item.status === 'active');
            if (!target) { status = 401; result = { code: 'BROWSER_ACCOUNT_UNAVAILABLE' }; }
            else result = { accountId: target.id, identity: identities.get(target.id) };
        } else if (path === '/api/browser/auth-flows' && req.method() === 'POST') {
            const id = randomUUID(); flows.add(id); result = { flowId: id };
        } else if (path.startsWith('/api/browser/auth-flows/') && req.method() === 'DELETE') flows.delete(path.split('/').at(-1)!);
        else if (path === '/api/auth/get-session') result = flowId && flows.has(flowId) ? null : account?.status === 'active' ? identities.get(account.id) : null;
        else if (path === '/api/auth/sign-out') { if (account) account.status = 'signed-out'; }
        else if (path === '/api/browser/accounts/sign-out-all') accounts.forEach((item) => { item.status = 'signed-out'; });
        else if (/^\/api\/browser\/accounts\/[^/]+$/.test(path) && req.method() === 'DELETE') {
            const index = accounts.findIndex((item) => item.id === path.split('/').at(-1));
            if (index >= 0) accounts.splice(index, 1);
        } else if (path === '/api/auth/update-user') {
            const name = req.postDataJSON().name;
            writes.push({ accountId: selected, name });
            if (account) { account.user.name = name; identities.get(account.id)!.user.name = name; result = identities.get(account.id)!.user; }
        } else if (path === '/api/auth/social/security') result = { hasPassword: true, identities: [], providers: [] };
        else if (path === '/api/social/providers') result = { providers: [] };
        else if (path === '/api/config') result = { turnstileSiteKey: '1x00000000000000000000AA' };
        else if (path === '/api/branding') result = { ...defaultBranding, logoUrl: '/assets/logo.svg', revision: 0 };
        await route.fulfill({ status, json: result });
    });
    return { accounts, identities, writes };
}

async function openAccount(page: Page, accountId: string, locale = 'en-us') {
    await page.addInitScript((id) => { if (!sessionStorage.getItem('loginflare.account')) sessionStorage.setItem('loginflare.account', id); }, accountId);
    await page.goto(`/${locale}/account`);
}

test('switches only the current tab, clears drafts, and sends writes as the selected account', async ({ page, context }) => {
    const state = await mockBrowser(context), [alpha, beta, gamma] = state.accounts;
    await openAccount(page, alpha.id);
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Alpha');
    await page.getByLabel('Display name', { exact: true }).fill('Unsaved Alpha draft');
    const other = await context.newPage();
    await openAccount(other, gamma.id);
    await expect(other.getByLabel('Display name', { exact: true })).toHaveValue('Gamma');
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByRole('button', { name: 'Account: beta@loginflare.test', exact: true }).click();
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Beta');
    await expect(other.getByLabel('Display name', { exact: true })).toHaveValue('Gamma');
    await page.getByLabel('Display name', { exact: true }).fill('Updated Beta');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => state.writes).toEqual([{ accountId: beta.id, name: 'Updated Beta' }]);
    await page.reload();
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Updated Beta');
    await expect(other.getByLabel('Display name', { exact: true })).toHaveValue('Gamma');
    expect(await page.evaluate(() => sessionStorage.getItem('loginflare.account'))).toBe(beta.id);
    expect(await other.evaluate(() => sessionStorage.getItem('loginflare.account'))).toBe(gamma.id);
});

for (const locale of ['en-us', 'zh-cn']) {
    test(`cancels adding an account and retains signed-out entries in ${locale}`, async ({ page, context }) => {
        const state = await mockBrowser(context), alpha = state.accounts[0];
        const text = locale === 'en-us'
            ? { menu: 'Account menu', add: 'Add an account', cancel: 'Cancel sign-in', out: 'Sign out', choose: 'Choose an account', signedOut: 'Signed out', remove: 'Remove from this list', profile: 'Your profile' }
            : { menu: '账号菜单', add: '添加账号', cancel: '取消登录', out: '退出登录', choose: '选择账号', signedOut: '已退出', remove: '从列表移除', profile: '个人资料' };
        await openAccount(page, alpha.id, locale);
        await expect(page.getByRole('heading', { name: text.profile, exact: true })).toBeVisible();
        await page.getByRole('button', { name: text.menu, exact: true }).click();
        await page.getByRole('button', { name: text.add, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/${locale}/login\\?flow=`));
        await page.getByRole('button', { name: text.cancel, exact: true }).click();
        await expect(page.getByRole('heading', { name: text.profile, exact: true })).toBeVisible();
        await page.getByRole('button', { name: text.menu, exact: true }).click();
        await page.getByRole('button', { name: text.out, exact: true }).click();
        await expect(page.getByRole('heading', { name: text.choose, exact: true })).toBeVisible();
        await expect(page.getByText(text.signedOut, { exact: true })).toBeVisible();
        await page.getByRole('button', { name: `${text.remove}: alpha@loginflare.test`, exact: true }).click();
        await expect(page.getByRole('button', { name: /alpha@loginflare.test/ })).toHaveCount(0);
    });
}

test('preserves the active flow when identity invalidation redirects a protected page', async ({ page, context }) => {
    const state = await mockBrowser(context);
    await openAccount(page, state.accounts[0].id);
    await expect(page.getByRole('heading', { name: 'Your profile', exact: true })).toBeVisible();
    // A context reset can commit before the account menu's deferred navigation.
    // Exercise that ordering while the protected route is still mounted.
    const flowId = await page.evaluate(async () => {
        const response = await fetch('/api/browser/auth-flows', { method: 'POST', body: JSON.stringify({ kind: 'add', locale: 'en-US' }) });
        const { flowId } = await response.json() as { flowId: string };
        sessionStorage.setItem('loginflare.auth-return-account', sessionStorage.getItem('loginflare.account')!);
        sessionStorage.setItem('loginflare.auth-flow', flowId);
        sessionStorage.setItem('loginflare.auth-flow-kind', 'add');
        window.dispatchEvent(new Event('loginflare:browser-context'));
        return flowId;
    });
    await expect(page).toHaveURL(`/en-us/login?flow=${flowId}`);
    await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your profile', exact: true })).toBeVisible();
});

test('a new tab without a selection displays the account chooser on narrow screens', async ({ page, context }) => {
    await mockBrowser(context);
    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto('/zh-cn/login');
    await expect(page.getByRole('heading', { name: '选择账号', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^账号：/ })).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('account-chooser-mobile-zh.png'), fullPage: true });
});

test('finishes recovery from an add flow while retaining another account and starts a fresh sign-in', async ({ page, context }) => {
    const state = await mockBrowser(context), alpha = state.accounts[0];
    await openAccount(page, alpha.id);
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByRole('button', { name: 'Add an account', exact: true }).click();
    await expect(page.getByLabel('Email or username', { exact: true })).toBeVisible();
    const oldFlow = await page.evaluate(() => sessionStorage.getItem('loginflare.auth-flow'));
    await page.goto('/en-us/reset-password?token=isolated-ui-reset-token');
    await page.getByLabel('New password', { exact: true }).fill('Recovered-other-account-218!');
    await page.getByLabel('Confirm password', { exact: true }).fill('Recovered-other-account-218!');
    await page.getByRole('button', { name: 'Reset password', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Password updated.');
    expect(await page.evaluate(() => sessionStorage.getItem('loginflare.auth-flow'))).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem('loginflare.account'))).toBe(alpha.id);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByLabel('Email or username', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('loginflare.auth-flow'))).not.toBe(oldFlow);
    await expect(page).toHaveURL(/\/en-us\/login\?flow=/);
});

test('uses real credentials to add, isolate, reauthenticate, and sign out browser accounts', async ({ page, context }) => {
    test.setTimeout(90_000);
    await context.addCookies([{ name: 'site_preference', value: 'dark', url: testOrigin }, { name: 'loginflare.browser', value: 'stale.invalid', url: testOrigin }]);
    const password = 'Browser-multi-account-735!', now = new Date().toISOString(), hash = await hashPassword(password);
    const fixtures = ['Alpha', 'Beta'].map((name) => ({ name, id: randomUUID(), email: `ui-${randomUUID()}@loginflare.test` }));
    for (const item of fixtures) {
        fixtureEmails.push(item.email);
        executeLocal(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned, locale)
            VALUES ('${item.id}', '${item.name}', '${item.email}', 1, '${now}', '${now}', '${item.name === 'Alpha' ? 'admin' : 'user'}', 0, 'en-US');
            INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
            VALUES ('${randomUUID()}', '${item.id}', 'credential', '${item.id}', '${hash}', '${now}', '${now}');`);
    }
    async function credentials(email: string) {
        await page.getByLabel('Email or username', { exact: true }).fill(email);
        await page.getByLabel('Password', { exact: true }).fill(password);
        await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    }
    await page.goto('/en-us/login');
    await credentials(fixtures[0].email);
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Alpha');
    const alphaAccount = await page.evaluate(() => sessionStorage.getItem('loginflare.account'));
    expect(alphaAccount).toBeTruthy();
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByRole('button', { name: 'Add an account', exact: true }).click();
    await credentials(fixtures[1].email);
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Beta');
    const betaAccount = await page.evaluate(() => sessionStorage.getItem('loginflare.account'));
    expect(betaAccount).toBeTruthy(); expect(betaAccount).not.toBe(alphaAccount);
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.screenshot({ path: test.info().outputPath('real-account-menu-en-desktop.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: 'Language', exact: true }).click();
    await page.getByRole('menuitem', { name: '简体中文', exact: true }).click();
    await expect(page).toHaveURL('/zh-cn/account');
    await page.getByRole('button', { name: '账号菜单', exact: true }).click();
    await page.screenshot({ path: test.info().outputPath('real-account-menu-zh-mobile.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '语言', exact: true }).click();
    await page.getByRole('menuitem', { name: 'English', exact: true }).click();
    await expect(page).toHaveURL('/en-us/account');
    await page.setViewportSize({ width: 1280, height: 720 });

    const alphaTab = await context.newPage();
    await alphaTab.goto('/en-us/account');
    await expect(alphaTab.getByRole('heading', { name: 'Choose an account', exact: true })).toBeVisible();
    await alphaTab.screenshot({ path: test.info().outputPath('real-account-chooser-en-desktop.png'), fullPage: true });
    await alphaTab.getByRole('button', { name: `Account: ${fixtures[0].email}`, exact: true }).click();
    await expect(alphaTab.getByLabel('Display name', { exact: true })).toHaveValue('Alpha');
    await page.reload();
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Beta');
    const selectedIdentity = await context.request.get('/api/auth/get-session', { headers: { 'X-Loginflare-Account': betaAccount! } });
    expect((await selectedIdentity.json()).user.id).toBe(fixtures[1].id);

    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Choose an account', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: 'Language', exact: true }).click();
    await page.getByRole('menuitem', { name: '简体中文', exact: true }).click();
    await expect(page.getByRole('heading', { name: '选择账号', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('real-account-chooser-zh-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '语言', exact: true }).click();
    await page.getByRole('menuitem', { name: 'English', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: `Account: ${fixtures[1].email}`, exact: true }).click();
    await credentials(fixtures[0].email);
    await expect(page.getByRole('alert')).toContainText('Use the account you selected');
    await alphaTab.reload();
    await expect(alphaTab.getByLabel('Display name', { exact: true })).toHaveValue('Alpha');
    await credentials(fixtures[1].email);
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Beta');
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out of all accounts', exact: true }).click();
    await page.locator('md-dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Choose an account', exact: true })).toBeVisible();
    await expect(alphaTab.getByRole('heading', { name: 'Choose an account', exact: true })).toBeVisible();
    await expect(page.getByText('Signed out', { exact: true })).toHaveCount(2);
});
