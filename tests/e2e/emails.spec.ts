import { testOrigin } from './runtime';
import { expect, test } from './fixtures';
import { randomUUID } from 'node:crypto';
import { removeLocalFixtures } from './database';
import { snapshotEmails, waitForCode, waitForMail } from './mailbox';

const fixtureEmails: string[] = [];
test.afterEach(() => {
    removeLocalFixtures(fixtureEmails);
    fixtureEmails.length = 0;
});

test('manages email addresses and recovers the same account through a secondary email', async ({ page }) => {
    test.setTimeout(150_000);
    const primary = `ui-${randomUUID()}@loginflare.test`;
    const secondary = `ui-${randomUUID()}@loginflare.test`;
    const username = `mail_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const password = 'Email-browser-password-917!';
    const recovered = 'Recovered-email-password-619!';
    fixtureEmails.push(primary, secondary);
    await page.route(`${testOrigin}/api/**`, (route) => route.continue({
        headers: { ...route.request().headers(), 'cf-connecting-ip': '192.0.2.60' },
    }));
    await page.emulateMedia({ colorScheme: 'light' });
    const beforeSignup = await snapshotEmails();
    await page.goto('/en-us/signup');
    await page.getByLabel('Display name', { exact: true }).fill('Email Browser Person');
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Email address', { exact: true }).fill(primary);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('Confirm password', { exact: true }).fill(password);
    await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeEnabled({ timeout: 25_000 });
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    await page.goto(await waitForMail(beforeSignup, 'verify'));

    async function signIn(identifier: string, candidate: string, expectedStatus = 200) {
        await page.goto('/en-us/login');
        await page.getByLabel('Email or username', { exact: true }).fill(identifier);
        await page.getByLabel('Password', { exact: true }).fill(candidate);
        await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled({ timeout: 25_000 });
        const endpoint = identifier.includes('@') ? '/api/auth/sign-in/email' : '/api/auth/sign-in/username';
        const signedIn = page.waitForResponse((response) => response.url() === `${testOrigin}${endpoint}`
            && response.request().method() === 'POST', { timeout: 60_000 });
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        expect((await signedIn).status()).toBe(expectedStatus);
    }

    await signIn(username, password);
    await expect(page).toHaveURL('/en-us/account');
    const original = await (await page.request.get('/api/auth/get-session')).json();
    await page.getByRole('link', { name: 'Email addresses', exact: true }).click();
    await expect(page).toHaveURL('/en-us/account/emails');
    await expect(page.getByRole('button', { name: `Remove email: ${primary}`, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Add email address', exact: true }).click();
    await page.getByLabel('New email address', { exact: true }).fill(secondary.toUpperCase());
    await page.getByLabel('Current password', { exact: true }).fill(password);
    const beforeAdd = await snapshotEmails();
    await page.getByRole('button', { name: 'Send verification code', exact: true }).click();
    await page.getByLabel('Verification code', { exact: true }).fill(await waitForCode(beforeAdd));
    await page.getByRole('button', { name: 'Verify email', exact: true }).click();
    await expect(page.getByRole('button', { name: `Make primary: ${secondary}`, exact: true })).toBeVisible();
    await page.getByRole('button', { name: `Make primary: ${secondary}`, exact: true }).click();
    await page.getByLabel('Current password', { exact: true }).fill(password);
    await page.locator('.email-action').getByRole('button', { name: 'Make primary', exact: true }).click();
    await expect(page.getByRole('button', { name: `Remove email: ${primary}`, exact: true })).toBeVisible();
    const switched = await (await page.request.get('/api/auth/get-session')).json();
    expect(switched.user.id).toBe(original.user.id);
    expect(switched.user.username).toBe(username);
    expect(switched.user.email).toBe(secondary);
    await expect(page.getByRole('button', { name: `Remove email: ${secondary}`, exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('emails-desktop-light.png'), fullPage: true });
    await page.getByRole('combobox', { name: 'Language', exact: true }).first().click();
    await page.getByRole('option', { name: '简体中文', exact: true }).click();
    await expect(page).toHaveURL('/zh-cn/account/emails');
    await page.getByRole('button', { name: '主题', exact: true }).click();
    await page.getByRole('menuitem', { name: '深色', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('.theme-control md-menu .menu')).toBeHidden();
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('emails-mobile-zh-dark.png'), fullPage: true });
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 720 });

    await signIn(primary, password, 401);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL('/en-us/login');
    await page.getByRole('link', { name: 'Forgot password?', exact: true }).click();
    await page.getByLabel('Primary email or username', { exact: true }).fill(username);
    await page.getByLabel('Email to receive the code', { exact: true }).fill(primary);
    await expect(page.getByRole('button', { name: 'Send verification code', exact: true })).toBeEnabled({ timeout: 25_000 });
    const beforeRecovery = await snapshotEmails();
    const recoveryStarted = page.waitForResponse((response) => response.url() === `${testOrigin}/api/auth/emails/recovery/start`
        && response.request().method() === 'POST', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Send verification code', exact: true }).click();
    expect((await recoveryStarted).status()).toBe(200);
    await page.getByLabel('Verification code', { exact: true }).fill(await waitForCode(beforeRecovery));
    await page.getByRole('button', { name: 'Continue to new password', exact: true }).click();
    await page.getByLabel('New password', { exact: true }).fill(recovered);
    await page.getByLabel('Confirm password', { exact: true }).fill(recovered);
    await page.getByRole('button', { name: 'Reset password', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Password updated.');

    await signIn(secondary, recovered);
    await expect(page).toHaveURL('/en-us/account');
    expect((await (await page.request.get('/api/auth/get-session')).json()).user.id).toBe(original.user.id);
    await page.getByRole('link', { name: 'Email addresses', exact: true }).click();
    await page.getByRole('button', { name: `Remove email: ${primary}`, exact: true }).click();
    await page.getByLabel('Current password', { exact: true }).fill(recovered);
    await page.locator('.email-action').getByRole('button', { name: 'Remove email', exact: true }).click();
    await expect(page.locator('.email-row')).toHaveCount(1);
    await expect(page.locator('.email-row')).toContainText(secondary);
});
