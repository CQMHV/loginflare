import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { deflateSync } from 'node:zlib';
import { expect, test } from './fixtures';
import { executeLocal, removeLocalFixtures } from './database';
import { avatarJpeg, avatarWebp, sourcePng } from '../fixtures/avatars';
import { inspectImage, maximumSourceBytes } from '../../src/shared/avatars';

function largeSourcePng() {
    const width = 10_000, height = 3_000;
    const table = Uint32Array.from({ length: 256 }, (_, value) => {
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        return value >>> 0;
    });
    const chunk = (type: string, data: Buffer) => {
        const contents = Buffer.concat([Buffer.from(type), data]);
        let crc = 0xffffffff;
        for (const value of contents) crc = table[(crc ^ value) & 255]! ^ (crc >>> 8);
        const result = Buffer.alloc(12 + data.length);
        result.writeUInt32BE(data.length); contents.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
        return result;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
        chunk('tEXt', Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(6 * 1024 * 1024, 65)])),
        chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0)),
    ]);
}

const emails: string[] = [];
test.afterEach(() => { removeLocalFixtures(emails); emails.length = 0; });

test('uploads, crops, synchronizes, replaces and removes avatars through the real account APIs', async ({ page, context }) => {
    test.setTimeout(120_000);
    const id = randomUUID(), email = `ui-${randomUUID()}@loginflare.test`, password = 'Avatar-local-test-731!';
    emails.push(email);
    const now = new Date().toISOString(), hash = await hashPassword(password);
    executeLocal(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned, locale) VALUES ('${id}', 'Avatar Person', '${email}', 1, '${now}', '${now}', 'admin', 0, 'en-US');
        INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ('${randomUUID()}', '${id}', 'credential', '${id}', '${hash}', '${now}', '${now}');`);
    await page.goto('/en-us/login');
    await page.getByLabel('Email or username', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL('/en-us/account');
    await page.getByRole('link', { name: 'Administration', exact: true }).click();
    const row = page.locator('tbody tr').filter({ hasText: email });
    await expect(row).toBeVisible();
    await expect(row.locator('.table-avatar img')).toHaveCount(0);
    await page.getByRole('link', { name: 'Account center', exact: true }).click();
    const peer = await context.newPage();
    await peer.goto('/en-us/account');
    await peer.getByLabel('Display name', { exact: true }).fill('Unsaved peer draft');
    const file = { name: 'synthetic-avatar.png', mimeType: 'image/png', buffer: Buffer.from(sourcePng, 'base64') };
    await page.getByLabel('Choose an avatar image', { exact: true }).setInputFiles(file);
    await expect(page.getByRole('img', { name: 'Avatar preview', exact: true })).toBeVisible();
    await page.getByRole('slider', { name: 'Zoom', exact: true }).press('End');
    await page.getByRole('slider', { name: 'Horizontal position', exact: true }).press('Home');
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/account/avatar') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save photo', exact: true }).click();
    const uploaded = await saved;
    expect(uploaded.status()).toBe(200);
    expect(uploaded.request().headers()['content-type']).toBe('image/webp');
    const payload = uploaded.request().postDataBuffer()!;
    expect(inspectImage(payload)).toMatchObject({ mime: 'image/webp', width: 256, height: 256 });
    expect(payload.toString()).not.toContain('fixture-private-location');
    const stored = await context.request.get((await uploaded.json()).image);
    expect(stored.headers()['content-type']).toBe('image/webp');
    expect(inspectImage(await stored.body())).toMatchObject({ mime: 'image/webp', width: 256, height: 256 });
    await expect(page.locator('.profile-avatar img')).toBeVisible();
    await expect.poll(() => page.locator('.profile-avatar img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(256);
    const first = await page.locator('.profile-avatar img').getAttribute('src');
    await peer.bringToFront();
    await expect(peer.locator('.profile-avatar img')).toHaveAttribute('src', first!);
    await expect(peer.getByLabel('Display name', { exact: true })).toHaveValue('Unsaved peer draft');
    await peer.close();
    await page.getByRole('link', { name: 'Administration', exact: true }).click();
    await expect(row.locator('.table-avatar img')).toHaveAttribute('src', first!);
    await row.locator('.table-user').click();
    await expect(page.locator('.page-heading .profile-avatar img')).toHaveAttribute('src', first!);
    await page.getByRole('link', { name: 'Account center', exact: true }).click();
    await page.getByLabel('Choose an avatar image', { exact: true }).setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg onload="alert(1)"/>') });
    await expect(page.getByRole('alert')).toContainText('Choose a valid static');
    await expect(page.locator('.profile-avatar img')).toHaveAttribute('src', first!);
    await page.getByLabel('Choose an avatar image', { exact: true }).setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(maximumSourceBytes + 1) });
    await expect(page.getByRole('alert')).toContainText('no larger than 20 MiB');
    await expect(page.locator('.profile-avatar img')).toHaveAttribute('src', first!);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/zh-cn/account');
    await page.getByLabel('选择头像图片', { exact: true }).setInputFiles(file);
    await expect(page.getByRole('img', { name: '头像预览', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('avatar-crop-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.locator('.profile-avatar img')).toHaveAttribute('src', first!);
    await page.getByLabel('选择头像图片', { exact: true }).setInputFiles(file);
    await page.getByRole('button', { name: '保存头像', exact: true }).click();
    await expect(page.locator('.profile-avatar img')).not.toHaveAttribute('src', first!);
    await page.reload();
    await expect(page.locator('.profile-avatar img')).toBeVisible();
    const large = largeSourcePng();
    expect(large.byteLength).toBeGreaterThan(5 * 1024 * 1024);
    const sources = [
        ...[['jpeg', avatarJpeg], ['webp', avatarWebp]].map(([type, data]) => ({ name: `synthetic.${type}`, mimeType: `image/${type}`, buffer: Buffer.from(data!, 'base64') })),
        { name: 'large-source.png', mimeType: 'image/png', buffer: large },
    ];
    for (const source of sources) {
        const before = await page.locator('.profile-avatar img').getAttribute('src');
        await page.getByLabel('选择头像图片', { exact: true }).setInputFiles(source);
        const posted = page.waitForResponse((response) => response.url().endsWith('/api/account/avatar') && response.request().method() === 'POST');
        await page.getByRole('button', { name: '保存头像', exact: true }).click();
        const response = await posted;
        expect(response.status()).toBe(200);
        expect(response.request().headers()['content-type']).toBe('image/webp');
        expect(inspectImage(response.request().postDataBuffer()!)).toMatchObject({ mime: 'image/webp', width: 256, height: 256 });
        await expect(page.locator('.profile-avatar img')).not.toHaveAttribute('src', before!);
    }
    let unexpectedUploads = 0;
    page.on('request', (request) => { if (request.url().endsWith('/api/account/avatar') && request.method() === 'POST') unexpectedUploads++; });
    for (const mode of ['png', 'null', 'decode']) {
        const before = await page.locator('.profile-avatar img').getAttribute('src');
        await page.evaluate((failure) => {
            if (failure === 'decode') {
                window.createImageBitmap = async () => { throw new Error('Test image decode failure'); };
                return;
            }
            const encode = HTMLCanvasElement.prototype.toBlob;
            HTMLCanvasElement.prototype.toBlob = function(callback, _type, quality) {
                if (failure === 'null') queueMicrotask(() => callback(null));
                else encode.call(this, callback, 'image/png', quality);
            };
        }, mode);
        await page.getByLabel('选择头像图片', { exact: true }).setInputFiles(file);
        if (mode !== 'decode') await page.getByRole('button', { name: '保存头像', exact: true }).click();
        await expect(page.getByRole('alert')).toContainText(mode === 'png' ? '当前浏览器无法生成 WebP 图片' : '无法处理这张图片');
        expect(unexpectedUploads).toBe(0);
        await expect(page.locator('.profile-avatar img')).toHaveAttribute('src', before!);
        if (mode !== 'decode') await page.getByRole('button', { name: '取消', exact: true }).click();
        await page.reload();
        await expect(page.locator('.profile-avatar img')).toHaveAttribute('src', before!);
    }
    await page.getByRole('button', { name: '移除头像', exact: true }).click();
    await page.locator('md-dialog').getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.locator('.profile-avatar img')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.profile-avatar img')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Avatar Person', exact: true })).toBeVisible();
});
