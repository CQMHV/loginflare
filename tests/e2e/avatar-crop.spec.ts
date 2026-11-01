import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from './fixtures';
import { testOrigin } from './runtime';
import { sourcePng } from '../fixtures/avatars';

test.use({ hasTouch: true });

test('reports an editor load failure without losing the profile or uploading the photo', async ({ page }) => {
    const uploads = await cropFixture(page);
    await page.route('**/assets/ImageCropDialog-*.js', (route) => route.abort());
    await page.goto('/en-us/account');
    const chooser = page.waitForEvent('filechooser');
    const badge = page.getByRole('button', { name: 'Edit photo', exact: true });
    const bounds = (await badge.boundingBox())!;
    // The edit control remains clickable where it extends beyond the photo.
    await badge.click({ position: { x: bounds.width - 4, y: bounds.height / 2 } });
    await (await chooser).setFiles({ name: 'crop.png', mimeType: 'image/png', buffer: Buffer.from(sourcePng, 'base64') });
    await expect(page.getByRole('alert')).toHaveText('Unable to load the image editor. Reload this page and try again.');
    await expect(page.locator('md-dialog.image-crop-dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Change photo', exact: true })).toBeEnabled();
    await page.getByLabel('Display name', { exact: true }).fill('Retained profile');
    await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Retained profile');
    expect(uploads).toHaveLength(0);
});

