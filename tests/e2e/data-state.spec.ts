import { expect, test, type Page } from './fixtures';
import { testOrigin } from './runtime';
import type { BrowserContext } from '@playwright/test';
import type { Identity } from '../../src/client/api';

function identity(id = 'alpha', role = 'admin'): Identity {
    const now = new Date().toISOString();
    return {
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
        const application = () => ({ clientId, name: state.applicationName, type: 'web', disabled: false,
            redirectUris: ['https://app.example.test/callback'], postLogoutRedirectUris: ['https://app.example.test/'], scopes: ['openid', 'profile'] });
        if (url.pathname === '/api/auth/get-session') result = structuredClone(state.actor);
        else if (url.pathname === '/api/config') result = { turnstileSiteKey: '1x00000000000000000000AA' };
        else if (url.pathname === '/api/auth/sign-out') state.actor = null;
        else if (url.pathname === '/api/auth/sign-in/username') state.actor = identity(req.postDataJSON().username, 'user');
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
        else if (url.pathname === '/api/admin/users') result = { items: rows.slice(0, 20), pageInfo: { nextCursor: null, previousCursor: null } };
        else if (url.pathname === '/api/auth/admin/get-user') {
            if (state.forbiddenUser) { status = 403; result = { code: 'YOU_ARE_NOT_ALLOWED_TO_GET_USER' }; }
            else result = rows.find((row) => row.id === url.searchParams.get('id'));
        }
        else if (url.pathname === '/api/admin/applications') {
            if (state.forbiddenApplications) { status = 403; result = { code: 'FORBIDDEN' }; }
            else result = { items: [{ ...application(), createdAt: new Date().toISOString() }], pageInfo: { nextCursor: null, previousCursor: null }, issuer: `${testOrigin}/api/auth` };
        } else if (url.pathname.endsWith('/rotate-secret')) {
            await state.writeGate;
            result = { clientSecret: 'test-only-one-time-application-secret' };
        }
        else if (url.pathname === `/api/admin/applications/${clientId}`) {
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

for (const [role, width] of [['admin', 1280], ['user', 320]] as const) {
    test(`keeps the ${role} header menus accessible and bounded at ${width}px`, async ({ page, context }) => {
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
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await language.press('ArrowUp');
        const selected = page.getByRole('menuitem', { name: '简体中文', exact: true });
        await expect(selected).toBeFocused();
        await expect(selected).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Escape');
        await expect(header.locator('.language-control md-menu .menu')).toBeHidden();
        await expect(language).toBeFocused();
        await expect(language).toHaveAttribute('aria-expanded', 'false');
        await account.press('ArrowDown');
        await expect(page.getByRole('menuitem', { name: '个人资料', exact: true })).toBeFocused();
        await expect(page.getByRole('menuitem', { name: '管理后台', exact: true })).toHaveCount(role === 'admin' ? 1 : 0);
        await page.screenshot({ path: test.info().outputPath(`header-${role}-${width}.png`), fullPage: true });
        await page.keyboard.press('Escape');
        await expect(header.locator('.account-menu md-menu .menu')).toBeHidden();
        await expect(account).toBeFocused();
        await language.press('ArrowDown');
        await expect(page.getByRole('menuitem', { name: 'English', exact: true })).toBeFocused();
        await page.route(`${testOrigin}/api/auth/update-user`, (route) => route.fulfill({ status: 503, json: { code: 'REQUEST_FAILED' } }));
        await page.keyboard.press('Space');
        await expect(page).toHaveURL('/en-us/account');
        const failure = header.getByRole('alert');
        await expect(failure).toBeVisible();
        const failureBounds = await failure.boundingBox();
        expect(failureBounds!.x).toBeGreaterThanOrEqual(0);
        expect(failureBounds!.x + failureBounds!.width).toBeLessThanOrEqual(width);
        await header.getByRole('button', { name: 'Account menu', exact: true }).press('ArrowUp');
        await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(header.locator('.account-menu md-menu .menu')).toBeHidden();
        await header.getByRole('button', { name: 'Account menu', exact: true }).click();
        await page.getByRole('menuitem', { name: role === 'admin' ? 'Administration' : 'Profile', exact: true }).click();
        await expect(page).toHaveURL(role === 'admin' ? '/en-us/admin/users' : '/en-us/account');
        await expect(page.getByRole('navigation', { name: role === 'admin' ? 'Administration navigation' : 'Account navigation', exact: true })).toBeVisible();
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
        ['users', '/en-us/admin/users', 'tbody tr'],
        ['user', '/en-us/admin/users/detail?id=row-0', '.user-detail-grid'],
        ['applications', '/en-us/admin/applications', '.application-name'],
        ['application', `/en-us/admin/applications/detail?clientId=${server.clientId}`, '.scope-options'],
    ]) {
        await page.goto(path);
        await expect(page.locator(ready).first()).toBeVisible();
        await expect(page.getByRole('button', { name: /^(Refresh data|刷新数据)$/ })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
        const positions = () => page.locator('.page-content > .page-heading, .page-content > .card').evaluateAll((elements) =>
            elements.map((element) => { const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; }));
        const before = await positions();
        let release!: () => void;
        server.state.readGate = new Promise<void>((resolve) => { release = resolve; });
        await returnToStalePage(page);
        await expect(page.getByRole('status')).toHaveText('Updating…');
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
    await page.getByRole('link', { name: 'Administration', exact: true }).click();
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

    await page.getByRole('link', { name: 'Applications', exact: true }).click();
    await page.getByRole('link', { name: 'Cache application', exact: true }).click();
    await page.getByLabel('Application name', { exact: true }).fill('Unsaved application');
    await page.getByRole('link', { name: 'Back to applications', exact: true }).click();
    await page.getByRole('link', { name: 'Cache application', exact: true }).click();
    await expect(page.getByLabel('Application name', { exact: true })).toHaveValue('Unsaved application');
    expect(server.count(page, `/api/admin/applications/${server.clientId}`)).toBe(1);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Application updated');
    await page.getByRole('link', { name: 'Back to applications', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Unsaved application', exact: true })).toBeVisible();
    expect(server.count(page, '/api/admin/applications')).toBe(2);
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
    await peer.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(peer).toHaveURL('/en-us/login');
    await expect(page).toHaveURL('/en-us/login');
    await expect(page.getByText('alpha-v1@loginflare.test', { exact: true })).toHaveCount(0);
    await peer.close();
    server.state.actor = identity();
    await page.reload();
    await expect(page).toHaveURL('/en-us/account');
    let release!: () => void;
    server.state.emailGate = new Promise<void>((resolve) => { release = resolve; });
    await page.getByRole('link', { name: 'Email addresses', exact: true }).click();
    await expect.poll(() => server.count(page, '/api/auth/emails')).toBe(2);
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL('/en-us/login');
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
    await page.getByLabel('Current password', { exact: true }).fill('must-be-cleared');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(page.getByLabel('Current password', { exact: true })).toHaveValue('');
    await page.getByRole('link', { name: 'Profile', exact: true }).click();
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Second revision');
    await page.reload();
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('First revision');
    await page.getByRole('link', { name: 'Administration', exact: true }).click();
    await page.getByRole('link', { name: 'Applications', exact: true }).click();
    await page.getByRole('link', { name: 'Cache application', exact: true }).click();
    await page.getByRole('button', { name: 'Rotate client secret', exact: true }).click();
    await page.locator('md-dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByLabel('Client secret', { exact: true })).toHaveValue('test-only-one-time-application-secret');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(page.getByLabel('Client secret', { exact: true })).toHaveCount(0);
    server.state.writeGate = new Promise<void>((resolve) => { release = resolve; });
    await page.getByRole('button', { name: 'Rotate client secret', exact: true }).click();
    await page.locator('md-dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect.poll(() => server.count(page, `/api/admin/applications/${server.clientId}/rotate-secret`, 'POST')).toBe(2);
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
