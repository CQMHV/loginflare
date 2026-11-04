import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { expect, test } from './fixtures';
import { executeLocal, removeLocalApplications, removeLocalFixtures } from './database';
import { testOrigin } from './runtime';

test('persists API resources, application access and user business roles through the real console', async ({ page, context }) => {
    test.setTimeout(120_000);
    const password = 'Isolated-api-management-492!', now = new Date().toISOString(), hash = await hashPassword(password), tag = randomUUID().slice(0, 8);
    const administrator = { id: randomUUID(), email: `ui-${randomUUID()}@loginflare.test` }, member = { id: randomUUID(), email: `ui-${randomUUID()}@loginflare.test` };
    const resourceName = `Orders API ${tag}`, roleName = `Order reader ${tag}`, permissionName = `Read orders ${tag}`, scope = `orders:${tag}:read`;
    const identifier = `https://api-${tag}.example.test/orders`, headers = { Origin: testOrigin };
    let resourceId = '', roleId = '', clientId = '';
    try {
        for (const [user, role] of [[administrator, 'admin'], [member, 'user']] as const) {
            executeLocal(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned, locale)
                VALUES ('${user.id}', 'API console test', '${user.email}', 1, '${now}', '${now}', '${role}', 0, 'en-US');
                INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
                VALUES ('${randomUUID()}', '${user.id}', 'credential', '${user.id}', '${hash}', '${now}', '${now}');`);
        }
        await page.goto('/en-us/login');
        await page.getByLabel('Email or username', { exact: true }).fill(administrator.email);
        await page.getByLabel('Password', { exact: true }).fill(password);
        await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await expect(page).toHaveURL('/en-us/account');
        const client = await context.request.post('/api/developer/applications', { headers, data: { name: `ui-oauth-${randomUUID()}`, type: 'web', redirectUris: ['https://api-app.example.test/callback'], postLogoutRedirectUris: ['https://api-app.example.test/'], scopes: ['openid', 'profile', 'email', 'offline_access'] } });
        expect(client.status(), await client.text()).toBe(201); clientId = (await client.json()).application.clientId;

        await page.goto('/en-us/admin/access/resources');
        await page.getByRole('button', { name: 'Create API resource', exact: true }).click();
        let dialog = page.locator('md-dialog.form-dialog');
        await dialog.getByLabel('Resource name', { exact: true }).fill(resourceName);
        await dialog.getByLabel('API identifier', { exact: true }).fill(identifier);
        await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await page.getByRole('link', { name: resourceName, exact: true }).click();
        await expect(page).toHaveURL((url) => url.pathname === '/en-us/admin/access/resources/detail' && !!url.searchParams.get('id'));
        resourceId = new URL(page.url()).searchParams.get('id')!;
        await page.getByRole('button', { name: 'Create permission', exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
        await dialog.getByLabel('Permission name', { exact: true }).fill(permissionName);
        await dialog.getByLabel('Permission scope', { exact: true }).fill(scope);
        await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await page.getByRole('button', { name: 'Allow application', exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
        await dialog.getByLabel('Client ID', { exact: true }).fill(clientId);
        await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await page.reload();
        await expect(page.getByText(scope, { exact: true })).toBeVisible();
        await expect(page.getByText(clientId, { exact: true })).toBeVisible();

        await page.goto('/en-us/admin/access/roles');
        await page.getByRole('button', { name: 'Create role', exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
        await dialog.getByLabel('Role name', { exact: true }).fill(roleName);
        await dialog.getByRole('checkbox', { name: `${permissionName} (${scope})`, exact: true }).check();
        await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(page.getByText(roleName, { exact: true })).toBeVisible();
        const roles = await context.request.get(`/api/admin/access/roles?${new URLSearchParams({ lookupField: 'name', lookupValue: roleName })}`);
        expect(roles.status()).toBe(200); roleId = (await roles.json()).items[0].id;
        await page.goto(`/en-us/admin/users/detail?id=${member.id}`);
        await page.getByRole('button', { name: 'Manage business roles', exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
        await dialog.getByRole('checkbox', { name: roleName, exact: true }).check();
        await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await page.reload();
        await expect(page.getByText(roleName, { exact: true })).toBeVisible();
        const target = await context.request.get(`/api/auth/admin/get-user?id=${member.id}`);
        expect((await target.json()).role).toBe('user');

        await page.goto(`/en-us/developer/applications/detail?clientId=${clientId}`);
        await expect(page.getByRole('heading', { name: 'Business API scopes', exact: true })).toBeVisible();
        await expect(page.getByText(scope, { exact: true })).toBeVisible();
        await page.getByLabel('Application name', { exact: true }).fill(`ui-oauth-updated-${tag}`);
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(page.getByRole('status').filter({ hasText: 'Application updated.' })).toBeVisible();
        await page.reload();
        await expect(page.getByText(scope, { exact: true })).toBeVisible();

        await page.goto(`/en-us/admin/audit-logs?${new URLSearchParams({ lookupField: 'targetUserId', lookupValue: member.id })}`);
        await page.getByRole('button', { name: 'Details: access.user.roles.updated', exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
        await expect(dialog.getByText(administrator.id, { exact: true })).toBeVisible();
        await expect(dialog.getByText(member.id, { exact: true }).first()).toBeVisible();
        await expect(dialog.getByText('User business roles changed', { exact: false })).toBeVisible();
        await expect(dialog.getByText(password, { exact: true })).toHaveCount(0);
    } finally {
        if (resourceId) await context.request.delete(`/api/admin/access/resources/${resourceId}`, { headers });
        if (roleId) await context.request.delete(`/api/admin/access/roles/${roleId}`, { headers });
        if (clientId) removeLocalApplications([clientId]);
        removeLocalFixtures([administrator.email, member.email]);
    }
});