async function cropFixture(page: Page) {
    const now = new Date().toISOString();
    const actor = {
        user: { id: 'crop-user', name: 'Crop preview', username: 'crop_preview', email: 'crop@loginflare.test', emailVerified: true, image: null as string | null, role: 'user', locale: 'en-US', createdAt: now },
        session: { id: 'crop-session', userId: 'crop-user', token: 'crop-test-only', createdAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    };
    const uploads: Buffer[] = [];
    await page.route(`${testOrigin}/api/**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/auth/get-session') { await route.fulfill({ json: actor }); return; }
        if (path === '/api/account/avatar' && route.request().method() === 'POST') {
            uploads.push(route.request().postDataBuffer()!);
            actor.user.image = `${testOrigin}/avatars/${randomUUID()}`;
            await route.fulfill({ json: { image: actor.user.image } }); return;
        }
        await route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
    });
    await page.route(`${testOrigin}/avatars/**`, (route) => route.fulfill({ contentType: 'image/webp', body: uploads.at(-1)! }));
    return uploads;
}

async function choosePhoto(page: Page, data = sourcePng, locale = 'en-us') {
    await page.goto(`/${locale}/account`);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: locale === 'zh-cn' ? '编辑头像' : 'Edit photo', exact: true }).click();
    await (await chooser).setFiles({ name: 'crop.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
    const dialog = page.locator('md-dialog.image-crop-dialog');
    await expect(dialog.getByRole('button', { name: locale === 'zh-cn' ? '保存头像' : 'Save photo', exact: true })).toBeEnabled();
    return dialog;
}

async function pixels(page: Page, base64: string) {
    return page.evaluate(async (data) => {
        const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes]));
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const colors = [[.25, .25], [.75, .25], [.25, .75], [.75, .75]].map(([x, y]) =>
            [...context.getImageData(Math.floor(x! * image.width), Math.floor(y! * image.height), 1, 1).data]);
        const rgba = context.getImageData(0, 0, image.width, image.height).data;
        let minimumAlpha = 255;
        for (let index = 3; index < rgba.length; index += 4) {
            minimumAlpha = Math.min(minimumAlpha, rgba[index]!);
        }
        image.close();
        return { width: canvas.width, height: canvas.height, colors, minimumAlpha };
    }, base64);
}

async function resizedPhoto(page: Page, width: number, height: number) {
    return page.evaluate(async ({ data, width, height }) => {
        const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes]));
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d')!.drawImage(image, 0, 0, width, height);
        image.close();
        return canvas.toDataURL('image/png').split(',')[1]!;
    }, { data: sourcePng, width, height });
}

test('keeps edit-button feedback separate from the photo and supports keyboard activation', async ({ page }) => {
    const uploads = await cropFixture(page);
    await page.goto('/en-us/account');
    const edit = page.getByRole('button', { name: 'Edit photo', exact: true });
    const photo = page.getByRole('button', { name: 'Change photo', exact: true });
    const editState = edit.locator('md-ripple .surface');
    const photoState = photo.locator('md-ripple .surface');
    await edit.hover();
    await expect(editState).toHaveClass(/\bhovered\b/);
    await expect(photoState).not.toHaveClass(/\bhovered\b/);
    await page.mouse.down();
    await expect(editState).toHaveClass(/\bpressed\b/);
    await expect(photoState).not.toHaveClass(/\bpressed\b/);
    await page.screenshot({ path: test.info().outputPath('edit-button-pressed.png'), fullPage: false });
    let chooser = page.waitForEvent('filechooser');
    await page.mouse.up();
    await (await chooser).setFiles({ name: 'crop.png', mimeType: 'image/png', buffer: Buffer.from(sourcePng, 'base64') });
    await expect(page.getByRole('button', { name: 'Save photo', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await edit.focus();
    await expect(edit).toBeFocused();
    await expect(photo).not.toBeFocused();
    chooser = page.waitForEvent('filechooser');
    await edit.press('Enter');
    await (await chooser).setFiles({ name: 'crop.png', mimeType: 'image/png', buffer: Buffer.from(sourcePng, 'base64') });
    await expect(page.getByRole('button', { name: 'Save photo', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(uploads).toHaveLength(0);
});

test('drags and zooms directly, resets the crop and cancels without uploading', async ({ page }) => {
    const uploads = await cropFixture(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await choosePhoto(page);
    const image = dialog.getByRole('img', { name: 'Avatar preview', exact: true });
    const initial = await image.evaluate((element) => (element as HTMLElement).style.transform);
    const position = dialog.getByRole('region', { name: 'Photo position', exact: true });
    const bounds = (await position.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 45, bounds.y + bounds.height / 2 + 25, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => image.evaluate((element) => (element as HTMLElement).style.transform)).not.toBe(initial);
    await page.mouse.wheel(0, -180);
    const zoom = dialog.getByRole('slider', { name: 'Zoom', exact: true });
    await expect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(1);
    await dialog.getByRole('button', { name: 'Reset crop', exact: true }).click();
    await expect(zoom).toHaveValue('1');
    await expect.poll(() => image.evaluate((element) => (element as HTMLElement).style.transform)).toBe(initial);
    await page.screenshot({ path: test.info().outputPath('crop-desktop.png'), fullPage: false });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('md-dialog.image-crop-dialog')).toHaveCount(0);
    expect(uploads).toHaveLength(0);
});

test('rotates the original and exports the visible composition as a square WebP', async ({ page }) => {
    const uploads = await cropFixture(page);
    const original = await pixels(page, sourcePng);
    const dialog = await choosePhoto(page);
    const position = dialog.getByRole('region', { name: 'Photo position', exact: true });
    const image = dialog.getByRole('img', { name: 'Avatar preview', exact: true });
    const initial = await image.evaluate((element) => (element as HTMLElement).style.transform);
    await position.press('ArrowRight');
    await expect.poll(() => image.evaluate((element) => (element as HTMLElement).style.transform)).not.toBe(initial);
    await dialog.getByRole('button', { name: 'Reset crop', exact: true }).click();
    await dialog.getByRole('button', { name: 'Rotate right', exact: true }).click();
    await expect.poll(() => image.evaluate((element) => (element as HTMLElement).style.transform)).toContain('rotate(90deg)');
    await dialog.getByRole('button', { name: 'Save photo', exact: true }).click();
    await expect.poll(() => uploads.length).toBe(1);
    await expect(page.locator('md-dialog.image-crop-dialog')).toHaveCount(0);
    const exported = await pixels(page, uploads[0]!.toString('base64'));
    expect([exported.width, exported.height]).toEqual([256, 256]);
    const order = [2, 0, 3, 1]; // Clockwise quarter turn of the four-color source.
    for (let index = 0; index < 4; index++) {
        for (let channel = 0; channel < 4; channel++) {
            expect(Math.abs(exported.colors[index]![channel]! - original.colors[order[index]!]![channel]!)).toBeLessThanOrEqual(10);
        }
    }
});

test('minimum zoom fills only the crop frame and never exposes background when dragging landscape, portrait or small photos', async ({ page }) => {
    const uploads = await cropFixture(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const [width, height] of [[560, 280], [280, 560], [32, 32]]) {
        const source = await resizedPhoto(page, width!, height!);
        const dialog = await choosePhoto(page, source);
        const zoom = dialog.getByRole('slider', { name: 'Zoom', exact: true });
        await zoom.press('End');
        await dialog.getByRole('region', { name: 'Photo position', exact: true }).press('ArrowRight');
        await zoom.press('Home');
        await expect(zoom).toHaveValue('1');
        const geometry = await dialog.evaluate((element) => {
            const frame = element.querySelector('.reactEasyCrop_CropArea')!.getBoundingClientRect();
            const image = element.querySelector('img')!.getBoundingClientRect();
            return { frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height }, width: image.width, height: image.height };
        });
        // The short side touches the crop frame, without filling the larger editor stage.
        expect(Math.abs(Math.min(geometry.width, geometry.height) - geometry.frame.width)).toBeLessThanOrEqual(.5);
        const x = geometry.frame.x + geometry.frame.width / 2, y = geometry.frame.y + geometry.frame.height / 2;
        for (const direction of [-1, 1]) {
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x + direction * 240, y + direction * 170, { steps: 5 });
            await page.mouse.up();
            const uncovered = await dialog.evaluate((element) => {
                const frame = element.querySelector('.reactEasyCrop_CropArea')!.getBoundingClientRect();
                const image = element.querySelector('img')!.getBoundingClientRect();
                return [image.left - frame.left, image.top - frame.top, frame.right - image.right, frame.bottom - image.bottom];
            });
            for (const gap of uncovered) expect(gap).toBeLessThanOrEqual(.5);
        }
        await page.screenshot({ path: test.info().outputPath(`crop-fit-${width}-${height}.png`), fullPage: false });
        await dialog.getByRole('button', { name: 'Save photo', exact: true }).click();
        await expect(page.locator('md-dialog.image-crop-dialog')).toHaveCount(0);
        const exported = await pixels(page, uploads.at(-1)!.toString('base64'));
        expect([exported.width, exported.height]).toEqual([256, 256]);
        expect(exported.minimumAlpha).toBe(255);
    }
    expect(uploads).toHaveLength(3);
});

test('supports touch pinch and dragging on a short mobile viewport', async ({ page, context }) => {
    const uploads = await cropFixture(page);
    await page.setViewportSize({ width: 375, height: 667 });
    const portrait = await resizedPhoto(page, 300, 600);
    const dialog = await choosePhoto(page, portrait, 'zh-cn');
    const save = dialog.getByRole('button', { name: '保存头像', exact: true });
    const saveBounds = (await save.boundingBox())!;
    expect(saveBounds.y).toBeGreaterThanOrEqual(0);
    expect(saveBounds.y + saveBounds.height).toBeLessThanOrEqual(667);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const position = dialog.getByRole('region', { name: '头像位置', exact: true });
    const bounds = (await position.boundingBox())!;
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    const client = await context.newCDPSession(page);
    try {
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - 30, y, id: 1 }, { x: x + 30, y, id: 2 }] });
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 60, y, id: 1 }, { x: x + 60, y, id: 2 }] });
        const zoom = dialog.getByRole('slider', { name: '缩放', exact: true });
        await expect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(1);
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        const image = dialog.getByRole('img', { name: '头像预览', exact: true });
        const before = await image.evaluate((element) => (element as HTMLElement).style.transform);
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
        await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 30, y: y + 20, id: 1 }] });
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await expect.poll(() => image.evaluate((element) => (element as HTMLElement).style.transform)).not.toBe(before);
    } finally { await client.detach(); }
    await page.screenshot({ path: test.info().outputPath('crop-mobile.png'), fullPage: false });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(uploads).toHaveLength(0);
});
