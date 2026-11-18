import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { expect, test } from './fixtures';
import { executeLocal, removeLocalFixtures } from './database';
import type { UpdateStatus } from '../../src/shared/releases';

const emails: string[] = [];
test.afterEach(() => { removeLocalFixtures(emails); emails.length = 0; });

for (const { locale, emailLabel, passwordLabel, signIn, hint, details, title, prepare, releaseNotes } of [
    { locale: 'en-us', emailLabel: 'Email or username', passwordLabel: 'Password', signIn: 'Sign in', hint: 'Version 0.1.1 is available.', details: 'View update', title: 'Version updates', prepare: 'Prepare update on GitHub', releaseNotes: 'Release notes' },
    { locale: 'zh-cn', emailLabel: '邮箱或用户名', passwordLabel: '密码', signIn: '登录', hint: '新版本 0.1.1 已发布。', details: '查看更新', title: '版本更新', prepare: '前往 GitHub 准备更新', releaseNotes: '版本说明' },
]) test(`announces a stable update in ${locale} and links to the downstream workflow`, async ({ page }) => {
    const id = randomUUID(), email = `ui-${randomUUID()}@loginflare.test`, password = 'Update-test-only-password!';
    emails.push(email);
    const time = new Date().toISOString(), hash = await hashPassword(password);
    executeLocal(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned, locale)
        VALUES ('${id}', 'Update administrator', '${email}', 1, '${time}', '${time}', 'admin', 0, '${locale === 'en-us' ? 'en-US' : 'zh-CN'}');
        INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
        VALUES ('${randomUUID()}', '${id}', 'credential', '${id}', '${hash}', '${time}', '${time}');`);
    const update: UpdateStatus = { currentVersion: '0.1.0', currentCommit: 'a'.repeat(40), status: 'available', availableVersion: '0.1.1',
        actionUrl: 'https://github.com/example/installation/actions/workflows/prepare-update.yml', releaseUrl: 'https://github.com/CQMHV/loginflare/releases/tag/v0.1.1' };
    const methods: string[] = [];
    await page.route('**/api/admin/updates', async (route) => {
        methods.push(route.request().method());
        await route.fulfill({ json: update });
    });
    await page.goto(`/${locale}/login`);
    await page.getByLabel(emailLabel, { exact: true }).fill(email);
    await page.getByLabel(passwordLabel, { exact: true }).fill(password);
    await page.getByRole('button', { name: signIn, exact: true }).click();
    await expect(page).toHaveURL(`/${locale}/account`);
    expect(methods).toEqual([]);
    await page.goto(`/${locale}/admin/users`);
    await expect(page.getByRole('status').filter({ hasText: hint })).toBeVisible();
    await page.getByRole('link', { name: details, exact: true }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByRole('link', { name: prepare })).toHaveAttribute('href', update.actionUrl!);
    await expect(page.getByRole('link', { name: releaseNotes })).toHaveAttribute('href', update.releaseUrl!);
    expect(methods).toEqual(['GET']);
    const directResponse = await page.reload();
    expect(directResponse?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByRole('link', { name: prepare })).toHaveAttribute('href', update.actionUrl!);
});
