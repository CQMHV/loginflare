import { randomUUID } from 'node:crypto';
import { expect, test } from './fixtures';
import { testOrigin } from './runtime';
import { executeLocal, removeLocalFixtures } from './database';
import { snapshotEmails, waitForCode, waitForMail } from './mailbox';
import { defaultConnectionConfig } from '../../src/shared/social';

test('completes email verification before creating a passwordless social account and sets a username later', async ({ page, context }) => {
    test.setTimeout(90_000);
    const administrator = `ui-${randomUUID()}@loginflare.test`, email = `ui-${randomUUID()}@loginflare.test`;
    const subject = `ui-social-${randomUUID()}`, name = `Google email ${randomUUID().slice(0, 8)}`, password = 'Social-email-password-917!';
    let connectionId = '';
    await context.route('https://accounts.google.com/**', async (route) => {
        const authorization = new URL(route.request().url());
        const code = Buffer.from(JSON.stringify({ sub: subject, email, unverified: true, nonce: authorization.searchParams.get('nonce') })).toString('base64url');
        const callback = new URL(authorization.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', code); callback.searchParams.set('state', authorization.searchParams.get('state')!);
        await route.fulfill({ status: 302, headers: { Location: callback.href }, body: '' });
    });
    try {
        const before = await snapshotEmails();
        expect((await context.request.post('/api/auth/sign-up/email', { headers: { Origin: testOrigin, 'x-captcha-response': 'isolated-e2e-captcha-token' }, data: { name: 'Email Administrator', email: administrator, password, locale: 'en-US', callbackURL: `${testOrigin}/en-us/verified` } })).status()).toBe(200);
        await page.goto(await waitForMail(before, 'verify'));
        expect((await context.request.post('/api/auth/sign-in/email', { headers: { Origin: testOrigin, 'x-captcha-response': 'isolated-e2e-captcha-token' }, data: { email: administrator, password } })).status()).toBe(200);
        executeLocal(`UPDATE "user" SET "role" = 'admin' WHERE "email" = '${administrator}';`);
        const input = { name, type: 'google', config: { ...defaultConnectionConfig('google'), clientId: 'isolated-email-client' }, clientSecret: 'isolated-email-secret', enabled: false, archived: false, revision: 0 };
        const created = await context.request.post('/api/admin/social-connections', { headers: { Origin: testOrigin }, data: input });
        expect(created.status(), await created.text()).toBe(201); connectionId = (await created.json()).id;
        expect((await context.request.patch(`/api/admin/social-connections/${connectionId}`, { headers: { Origin: testOrigin }, data: { ...input, enabled: true } })).status()).toBe(200);
        await context.request.post('/api/auth/sign-out', { headers: { Origin: testOrigin }, data: {} });
        await page.goto('/en-us/signup');
        await page.getByRole('button', { name: `Continue with ${name}`, exact: true }).click();
        await expect(page.getByText('Enter and verify your email address to finish creating your account.')).toBeVisible();
        expect(await (await context.request.get('/api/auth/get-session')).json()).toBeNull();
        await page.getByLabel('Email address', { exact: true }).fill(administrator);
        await page.getByRole('button', { name: 'Send verification code', exact: true }).click();
        await expect(page.getByRole('alert')).toContainText('This email is already in use.');
        await page.getByLabel('Email address', { exact: true }).fill(email);
        const mailbox = await snapshotEmails();
        await page.getByRole('button', { name: 'Send verification code', exact: true }).click();
        const code = await waitForCode(mailbox);
        expect(await (await context.request.get('/api/auth/get-session')).json()).toBeNull();
        await page.getByLabel('Verification code', { exact: true }).fill(code);
        await page.getByRole('button', { name: 'Verify email', exact: true }).click();
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect(page).toHaveURL('/en-us/account');
        await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('');
        await expect(page.getByRole('button', { name: 'Account menu', exact: true })).toHaveAttribute('aria-description', email);
        const username = `ui_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
        await page.getByLabel('Username', { exact: true }).fill(username);
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(page.getByRole('status').filter({ hasText: 'Your changes have been saved.' })).toBeVisible();
        expect((await (await context.request.get('/api/auth/get-session')).json()).user).toMatchObject({ name: '', username, email });
    } finally {
        removeLocalFixtures([administrator, email]);
        if (connectionId) executeLocal(`DELETE FROM "socialFlow" WHERE "connectionId" = '${connectionId}'; DELETE FROM "socialConnection" WHERE "id" = '${connectionId}';`);
    }
});
