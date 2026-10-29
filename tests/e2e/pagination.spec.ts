import { testOrigin } from './runtime';
import { expect, test, type Page } from './fixtures';
import { hashPassword } from 'better-auth/crypto';
import { randomBytes, randomUUID } from 'node:crypto';
import { executeLocal, removeLocalApplications, removeLocalFixtures } from './database';

const fixtureEmails: string[] = [];
const fixtureClients: string[] = [];

test.afterEach(() => {
    removeLocalApplications(fixtureClients);
    removeLocalFixtures(fixtureEmails);
    fixtureClients.length = 0;
    fixtureEmails.length = 0;
});

async function selectLookup(page: Page, option: string) {
    await page.getByRole('combobox', { name: 'Search by', exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
}

async function changePage(page: Page, endpoint: string, name: 'Next' | 'Previous') {
    const response = page.waitForResponse((value) => new URL(value.url()).pathname === endpoint && value.request().method() === 'GET');
    await page.getByRole('button', { name, exact: true }).click();
    const result = await response;
    expect(result.status(), await result.text()).toBe(200);
    const data = await result.json();
    expect(data.items.length).toBeLessThanOrEqual(20);
    expect(data).not.toHaveProperty('total');
    expect(new URL(result.url()).searchParams.get('cursor')).toBeTruthy();
    expect(new URL(result.url()).searchParams.get('limit')).toBe('20');
    return data;
}

test('keeps bounded user, application, and session pages in the URL', async ({ page }) => {
    test.setTimeout(180_000);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const password = 'Pagination-local-password-917!';
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const users = Array.from({ length: 45 }, (_, index) => ({
        id: randomUUID(), email: `ui-${randomUUID()}@loginflare.test`,
        username: `scale_${suffix}_${index}`, name: `Pagination User ${suffix} ${index}`,
        createdAt: new Date(now - (index + 1) * 60_000).toISOString(),
    }));
    const applications = Array.from({ length: 42 }, (_, index) => ({
        clientId: Array.from(randomBytes(32), (value) => String.fromCharCode(65 + value % 26)).join(''),
        name: `ui-oauth-${randomUUID()}-${index}`, createdAt: new Date(now - (index + 1) * 60_000).toISOString(),
    }));
    fixtureEmails.push(...users.map((value) => value.email));
    fixtureClients.push(...applications.map((value) => value.clientId));
    const administrator = users[0];
    const statements = users.map((user, index) => `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned, locale, username) VALUES ('${user.id}', '${user.name}', '${user.email}', 1, '${user.createdAt}', '${user.createdAt}', '${index === 0 ? 'admin' : 'user'}', 0, 'en-US', '${user.username}');`);
    statements.push(`INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ('${randomUUID()}', '${administrator.id}', 'credential', '${administrator.id}', '${await hashPassword(password)}', '${nowIso}', '${nowIso}');`);
    for (const [index, application] of applications.entries()) {
        statements.push(`INSERT INTO "oauthClient" (id, "clientId", name, "userId", "referenceId", metadata, "createdAt", "updatedAt", disabled, "tokenEndpointAuthMethod", "applicationType", "redirectUris", "postLogoutRedirectUris", scopes, "grantTypes", "responseTypes", "requirePKCE", "skipConsent", "enableEndSession") VALUES ('${randomUUID()}', '${application.clientId}', '${application.name}', '${administrator.id}', 'loginflare', '{"loginflareRedirectOrigins":["https://app.example.test"]}', '${application.createdAt}', '${application.createdAt}', ${index % 3 === 0 ? 1 : 0}, '${index % 2 === 0 ? 'client_secret_basic' : 'none'}', 'web', '["https://app.example.test/callback"]', '["https://app.example.test/"]', '["openid","profile"]', '["authorization_code","refresh_token"]', '["code"]', 1, 0, 1);`);
    }
    for (let index = 0; index < 20; index++) {
        const timestamp = new Date(now - (index + 1) * 3_600_000).toISOString();
        const expiresAt = new Date(now + 7 * 86_400_000).toISOString();
        statements.push(`INSERT INTO session (id, token, "userId", "createdAt", "updatedAt", "expiresAt", "ipAddress", "userAgent") VALUES ('${randomUUID()}', '${randomUUID()}', '${administrator.id}', '${timestamp}', '${timestamp}', '${expiresAt}', '192.0.2.${index + 1}', 'Pagination fixture ${index}');`);
    }
    executeLocal(statements.join('\n'));

    const legacyRequests: string[] = [];
    page.on('request', (request) => {
        if (/\/api\/auth\/(?:admin\/list-users|list-sessions)(?:\?|$)/.test(request.url())) legacyRequests.push(request.url());
    });
    await page.route(`${testOrigin}/api/**`, (route) => route.continue({ headers: { ...route.request().headers(), 'cf-connecting-ip': '192.0.2.72' } }));
    await page.goto('/en-us/login');
    await page.getByLabel('Email or username', { exact: true }).fill(administrator.username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled({ timeout: 25_000 });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL('/en-us/account');
    await page.getByRole('link', { name: 'Administration', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(20);
    await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Return to latest', exact: true })).toBeDisabled();
    const firstUsers = await page.locator('tbody tr').allTextContents();
    const secondUsers = await changePage(page, '/api/admin/users', 'Next');
    await expect(page.locator('tbody tr').first()).toContainText(secondUsers.items[0].email);
    expect(await page.locator('tbody tr').allTextContents()).not.toEqual(firstUsers);
    await page.reload();
    await expect(page.locator('tbody tr').first()).toContainText(secondUsers.items[0].email);
    await changePage(page, '/api/admin/users', 'Next');
    const restoredUsers = await changePage(page, '/api/admin/users', 'Previous');
    await expect(page.locator('tbody tr').first()).toContainText(restoredUsers.items[0].email);
    const userListUrl = page.url();
    await page.locator('.table-user').first().click();
    await expect(page.getByRole('heading', { name: 'User details', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Back to users', exact: true }).click();
    await expect(page).toHaveURL(userListUrl);
    await expect(page.locator('tbody tr').first()).toContainText(restoredUsers.items[0].email);
    await selectLookup(page, 'Username');
    await page.getByLabel('Find a user', { exact: true }).fill(users[8].username.toUpperCase());
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText(users[8].email);
    expect(new URL(page.url()).searchParams.has('cursor')).toBe(false);
    expect(new URL(page.url()).searchParams.get('lookupField')).toBe('username');
    const filteredUsersUrl = page.url();
    await page.locator('.table-user').click();
    await page.getByRole('link', { name: 'Back to users', exact: true }).click();
    await expect(page).toHaveURL(filteredUsersUrl);
    await selectLookup(page, 'Account ID');
    await page.getByLabel('Find a user', { exact: true }).fill(users[9].id);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.locator('tbody tr')).toContainText(users[9].email);
    await page.getByLabel('Find a user', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL('/en-us/admin/users');
    await expect(page.locator('tbody tr')).toHaveCount(20);
    await changePage(page, '/api/admin/users', 'Next');
    await page.getByRole('button', { name: 'Return to latest', exact: true }).click();
    await expect(page).toHaveURL('/en-us/admin/users');
    await expect(page.locator('tbody tr')).toHaveCount(20);

    await page.getByRole('link', { name: 'Applications', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(20);
    const secondApplications = await changePage(page, '/api/admin/applications', 'Next');
    await expect(page.locator('tbody tr').first()).toContainText(secondApplications.items[0].name);
    const applicationListUrl = page.url();
    await page.locator('.application-name').first().click();
    await expect(page.getByRole('heading', { name: 'Application details', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Back to applications', exact: true }).click();
    await expect(page).toHaveURL(applicationListUrl);
    await expect(page.locator('tbody tr').first()).toContainText(secondApplications.items[0].name);
    await selectLookup(page, 'Application name');
    await page.getByLabel('Find an application', { exact: true }).fill(applications[3].name);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText(applications[3].name);
    expect(new URL(page.url()).searchParams.has('cursor')).toBe(false);
    await selectLookup(page, 'Client ID');
    await page.getByLabel('Find an application', { exact: true }).fill(applications[4].clientId);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.locator('tbody tr')).toContainText(applications[4].name);
    await page.reload();
    await expect(page.locator('tbody tr')).toContainText(applications[4].name);

    await page.getByRole('link', { name: 'Account center', exact: true }).click();
    await page.getByRole('link', { name: 'Sessions', exact: true }).click();
    await expect(page.locator('.session-row')).toHaveCount(20);
    await expect(page.getByText('This session', { exact: true })).toBeVisible();
    const laterSessions = await changePage(page, '/api/account/sessions', 'Next');
    expect(laterSessions.items).toHaveLength(1);
    await expect(page.locator('.session-row')).toHaveCount(1);
    await expect(page.getByText('This session', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign out other sessions', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Sign out other sessions', exact: true }).click();
    await expect(page).toHaveURL('/en-us/account/sessions');
    await expect(page.locator('.session-row')).toHaveCount(1);
    await expect(page.getByText('This session', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out other sessions', exact: true })).toBeDisabled();

    for (const entry of [
        { path: '/en-us/admin/users', lookupField: 'username', lookupValue: users[8].username, expected: users[8].email, selector: 'tbody tr' },
        { path: '/en-us/admin/applications', lookupField: 'name', lookupValue: applications[4].name, expected: applications[4].name, selector: 'tbody tr' },
        { path: '/en-us/account/sessions', lookupField: '', lookupValue: '', expected: 'This session', selector: '.session-row' },
    ]) {
        const parameters = new URLSearchParams({ cursor: 'invalid-cursor' });
        if (entry.lookupField) { parameters.set('lookupField', entry.lookupField); parameters.set('lookupValue', entry.lookupValue); }
        await page.goto(`${entry.path}?${parameters}`);
        await expect(page.getByRole('alert')).toHaveText('This page link is no longer valid. Return to the latest records.');
        await page.getByRole('button', { name: 'Return to latest', exact: true }).click();
        parameters.delete('cursor');
        await expect(page).toHaveURL(`${entry.path}${parameters.size ? `?${parameters}` : ''}`);
        await expect(page.locator(entry.selector)).toHaveCount(1);
        await expect(page.locator(entry.selector)).toContainText(entry.expected);
    }

    const identity = await (await page.request.get('/api/auth/get-session')).json();
    expect(identity.user.id).toBe(administrator.id);
    const sessionId = String(identity.session.id).replaceAll("'", "''");
    executeLocal(`UPDATE session SET "createdAt" = '${new Date(now - 2 * 86_400_000).toISOString()}' WHERE id = '${sessionId}' AND "userId" = '${administrator.id}';`);
    try {
        await page.goto('/en-us/account/sessions');
        await expect(page.getByRole('alert')).toHaveText('Sign out and sign in again to view and manage your sessions.');
        await page.goto('/zh-cn/account/sessions');
        await expect(page.getByRole('alert')).toHaveText('请退出并重新登录，以查看和管理登录会话。');
    } finally {
        executeLocal(`UPDATE session SET "createdAt" = '${new Date().toISOString()}' WHERE id = '${sessionId}' AND "userId" = '${administrator.id}';`);
    }
    expect(legacyRequests).toEqual([]);
});
