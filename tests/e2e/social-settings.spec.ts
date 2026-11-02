import type { BrowserContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { testOrigin } from './runtime';
import type { Identity } from '../../src/client/api';
import type { SecurityCapabilities } from '../../src/shared/social';

const google = { id: '00000000-0000-4000-8000-000000000001', name: 'Google', type: 'google' as const };
const github = { id: '00000000-0000-4000-8000-000000000002', name: 'GitHub', type: 'github' as const };
const linkedGoogle = { id: 'google-account', providerId: google.id, accountId: 'private-subject', name: google.name, enabled: true };
async function account(context: BrowserContext, security: SecurityCapabilities) {
    const now = new Date().toISOString();
    const identity: Identity = {
        user: { id: 'social-settings-user', name: 'Social Settings User', email: 'settings@loginflare.test', emailVerified: true, role: 'user', createdAt: now },
        session: { id: 'social-settings-session', token: 'test-only-session', userId: 'social-settings-user', createdAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    };
    const starts: Record<string, unknown>[] = [], unlinks: Record<string, unknown>[] = [];
    await context.route(`${testOrigin}/api/auth/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/auth/get-session') await route.fulfill({ json: identity });
        else if (path === '/api/auth/social/security') await route.fulfill({ json: security });
        else if (path === '/api/auth/verify-password') await route.fulfill(route.request().postDataJSON().password === 'test-only-password'
            ? { json: { status: true } } : { status: 400, json: { code: 'INVALID_PASSWORD' } });
        else if (path === '/api/auth/social/start') {
            starts.push(route.request().postDataJSON());
            await route.fulfill({ status: 503, json: { code: 'SOCIAL_PROVIDER_UNAVAILABLE' } });
        } else if (path === '/api/auth/social/unlink') {
            const body = route.request().postDataJSON(); unlinks.push(body);
            security.identities = security.identities.filter((item) => item.id !== body.accountId);
            await route.fulfill({ json: { status: true } });
        } else await route.fallback();
    });
    return { starts, unlinks };
}

test('hides third-party account controls when no provider or identity exists', async ({ page, context }) => {
    await account(context, { hasPassword: true, providers: [], identities: [] });
    await page.goto('/zh-cn/account/security');
    await expect(page.getByRole('heading', { name: '修改密码', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '第三方账号', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /绑定|解绑/ })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('no-social-providers.png'), fullPage: true });
});

for (const [locale, width] of [['en-us', 1280], ['zh-cn', 375]] as const) {
    test(`links the chosen provider directly without dropdowns in ${locale}`, async ({ page, context }) => {
        const server = await account(context, { hasPassword: true, providers: [google, github], identities: [] });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/${locale}/account/security`);
        const chinese = locale === 'zh-cn';
        const section = page.getByRole('region', { name: chinese ? '第三方账号' : 'Third-party accounts', exact: true });
        await expect(section.getByText(chinese ? '未绑定' : 'Not linked', { exact: true })).toHaveCount(2);
        await expect(section.getByText(chinese ? '已绑定' : 'Linked', { exact: true })).toHaveCount(0);
        await expect(section.getByRole('combobox')).toHaveCount(0);
        await section.getByRole('button', { name: chinese ? '绑定 GitHub' : 'Link GitHub', exact: true }).click();
        const form = page.locator('md-dialog.form-dialog');
        await expect(form).toBeVisible();
        await expect(section.locator('form')).toHaveCount(0);
        await expect(section.locator('.social-account')).toHaveCount(2);
        await expect(form.getByRole('combobox')).toHaveCount(0);
        expect(server.starts).toHaveLength(0);
        await expect(form.getByRole('button', { name: chinese ? '继续绑定 GitHub' : 'Continue linking GitHub', exact: true })).toHaveCount(0);
        await page.screenshot({ path: test.info().outputPath(`direct-link-${locale}.png`), fullPage: true });
        await form.getByLabel(chinese ? '当前密码' : 'Current password', { exact: true }).fill('test-only-password');
        await form.getByRole('button', { name: chinese ? '验证并继续' : 'Verify and continue', exact: true }).click();
        await form.getByRole('button', { name: chinese ? '继续绑定 GitHub' : 'Continue linking GitHub', exact: true }).click();
        await expect.poll(() => server.starts.length).toBe(1);
        expect(server.starts[0]).toMatchObject({ connectionId: github.id, purpose: 'link', password: 'test-only-password' });
        await expect(form.getByRole('alert')).toBeVisible();
        await expect(section.getByRole('alert')).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await form.getByRole('button', { name: chinese ? '取消' : 'Cancel', exact: true }).click();
        await expect(form).toHaveCount(0);
        await expect(section.locator('.social-account')).toHaveCount(2);
        await expect(section.getByRole('button', { name: chinese ? '绑定 GitHub' : 'Link GitHub', exact: true })).toBeFocused();
    });
}

