import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { expect, installOfflineRoutes, test } from './fixtures';
import { executeLocal, removeLocalFixtures } from './database';
import { testOrigin } from './runtime';
import { defaultConnectionConfig } from '../../src/shared/social';
import { authenticatorCode } from '../totp';

test('adds a social account with MFA while retaining the original account in another tab', async ({ page, context, browser }) => {
    test.setTimeout(120_000);
    const password = 'Browser-social-MFA-482!', hash = await hashPassword(password), now = new Date().toISOString();
    const alpha = { id: randomUUID(), email: `ui-${randomUUID()}@loginflare.test` };
    const beta = { id: randomUUID(), email: `ui-${randomUUID()}@loginflare.test` };
    const subject = `ui-social-${randomUUID()}`, providerName = `Browser Google ${randomUUID().slice(0, 8)}`;
    let connectionId = '';
    await context.route('https://accounts.google.com/**', async (route) => {
        const authorization = new URL(route.request().url());
        const code = Buffer.from(JSON.stringify({ sub: subject, email: beta.email, name: 'Social Beta', nonce: authorization.searchParams.get('nonce') })).toString('base64url');
        const callback = new URL(authorization.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', code); callback.searchParams.set('state', authorization.searchParams.get('state')!);
        await route.fulfill({ status: 302, headers: { Location: callback.href }, body: '' });
    });
    try {
        for (const [item, name, role] of [[alpha, 'Local Alpha', 'admin'], [beta, 'Social Beta', 'user']] as const) {
            executeLocal(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned, locale)
                VALUES ('${item.id}', '${name}', '${item.email}', 1, '${now}', '${now}', '${role}', 0, 'en-US');
                INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
                VALUES ('${randomUUID()}', '${item.id}', 'credential', '${item.id}', '${hash}', '${now}', '${now}');`);
        }
        const captchaHeaders = { Origin: testOrigin, 'x-captcha-response': 'isolated-e2e-captcha-token' };
        const signedIn = await context.request.post('/api/auth/sign-in/email', { headers: captchaHeaders, data: { email: alpha.email, password } });
        expect(signedIn.status(), await signedIn.text()).toBe(200);
        const input = { name: providerName, type: 'google', config: { ...defaultConnectionConfig('google'), clientId: 'isolated-social-client' }, clientSecret: 'isolated-social-secret', enabled: false, archived: false, revision: 0 };
        const created = await context.request.post('/api/admin/social-connections', { headers: { Origin: testOrigin }, data: input });
        expect(created.status(), await created.text()).toBe(201); connectionId = (await created.json()).id;
        const enabled = await context.request.patch(`/api/admin/social-connections/${connectionId}`, { headers: { Origin: testOrigin }, data: { ...input, enabled: true } });
        expect(enabled.status(), await enabled.text()).toBe(200);
        executeLocal(`INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES ('${randomUUID()}', '${subject}', '${connectionId}', '${beta.id}', '${now}', '${now}');`);

        const setup = await browser.newContext({ baseURL: testOrigin });
        let totpURI = '';
        try {
            await installOfflineRoutes(setup);
            expect((await setup.request.post('/api/auth/sign-in/email', { headers: captchaHeaders, data: { email: beta.email, password } })).status()).toBe(200);
            const enrollment = await setup.request.post('/api/auth/two-factor/enable', { headers: { Origin: testOrigin }, data: { password } });
            expect(enrollment.status(), await enrollment.text()).toBe(200);
            totpURI = (await enrollment.json()).totpURI;
            const verified = await setup.request.post('/api/auth/two-factor/verify-totp', { headers: { Origin: testOrigin }, data: { code: await authenticatorCode(totpURI) } });
            expect(verified.status(), await verified.text()).toBe(200);
        } finally { await setup.close(); }

        await page.goto('/en-us/account');
        await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Local Alpha');
        const alphaAccountId = await page.evaluate(() => sessionStorage.getItem('loginflare.account'));
        const alphaTab = await context.newPage();
        await alphaTab.goto('/en-us/account');
        await expect(alphaTab.getByLabel('Display name', { exact: true })).toHaveValue('Local Alpha');
        await page.getByRole('button', { name: 'Account menu', exact: true }).click();
        await page.getByRole('button', { name: 'Add an account', exact: true }).click();
        await page.getByRole('button', { name: `Continue with ${providerName}`, exact: true }).click();
        await expect(page.getByLabel('Authenticator code', { exact: true })).toBeVisible();
        const pending = await context.request.get('/api/browser/accounts');
        expect((await pending.json()).accounts.filter((item: { status: string }) => item.status === 'active')).toHaveLength(1);
        const retained = await context.request.get('/api/auth/get-session', { headers: { 'X-Loginflare-Account': alphaAccountId! } });
        expect((await retained.json()).user.id).toBe(alpha.id);
        await page.getByLabel('Authenticator code', { exact: true }).fill(await authenticatorCode(totpURI));
        await page.getByRole('button', { name: 'Verify sign-in', exact: true }).click();
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Social Beta');
        await alphaTab.reload();
        await expect(alphaTab.getByLabel('Display name', { exact: true })).toHaveValue('Local Alpha');
        const accounts = await context.request.get('/api/browser/accounts');
        expect((await accounts.json()).accounts.filter((item: { status: string }) => item.status === 'active')).toHaveLength(2);
    } finally {
        removeLocalFixtures([alpha.email, beta.email]);
        if (connectionId) executeLocal(`DELETE FROM "socialFlow" WHERE "connectionId" = '${connectionId}'; DELETE FROM "socialConnection" WHERE "id" = '${connectionId}';`);
    }
});
