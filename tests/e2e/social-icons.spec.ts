import type { BrowserContext } from '@playwright/test';
import { expect, test, selectMaterialOption } from './fixtures';
import { testOrigin } from './runtime';
import type { Identity } from '../../src/client/api';
import { defaultConnectionConfig, type SocialConnection } from '../../src/shared/social';

const iconId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const brokenIconId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const iconUrl = `/social/icons/${iconId}`;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#6750a4"/><path d="m18 32 9 9 19-20" fill="none" stroke="white" stroke-width="6"/></svg>';

async function icons(context: BrowserContext) {
    const now = new Date().toISOString();
    const actor: Identity = {
        user: { id: 'icon-administrator', name: 'Icon Administrator', email: 'icons@loginflare.test', emailVerified: true, role: 'admin', createdAt: now },
        session: { id: 'icon-session', token: 'test-only-session', userId: 'icon-administrator', createdAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    };
    const state = {
        actor: actor as Identity | null, failUpload: false,
        connections: [{
            id: 'connection-google', name: 'Google preview', type: 'google', position: 0, revision: 1,
            config: { ...defaultConnectionConfig('google'), clientId: 'preview-client' },
            hasSecret: true, enabled: true, archived: false, identityLocked: true, linkedAccounts: 1,
            callbackURL: `${testOrigin}/api/auth/callback/connection-google`, iconId: null, iconUrl: null,
        }] as SocialConnection[],
        writes: [] as Record<string, unknown>[], uploads: [] as { type: string; bytes: Buffer }[], externalIcons: [] as string[],
        identities: [
            { id: 'linked-google', providerId: 'google', accountId: 'test-subject', name: 'Google', type: 'google', enabled: true, iconUrl: iconUrl as string | null },
            { id: 'linked-disabled-github', providerId: 'disabled-github', accountId: 'other-subject', name: 'Disabled GitHub', type: 'github', enabled: false, iconUrl: null },
        ],
    };
    const providers = [
        { id: 'google', name: 'Google', type: 'google', iconUrl },
        { id: 'oidc', name: 'OIDC', type: 'oidc', iconUrl: null },
        { id: 'github', name: 'GitHub', type: 'github', iconUrl: `/social/icons/${brokenIconId}` },
        { id: 'x', name: 'X', type: 'x', iconUrl: null },
        { id: 'telegram', name: 'Telegram', type: 'telegram', iconUrl: null },
        { id: 'untrusted', name: 'External metadata', type: 'oauth2', iconUrl: 'https://untrusted.example.test/tracker.svg' },
    ];
    context.on('request', (request) => { if (request.url().includes('untrusted.example.test')) state.externalIcons.push(request.url()); });
    await context.route(`${testOrigin}/social/icons/**`, (route) => new URL(route.request().url()).pathname === iconUrl
        ? route.fulfill({ contentType: 'image/svg+xml', body: svg }) : route.fulfill({ status: 404, body: '' }));
    await context.route(`${testOrigin}/api/**`, async (route) => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (path === '/api/auth/get-session') await route.fulfill({ json: state.actor });
        else if (path === '/api/social/providers') await route.fulfill({ json: { providers } });
        else if (path === '/api/auth/social/security') await route.fulfill({ json: {
            hasPassword: false, providers, identities: state.identities,
        } });
        else if (path === '/api/admin/social-connections/icon') {
            state.uploads.push({ type: request.headers()['content-type'] ?? '', bytes: request.postDataBuffer()! });
            await route.fulfill(state.failUpload ? { status: 400, json: { code: 'SOCIAL_ICON_INVALID' } } : { json: { iconId, iconUrl } });
        } else if (path === '/api/admin/social-connections' && request.method() === 'GET') await route.fulfill({ json: { connections: state.connections } });
        else if (path === '/api/admin/social-connections/connection-google' && request.method() === 'PATCH') {
            const body = request.postDataJSON(); state.writes.push(body);
            const connection = { ...state.connections[0]!, ...body, revision: state.connections[0]!.revision + 1, iconUrl: body.iconId ? iconUrl : null };
            state.connections = [connection];
            await route.fulfill({ json: connection });
        } else await route.fallback();
    });
    return state;
}

