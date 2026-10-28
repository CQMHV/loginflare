import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { snapshotEmails, waitForCode, waitForMail } from './mailbox';
import { removeLocalFixtures } from './database';

const fixtureEmails: string[] = [];

test.afterEach(() => {
    removeLocalFixtures(fixtureEmails);
    fixtureEmails.length = 0;
});

test('completes registration, recovery, account management, and administrator controls through the real UI', async ({ page, browser }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: 'dark' });
    const email = `ui-${randomUUID()}@loginflare.test`;
    const username = `ui_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const replacementUsername = `new_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    fixtureEmails.push(email);
    const beforeSignup = await snapshotEmails();
    await page.goto('/en-us/signup');
    await page.getByLabel('Display name', { exact: true }).fill('Browser Test');
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Email address', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill('Browser-test-password-917!');
    await page.getByLabel('Confirm password', { exact: true }).fill('Browser-test-password-917!');
    const submit = page.getByRole('button', { name: 'Create account', exact: true });
    await expect(submit).toBeEnabled({ timeout: 20_000 });
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/auth/sign-up/email') && response.request().method() === 'POST');
    await submit.click();
    const response = await responsePromise;
    expect(response.status(), await response.text()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/en-us/verify-email\\?email=${encodeURIComponent(email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(email);
    await page.screenshot({ path: test.info().outputPath('verification-pending.png'), fullPage: true });

    // The new user is not signed in until their email has been verified.
    const session = await page.request.get('/api/auth/get-session');
    expect(await session.json()).toBeNull();

    await page.goto(await waitForMail(beforeSignup, 'verify'));
    await expect(page).toHaveURL('/en-us/verified');
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Email or username', { exact: true }).fill(username.toUpperCase());
    await page.getByLabel('Password', { exact: true }).fill('Browser-test-password-917!');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL('/en-us/account');
    await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();
    const profileLink = page.getByRole('link', { name: 'Profile', exact: true });
    await expect(profileLink).toHaveAttribute('aria-current', 'page');
    await page.evaluate(() => { document.documentElement.dataset.navigationCheck = 'account'; });
    const sessionsLink = page.getByRole('link', { name: 'Sessions', exact: true });
    await page.keyboard.press('Tab');
    await sessionsLink.focus();
    await expect(sessionsLink.locator('md-focus-ring')).toHaveAttribute('visible', '');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/en-us/account/sessions');
    await expect(sessionsLink).toHaveAttribute('aria-current', 'page');
    await expect(profileLink).not.toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('list', { name: 'Active sessions', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-navigation-check', 'account');
    await page.goBack();
    await expect(page).toHaveURL('/en-us/account');
    await page.getByRole('list', { name: 'Preferences', exact: true }).getByRole('combobox', { name: 'Language', exact: true }).click();
    await expect(page.getByRole('option', { name: 'English', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Light', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('.theme-control md-menu .menu')).toBeHidden();
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByLabel('Display name', { exact: true }).fill('Updated Browser Person');
    await page.getByLabel('Username', { exact: true }).fill(replacementUsername);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Your changes have been saved.');
    await expect(page.getByLabel('Username', { exact: true })).toHaveValue(replacementUsername);
    await page.screenshot({ path: test.info().outputPath('profile-desktop.png'), fullPage: true });

    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL('/en-us/login');
    await page.getByLabel('Email or username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('Browser-test-password-917!');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL('/en-us/login');
    await page.getByLabel('Email or username', { exact: true }).fill(replacementUsername.toUpperCase());
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL('/en-us/account');
    await expect(page.getByLabel('Username', { exact: true })).toHaveValue(replacementUsername);

    const preferenceResponse = page.waitForResponse((response) => response.url().endsWith('/api/auth/update-user') && response.request().postDataJSON()?.locale === 'zh-CN');
    await page.getByRole('combobox', { name: 'Language', exact: true }).first().click();
    await page.getByRole('option', { name: '简体中文', exact: true }).click();
    expect((await preferenceResponse).status()).toBe(200);
    await expect(page).toHaveURL('/zh-cn/account');
    await expect(page.getByRole('heading', { name: '个人资料', exact: true })).toBeVisible();
    const identity = await page.request.get('/api/auth/get-session');
    expect((await identity.json()).user.locale).toBe('zh-CN');
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('profile-mobile-zh-cn.png') });
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.getByRole('link', { name: '登录会话', exact: true }).click();
    await expect(page.getByText('当前会话', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: '安全', exact: true }).click();
    await page.getByLabel('当前密码', { exact: true }).fill('Browser-test-password-917!');
    await page.getByLabel('新密码', { exact: true }).fill('Changed-browser-password-728!');
    await page.getByLabel('确认密码', { exact: true }).fill('Changed-browser-password-728!');
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('密码已修改，其他会话已退出。');
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page).toHaveURL('/zh-cn/login');
    await expect(page.getByLabel('邮箱或用户名', { exact: true })).toBeVisible();

    await page.getByRole('link', { name: '忘记密码？', exact: true }).click();
    await page.getByLabel('主邮箱或用户名', { exact: true }).fill(replacementUsername);
    await page.getByLabel('接收验证码的邮箱', { exact: true }).fill(email);
    await expect(page.getByRole('button', { name: '发送验证码', exact: true })).toBeEnabled({ timeout: 20_000 });
    const beforeReset = await snapshotEmails();
    await page.getByRole('button', { name: '发送验证码', exact: true }).click();
    await page.getByLabel('验证码', { exact: true }).fill(await waitForCode(beforeReset));
    await page.getByRole('button', { name: '继续设置新密码', exact: true }).click();
    await expect(page.getByRole('heading', { name: '设置新密码' })).toBeVisible();
    await page.getByLabel('新密码', { exact: true }).fill('Recovered-browser-password-639!');
    await page.getByLabel('确认密码', { exact: true }).fill('Recovered-browser-password-639!');
    await page.getByRole('button', { name: '重置密码', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('密码已更新');
    expect(await (await page.request.get('/api/auth/get-session')).json()).toBeNull();

    // An explicit English URL takes precedence over the saved Chinese preference.
    await page.goto('/en-us/login');
    await page.getByLabel('Email or username', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill('Recovered-browser-password-639!');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL('/en-us/account');
    await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();

    // Promote only this test's verified local account using the shipped operator command.
    execFileSync(process.execPath, ['scripts/database.mjs', 'promote', '--email', email, '--local'], {
        cwd: process.cwd(),
        stdio: 'pipe',
        timeout: 30_000,
    });
    await page.reload();
    await expect(page.getByRole('link', { name: 'Users', exact: true })).toBeVisible();

    const targetEmail = `ui-target-${randomUUID()}@loginflare.test`;
    fixtureEmails.push(targetEmail);
    const targetContext = await browser.newContext({ baseURL: 'http://localhost:5173' });
    const targetPage = await targetContext.newPage();
    await targetPage.goto('/en-us/signup');
    await targetPage.getByLabel('Display name', { exact: true }).fill('Browser Target');
    await targetPage.getByLabel('Username', { exact: true }).fill(`ui_${randomUUID().replaceAll('-', '').slice(0, 20)}`);
    await targetPage.getByLabel('Email address', { exact: true }).fill(targetEmail);
    await targetPage.getByLabel('Password', { exact: true }).fill('Target-account-password-917!');
    await targetPage.getByLabel('Confirm password', { exact: true }).fill('Target-account-password-917!');
    await expect(targetPage.getByRole('button', { name: 'Create account', exact: true })).toBeEnabled({ timeout: 20_000 });
    await targetPage.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(targetPage.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    await targetContext.close();

    await page.getByRole('link', { name: 'Users', exact: true }).click();
    await page.getByLabel('Find a user by exact email', { exact: true }).fill(targetEmail.toUpperCase());
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('link', { name: `User details: ${targetEmail}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'User details', exact: true })).toBeVisible();
    await page.getByLabel('Reason for suspension', { exact: true }).fill('Local browser-test fixture');
    await page.getByRole('button', { name: 'Suspend account', exact: true }).click();
    const suspendDialog = page.getByRole('dialog', { name: 'Suspend account', exact: true });
    await expect(suspendDialog).toBeVisible();
    // Actions are slotted light-DOM children of the Material Web host.
    await page.locator('md-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(suspendDialog).toHaveCount(0);
    await expect(page.getByText('Active', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Suspend account', exact: true }).click();
    await page.locator('md-dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText('Suspended', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 1024 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: test.info().outputPath('admin-user-details.png') });
    await page.getByRole('button', { name: 'Restore account', exact: true }).click();
    await expect(page.getByText('Active', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out all sessions', exact: true }).click();
    await page.locator('md-dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Account updated.');

    const administratorResponse = await page.request.get('/api/auth/get-session');
    expect(administratorResponse.status()).toBe(200);
    expect(administratorResponse.headers()['content-type']).toContain('application/json');
    const administrator = await administratorResponse.json();
    await page.goto(`/en-us/admin/users/detail?id=${encodeURIComponent(administrator.user.id)}`);
    await expect(page.getByText('Administrator accounts cannot be managed from this interface.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Suspend account', exact: true })).toHaveCount(0);
});