test('keeps disabled bindings visible and unlinks the selected identity without dropdowns', async ({ page, context }) => {
    const server = await account(context, { hasPassword: true, providers: [], identities: [{ ...linkedGoogle, enabled: false }] });
    await page.goto('/en-us/account/security');
    const section = page.getByRole('region', { name: 'Third-party accounts', exact: true });
    await expect(section.getByText('Linked · Unavailable', { exact: true })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Link Google', exact: true })).toHaveCount(0);
    await section.getByRole('button', { name: 'Unlink Google', exact: true }).click();
    const form = page.locator('md-dialog.form-dialog');
    await expect(form.getByText('Unlink Google? You will no longer be able to sign in with this account.')).toHaveCount(0);
    await expect(form.getByRole('combobox')).toHaveCount(0);
    await form.getByLabel('Current password', { exact: true }).fill('test-only-password');
    await form.getByRole('button', { name: 'Verify and continue', exact: true }).click();
    await expect(form.getByText('Unlink Google? You will no longer be able to sign in with this account.')).toBeVisible();
    await form.getByRole('button', { name: 'Confirm unlinking Google', exact: true }).click();
    await expect.poll(() => server.unlinks.length).toBe(1);
    expect(server.unlinks[0]).toEqual({ accountId: linkedGoogle.id, password: 'test-only-password' });
    await expect(section).toHaveCount(0);
});

test('explains why a passwordless account cannot unlink its last sign-in method', async ({ page, context }) => {
    await account(context, { hasPassword: false, providers: [google], identities: [linkedGoogle] });
    await page.goto('/en-us/account/security');
    const section = page.getByRole('region', { name: 'Third-party accounts', exact: true });
    await expect(section.getByRole('button', { name: 'Unlink Google', exact: true })).toBeDisabled();
    await expect(section.getByText('Set a password or link another account before removing your last sign-in method.')).toBeVisible();
    await expect(section.getByRole('button', { name: 'Link Google', exact: true })).toHaveCount(0);
});

test('continues binding the chosen provider after passwordless identity confirmation', async ({ page, context }) => {
    const server = await account(context, { hasPassword: false, providers: [google, github], identities: [linkedGoogle], proofPurpose: 'link', proofExpiresAt: Date.now() + 300_000 });
    await page.goto('/en-us/account/security');
    const section = page.getByRole('region', { name: 'Third-party accounts', exact: true });
    await section.getByRole('button', { name: 'Link GitHub', exact: true }).click();
    expect(server.starts).toHaveLength(0);
    const dialog = page.locator('md-dialog.form-dialog');
    await dialog.getByRole('button', { name: 'Continue linking GitHub', exact: true }).click();
    await expect.poll(() => server.starts.length).toBe(1);
    expect(server.starts[0]).toMatchObject({ connectionId: github.id, purpose: 'link' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Current password', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('combobox')).toHaveCount(0);
});

test('keeps passwordless identity confirmation in a dialog without adding a list item or premature submit', async ({ page, context }) => {
    const server = await account(context, { hasPassword: false, providers: [google, github], identities: [linkedGoogle] });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/zh-cn/account/security');
    const section = page.getByRole('region', { name: '第三方账号', exact: true });
    await section.getByRole('button', { name: '绑定 GitHub', exact: true }).click();
    const dialog = page.locator('md-dialog.form-dialog');
    await expect(dialog).toBeVisible();
    await expect(section.locator('.social-account')).toHaveCount(2);
    await expect(section.locator('form')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '继续绑定 GitHub', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '使用 Google 继续', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('passwordless-confirmation-mobile.png'), fullPage: true });
    await dialog.getByRole('button', { name: '使用 Google 继续', exact: true }).click();
    await expect.poll(() => server.starts.length).toBe(1);
    expect(server.starts[0]).toMatchObject({ connectionId: google.id, purpose: 'reauth', action: 'link' });
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(section.getByRole('alert')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
});

test('keeps email operation errors inside their dialog without inserting another card', async ({ page, context }) => {
    await account(context, { hasPassword: true, providers: [], identities: [] });
    await context.route(`${testOrigin}/api/auth/emails`, (route) => route.fulfill({ json: { emails: [{ id: 'primary-email', email: 'settings@loginflare.test', verified: true, primary: true }] } }));
    await context.route(`${testOrigin}/api/auth/emails/add`, (route) => route.fulfill({ status: 400, json: { code: 'INVALID_PASSWORD' } }));
    await page.goto('/en-us/account/emails');
    await page.getByRole('button', { name: 'Add email address', exact: true }).click();
    const dialog = page.locator('md-dialog.form-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('.email-row')).toHaveCount(1);
    await expect(page.locator('.email-action')).toHaveCount(0);
    await expect(dialog.getByLabel('New email address', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Current password', { exact: true }).fill('wrong-test-password');
    await dialog.getByRole('button', { name: 'Verify and continue', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByLabel('New email address', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Current password', { exact: true }).fill('test-only-password');
    await dialog.getByRole('button', { name: 'Verify and continue', exact: true }).click();
    await dialog.getByLabel('New email address', { exact: true }).fill('additional@loginflare.test');
    await dialog.getByRole('button', { name: 'Send verification code', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.email-row')).toHaveCount(1);
});

test('keeps MFA confirmation errors in the selected operation dialog', async ({ page, context }) => {
    await account(context, { hasPassword: true, providers: [], identities: [] });
    await context.route(`${testOrigin}/api/auth/two-factor/enable`, (route) => route.fulfill({ status: 400, json: { code: 'INVALID_PASSWORD' } }));
    await page.goto('/en-us/account/security');
    const section = page.getByRole('region', { name: 'Two-factor authentication', exact: true });
    await section.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
    const dialog = page.locator('md-dialog.form-dialog');
    await expect(dialog).toBeVisible();
    await expect(section.locator('form')).toHaveCount(0);
    await dialog.getByLabel('Account password', { exact: true }).fill('wrong-test-password');
    await dialog.getByRole('button', { name: 'Verify and continue', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByLabel('Setup key', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Set up authenticator', exact: true })).toHaveCount(0);
    await dialog.getByLabel('Account password', { exact: true }).fill('test-only-password');
    await dialog.getByRole('button', { name: 'Verify and continue', exact: true }).click();
    await dialog.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(section.getByRole('alert')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
});

test('reveals MFA enrollment errors after submission from the bottom of the dialog', async ({ page, context }) => {
    await account(context, { hasPassword: true, providers: [], identities: [] });
    await page.setViewportSize({ width: 375, height: 600 });
    await context.route(`${testOrigin}/api/auth/two-factor/enable`, (route) => route.fulfill({ json: {
        totpURI: 'otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP', backupCodes: Array.from({ length: 10 }, (_, index) => `test-recovery-${index}`),
    } }));
    await context.route(`${testOrigin}/api/auth/two-factor/verify-totp`, (route) => route.fulfill({ status: 400, json: { code: 'INVALID_CODE' } }));
    await page.goto('/en-us/account/security');
    await page.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
    const dialog = page.locator('md-dialog.form-dialog');
    await dialog.getByLabel('Account password', { exact: true }).fill('test-only-password');
    await dialog.getByRole('button', { name: 'Verify and continue', exact: true }).click();
    await dialog.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
    await dialog.getByLabel('Authenticator code', { exact: true }).fill('000000');
    await dialog.getByRole('checkbox', { name: 'I have saved my recovery codes', exact: true }).check();
    await dialog.getByRole('button', { name: 'Verify and enable', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeFocused();
    await expect(dialog.getByRole('alert')).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByLabel('Authenticator code', { exact: true })).toHaveValue('000000');
    await page.screenshot({ path: test.info().outputPath('mfa-error-visible-mobile.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
});

test('shows new password fields only after server verification and clears them when verification expires', async ({ page, context }) => {
    await account(context, { hasPassword: true, providers: [], identities: [] });
    await page.clock.install();
    await page.goto('/en-us/account/security');
    await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    const dialog = page.locator('md-dialog.form-dialog');
    await expect(dialog.getByLabel('New password', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Current password', { exact: true }).fill('wrong-test-password');
    await dialog.getByRole('button', { name: 'Verify and continue', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByLabel('New password', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Current password', { exact: true }).fill('test-only-password');
    await dialog.getByRole('button', { name: 'Verify and continue', exact: true }).click();
    await dialog.getByLabel('New password', { exact: true }).fill('Will-be-cleared-817!');
    await page.clock.fastForward(300_100);
    await expect(dialog.getByLabel('New password', { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel('Current password', { exact: true })).toHaveValue('');
    await dialog.getByLabel('Current password', { exact: true }).fill('test-only-password');
    await dialog.getByRole('button', { name: 'Verify and continue', exact: true }).click();
    await expect(dialog.getByLabel('New password', { exact: true })).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(dialog.getByLabel('New password', { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel('Current password', { exact: true })).toHaveValue('');
});

test('does not navigate from a delayed reauthentication response after page departure', async ({ page, context }) => {
    await account(context, { hasPassword: false, providers: [google, github], identities: [linkedGoogle] });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await context.route(`${testOrigin}/api/auth/social/start`, async (route) => {
        await pending;
        await route.fulfill({ json: { url: `${testOrigin}/en-us/social/complete` } });
    });
    await page.goto('/en-us/account/security');
    const section = page.getByRole('region', { name: 'Third-party accounts', exact: true });
    await section.getByRole('button', { name: 'Link GitHub', exact: true }).click();
    const requested = page.waitForRequest((request) => request.url().endsWith('/api/auth/social/start'));
    await page.locator('md-dialog.form-dialog').getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await requested;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(page.locator('md-dialog.form-dialog')).toHaveCount(0);
    const completed = page.waitForResponse((response) => response.url().endsWith('/api/auth/social/start'));
    release(); await completed; await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL('/en-us/account/security');
    await expect(section.getByRole('button', { name: 'Link GitHub', exact: true })).toBeEnabled();
});
