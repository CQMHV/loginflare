import { expect, test, switchArea, type Page } from './fixtures';
import { testOrigin } from './runtime';
import type { BrowserContext } from '@playwright/test';
import type { Identity } from '../../src/client/api';
import { defaultBranding } from '../../src/shared/branding';

function identity(id = 'alpha', role = 'admin'): Identity {
    const now = new Date().toISOString();
    return {
        browserAccountId: `browser-${id}`,
        user: { id, name: `Account ${id}`, username: id, email: `${id}@loginflare.test`, emailVerified: true, role, createdAt: now, locale: 'en-US' },
        session: { id: `session-${id}`, token: `test-only-${id}-session-value`, userId: id, createdAt: now, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() },
    };
}

async function mockAccount(context: BrowserContext) {
    const state = {
        actor: identity() as Identity | null, emailVersion: 1, failEmails: false, rateLimitEmails: false,
        emailGate: undefined as Promise<void> | undefined, writeGate: undefined as Promise<void> | undefined, readGate: undefined as Promise<void> | undefined,
        applicationName: 'Cache application', forbiddenApplications: false, forbiddenUser: false,
    };
    const counts = new Map<Page, Map<string, number>>();
    const clientId = 'A'.repeat(32);
    const remembered = new Map<string, Identity>();
    const rows = Array.from({ length: 60 }, (_, index) => ({ ...identity(`row-${index}`, 'user').user, banned: false }));
    await context.route(`${testOrigin}/api/**`, async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const page = req.frame().page();
        const pageCounts = counts.get(page) ?? new Map<string, number>();
        const key = `${req.method()} ${url.pathname}`;
        pageCounts.set(key, (pageCounts.get(key) ?? 0) + 1); counts.set(page, pageCounts);
        if (url.search) pageCounts.set(key + url.search, (pageCounts.get(key + url.search) ?? 0) + 1);
        let result: unknown = {};
        let status = 200;
        const application = () => ({ clientId, name: state.applicationName, type: 'web', disabled: false, ownerId: state.actor?.user.id ?? null, ownerDisabled: false, adminSuspended: false,
            redirectUris: ['https://app.example.test/callback'], postLogoutRedirectUris: ['https://app.example.test/'], scopes: ['openid', 'profile'] });
        if (state.actor) remembered.set(state.actor.browserAccountId!, state.actor);
        if (url.pathname === '/api/browser/accounts') result = { accounts: [...remembered.entries()].map(([id, item]) => ({ id, user: item.user, status: state.actor?.user.id === item.user.id ? 'active' : 'signed-out', lastUsedAt: item.session.createdAt })), maximumAccounts: 5 };
        else if (url.pathname === '/api/browser/accounts/select') result = { accountId: state.actor?.browserAccountId, identity: state.actor };
        else if (url.pathname === '/api/browser/auth-flows' && req.method() === 'POST') result = { flowId: '00000000-0000-4000-8000-000000000001' };
        else if (url.pathname.startsWith('/api/browser/auth-flows/') && req.method() === 'DELETE') result = { status: true };
        else if (url.pathname === '/api/auth/get-session') result = structuredClone(state.actor);
        else if (url.pathname === '/api/auth/social/security') result = { hasPassword: true, identities: [], providers: [] };
        else if (url.pathname === '/api/social/providers') result = { providers: [] };
        else if (url.pathname === '/api/config') result = { turnstileSiteKey: '1x00000000000000000000AA' };
        else if (url.pathname === '/api/auth/sign-out') state.actor = null;
        else if (url.pathname === '/api/auth/sign-in/username') state.actor = identity(req.postDataJSON().username, 'user');
        else if (url.pathname === '/api/auth/verify-password') {
            if (!state.actor) { status = 401; result = { code: 'UNAUTHORIZED' }; }
            else if (req.method() !== 'POST' || req.postDataJSON()?.password !== 'test-only-password') { status = 400; result = { code: 'INVALID_PASSWORD' }; }
            else result = { status: true };
        }
        else if (url.pathname === '/api/auth/update-user') {
            const body = req.postDataJSON();
            await state.writeGate;
            if (state.actor) state.actor.user = { ...state.actor.user, ...body };
        } else if (url.pathname === '/api/auth/emails') {
            result = { emails: [{ id: 'email', email: `${state.actor?.user.id}-v${state.emailVersion}@loginflare.test`, verified: true, primary: true }] };
            if (state.failEmails) { status = 503; result = { code: 'REQUEST_FAILED' }; }
            if (state.rateLimitEmails) { status = 429; result = { code: 'TOO_MANY_REQUESTS' }; }
            await state.emailGate;
        } else if (url.pathname === '/api/account/sessions') result = { items: state.actor ? [state.actor.session] : [], pageInfo: { nextCursor: null, previousCursor: null }, hasOtherSessions: false };
        else if (url.pathname === '/api/account/applications') result = { items: [{ clientId, name: 'Authorized cache application', scopes: ['openid', 'profile', 'email'], authorizedAt: new Date().toISOString(), disabled: false }], pageInfo: { nextCursor: null, previousCursor: null } };
        else if (url.pathname === '/api/admin/users') result = { items: rows.slice(0, 20), pageInfo: { nextCursor: null, previousCursor: null } };
        else if (/^\/api\/admin\/access\/users\/[^/]+\/roles$/.test(url.pathname)) result = { roles: [] };
        else if (url.pathname === '/api/auth/admin/get-user') {
            if (state.forbiddenUser) { status = 403; result = { code: 'YOU_ARE_NOT_ALLOWED_TO_GET_USER' }; }
            else result = rows.find((row) => row.id === url.searchParams.get('id')) ?? (url.searchParams.get('id') === state.actor?.user.id ? state.actor.user : undefined);
        }
        else if (['/api/admin/applications', '/api/developer/applications'].includes(url.pathname)) {
            if (state.forbiddenApplications && url.pathname.includes('/admin/')) { status = 403; result = { code: 'FORBIDDEN' }; }
            else result = { items: [{ ...application(), createdAt: new Date().toISOString() }], pageInfo: { nextCursor: null, previousCursor: null }, issuer: `${testOrigin}/api/auth` };
        } else if (url.pathname.endsWith('/rotate-secret')) {
            await state.writeGate;
            result = { clientSecret: 'test-only-one-time-application-secret' };
        }
        else if ([`/api/admin/applications/${clientId}`, `/api/developer/applications/${clientId}`].includes(url.pathname)) {
            if (req.method() === 'PATCH') state.applicationName = req.postDataJSON().name ?? state.applicationName;
            result = { application: application(), issuer: `${testOrigin}/api/auth` };
        } else { status = 404; result = { code: 'NOT_FOUND' }; }
        if (req.method() === 'GET') await state.readGate;
        await route.fulfill({ status, json: result, ...(status === 429 ? { headers: { 'Retry-After': '20' } } : {}) }).catch(() => {});
    });
    return { state, clientId, count: (page: Page, path: string, method = 'GET') => counts.get(page)?.get(`${method} ${path}`) ?? 0 };
}

