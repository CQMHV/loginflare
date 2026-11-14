import { expect, test } from './fixtures';
import { testOrigin } from './runtime';
import { randomUUID } from 'node:crypto';
import { snapshotEmails, waitForMail } from './mailbox';
import { executeLocal, removeLocalApplications, removeLocalFixtures } from './database';

const emails: string[] = [], clients: string[] = [], tasks: string[] = [];
const password = 'Deletion-browser-password-957!';
test.afterEach(() => {
    removeLocalApplications(clients); removeLocalFixtures(emails);
    for (const id of tasks) {
        if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new Error('Unexpected fixture user');
        executeLocal(`DELETE FROM accountDeletion WHERE userId = '${id}'`);
    }
    emails.length = 0; clients.length = 0; tasks.length = 0;
});

for (const chinese of [false, true]) test(`confirms account deletion and owned application impact in ${chinese ? 'Chinese' : 'English'}`, async ({ page }) => {
    test.setTimeout(120000);
    const locale = chinese ? 'zh-cn' : 'en-us', email = `ui-${randomUUID()}@loginflare.test`;
    emails.push(email);
    const before = await snapshotEmails();
    const created = await page.request.post(`${testOrigin}/api/auth/sign-up/email`, { headers: { Origin: testOrigin, 'x-captcha-response': 'isolated-e2e-captcha-token' }, data: {
        name: 'Deletion browser fixture', username: 'del_' + randomUUID().replaceAll('-', '').slice(0, 20), email, password,
        locale: chinese ? 'zh-CN' : 'en-US', callbackURL: `${testOrigin}/${locale}/verified`,
    } });
    expect(created.status(), await created.text()).toBe(200);
    await page.goto(await waitForMail(before, 'verify'));
    await page.goto(`/${locale}/login`);
    await page.getByLabel(chinese ? '邮箱或用户名' : 'Email or username', { exact: true }).fill(email);
    await page.getByLabel(chinese ? '密码' : 'Password', { exact: true }).fill(password);
    const signIn = page.getByRole('button', { name: chinese ? '登录' : 'Sign in', exact: true });
    await expect(signIn).toBeEnabled(); await signIn.click();
    await expect(page).toHaveURL(`/${locale}/account`);
    async function app() {
        const name = 'ui-oauth-' + randomUUID();
        const response = await page.request.post(`${testOrigin}/api/developer/applications`, { headers: { Origin: testOrigin }, data: {
            name, type: 'spa', redirectUris: ['https://fixture.example.test/callback'], postLogoutRedirectUris: ['https://fixture.example.test/'], scopes: ['openid'],
        } });
        expect(response.status(), await response.text()).toBe(201);
        const result = await response.json(); clients.push(result.application.clientId);
        return name;
    }
    const first = await app();
    await page.goto(`/${locale}/account/security`);
    await page.getByRole('button', { name: chinese ? '注销账号' : 'Delete account', exact: true }).click();
    // Form fields are slotted light-DOM children of the Material host, not
    // descendants of its internal native <dialog> element.
    const dialog = page.locator('md-dialog.form-dialog');
    await expect(dialog.getByRole('heading', { name: chinese ? '注销账号' : 'Delete account', exact: true })).toBeVisible();
    await dialog.getByLabel(chinese ? '当前密码' : 'Current password', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: chinese ? '验证并继续' : 'Verify and continue', exact: true }).click();
    await expect(dialog.getByText(first, { exact: false })).toBeVisible();
    const confirm = dialog.getByRole('button', { name: chinese ? '确认永久注销' : 'Request permanent deletion', exact: true });
    await expect(confirm).toBeDisabled();
    const acknowledgement = dialog.getByRole('checkbox');
    await acknowledgement.check();
    await expect(confirm).toBeEnabled();
    if (!chinese) {
        const added = await app();
        const rejected = page.waitForResponse((response) => response.url().endsWith('/api/account/delete'));
        await confirm.click(); expect((await rejected).status()).toBe(409);
        await expect(dialog.getByText(added, { exact: false })).toBeVisible();
        await expect(acknowledgement).not.toBeChecked();
        await acknowledgement.check();
    }
    const accepted = page.waitForResponse((response) => response.url().endsWith('/api/account/delete'));
    tasks.push((await (await page.request.get(`${testOrigin}/api/auth/get-session`)).json()).user.id);
    await confirm.click(); const response = await accepted;
    // The app intentionally navigates immediately after reading the receipt;
    // the old frame's CDP response body is no longer available after that.
    expect(response.status()).toBe(202);
    await expect(page).toHaveURL(`/${locale}/account-deleted`);
    await expect(page.getByRole('heading', { name: chinese ? '已提交账号注销' : 'Account deletion requested', exact: true })).toBeVisible();
    const identity = await page.request.get(`${testOrigin}/api/auth/get-session`);
    if (identity.status() === 200) expect(await identity.json()).toBeNull();
    else expect([401, 403]).toContain(identity.status());
    await page.goto(`/${locale}/account/security`);
    await expect(page).not.toHaveURL(`/${locale}/account/security`);
});
