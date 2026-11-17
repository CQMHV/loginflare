import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { expect, installOfflineRoutes, test } from './fixtures';
import { executeLocal, removeLocalFixtures } from './database';
import { testOrigin } from './runtime';
import { defaultConnectionConfig } from '../../src/shared/social';
import type { Response as BrowserResponse } from '@playwright/test';

test('uploads a provider icon through the real API and displays it directly from R2 on the public login page', async ({ page, context, browser }) => {
    const id = randomUUID(), email = `ui-${randomUUID()}@loginflare.test`, password = 'Public-media-test-731!';
    const now = new Date().toISOString(), hashed = await hashPassword(password);
    let providerId: string | undefined;
    executeLocal(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned, locale) VALUES ('${id}', 'Media administrator', '${email}', 1, '${now}', '${now}', 'admin', 0, 'en-US');
        INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ('${randomUUID()}', '${id}', 'credential', '${id}', '${hashed}', '${now}', '${now}');`);
    try {
        await page.goto('/en-us/login');
        await page.getByLabel('Email or username', { exact: true }).fill(email);
        await page.getByLabel('Password', { exact: true }).fill(password);
        await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await expect(page).toHaveURL('/en-us/account');
        const uploaded = await context.request.post(`${testOrigin}/api/admin/social-connections/icon`, {
            headers: { Origin: testOrigin, 'Content-Type': 'image/svg+xml' },
            data: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="red"/></svg>',
        });
        expect(uploaded.status()).toBe(200);
        const icon = await uploaded.json() as { iconId: string; iconUrl: string };
        expect(new URL(icon.iconUrl).hostname).toBe('127.0.0.1');
        const created = await context.request.post(`${testOrigin}/api/admin/social-connections`, {
            headers: { Origin: testOrigin }, data: {
                name: 'Direct media provider', type: 'google', config: { ...defaultConnectionConfig('google'), clientId: 'isolated-media-client' },
                clientSecret: 'isolated-media-secret', enabled: true, archived: false, revision: 0, iconId: icon.iconId,
            },
        });
        expect(created.status(), await created.text()).toBe(201);
        const provider = await created.json() as { id: string; iconUrl: string; revision: number };
        providerId = provider.id; expect(provider.iconUrl).toBe(icon.iconUrl);
        // New connectors intentionally start disabled until explicitly enabled.
        const enabled = await context.request.patch(`${testOrigin}/api/admin/social-connections/${provider.id}`, {
            headers: { Origin: testOrigin }, data: {
                name: 'Direct media provider', type: 'google', config: { ...defaultConnectionConfig('google'), clientId: 'isolated-media-client' },
                enabled: true, archived: false, revision: provider.revision, iconId: icon.iconId,
            },
        });
        expect(enabled.status(), await enabled.text()).toBe(200);
        const anonymous = await browser.newContext();
        try {
            await installOfflineRoutes(anonymous);
            const login = await anonymous.newPage();
            let served: BrowserResponse | undefined;
            login.on('response', (response) => { if (response.url() === icon.iconUrl) served = response; });
            await login.goto(`${testOrigin}/en-us/login`);
            const button = login.getByRole('button', { name: 'Continue with Direct media provider', exact: true });
            const image = login.locator('md-outlined-button').filter({ has: button }).locator('.provider-icon img');
            await expect(image).toHaveAttribute('src', icon.iconUrl);
            await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(24);
            expect(served).toBeDefined();
            expect(served!.status()).toBe(200); expect(served!.headers()['x-loginflare-test-worker']).toBeUndefined();
            expect(served!.request().headers()['cookie']).toBeUndefined();
            expect(served!.request().headers()['referer']).toBeUndefined();
        } finally { await anonymous.close(); }
    } finally {
        if (providerId) executeLocal(`DELETE FROM "socialConnection" WHERE "id" = '${providerId}' AND "name" = 'Direct media provider'`);
        removeLocalFixtures([email]);
    }
});