async function visibility(page: Page, visible: boolean) {
    await page.evaluate((visible) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
        document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    }, visible);
}

for (const [locale, width] of [['en-us', 1280], ['zh-cn', 375]] as const) {
    test(`centers initial security loading without partially rendering settings in ${locale}`, async ({ page, context }) => {
        await mockAccount(context);
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        await context.route(`${testOrigin}/api/auth/social/security`, async (route) => {
            await pending;
            await route.fulfill({ json: { hasPassword: true, identities: [], providers: [{ id: 'test-google', name: 'Google', type: 'google' }] } });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/${locale}/account/security`);
        const loading = page.locator('.page-content > .loading-state');
        await expect(loading).toBeVisible();
        await expect(page.locator('.page-content .card')).toHaveCount(0);
        const placement = await page.evaluate(() => {
            const main = document.querySelector('.page-content')!;
            const heading = main.querySelector('.page-heading')!;
            const loading = main.querySelector('.loading-state')!.getBoundingClientRect();
            const top = heading.getBoundingClientRect().bottom + parseFloat(getComputedStyle(heading).marginBottom);
            const bottom = main.getBoundingClientRect().bottom - parseFloat(getComputedStyle(main).paddingBottom);
            return { actual: loading.top + loading.height / 2, expected: (top + bottom) / 2 };
        });
        expect(Math.abs(placement.actual - placement.expected)).toBeLessThan(2);
        await page.screenshot({ path: test.info().outputPath(`security-loading-${locale}.png`) });
        release();
        await expect(loading).toHaveCount(0);
        await expect(page.getByRole('heading', { name: locale === 'zh-cn' ? '双重验证' : 'Two-factor authentication', exact: true })).toBeVisible();
        await expect(page.getByRole('region', { name: locale === 'zh-cn' ? '第三方账号' : 'Third-party accounts', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: locale === 'zh-cn' ? '修改密码' : 'Change password', exact: true })).toBeEnabled();
    });
}

for (const [path, endpoint] of [
    ['account/sessions', '/api/account/sessions'],
    ['admin/users', '/api/admin/users'],
    ['admin/applications', '/api/admin/applications'],
]) {
    test(`keeps ${path} loading inside its data panel`, async ({ page, context }) => {
        await mockAccount(context);
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        await context.route(`${testOrigin}${endpoint}*`, async (route) => { await pending; await route.fallback(); });
        await page.goto(`/en-us/${path}`);
        const loading = page.locator('.page-content .card .loading-state');
        await expect(loading).toBeVisible();
        await expect(page.locator('.page-content > .loading-state')).toHaveCount(0);
        await expect(page.locator('.page-heading')).toBeVisible();
        release();
        await expect(loading).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeVisible();
    });
}

test('keeps security settings hidden after an initial read failure and recovers on retry', async ({ page, context }) => {
    await mockAccount(context);
    let failing = true;
    await context.route(`${testOrigin}/api/auth/social/security`, async (route) => {
        if (failing) await route.fulfill({ status: 503, json: { code: 'REQUEST_FAILED' } });
        else await route.fallback();
    });
    await page.goto('/en-us/account/security');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('.page-content .card')).toHaveCount(0);
    failing = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Set up authenticator', exact: true })).toBeEnabled();
});

for (const locale of ['en-us', 'zh-cn'] as const) {
    test(`shows a rotated client secret in a modal at the current viewport in ${locale}`, async ({ page, context }) => {
        const server = await mockAccount(context);
        const chinese = locale === 'zh-cn';
        await page.setViewportSize({ width: chinese ? 375 : 1280, height: 600 });
        await page.goto(`/${locale}/developer/applications/detail?clientId=${server.clientId}`);
        const rotate = page.getByRole('button', { name: chinese ? '轮换客户端密钥' : 'Rotate client secret', exact: true });
        await rotate.click();
        await page.locator('md-dialog.form-dialog').getByRole('button', { name: chinese ? '确认' : 'Confirm', exact: true }).click();
        const dialog = page.locator('md-dialog.form-dialog');
        await expect(dialog).toHaveCount(1);
        const secret = dialog.getByLabel(chinese ? '客户端密钥' : 'Client secret', { exact: true });
        await expect(secret).toHaveValue('test-only-one-time-application-secret');
        await expect(secret).toBeInViewport({ ratio: 1 });
        await expect(page.locator('.secret-notice')).toHaveCount(0);
        await page.screenshot({ path: test.info().outputPath(`secret-modal-${locale}.png`) });
        await dialog.getByRole('button', { name: chinese ? '我已保存密钥' : 'I have saved the secret', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByLabel(chinese ? '客户端密钥' : 'Client secret', { exact: true })).toHaveCount(0);
        await expect(rotate).toBeFocused();
        expect(server.count(page, `/api/developer/applications/${server.clientId}/rotate-secret`, 'POST')).toBe(1);
    });

    test(`brings long-form submission errors into view in ${locale}`, async ({ page, context }) => {
        const server = await mockAccount(context);
        const chinese = locale === 'zh-cn';
        await page.setViewportSize({ width: chinese ? 375 : 1280, height: 600 });
        for (const endpoint of ['/api/auth/update-user', `/api/developer/applications/${server.clientId}`]) {
            await context.route(`${testOrigin}${endpoint}`, (route) => route.request().method() === 'GET' ? route.fallback() : route.fulfill({ status: 503, json: { code: 'REQUEST_FAILED' } }));
        }
        await context.route(`${testOrigin}/api/admin/branding`, (route) => route.fulfill(route.request().method() === 'GET'
            ? { json: { ...defaultBranding, logoUrl: '/assets/logo.svg', colors: { light: {}, dark: {} } } }
            : { status: 503, json: { code: 'REQUEST_FAILED' } }));
        for (const [path, label] of [
            ['account', chinese ? '显示名称' : 'Display name'],
            [`developer/applications/detail?clientId=${server.clientId}`, chinese ? '应用名称' : 'Application name'],
            ['admin/branding', chinese ? '品牌名' : 'Brand name'],
        ]) {
            await page.goto(`/${locale}/${path}`);
            await page.getByLabel(label, { exact: true }).fill('Unsaved changes');
            for (let attempt = 0; attempt < 2; attempt++) {
                await page.getByRole('button', { name: chinese ? '保存修改' : 'Save changes', exact: true }).click();
                const error = page.getByRole('alert');
                await expect(error).toBeFocused();
                await expect(error).toBeInViewport({ ratio: 1 });
                await expect(page.getByLabel(label, { exact: true })).toHaveValue('Unsaved changes');
            }
        }
    });
}

for (const timing of ['immediate', 'after-navigation'] as const)
for (const [role, width] of [['admin', 1280], ['admin', 800], ['admin', 375], ['user', 320]] as const) {
    test(`keeps the ${role} header menus accessible and bounded at ${width}px with ${timing} feedback`, async ({ page, context }) => {
        const server = await mockAccount(context);
        server.state.actor = identity('alpha', role);
        await page.setViewportSize({ width, height: 812 });
        await page.goto('/zh-cn/account');
        const header = page.locator('.header-actions');
        const language = header.getByRole('button', { name: '语言', exact: true });
        const theme = header.getByRole('button', { name: '主题', exact: true });
        const account = header.getByRole('button', { name: '账号菜单', exact: true });
        await expect(account.locator('.user-avatar')).toHaveText('');
        await expect(account.locator('.user-avatar md-icon svg')).toBeVisible();
        for (const control of [language, theme, account]) {
            await expect(control).toBeVisible();
            const bounds = await control.boundingBox();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        expect(await page.locator('.sidebar').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await language.press('ArrowUp');
        const selected = page.getByRole('menuitem', { name: '简体中文', exact: true });
        await expect(selected).toBeFocused();
        await expect(selected).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Escape');
        await expect(header.locator('.language-control md-menu .menu')).toBeHidden();
        await expect(language).toBeFocused();
        await expect(language).toHaveAttribute('aria-expanded', 'false');
        await account.press('Enter');
        await expect(page.getByRole('button', { name: '账号：alpha@loginflare.test', exact: true })).toBeFocused();
        await expect(page.getByRole('menuitem', { name: '管理后台', exact: true })).toHaveCount(0);
        await page.screenshot({ path: test.info().outputPath(`header-${role}-${width}.png`), fullPage: true });
        await page.keyboard.press('Escape');
        await expect(header.locator('.browser-account-popover')).toHaveCount(0);
        await expect(account).toBeFocused();
        await language.press('ArrowDown');
        await expect(page.getByRole('menuitem', { name: 'English', exact: true })).toBeFocused();
        if (timing === 'immediate') {
            // Resolve before the deferred locale navigation commits, as a fast response can in production.
            await page.evaluate(() => {
                const original = window.fetch;
                window.fetch = (input, init) => String(input) === '/api/auth/update-user'
                    ? Promise.resolve(new Response(JSON.stringify({ code: 'REQUEST_FAILED' }), { status: 503 }))
                    : original(input, init);
            });
        } else {
            await page.route(`${testOrigin}/api/auth/update-user`, async (route) => {
                await page.waitForURL('/en-us/account');
                await route.fulfill({ status: 503, json: { code: 'REQUEST_FAILED' } });
            });
        }
        await page.keyboard.press('Space');
        await expect(page).toHaveURL('/en-us/account');
        const failure = page.locator('.feedback-toast[role="alert"]');
        await expect(failure).toBeVisible();
        await expect(header.getByRole('alert')).toHaveCount(0);
        await expect(failure).toContainText('We couldn’t complete this request. Please try again.');
        const failureBounds = await failure.boundingBox();
        expect(failureBounds!.x).toBeGreaterThanOrEqual(0);
        expect(failureBounds!.x + failureBounds!.width).toBeLessThanOrEqual(width);
        await failure.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
        await expect(failure).toHaveCount(0);
        await header.getByRole('button', { name: 'Account menu', exact: true }).press('Enter');
        await expect(page.getByRole('button', { name: 'Account: alpha@loginflare.test', exact: true })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(page.getByRole('button', { name: 'Profile', exact: true })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(header.locator('.browser-account-popover')).toHaveCount(0);
        await header.getByRole('button', { name: 'Account menu', exact: true }).click();
        await page.getByRole('button', { name: 'Profile', exact: true }).click();
        await expect(page).toHaveURL('/en-us/account');
        const area = page.locator('.area-selector').getByRole('button', { name: /^Switch area:/ });
        if (role === 'admin') {
            await expect(area).toHaveAccessibleName('Switch area: Account center');
            const triggerBounds = (await area.boundingBox())!;
            const navigationBounds = (await page.getByRole('navigation', { name: 'Account navigation', exact: true }).boundingBox())!;
            expect(triggerBounds.y).toBeGreaterThanOrEqual(navigationBounds.y + navigationBounds.height);
            if (width > 760) expect(triggerBounds.y + triggerBounds.height).toBeGreaterThan(812 - 64);
            await area.press('ArrowDown');
            const current = page.getByRole('menuitem', { name: 'Account center', exact: true });
            await expect(current).toBeFocused();
            await expect(current).toHaveAttribute('aria-selected', 'true');
            await page.keyboard.press('Escape');
            await expect(page.locator('.area-selector md-menu .menu')).toBeHidden();
            await expect(area).toBeFocused();
            await expect(area).toHaveAttribute('aria-expanded', 'false');
            await area.press('ArrowUp');
            const destination = page.getByRole('menuitem', { name: 'Administration', exact: true });
            await expect(destination).toBeFocused();
            const bounds = await destination.boundingBox();
            expect(bounds!.x).toBeGreaterThanOrEqual(0);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
            expect(bounds!.y).toBeGreaterThanOrEqual(0);
            expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(triggerBounds.y);
            expect(await page.locator('.sidebar').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
            await page.keyboard.press('Enter');
            await expect(page).toHaveURL('/en-us/admin/users');
            await expect(area).toHaveAccessibleName('Switch area: Administration');
            await expect(page.getByRole('navigation', { name: 'Account navigation', exact: true })).toHaveCount(0);
        } else {
            await expect(area).toHaveAccessibleName('Switch area: Account center');
            await area.click();
            await expect(page.getByRole('menuitem', { name: 'Developer center', exact: true })).toBeVisible();
            await expect(page.getByRole('menuitem', { name: 'Administration', exact: true })).toHaveCount(0);
            await page.keyboard.press('Escape');
        }
        await expect(page.getByRole('navigation', { name: role === 'admin' ? 'Administration navigation' : 'Account navigation', exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        expect(await page.locator('.sidebar').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    });
}

async function returnToStalePage(page: Page) {
    await page.clock.fastForward(61_000);
    await visibility(page, false);
    await visibility(page, true);
}

for (const width of [1280, 375]) test(`keeps account and administration layout stable during background reads at ${width}px`, async ({ page, context }) => {
    test.setTimeout(90_000);
    const server = await mockAccount(context);
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    for (const [name, path, ready] of [
        ['profile', '/en-us/account', '.profile-card .avatar-editor'],
        ['emails', '/en-us/account/emails', '.email-row'],
        ['sessions', '/en-us/account/sessions', '.session-row'],
        ['authorized-applications', '/en-us/account/applications', '.authorized-application-card'],
        ['users', '/en-us/admin/users', 'tbody tr'],
        ['user', '/en-us/admin/users/detail?id=row-0', '.user-detail-grid'],
        ['applications', '/en-us/admin/applications', '.application-name'],
        ['application', `/en-us/admin/applications/detail?clientId=${server.clientId}`, '.application-details'],
        ['developer-applications', '/en-us/developer/applications', '.developer-application-card'],
        ['developer-application', `/en-us/developer/applications/detail?clientId=${server.clientId}`, '.scope-options'],
    ]) {
        await page.goto(path);
        await expect(page.locator(ready).first()).toBeVisible();
        if (name === 'user') await expect(page.getByText('No business roles assigned.', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: /^(Refresh data|刷新数据)$/ })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
        const positions = () => page.locator('.page-content > .page-heading, .page-content > .card, .developer-applications-grid, .authorized-application-list').evaluateAll((elements) =>
            elements.map((element) => { const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; }));
        const before = await positions();
        let release!: () => void;
        server.state.readGate = new Promise<void>((resolve) => { release = resolve; });
        await returnToStalePage(page);
        // Independent cards can announce their own background refresh.
        await expect(page.getByRole('status').filter({ hasText: 'Updating…' }).first()).toHaveText('Updating…');
        expect(await positions()).toEqual(before);
        release(); server.state.readGate = undefined;
        await expect(page.getByText('Updating…', { exact: true })).toHaveCount(0);
        expect(await positions()).toEqual(before);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath(`${name}-${width}.png`), fullPage: true });
    }
});

test('reuses account and administration reads, preserves drafts and scroll, and invalidates writes', async ({ page, context }) => {
    const server = await mockAccount(context);
    await page.clock.install();
    await page.goto('/en-us/account/emails');
    await expect(page.getByText('alpha-v1@loginflare.test', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Profile', exact: true }).click();
    expect(server.count(page, '/api/auth/get-session')).toBe(1);
    await page.getByLabel('Display name', { exact: true }).fill('Unsaved profile');
    await page.getByRole('link', { name: 'Email addresses', exact: true }).click();
    await expect(page.getByText('alpha-v1@loginflare.test', { exact: true })).toBeVisible();
    expect(server.count(page, '/api/auth/emails')).toBe(1);
    await page.getByRole('link', { name: 'Profile', exact: true }).click();
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Unsaved profile');
    server.state.actor!.user.name = 'Updated on server';
    const beforeProfileReturn = server.count(page, '/api/auth/get-session');
    await page.clock.fastForward(16_000);
    await page.getByRole('link', { name: 'Email addresses', exact: true }).click();
    await page.getByRole('link', { name: 'Profile', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Account menu', exact: true })).toHaveAttribute('aria-description', 'Updated on server');
    expect(server.count(page, '/api/auth/get-session')).toBe(beforeProfileReturn + 1);
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Unsaved profile');
    await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Updated on server');

    await page.setViewportSize({ width: 1280, height: 500 });
    await switchArea(page, 'Administration');
    await expect(page.locator('tbody tr')).toHaveCount(20);
    const target = page.locator('.table-user').nth(15);
    await target.scrollIntoViewIfNeeded();
    const scroll = await page.evaluate(() => window.scrollY);
    expect(scroll).toBeGreaterThan(100);
    await target.click();
    await expect(page.getByRole('heading', { name: 'User details', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Back to users', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(20);
    await expect.poll(() => page.evaluate((position) => Math.abs(window.scrollY - position), scroll)).toBeLessThanOrEqual(5);
    expect(server.count(page, '/api/admin/users')).toBe(1);

    await switchArea(page, 'Developer center');
    await page.getByRole('link', { name: 'My applications', exact: true }).click();
    await page.getByRole('link', { name: 'Cache application', exact: true }).click();
    await page.getByLabel('Application name', { exact: true }).fill('Unsaved application');
    await page.getByRole('link', { name: 'Back to applications', exact: true }).click();
    await page.getByRole('link', { name: 'Cache application', exact: true }).click();
    await expect(page.getByLabel('Application name', { exact: true })).toHaveValue('Unsaved application');
    expect(server.count(page, `/api/developer/applications/${server.clientId}`)).toBe(1);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Application updated');
    await page.getByRole('link', { name: 'Back to applications', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Unsaved application', exact: true })).toBeVisible();
    expect(server.count(page, '/api/developer/applications')).toBe(2);
});

test('retains stale data during refresh and failures, merges focus/reconnect work, and reloads on F5', async ({ page, context }) => {
    const server = await mockAccount(context);
    await page.clock.install();
    await page.goto('/en-us/account/emails');
    await expect(page.getByText('alpha-v1@loginflare.test', { exact: true })).toBeVisible();
    await visibility(page, false); await visibility(page, true);
    expect(server.count(page, '/api/auth/emails')).toBe(1);
    let release!: () => void;
    server.state.emailGate = new Promise<void>((resolve) => { release = resolve; });
    server.state.emailVersion = 2;
    await page.clock.fastForward(61_000);
    await visibility(page, false); await visibility(page, true);
    await expect.poll(() => server.count(page, '/api/auth/emails')).toBe(2);
    await expect(page.getByText('alpha-v1@loginflare.test', { exact: true })).toBeVisible();
    await expect(page.getByText('Updating…', { exact: true })).toBeVisible();
    await visibility(page, false); await visibility(page, true);
    expect(server.count(page, '/api/auth/emails')).toBe(2);
    release(); server.state.emailGate = undefined;
    await expect(page.getByText('alpha-v2@loginflare.test', { exact: true })).toBeVisible();
    server.state.failEmails = true;
    const failure = page.waitForResponse((response) => response.url().endsWith('/api/auth/emails') && response.status() === 503);
    await returnToStalePage(page);
    await failure;
    await expect.poll(() => server.count(page, '/api/auth/emails')).toBe(3);
    await page.clock.runFor(1500);
    await expect(page.getByRole('alert')).toContainText('Showing previously loaded data');
    await expect(page.getByText('alpha-v2@loginflare.test', { exact: true })).toBeVisible();
    server.state.failEmails = false; server.state.emailVersion = 3;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByText('alpha-v3@loginflare.test', { exact: true })).toBeVisible();
    await page.clock.fastForward(61_000);
    const beforeReconnect = server.count(page, '/api/auth/emails');
    await page.evaluate(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
    await expect.poll(() => server.count(page, '/api/auth/emails')).toBe(beforeReconnect + 1);
    await expect(page.getByText('Updating…', { exact: true })).toHaveCount(0);
    const beforeRestore = server.count(page, '/api/auth/emails');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect.poll(() => server.count(page, '/api/auth/emails')).toBe(beforeRestore + 1);
    await expect(page.getByText('Updating…', { exact: true })).toHaveCount(0);
    const beforeReload = server.count(page, '/api/auth/emails');
    await page.reload();
    await expect(page.getByText('alpha-v3@loginflare.test', { exact: true })).toBeVisible();
    expect(server.count(page, '/api/auth/emails')).toBe(beforeReload + 1);
});

test('clears private data across tabs and ignores a late response from the previous account', async ({ page, context }) => {
    const server = await mockAccount(context);
    await page.goto('/en-us/account/emails');
    await expect(page.getByText('alpha-v1@loginflare.test', { exact: true })).toBeVisible();
    const peer = await context.newPage();
    await peer.goto('/en-us/account');
    await peer.getByRole('button', { name: 'Account menu', exact: true }).click();
    await peer.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(peer).toHaveURL('/en-us/select-account');
    await expect(page).toHaveURL('/en-us/select-account');
    await expect(page.getByText('alpha-v1@loginflare.test', { exact: true })).toHaveCount(0);
    await peer.close();
    server.state.actor = identity();
    await page.goto('/en-us/account');
    await expect(page).toHaveURL('/en-us/account');
    let release!: () => void;
    server.state.emailGate = new Promise<void>((resolve) => { release = resolve; });
    await page.getByRole('link', { name: 'Email addresses', exact: true }).click();
    await expect.poll(() => server.count(page, '/api/auth/emails')).toBe(2);
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL('/en-us/select-account');
    await page.getByRole('button', { name: 'Use another account', exact: true }).click();
    server.state.emailGate = undefined;
    await page.getByLabel('Email or username', { exact: true }).fill('beta');
    await page.getByLabel('Password', { exact: true }).fill('test-only-password');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL('/en-us/account');
    await page.getByRole('link', { name: 'Email addresses', exact: true }).click();
    await expect(page.getByText('beta-v1@loginflare.test', { exact: true })).toBeVisible();
    release();
    await expect(page.getByText('alpha-v1@loginflare.test', { exact: true })).toHaveCount(0);
    const persisted = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    for (const value of ['alpha-v1', 'beta-v1', 'test-only-beta-session-value', 'test-only-password']) expect(persisted).not.toContain(value);
});

test('ignores delayed operation feedback after leaving its page', async ({ page, context }) => {
    const server = await mockAccount(context);
    await page.goto('/en-us/account');
    await page.getByLabel('Display name', { exact: true }).fill('Delayed profile save');
    let release!: () => void;
    server.state.writeGate = new Promise<void>((resolve) => { release = resolve; });
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => server.count(page, '/api/auth/update-user', 'POST')).toBe(1);
    await page.getByRole('link', { name: 'Sessions', exact: true }).click();
    await expect(page).toHaveURL('/en-us/account/sessions');
    const response = page.waitForResponse((result) => result.url().endsWith('/api/auth/update-user'));
    release(); server.state.writeGate = undefined;
    await response;
    await expect(page.getByRole('button', { name: 'Account menu', exact: true })).toHaveAttribute('aria-description', 'Delayed profile save');
    await expect(page.locator('.feedback-toast')).toHaveCount(0);
});

test('requires successful server password confirmation before revealing password changes', async ({ page, context }) => {
    const server = await mockAccount(context);
    await page.goto('/en-us/account/security');
    await expect(page.getByLabel('Current password', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Confirm password', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    const dialog = page.locator('md-dialog.form-dialog');
    await dialog.getByLabel('Current password', { exact: true }).fill('wrong-test-password');
    await dialog.getByRole('button', { name: 'Verify and continue', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByLabel('New password', { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel('Confirm password', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Change password', exact: true })).toHaveCount(0);
    await dialog.getByLabel('Current password', { exact: true }).fill('test-only-password');
    await dialog.getByRole('button', { name: 'Verify and continue', exact: true }).click();
    await expect(dialog.getByLabel('New password', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Confirm password', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Current password', { exact: true })).toHaveCount(0);
    expect(server.count(page, '/api/auth/verify-password', 'POST')).toBe(2);
    await dialog.getByLabel('New password', { exact: true }).fill('Unsubmitted-new-password-917!');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(dialog.getByLabel('Current password', { exact: true })).toHaveValue('');
    await expect(dialog.getByLabel('New password', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Current password', { exact: true }).fill('test-only-password');
    await dialog.getByRole('button', { name: 'Verify and continue', exact: true }).click();
    await expect(dialog.getByLabel('New password', { exact: true })).toHaveValue('');
});

test('keeps newer edits after saving and clears sensitive inputs on page departure', async ({ page, context }) => {
    const server = await mockAccount(context);
    await page.goto('/en-us/account');
    await page.getByLabel('Display name', { exact: true }).fill('First revision');
    let release!: () => void;
    server.state.writeGate = new Promise<void>((resolve) => { release = resolve; });
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => server.count(page, '/api/auth/update-user', 'POST')).toBe(1);
    await page.getByLabel('Display name', { exact: true }).fill('Second revision');
    release(); server.state.writeGate = undefined;
    await expect(page.getByRole('button', { name: 'Account menu', exact: true })).toHaveAttribute('aria-description', 'First revision');
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Second revision');
    await page.getByRole('link', { name: 'Security', exact: true }).click();
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    const passwordDialog = page.locator('md-dialog.form-dialog');
    await passwordDialog.getByLabel('Current password', { exact: true }).fill('must-be-cleared');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(passwordDialog).toHaveCount(0);
    await expect(page.getByLabel('Current password', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(passwordDialog.getByLabel('Current password', { exact: true })).toHaveValue('');
    await passwordDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(passwordDialog).toHaveCount(0);
    await page.getByRole('link', { name: 'Profile', exact: true }).click();
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Second revision');
    await page.reload();
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('First revision');
    await switchArea(page, 'Developer center');
    await page.getByRole('link', { name: 'My applications', exact: true }).click();
    await page.getByRole('link', { name: 'Cache application', exact: true }).click();
    await page.getByRole('button', { name: 'Rotate client secret', exact: true }).click();
    await page.locator('md-dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByLabel('Client secret', { exact: true })).toHaveValue('test-only-one-time-application-secret');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(page.getByLabel('Client secret', { exact: true })).toHaveCount(0);
    server.state.writeGate = new Promise<void>((resolve) => { release = resolve; });
    await page.getByRole('button', { name: 'Rotate client secret', exact: true }).click();
    await page.locator('md-dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect.poll(() => server.count(page, `/api/developer/applications/${server.clientId}/rotate-secret`, 'POST')).toBe(2);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    release(); server.state.writeGate = undefined;
    await expect(page.getByRole('button', { name: 'Rotate client secret', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Client secret', { exact: true })).toHaveCount(0);
});

test('removes administration state after permissions are revoked without retrying forbidden reads', async ({ page, context }) => {
    const server = await mockAccount(context);
    await page.clock.install();
    await page.goto('/en-us/admin/applications');
    await expect(page.getByRole('link', { name: 'Cache application', exact: true })).toBeVisible();
    server.state.actor!.user.role = 'user'; server.state.forbiddenApplications = true;
    await page.clock.fastForward(61_000);
    await page.getByRole('link', { name: 'Users', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(20);
    await page.getByRole('link', { name: 'Applications', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Access restricted', exact: true })).toBeVisible();
    expect(server.count(page, '/api/admin/applications')).toBe(2);
    await expect(page.getByRole('link', { name: 'Cache application', exact: true })).toHaveCount(0);
});

test('synchronizes profile changes between tabs without overwriting a local draft', async ({ page, context }) => {
    await mockAccount(context);
    await page.goto('/en-us/account');
    await page.getByLabel('Display name', { exact: true }).fill('Local unsaved draft');
    const peer = await context.newPage();
    await peer.goto('/en-us/account');
    await peer.getByLabel('Display name', { exact: true }).fill('Saved in another tab');
    await peer.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(peer.getByRole('button', { name: 'Account menu', exact: true })).toHaveAttribute('aria-description', 'Saved in another tab');
    await page.bringToFront();
    await expect(page.getByRole('button', { name: 'Account menu', exact: true })).toHaveAttribute('aria-description', 'Saved in another tab');
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Local unsaved draft');
    await peer.close();
});

test('rechecks identity for native Better Auth permission errors as well as custom API errors', async ({ page, context }) => {
    const server = await mockAccount(context);
    await page.clock.install();
    await page.goto('/en-us/admin/users/detail?id=row-0');
    await expect(page.locator('.user-detail-grid')).toContainText('row-0@loginflare.test');
    server.state.actor!.user.role = 'user'; server.state.forbiddenUser = true;
    await page.clock.fastForward(61_000);
    await page.getByRole('link', { name: 'Back to users', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(20);
    await page.locator('.table-user').first().click();
    await expect(page.getByRole('heading', { name: 'Access restricted', exact: true })).toBeVisible();
    expect(server.count(page, '/api/auth/admin/get-user')).toBe(2);
    await expect(page.locator('.user-detail-grid')).toHaveCount(0);
});

test('bounds inactive detail caches while retaining recent results', async ({ page, context }) => {
    const server = await mockAccount(context);
    await page.goto('/en-us/admin/users/detail?id=row-0');
    await expect(page.locator('.user-detail-grid')).toContainText('row-0@loginflare.test');
    async function visit(index: number) {
        await page.evaluate((index) => {
            history.pushState(null, '', `/en-us/admin/users/detail?id=row-${index}`);
            window.dispatchEvent(new PopStateEvent('popstate'));
        }, index);
        await expect(page.locator('.user-detail-grid')).toContainText(`row-${index}@loginflare.test`);
    }
    for (let index = 1; index <= 55; index++) await visit(index);
    await visit(54);
    expect(server.count(page, '/api/auth/admin/get-user?id=row-54')).toBe(1);
    await visit(0);
    expect(server.count(page, '/api/auth/admin/get-user?id=row-0')).toBe(2);
});

test('honors Retry-After across remounts and visibility changes even without cached data', async ({ page, context }) => {
    const server = await mockAccount(context);
    server.state.rateLimitEmails = true;
    await page.clock.install();
    await page.goto('/en-us/account/emails');
    await expect(page.getByRole('alert')).toBeVisible();
    expect(server.count(page, '/api/auth/emails')).toBe(1);
    await page.getByRole('link', { name: 'Profile', exact: true }).click();
    await page.getByRole('link', { name: 'Email addresses', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await visibility(page, false); await visibility(page, true);
    await page.clock.fastForward(10_000);
    await visibility(page, false); await visibility(page, true);
    expect(server.count(page, '/api/auth/emails')).toBe(1);
    server.state.rateLimitEmails = false;
    await page.clock.fastForward(11_000);
    await visibility(page, false); await visibility(page, true);
    await expect(page.getByText('alpha-v1@loginflare.test', { exact: true })).toBeVisible();
    expect(server.count(page, '/api/auth/emails')).toBe(2);
});

test('clears expired identity and private views, and restores usable login controls after pagehide', async ({ page, context }) => {
    const server = await mockAccount(context);
    server.state.actor!.session.expiresAt = new Date(Date.now() + 30_000).toISOString();
    await page.clock.install();
    await page.goto('/en-us/account/emails');
    await expect(page.getByText('alpha-v1@loginflare.test', { exact: true })).toBeVisible();
    await page.clock.fastForward(31_000);
    await expect(page).toHaveURL('/en-us/login');
    await expect(page.getByText('alpha-v1@loginflare.test', { exact: true })).toHaveCount(0);
    await page.getByLabel('Email or username', { exact: true }).fill('beta');
    await page.getByLabel('Password', { exact: true }).fill('must-be-cleared');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await page.getByLabel('Password', { exact: true }).fill('test-only-password');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    expect(server.count(page, '/api/config')).toBe(1);
});