for (const locale of ['en-us', 'zh-cn'] as const) {
    const chinese = locale === 'zh-cn';
    test(`previews, saves and removes connection icons with isolated crop errors in ${locale}`, async ({ page, context }) => {
        const state = await icons(context);
        await page.setViewportSize({ width: chinese ? 375 : 1280, height: 812 });
        await page.goto(`/${locale}/admin/social-connections`);
        const card = page.locator('.social-connection-list .card').filter({ hasText: 'Google preview' });
        const edit = card.getByRole('button', { name: chinese ? '编辑连接器' : 'Edit connection', exact: true });
        await edit.click();
        const editor = page.locator('md-dialog.form-dialog');
        const crop = page.locator('md-dialog.image-crop-dialog');
        const chooseIcon = async () => {
            const chooser = page.waitForEvent('filechooser');
            await editor.getByRole('button', { name: chinese ? '编辑连接器图标' : 'Edit connection icon', exact: true }).click();
            await (await chooser).setFiles({ name: 'connection.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
            await expect(crop.getByRole('button', { name: chinese ? '使用图标' : 'Use icon', exact: true })).toBeEnabled();
        };
        await chooseIcon();
        await page.keyboard.press('Escape');
        await expect(crop).toHaveCount(0);
        await expect(editor).toBeVisible();
        expect(state.uploads).toHaveLength(0);
        await editor.getByRole('button', { name: chinese ? '取消' : 'Cancel', exact: true }).click();
        await expect(editor).toHaveCount(0);
        await edit.click();
        await chooseIcon(); state.failUpload = true;
        await crop.getByRole('button', { name: chinese ? '使用图标' : 'Use icon', exact: true }).click();
        await expect(crop.getByRole('alert')).toBeInViewport({ ratio: 1 });
        await expect(editor.locator(':scope > form > [role="alert"]')).toHaveCount(0);
        await expect(editor.locator('.provider-icon-preview img:not(.provider-icon-google)')).toHaveCount(0);
        await expect(editor.locator('.provider-icon-google')).toBeVisible();
        expect(state.writes).toHaveLength(0);
        state.failUpload = false;
        await crop.getByRole('button', { name: chinese ? '使用图标' : 'Use icon', exact: true }).click();
        await expect(crop).toHaveCount(0);
        await expect(editor.locator('.provider-icon-preview img:not(.provider-icon-google)')).toHaveAttribute('src', iconUrl);
        await expect(card.locator('.provider-icon img:not(.provider-icon-google)')).toHaveCount(0);
        await expect(card.locator('.provider-icon-google')).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`connection-icon-preview-${locale}.png`) });
        const save = editor.getByRole('button', { name: chinese ? '保存修改' : 'Save changes', exact: true });
        await save.click();
        await expect(card.locator('.provider-icon img:not(.provider-icon-google)')).toHaveAttribute('src', iconUrl);
        expect(state.writes[0]?.iconId).toBe(iconId);
        expect(state.writes[0]).not.toHaveProperty('iconUrl');
        expect(state.uploads).toHaveLength(2);
        for (const upload of state.uploads) { expect(upload.type).toBe('image/svg+xml'); expect(upload.bytes.toString()).toContain('<svg'); }
        await editor.getByRole('button', { name: chinese ? '移除图标' : 'Remove icon', exact: true }).click();
        await expect(editor.locator('.provider-icon-preview img:not(.provider-icon-google)')).toHaveCount(0);
        await expect(editor.locator('.provider-icon-google')).toBeVisible();
        await expect(card.locator('.provider-icon img:not(.provider-icon-google)')).toHaveAttribute('src', iconUrl);
        await editor.getByRole('button', { name: chinese ? '取消' : 'Cancel', exact: true }).click();
        await expect(editor).toHaveCount(0);
        await edit.click();
        await expect(editor.locator('.provider-icon-preview img:not(.provider-icon-google)')).toHaveAttribute('src', iconUrl);
        await editor.getByRole('button', { name: chinese ? '移除图标' : 'Remove icon', exact: true }).click();
        await save.click();
        await expect(card.locator('.provider-icon img:not(.provider-icon-google)')).toHaveCount(0);
        await expect(card.locator('.provider-icon-google')).toBeVisible();
        expect(state.writes.at(-1)?.iconId).toBeNull();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.keyboard.press('Escape');
        await expect(editor).toHaveCount(0);
    });

    test(`shows configured icons and safe fallbacks on sign-in, registration and account actions in ${locale}`, async ({ page, context }) => {
        const state = await icons(context);
        const actor = state.actor; state.actor = null;
        await page.setViewportSize({ width: chinese ? 375 : 1280, height: 812 });
        for (const path of ['login', 'signup']) {
            await page.emulateMedia({ colorScheme: 'light' });
            await page.goto(`/${locale}/${path}`);
            const google = page.getByRole('button', { name: chinese ? '使用 Google 继续' : 'Continue with Google', exact: true });
            await expect(page.locator('md-outlined-button').filter({ has: google }).locator('.provider-icon img:not(.provider-icon-google)')).toHaveAttribute('src', iconUrl);
            await expect(google).toHaveAccessibleName(chinese ? '使用 Google 继续' : 'Continue with Google');
            for (const name of ['OIDC', 'GitHub', 'External metadata']) {
                const button = page.getByRole('button', { name: chinese ? `使用 ${name} 继续` : `Continue with ${name}`, exact: true });
                const host = page.locator('md-outlined-button').filter({ has: button });
                await expect(host.locator('.provider-icon svg')).toBeVisible();
                await expect(host.locator('.provider-icon img:not(.provider-icon-google)')).toHaveCount(0);
                if (name === 'GitHub') await expect(host.locator('.provider-icon-github')).toBeVisible();
            }
            for (const [name, type] of [['X', 'x'], ['Telegram', 'telegram']]) {
                const button = page.getByRole('button', { name: chinese ? `使用 ${name} 继续` : `Continue with ${name}`, exact: true });
                await expect(page.locator('md-outlined-button').filter({ has: button }).locator(`.provider-icon-${type}`)).toBeVisible();
            }
            for (const css of ['.provider-icon-x', '.provider-icon-telegram']) {
                await expect.poll(() => page.locator(css).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
            }
            await expect(page.locator('.provider-icon-x')).toHaveCSS('filter', 'none');
            await page.emulateMedia({ colorScheme: 'dark' });
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
            await expect(page.locator('.provider-icon-x')).toHaveCSS('filter', 'invert(1)');
            await page.screenshot({ path: test.info().outputPath(`social-icons-${path}-${locale}.png`), fullPage: true });
        }
        expect(state.externalIcons).toHaveLength(0);
        state.actor = actor;
        await page.goto(`/${locale}/account/security`);
        for (const [name, type] of [['X', 'x'], ['Telegram', 'telegram']]) {
            const row = page.locator('.social-account').filter({ has: page.getByRole('button', { name: chinese ? `绑定 ${name}` : `Link ${name}`, exact: true }) });
            await expect(row.locator(`.provider-icon-${type}`)).toBeVisible();
        }
        const linked = page.locator('.social-account').filter({ hasText: 'Google' });
        await expect(linked.locator('.provider-icon img:not(.provider-icon-google)')).toHaveAttribute('src', iconUrl);
        await page.getByRole('button', { name: chinese ? '绑定 OIDC' : 'Link OIDC', exact: true }).click();
        const dialog = page.locator('md-dialog.form-dialog');
        const reauthenticate = dialog.getByRole('button', { name: chinese ? '使用 Google 继续' : 'Continue with Google', exact: true });
        await expect(dialog.locator('.provider-icon img:not(.provider-icon-google)')).toHaveAttribute('src', iconUrl);
        await expect(reauthenticate).toHaveAccessibleName(chinese ? '使用 Google 继续' : 'Continue with Google');
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        state.identities[0]!.iconUrl = null;
        await page.reload();
        await expect(linked.locator('.provider-icon-google')).toBeVisible();
        await expect(page.locator('.social-account').filter({ hasText: 'Disabled GitHub' }).locator('.provider-icon-github')).toBeVisible();
        await page.getByRole('button', { name: chinese ? '绑定 OIDC' : 'Link OIDC', exact: true }).click();
        await expect(dialog.locator('.provider-icon-google')).toBeVisible();
        await expect(dialog.locator('.provider-icon-github')).toHaveCount(0);
        await page.keyboard.press('Escape');
    });

    test(`follows provider presets while preserving custom icon overrides in ${locale}`, async ({ page, context }) => {
        const state = await icons(context);
        await page.setViewportSize({ width: chinese ? 375 : 1280, height: 812 });
        await page.goto(`/${locale}/admin/social-connections`);
        await page.getByRole('button', { name: chinese ? '新建连接器' : 'Create connection', exact: true }).click();
        const editor = page.locator('md-dialog.form-dialog');
        const select = async (name: string) => {
            const combobox = page.getByRole('combobox', { name: chinese ? '提供方类型' : 'Provider type', exact: true });
            await selectMaterialOption(editor.locator('md-outlined-select').filter({ has: combobox }),
                editor.getByRole('option', { name, exact: true }));
        };
        await expect(editor.locator('.provider-icon-google')).toBeVisible();
        await expect.poll(() => editor.locator('.provider-icon-google').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
        await select('GitHub');
        await expect(editor.locator('.provider-icon-github')).toBeVisible();
        await select('OpenID Connect');
        await expect(editor.locator('.provider-icon-preview svg')).toBeVisible();
        await expect(editor.locator('.provider-icon-google, .provider-icon-github')).toHaveCount(0);
        await select('OAuth 2.0');
        await expect(editor.locator('.provider-icon-preview svg')).toBeVisible();
        await select('Google');
        await expect(editor.locator('.provider-icon-google')).toBeVisible();
        const chooser = page.waitForEvent('filechooser');
        await editor.getByRole('button', { name: chinese ? '编辑连接器图标' : 'Edit connection icon', exact: true }).click();
        await (await chooser).setFiles({ name: 'connection.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
        await page.locator('md-dialog.image-crop-dialog').getByRole('button', { name: chinese ? '使用图标' : 'Use icon', exact: true }).click();
        await expect(editor.locator('.provider-icon-preview img:not(.provider-icon-google)')).toHaveAttribute('src', iconUrl);
        await select('GitHub');
        await expect(editor.locator('.provider-icon-preview img:not(.provider-icon-google)')).toHaveAttribute('src', iconUrl);
        await editor.getByRole('button', { name: chinese ? '移除图标' : 'Remove icon', exact: true }).click();
        await expect(editor.locator('.provider-icon-github')).toBeVisible();
        expect(state.writes).toHaveLength(0);
        await editor.getByRole('button', { name: chinese ? '取消' : 'Cancel', exact: true }).click();
        await expect(editor).toHaveCount(0);
    });
}
