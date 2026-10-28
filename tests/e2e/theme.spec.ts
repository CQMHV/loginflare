import { expect, test, type Page } from '@playwright/test';
import { renderedTextContrast } from './contrast';

async function chooseTheme(page: Page, name: 'Light' | 'Dark' | 'System' | '浅色' | '深色' | '跟随系统') {
    await expect(page.locator('.theme-control md-menu .menu')).toBeHidden();
    await page.getByRole('button', { name: /^(Theme|主题)$/ }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
    await expect(page.locator('.theme-control md-menu .menu')).toBeHidden();
}

test('uses the Material Web opening and closing animations', async ({ page }) => {
    await page.goto('/en-us/reset-password?token=MenuAnimation');
    const trigger = page.getByRole('button', { name: 'Theme', exact: true });
    const menu = page.locator('.theme-control md-menu');
    await expect(trigger).toBeVisible();
    async function hasNativeAnimation(event: 'opening' | 'closing') {
        return menu.evaluate((element, eventName) => new Promise<boolean>((resolve) => {
            element.addEventListener(eventName, () => requestAnimationFrame(() => {
                const animations = [...element.shadowRoot!.querySelectorAll('*')].flatMap((child) => child.getAnimations());
                resolve(animations.some((animation) => animation.playState === 'running' && Number(animation.effect?.getTiming().duration) > 0));
            }), { once: true });
        }), event);
    }
    const opening = hasNativeAnimation('opening');
    await trigger.click();
    expect(await opening).toBe(true);
    await expect(page.getByRole('menuitem', { name: 'Light', exact: true })).toBeFocused();
    const closing = hasNativeAnimation('closing');
    await page.getByRole('menuitem', { name: 'Dark', exact: true }).click();
    expect(await closing).toBe(true);
    await expect(menu.locator('.menu')).toBeHidden();
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menuitem', { name: 'Light', exact: true })).toBeFocused();
    await page.getByRole('menuitem', { name: 'Light', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('initializes the system theme before the React application loads', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.route(/\/src\/client\/main\.tsx(?:\?.*)?$/, (route) => route.abort());
    await page.goto('/en-us/login');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(25, 21, 17)');
    await expect(page.locator('#root')).toBeEmpty();
    expect(await page.evaluate(() => localStorage.getItem('loginflare.theme'))).toBeNull();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.evaluate(() => localStorage.setItem('loginflare.theme', 'unsupported-theme'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.evaluate(() => localStorage.setItem('loginflare.theme', 'dark'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(25, 21, 17)');
});

test('persists a manual choice across navigation and reloads, then resumes live system changes', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    const query = '?token=AaBbZ%2FCase%2BKeep%3D&source=EmailLink';
    await page.goto(`/en-us/reset-password${query}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await chooseTheme(page, 'Dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => localStorage.getItem('loginflare.theme'))).toBe('dark');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByRole('combobox', { name: 'Language', exact: true }).click();
    await page.getByRole('option', { name: '简体中文', exact: true }).click();
    await expect(page).toHaveURL(`/zh-cn/reset-password${query}`);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('heading', { name: '设置新密码', exact: true })).toBeVisible();
    await chooseTheme(page, '跟随系统');
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => localStorage.getItem('loginflare.theme'))).toBe('system');
});

test('synchronizes theme preferences across tabs and returns to the system after storage is cleared', async ({ page, context }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/en-us/reset-password?token=TabOne');
    const other = await context.newPage();
    await other.emulateMedia({ colorScheme: 'dark' });
    await other.goto('/en-us/reset-password?token=TabTwo');
    await chooseTheme(page, 'Light');
    await expect(other.locator('html')).toHaveAttribute('data-theme-preference', 'light');
    await expect(other.locator('html')).toHaveAttribute('data-theme', 'light');
    await chooseTheme(other, 'Dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await other.evaluate(() => localStorage.clear());
    await expect(page.locator('html')).toHaveAttribute('data-theme-preference', 'system');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await other.close();
});

test('keeps the theme menu usable with a keyboard on a narrow localized page', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.emulateMedia({ colorScheme: 'dark' });
    const query = '?token=AaBbZ%2FCase%2BKeep%3D&source=EmailLink';
    await page.goto(`/zh-cn/reset-password${query}`);
    const trigger = page.getByRole('button', { name: '主题', exact: true });
    await trigger.focus();
    await trigger.press('Enter');
    await expect(page.getByRole('menuitem', { name: '跟随系统', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '浅色', exact: true })).toBeFocused();
    for (const item of await page.getByRole('menuitem').all()) {
        const bounds = await item.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: '跟随系统', exact: true })).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await chooseTheme(page, '深色');
    await page.getByRole('combobox', { name: '语言', exact: true }).click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await expect(page).toHaveURL(`/en-us/reset-password${query}`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('dark-reset-mobile.png'), fullPage: true });
    await chooseTheme(page, 'Light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('keeps dark-mode text and primary button states readable', async ({ page }) => {
    test.setTimeout(45_000);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/en-us/login');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const email = page.getByLabel('Email or username', { exact: true });
    await email.fill('contrast@example.test');
    const submit = page.getByRole('button', { name: 'Sign in', exact: true });
    await expect(submit).toBeEnabled({ timeout: 20_000 });
    expect(await renderedTextContrast(email)).toBeGreaterThanOrEqual(4.5);
    expect(await renderedTextContrast(page.getByRole('link', { name: 'Forgot password?', exact: true }))).toBeGreaterThanOrEqual(4.5);
    expect(await renderedTextContrast(page.locator('.section-description'))).toBeGreaterThanOrEqual(4.5);
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
        await page.mouse.move(0, 0);
        await page.mouse.up();
    }
    await page.screenshot({ path: test.info().outputPath('dark-login-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('dark-login-mobile.png'), fullPage: true });
});
