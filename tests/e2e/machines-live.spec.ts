import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { expect, test } from './fixtures';
import { executeLocal, removeLocalApplications, removeLocalFixtures } from './database';
import { testOrigin } from './runtime';

test('persists machine credentials and roles through the real console and authenticates a service', async ({ page, context, request: service }) => {
    test.setTimeout(180_000);
    const password = 'Isolated-machine-console-492!', now = new Date().toISOString(), hash = await hashPassword(password), tag = randomUUID().slice(0, 8);
    const administrator = { id: randomUUID(), email: `ui-${randomUUID()}@loginflare.test` };
    const roleName = `Machine reader ${tag}`, applicationName = `ui-oauth-machine-${tag}`, headers = { Origin: testOrigin };
    let roleId = '', clientId = '', clientSecret = '';
    async function issue(secret = clientSecret) {
        return service.post(`${testOrigin}/api/auth/oauth2/token`, {
            headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}` },
            form: { grant_type: 'client_credentials', resource: 'urn:loginflare:management', scope: 'management:users:read' },
        });
    }
    async function users(accessToken: string) {
        return service.get(`${testOrigin}/api/management/v1/users?limit=1`, { headers: { Authorization: `Bearer ${accessToken}` } });
    }
    try {
        executeLocal(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned, locale)
            VALUES ('${administrator.id}', 'Machine console test', '${administrator.email}', 1, '${now}', '${now}', 'admin', 0, 'en-US');
            INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
            VALUES ('${randomUUID()}', '${administrator.id}', 'credential', '${administrator.id}', '${hash}', '${now}', '${now}');`);
        await page.goto('/en-us/login');
        await page.getByLabel('Email or username', { exact: true }).fill(administrator.email);
        await page.getByLabel('Password', { exact: true }).fill(password);
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await expect(page).toHaveURL('/en-us/account');

        await page.goto('/en-us/admin/machines/roles');
        await page.getByRole('button', { name: 'Create machine role', exact: true }).click();
        let dialog = page.locator('md-dialog.form-dialog');
        await dialog.getByLabel('Role name', { exact: true }).fill(roleName);
        await dialog.getByRole('checkbox', { name: 'Read users (management:users:read)', exact: true }).check();
        await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        const roles = await context.request.get(`/api/admin/machines/roles?${new URLSearchParams({ lookupField: 'name', lookupValue: roleName })}`);
        expect(roles.status(), await roles.text()).toBe(200); roleId = (await roles.json()).items[0].id;

        await page.goto('/en-us/admin/machines/applications');
        await page.getByRole('button', { name: 'Create machine application', exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
        await dialog.getByLabel('Application name', { exact: true }).fill(applicationName);
        await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(dialog.getByLabel('Client secret', { exact: true })).toBeVisible();
        clientId = await dialog.getByLabel('Client ID', { exact: true }).inputValue();
        clientSecret = await dialog.getByLabel('Client secret', { exact: true }).inputValue();
        expect(clientSecret.length).toBeGreaterThan(20);
        expect(await page.evaluate(() => JSON.stringify([sessionStorage, localStorage]))).not.toContain(clientSecret);
        await dialog.getByRole('button', { name: 'I have saved the secret', exact: true }).click();
        await expect(page).toHaveURL((url) => url.pathname === '/en-us/admin/machines/applications/detail' && url.searchParams.get('clientId') === clientId);
        await expect(page.getByLabel('Token endpoint', { exact: true })).toHaveValue(`${testOrigin}/api/auth/oauth2/token`);
        await expect(page.getByLabel('Client secret', { exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: 'Assign machine roles', exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
        await dialog.getByRole('checkbox', { name: roleName, exact: true }).check();
        await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await page.reload();
        await expect(page.getByText(roleName, { exact: true })).toBeVisible();
        await expect(page.getByText('management:users:read', { exact: true })).toBeVisible();
        const first = await issue(); expect(first.status(), await first.text()).toBe(200);
        const firstToken = (await first.json()).access_token as string;
        expect((await users(firstToken)).status()).toBe(200);
        const denied = await service.get(`${testOrigin}/api/management/v1/resources`, { headers: { Authorization: `Bearer ${firstToken}` } });
        expect(denied.status()).toBe(403);

        await page.getByRole('button', { name: 'Rotate client secret', exact: true }).click();
        dialog = page.locator('md-dialog');
        await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect(dialog.getByLabel('Client secret', { exact: true })).toBeVisible();
        const previousSecret = clientSecret; clientSecret = await dialog.getByLabel('Client secret', { exact: true }).inputValue();
        expect(clientSecret).not.toBe(previousSecret);
        await dialog.getByRole('button', { name: 'I have saved the secret', exact: true }).click();
        expect((await issue(previousSecret)).status()).toBeGreaterThanOrEqual(400);
        const rotated = await issue(); expect(rotated.status(), await rotated.text()).toBe(200);
        const rotatedToken = (await rotated.json()).access_token as string;
        expect((await users(rotatedToken)).status()).toBe(200);
        await page.getByRole('button', { name: 'Revoke access tokens', exact: true }).click();
        await page.locator('md-dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect(page.locator('md-dialog')).toHaveCount(0);
        expect((await users(rotatedToken)).status()).toBe(401);
        const current = await issue(); expect(current.status(), await current.text()).toBe(200);
        await page.getByRole('button', { name: 'Disable machine application', exact: true }).click();
        await page.locator('md-dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Enable machine application', exact: true })).toBeVisible();
        expect((await issue()).status()).toBeGreaterThanOrEqual(400);

        await page.goto(`/en-us/admin/audit-logs?${new URLSearchParams({ lookupField: 'actorClientId', lookupValue: clientId })}`);
        await expect(page.locator('.machine-actor-label').first()).toBeVisible();
        await page.getByRole('button', { name: 'Details: machine.token_issued', exact: true }).first().click();
        dialog = page.locator('md-dialog.form-dialog');
        await expect(dialog.getByText('Machine actor', { exact: true })).toBeVisible();
        await expect(dialog.getByText(clientId, { exact: true }).first()).toBeVisible();
        await expect(dialog.getByText(clientSecret, { exact: true })).toHaveCount(0);
    } finally {
        if (roleId) await context.request.delete(`/api/admin/machines/roles/${roleId}`, { headers });
        if (clientId) removeLocalApplications([clientId]);
        removeLocalFixtures([administrator.email]);
    }
});
