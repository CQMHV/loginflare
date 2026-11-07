import { expect, test } from '@playwright/test';
import { testOrigin } from './runtime';

test('setup shows Cloudflare progress, then only requests the email link on the formal domain', async ({ page }) => {
    let statusRequests = 0;
    await page.route('**/api/setup/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/status')) {
            const ready = ++statusRequests >= 2;
            await route.fulfill({ json: { step: ready ? 'ready' : 'sending', canonical: ready, canStart: !ready,
                publicUrl: ready ? testOrigin : undefined, completed: false, branding: { name: 'Example Accounts', logoUrl: '/favicon.svg' } } });
        } else if (path.endsWith('/start')) {
            expect(route.request().postDataJSON()).toEqual({});
            await route.fulfill({ status: 202, json: {} });
        } else if (path.endsWith('/invite')) {
            expect(route.request().postDataJSON()).toEqual({ locale: 'en-US' });
            await route.fulfill({ status: 202, json: {} });
        } else throw new Error(`Unexpected path: ${path}`);
    });
    await page.goto('/en-us/setup');
    await expect(page.locator('.setup-brand')).toHaveText('Example Accounts');
    await expect(page).toHaveTitle('Example Accounts');
    await expect(page.getByText('Configuring email delivery')).toBeVisible();
    await page.getByRole('button', { name: 'Send setup link' }).click();
    await expect(page.getByText('Check that mailbox for the link.')).toBeVisible();
    await expect(page.locator('input')).toHaveCount(0);
});

test('an email link opens username and password setup without persisting the proof', async ({ page }) => {
    const token = 'a'.repeat(64);
    await page.route('**/api/setup/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/status')) await route.fulfill({ json: {
            step: 'ready', canonical: true, publicUrl: testOrigin, completed: false, branding: { name: 'Example Accounts', logoUrl: '/favicon.svg' }, canStart: false,
        } });
        else if (path.endsWith('/claim')) {
            expect(route.request().postDataJSON()).toEqual({ token, username: 'first_admin', password: 'Example test password only', locale: 'en-US' });
            await route.fulfill({ json: {} });
        } else throw new Error(`Unexpected path: ${path}`);
    });
    await page.goto(`/en-us/setup#${token}`);
    await page.getByLabel('Username').fill('first_admin');
    await page.getByLabel('Password').fill('Example test password only');
    await expect(page).toHaveURL(/\/en-us\/setup$/);
    await page.getByRole('button', { name: 'Create administrator' }).click();
    await expect(page.getByText('Installation is complete.')).toBeVisible();
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(token);
});
