import { expect, test } from '@playwright/test';
import { renderedTextContrast } from './contrast';

test('defaults to English regardless of browser locale', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await expect(page).toHaveURL('/en-us/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.getByLabel('Email address', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('login-desktop.png'), fullPage: true });
});

test('language switching preserves opaque query values and persists the root preference', async ({ page }) => {
    const query = '?token=AaBbZ%2FCase%2BKeep%3D&source=EmailLink';
    await page.goto(`/en-us/reset-password${query}`);
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Language', exact: true }).click();
    await page.getByRole('option', { name: '简体中文', exact: true }).click();
    await expect(page).toHaveURL(`/zh-cn/reset-password${query}`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('heading', { name: '设置新密码' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('loginflare.locale'))).toBe('zh-CN');
    await page.goto('/');
    await expect(page).toHaveURL('/zh-cn/login');
    await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
    await page.goto('/en-us/login');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
});

test('rejects unknown or incorrectly cased locale and page paths', async ({ page }) => {
    for (const path of ['/en/login', '/EN-US/login', '/en-US/login', '/en-us/Login', '/fr-fr/login']) {
        const response = await page.goto(path);
        expect(response?.status()).toBe(404);
        await expect(page.locator('body')).toContainText(/not found/i);
    }
});

test('renders a readable Chinese mobile form without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/zh-cn/signup');
    await expect(page.getByRole('heading', { name: '从这里开始' })).toBeVisible();
    await expect(page.getByLabel('显示名称', { exact: true })).toBeVisible();
    await expect(page.getByLabel('确认密码', { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('signup-mobile-zh-cn.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 320, height: 700 });
    await page.reload();
    await expect(page.getByRole('heading', { name: '从这里开始' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('protects account and administrator routes for anonymous visitors', async ({ page }) => {
    for (const path of ['/en-us/account/security', '/zh-cn/account/sessions', '/en-us/admin/users']) {
        await page.goto(path);
        const locale = path.startsWith('/zh-cn/') ? 'zh-cn' : 'en-us';
        await expect(page).toHaveURL(`/${locale}/login`);
    }
});

test('Material Web controls preserve readable contrast, keyboard interaction, and native form validation', async ({ page }) => {
    const signInRequests: string[] = [];
    page.on('request', (request) => {
        if (request.url().endsWith('/api/auth/sign-in/email')) signInRequests.push(request.url());
    });
    await page.goto('/en-us/login');
    await expect(page.locator('md-outlined-text-field')).toHaveCount(2);
    await expect(page.locator('md-filled-button')).toHaveCount(1);
    const remember = page.getByRole('checkbox', { name: 'Keep me signed in', exact: true });
    await expect(remember).toBeChecked();
    await remember.focus();
    await remember.press('Space');
    await expect(remember).not.toBeChecked();
    await remember.press('Space');
    await expect(remember).toBeChecked();
    const email = page.getByLabel('Email address', { exact: true });
    await email.fill('invalid-email');
    await page.getByLabel('Password', { exact: true }).fill('valid-test-password');
    const submit = page.getByRole('button', { name: 'Sign in', exact: true });
    await expect(submit).toBeEnabled({ timeout: 20_000 });
    // Check actual rendered foregrounds and composited Material state layers.
    expect(await renderedTextContrast(submit, true)).toBeGreaterThanOrEqual(4.5);
    await submit.hover();
    expect(await renderedTextContrast(submit, true)).toBeGreaterThanOrEqual(4.5);
    await page.mouse.move(0, 0);
    await submit.focus();
    expect(await renderedTextContrast(submit, true)).toBeGreaterThanOrEqual(4.5);
    await submit.hover();
    await page.mouse.down();
    try {
        expect(await renderedTextContrast(submit, true)).toBeGreaterThanOrEqual(4.5);
    } finally {
        await page.mouse.up();
    }
    expect(await renderedTextContrast(page.getByRole('link', { name: 'Forgot password?', exact: true }))).toBeGreaterThanOrEqual(4.5);
    expect(await renderedTextContrast(page.locator('.section-description'))).toBeGreaterThanOrEqual(4.5);
    await submit.click();
    await expect(email).toBeFocused();
    expect(await page.locator('form').evaluate((form: HTMLFormElement) => form.checkValidity())).toBe(false);
    expect(signInRequests).toEqual([]);
});
