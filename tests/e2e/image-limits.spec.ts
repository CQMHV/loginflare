import type { BrowserContext } from '@playwright/test';
import { expect, test, type Page } from './fixtures';
import { testOrigin } from './runtime';
import type { Identity } from '../../src/client/api';
import { defaultBranding } from '../../src/shared/branding';
import { maximumImageBytes, maximumSourceBytes } from '../../src/shared/image-limits';
import { defaultConnectionConfig, type SocialConnection } from '../../src/shared/social';
import { sourcePng } from '../fixtures/avatars';

const imageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const targets = [
    { kind: 'avatar', locale: 'en-us', path: 'account', edit: 'Edit photo', save: 'Save photo', cancel: 'Cancel', svg: false },
    { kind: 'logo', locale: 'zh-cn', path: 'admin/branding', edit: '编辑 Logo', save: '使用此 Logo', cancel: '取消', svg: true },
    { kind: 'social', locale: 'en-us', path: 'admin/social-connections', edit: 'Edit connection icon', save: 'Use icon', cancel: 'Cancel', svg: true },
] as const;

async function imageFixture(context: BrowserContext) {
    const now = new Date().toISOString();
    const actor: Identity = {
        user: { id: 'image-limits-admin', name: 'Image Limits Administrator', username: 'image_limits_admin', email: 'image-limits@loginflare.test', emailVerified: true, role: 'admin', createdAt: now },
        session: { id: 'image-limits-session', userId: 'image-limits-admin', token: 'test-only-image-session', createdAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    };
    const connection: SocialConnection = {
        id: 'image-limits-connection', name: 'Image limits preview', type: 'google', position: 0, revision: 1,
        config: { ...defaultConnectionConfig('google'), clientId: 'image-limits-client' },
        hasSecret: true, enabled: true, archived: false, identityLocked: true, linkedAccounts: 1,
        callbackURL: `${testOrigin}/api/auth/callback/image-limits-connection`, iconId: null, iconUrl: null,
    };
    const branding = { ...defaultBranding, logoUrl: '/assets/logo.svg', colors: { light: {}, dark: {} } };
    const uploads: { path: string; bytes: Buffer }[] = [];
    const otherWrites: string[] = [];
    await context.route(`${testOrigin}/api/**`, async (route) => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (request.method() !== 'GET') {
            if (['/api/account/avatar', '/api/admin/branding/logo', '/api/admin/social-connections/icon'].includes(path)) {
                uploads.push({ path, bytes: request.postDataBuffer()! });
                if (path === '/api/account/avatar') {
                    actor.user.image = `${testOrigin}/avatars/${imageId}`;
                    await route.fulfill({ json: { image: actor.user.image } });
                } else if (path === '/api/admin/branding/logo') await route.fulfill({ json: { logoId: imageId, logoUrl: `/branding/logos/${imageId}` } });
                else await route.fulfill({ json: { iconId: imageId, iconUrl: `/social/icons/${imageId}` } });
                return;
            }
            otherWrites.push(path);
        }
        if (path === '/api/auth/get-session') await route.fulfill({ json: actor });
        else if (path === '/api/admin/branding' || path === '/api/branding') await route.fulfill({ json: branding });
        else if (path === '/api/admin/social-connections') await route.fulfill({ json: { connections: [connection] } });
        else await route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
    });
    for (const path of [`/avatars/${imageId}`, `/branding/logos/${imageId}`, `/social/icons/${imageId}`]) {
        await context.route(`${testOrigin}${path}`, (route) => uploads.length
            ? route.fulfill({ contentType: 'image/webp', body: uploads.at(-1)!.bytes })
            : route.fulfill({ status: 404, body: '' }));
    }
    return { uploads, otherWrites };
}

async function choose(page: Page, label: string, file: { name: string; mimeType: string; buffer: Buffer }) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: label, exact: true }).click();
    await (await chooser).setFiles(file);
}

function svgOfSize(size: number) {
    const start = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#6750a4"/><!--';
    const end = '--></svg>';
    return Buffer.from(start + 'x'.repeat(size - Buffer.byteLength(start + end)) + end);
}

for (const target of targets) {
    test(`uses shared source and output limits for ${target.kind} in ${target.locale}`, async ({ page, context }) => {
        const state = await imageFixture(context);
        await page.goto(`/${target.locale}/${target.path}`);
        if (target.kind === 'social') await page.getByRole('button', { name: 'Edit connection', exact: true }).click();
        const crop = page.locator('md-dialog.image-crop-dialog');
        await choose(page, target.edit, { name: 'oversized.png', mimeType: 'image/png', buffer: Buffer.alloc(maximumSourceBytes + 1) });
        await expect(page.getByRole('alert')).toContainText('20 MiB');
        await expect(crop).toHaveCount(0);
        expect(state.uploads).toHaveLength(0);

        if (target.svg) {
            await choose(page, target.edit, { name: 'oversized.svg', mimeType: 'image/svg+xml', buffer: svgOfSize(maximumImageBytes + 1) });
            await expect(page.getByRole('alert')).toContainText('256 KiB');
            await expect(crop).toHaveCount(0);
            expect(state.uploads).toHaveLength(0);
            // The exact source boundary is accepted; the exported crop wrapper
            // then exceeds the common upload limit and must stay in the editor.
            await choose(page, target.edit, { name: 'boundary.svg', mimeType: 'image/svg+xml', buffer: svgOfSize(maximumImageBytes) });
            await expect(crop.getByRole('button', { name: target.save, exact: true })).toBeEnabled();
            await crop.getByRole('button', { name: target.save, exact: true }).click();
            await expect(crop.getByRole('alert')).toContainText('256 KiB');
            await expect(crop).toBeVisible();
            expect(state.uploads).toHaveLength(0);
            await crop.getByRole('button', { name: target.cancel, exact: true }).click();
            await expect(crop).toHaveCount(0);
        }

        await choose(page, target.edit, { name: 'valid.png', mimeType: 'image/png', buffer: Buffer.from(sourcePng, 'base64') });
        const save = crop.getByRole('button', { name: target.save, exact: true });
        await expect(save).toBeEnabled();
        const restoreEncoder = await page.evaluateHandle((limit) => {
            const original = HTMLCanvasElement.prototype.toBlob;
            HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
                if (type === 'image/webp') queueMicrotask(() => callback(new Blob([new Uint8Array(limit + 1)], { type: 'image/webp' })));
                else original.call(this, callback, type, quality);
            };
            return () => { HTMLCanvasElement.prototype.toBlob = original; };
        }, maximumImageBytes);
        try {
            await save.click();
            await expect(crop.getByRole('alert')).toContainText('256 KiB');
            await expect(crop).toBeVisible();
            await expect(save).toBeEnabled();
            expect(state.uploads).toHaveLength(0);
        } finally {
            await restoreEncoder.evaluate((restore) => restore());
            await restoreEncoder.dispose();
        }
        // The original file remains available for a normal retry.
        await save.click();
        await expect(crop).toHaveCount(0);
        expect(state.uploads).toHaveLength(1);
        expect(state.uploads[0]!.bytes.length).toBeLessThanOrEqual(maximumImageBytes);
        expect(state.otherWrites).toHaveLength(0);
    });
}
