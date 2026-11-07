import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { expect, test, type Page } from './fixtures';
import { executeLocal, removeLocalFixtures } from './database';
import { testOrigin } from './runtime';
import type { Branding } from '../../src/shared/branding';
import { sourcePng } from '../fixtures/avatars';
import { inspectImage } from '../../src/shared/avatars';

const emails: string[] = [];
const logo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="80" height="40" rx="8" fill="#6750a4"/><path d="M20 10v20m0-10h40" stroke="white" stroke-width="6"/></svg>');
test.afterEach(() => {
    executeLocal('UPDATE "siteBranding" SET "name" = \'Loginflare\', "primaryColor" = \'#f38020\', "colorScheme" = \'tonal-spot\', "logoId" = NULL, "revision" = "revision" + 1 WHERE "id" = 1');
    removeLocalFixtures(emails); emails.length = 0;
});
async function signin(page: Page, role = 'admin') {
    const id = randomUUID(), email = `ui-${randomUUID()}@loginflare.test`, password = 'Brand-local-test-731!';
    emails.push(email); const now = new Date().toISOString(), hash = await hashPassword(password);
    executeLocal(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned, locale) VALUES ('${id}', 'Brand administrator', '${email}', 1, '${now}', '${now}', '${role}', 0, 'en-US');
        INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ('${randomUUID()}', '${id}', 'credential', '${id}', '${hash}', '${now}', '${now}');`);
    await page.goto('/en-us/login');
    await page.getByLabel('Email or username', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL('/en-us/account');
}

test('publishes independent logo, name and Material color schemes across pages, tabs and reloads', async ({ page, context }) => {
    test.setTimeout(90_000); await signin(page);
    const peer = await context.newPage(); await peer.goto('/en-us/developer/applications');
    await page.bringToFront(); await page.goto('/en-us/admin/branding');
    await expect(page.getByLabel('Brand name', { exact: true })).toHaveValue('Loginflare');
    await page.screenshot({ path: test.info().outputPath('brand-settings-desktop.png'), fullPage: true });
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Edit logo', exact: true }).click();
    await (await chooser).setFiles({ name: 'brand.svg', mimeType: 'image/svg+xml', buffer: logo });
    const editor = page.locator('md-dialog.image-crop-dialog');
    await expect(editor.getByRole('button', { name: 'Use logo', exact: true })).toBeEnabled();
    await editor.getByRole('button', { name: 'Use logo', exact: true }).click();
    await expect(editor).toHaveCount(0);
    const name = 'Example &quot; Hub';
    await expect(page.getByLabel('Brand name', { exact: true })).toBeEnabled();
    await page.getByLabel('Brand name', { exact: true }).fill(name);
    await page.getByLabel('Theme color', { exact: true }).fill('#6750a4');
    await page.getByRole('combobox', { name: 'Color scheme', exact: true }).click();
    await page.getByRole('option', { name: 'Vibrant', exact: true }).click();
    const changed = page.waitForResponse((response) => response.url() === `${testOrigin}/api/admin/branding` && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    const response = await changed; expect(response.status()).toBe(200);
    const saved = await response.json() as Branding;
    expect(saved.colorScheme).toBe('vibrant');
    expect(Object.keys(saved.colors.light)).toHaveLength(49);
    await expect(page.locator('.brand-name:visible')).toHaveText(name);
    await expect(page.locator('.brand-logo:visible')).toHaveAttribute('src', saved.logoUrl);
    await expect.poll(() => page.locator('.brand-logo:visible').evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator('.brand-logo:visible')).toHaveCSS('object-fit', 'contain');
    await peer.bringToFront(); await expect(peer.locator('.brand-name:visible')).toHaveText(name);
    await expect(peer.getByText(`Add ${name} sign-in to your applications.`, { exact: true })).toBeVisible();
    await expect(peer.getByText(`Let people sign in to your website or application with their ${name} account.`, { exact: true })).toBeVisible();
    await peer.goto('/en-us/developer/applications/new');
    await expect(peer.getByText(`One exact URI per line for returning after signing out of ${name}.`, { exact: true })).toBeVisible();
    await peer.goto('/zh-cn/developer/applications');
    await expect(peer.getByText(`为你的应用接入 ${name} 登录。`, { exact: true })).toBeVisible();
    await expect(peer.getByText(`让用户使用 ${name} 账号登录你的网站或应用。`, { exact: true })).toBeVisible();
    await peer.route('**/api/oauth/consent?*', (route) => route.fulfill({ json: {
        client: { clientId: 'brand-client', name: 'Example application' }, scopes: ['openid'],
    } }));
    const authorization = 'client_id=brand-client&scope=openid&sig=branding-ui-test&ba_param=client_id&ba_param=scope';
    await peer.goto(`/en-us/consent?${authorization}`);
    await expect(peer.getByText(`Example application wants to use your ${name} account.`, { exact: true })).toBeVisible();
    await peer.goto(`/zh-cn/consent?${authorization}`);
    await expect(peer.getByText(`Example application 希望使用你的 ${name} 账号。`, { exact: true })).toBeVisible();
    await expect.poll(() => peer.evaluate(() => window.loginflareBranding.getSnapshot().colorScheme)).toBe('vibrant');
    await page.bringToFront(); await page.reload();
    await expect(page.getByLabel('Brand name', { exact: true })).toHaveValue(name);
    await expect(page.locator('md-outlined-select')).toHaveJSProperty('value', 'vibrant');
    await expect(page).toHaveTitle(name);
    const keyboardChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose logo', exact: true }).press('Enter');
    await (await keyboardChooser).setFiles([]);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-primary').trim())).toBe(saved.colors.light.primary);
    await page.getByRole('button', { name: 'Theme', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-primary').trim())).toBe(saved.colors.dark.primary);
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('brand-settings-mobile.png'), fullPage: true });
    await peer.close();
    await page.route(/\/assets\/index-[^/]+\.js(?:\?.*)?$/, (route) => route.abort());
    await page.reload();
    await expect(page.locator('#root')).toBeEmpty();
    expect(await page.evaluate(() => window.loginflareBranding.getSnapshot().name)).toBe(name);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-primary').trim())).toBe(saved.colors.dark.primary);
});

test('adjusts SVG logos before upload and retains vectors with the displayed rotation', async ({ page, context }) => {
    await signin(page); await page.goto('/en-us/admin/branding');
    const vectors = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="64 104 80 40"><path fill="#ff0000" d="M64 104h40v40H64z"/><path fill="#0000ff" d="M104 104h40v40H104z"/></svg>');
    const uploads: Buffer[] = [];
    page.on('request', (request) => { if (request.url() === `${testOrigin}/api/admin/branding/logo` && request.method() === 'POST') uploads.push(request.postDataBuffer()!); });
    const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Edit logo', exact: true }).click();
    await (await chooser).setFiles({ name: 'bands.svg', mimeType: 'image/svg+xml', buffer: vectors });
    const editor = page.locator('md-dialog.image-crop-dialog');
    const save = editor.getByRole('button', { name: 'Use logo', exact: true });
    await expect(save).toBeEnabled(); expect(uploads).toHaveLength(0);
    const initialFrame = (await editor.locator('.reactEasyCrop_CropArea').boundingBox())!;
    expect(initialFrame.width).toBeCloseTo(initialFrame.height, 1);
    const preview = await editor.getByRole('img', { name: 'Logo preview', exact: true }).evaluate((element) => {
        const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 2;
        const drawing = canvas.getContext('2d')!; drawing.drawImage(element as HTMLImageElement, 0, 0, 4, 2);
        return { left: Array.from(drawing.getImageData(0, 1, 1, 1).data), right: Array.from(drawing.getImageData(3, 1, 1, 1).data) };
    });
    expect(preview).toEqual({ left: [255, 0, 0, 255], right: [0, 0, 255, 255] });
    await editor.getByRole('button', { name: 'Rotate right', exact: true }).click();
    await expect(save).toBeEnabled();
    const rotatedFrame = (await editor.locator('.reactEasyCrop_CropArea').boundingBox())!;
    expect(rotatedFrame.width).toBeCloseTo(rotatedFrame.height, 1);
    expect(rotatedFrame.width).toBeCloseTo(initialFrame.width, 1);
    const response = page.waitForResponse((response) => response.url() === `${testOrigin}/api/admin/branding/logo` && response.request().method() === 'POST');
    await save.click(); const uploaded = await response;
    expect(uploaded.status()).toBe(200); await expect(editor).toHaveCount(0);
    expect(uploads).toHaveLength(1); expect(uploads[0]!.toString()).toContain('<g transform='); expect(uploads[0]!.toString()).not.toContain('<image');
    const { logoUrl } = await uploaded.json() as { logoUrl: string };
    const stored = await context.request.get(`${testOrigin}${logoUrl}`);
    expect(stored.headers()['content-type']).toBe('image/svg+xml'); expect(await stored.text()).toBe(uploads[0]!.toString());
    const pixels = await page.evaluate(async (url) => {
        const image = new Image(); image.src = url; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 8;
        const drawing = canvas.getContext('2d')!; drawing.drawImage(image, 0, 0, 4, 8);
        return { width: image.naturalWidth, height: image.naturalHeight, top: Array.from(drawing.getImageData(2, 1, 1, 1).data), bottom: Array.from(drawing.getImageData(2, 6, 1, 1).data) };
    }, logoUrl);
    expect(pixels).toMatchObject({ width: 512, height: 512, top: [255, 0, 0, 255], bottom: [0, 0, 255, 255] });
    expect((await (await context.request.get(`${testOrigin}/api/branding`)).json()).logoId).toBeNull();
});

test('cancels without uploading, then confirms a raster logo as WebP through the shared editor', async ({ page }) => {
    await signin(page); await page.goto('/en-us/admin/branding');
    let uploads = 0;
    page.on('request', (request) => { if (request.url() === `${testOrigin}/api/admin/branding/logo` && request.method() === 'POST') uploads++; });
    const file = { name: 'source.png', mimeType: 'image/png', buffer: Buffer.from(sourcePng, 'base64') };
    async function choose() {
        const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Choose logo', exact: true }).click();
        await (await chooser).setFiles(file);
        const editor = page.locator('md-dialog.image-crop-dialog');
        await expect(editor.getByRole('button', { name: 'Use logo', exact: true })).toBeEnabled();
        const frame = (await editor.locator('.reactEasyCrop_CropArea').boundingBox())!;
        expect(frame.width).toBeCloseTo(frame.height, 1); return editor;
    }
    const editor = await choose(); await editor.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).toHaveCount(0); expect(uploads).toBe(0);
    await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    const confirmed = await choose();
    const request = page.waitForRequest((request) => request.url() === `${testOrigin}/api/admin/branding/logo` && request.method() === 'POST');
    await confirmed.getByRole('button', { name: 'Use logo', exact: true }).click();
    const uploaded = await request; expect(uploaded.headers()['content-type']).toBe('image/webp');
    const image = inspectImage(uploaded.postDataBuffer()!); expect(image).toMatchObject({ width: 512, height: 512 });
    await expect(confirmed).toHaveCount(0); await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
});

test('saves scheme-only changes and restores the default without creating empty edits', async ({ page }) => {
    await signin(page); await page.goto('/en-us/admin/branding');
    const select = page.getByRole('combobox', { name: 'Color scheme', exact: true });
    const save = page.getByRole('button', { name: 'Save changes', exact: true });
    const reset = page.getByRole('button', { name: 'Restore defaults', exact: true });
    await expect(reset).toBeDisabled(); await expect(save).toBeDisabled();
    await select.click();
    await expect(page.getByRole('option')).toHaveCount(9);
    await page.getByRole('option', { name: 'Monochrome', exact: true }).click();
    await expect(save).toBeEnabled(); await expect(reset).toBeEnabled();
    await reset.click(); await expect(save).toBeDisabled(); await expect(reset).toBeDisabled();
    await expect(page.locator('md-outlined-select')).toHaveJSProperty('value', 'tonal-spot');
    await select.click(); await page.getByRole('option', { name: 'Monochrome', exact: true }).click();
    await save.click(); await expect(page.getByText('Your changes have been saved.', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.loginflareBranding.getSnapshot().colorScheme)).toBe('monochrome');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-primary').trim())).toBe('#000000');
    await page.reload(); await expect(page.locator('md-outlined-select')).toHaveJSProperty('value', 'monochrome');
    await expect(reset).toBeEnabled(); await reset.click(); await expect(save).toBeEnabled();
    await save.click(); await expect(page.getByText('Your changes have been saved.', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.loginflareBranding.getSnapshot().colorScheme)).toBe('tonal-spot');
    await expect(reset).toBeDisabled(); await expect(save).toBeDisabled();
});

test('preserves a draft and reports conflicts instead of overwriting another administrator', async ({ page, context }) => {
    await signin(page); await page.goto('/en-us/admin/branding');
    await page.getByLabel('Brand name', { exact: true }).fill('First edit');
    const peer = await context.newPage(); await peer.goto('/en-us/admin/branding');
    await peer.getByLabel('Brand name', { exact: true }).fill('Second draft');
    await page.bringToFront(); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('Your changes have been saved.', { exact: true })).toBeVisible();
    await peer.bringToFront(); await peer.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(peer.getByRole('alert')).toContainText('changed in another session');
    await expect(peer.getByLabel('Brand name', { exact: true })).toHaveValue('Second draft');
    await peer.close();
});

test('keeps brand settings out of the ordinary account area and denies direct access', async ({ page, context }) => {
    await signin(page, 'user');
    await expect(page.getByRole('link', { name: 'Brand settings', exact: true })).toHaveCount(0);
    await page.goto('/en-us/admin/branding');
    await expect(page.getByRole('heading', { name: 'Access restricted', exact: true })).toBeVisible();
    expect((await context.request.get(`${testOrigin}/api/admin/branding`)).status()).toBe(403);
});
