import type { BrowserContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { testOrigin } from './runtime';
import { connectionTypes, defaultConnectionConfig, type SocialConnection } from '../../src/shared/social';
import type { Identity } from '../../src/client/api';

async function administrator(context: BrowserContext) {
    const now = new Date().toISOString();
    const identity: Identity = {
        user: { id: 'connector-admin', name: 'Connector Administrator', email: 'connector-admin@loginflare.test', emailVerified: true, role: 'admin', createdAt: now },
        session: { id: 'connector-session', token: 'test-only-session', userId: 'connector-admin', createdAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    };
    const state = {
        connections: connectionTypes.map((type, position): SocialConnection => ({
            id: `connection-${type}`, name: `${type} preview`, type, position, revision: 1,
            config: { ...defaultConnectionConfig(type), clientId: `${type}-client` },
            hasSecret: true, enabled: true, archived: false, identityLocked: true, linkedAccounts: 1,
            callbackURL: `${testOrigin}/api/auth/callback/connection-${type}`,
        })),
        fail: false, writes: [] as Record<string, unknown>[],
    };
    await context.route(`${testOrigin}/api/auth/get-session`, (route) => route.fulfill({ json: identity }));
    await context.route(`${testOrigin}/api/admin/social-connections**`, async (route) => {
        const request = route.request();
        if (request.method() === 'GET') { await route.fulfill({ json: { connections: state.connections } }); return; }
        const body = request.postDataJSON(); state.writes.push(body);
        if (state.fail) { await route.fulfill({ status: 409, json: { code: 'SOCIAL_CONNECTION_CONFLICT' } }); return; }
        const id = new URL(request.url()).pathname.split('/')[4];
        const existing = state.connections.find((connection) => connection.id === id);
        const saved: SocialConnection = {
            ...body, id: id ?? 'new-connection', revision: (existing?.revision ?? 0) + 1,
            position: existing?.position ?? state.connections.length,
            hasSecret: true, identityLocked: existing?.identityLocked ?? false, linkedAccounts: existing?.linkedAccounts ?? 0,
            callbackURL: existing?.callbackURL ?? `${testOrigin}/api/auth/callback/new-connection`,
        };
        state.connections = existing ? state.connections.map((connection) => connection.id === id ? saved : connection) : [...state.connections, saved];
        await route.fulfill({ status: existing ? 200 : 201, json: saved });
    });
    return state;
}

for (const [locale, width] of [['en-us', 1280], ['zh-cn', 375]] as const) {
    test(`opens each connector in a visible modal and restores focus on cancellation in ${locale}`, async ({ page, context }) => {
        const state = await administrator(context);
        const chinese = locale === 'zh-cn';
        await page.setViewportSize({ width, height: 812 });
        await page.goto(`/${locale}/admin/social-connections`);
        for (const [index, connection] of state.connections.entries()) {
            const trigger = page.getByRole('button', { name: chinese ? '编辑连接器' : 'Edit connection', exact: true }).nth(index);
            await trigger.click();
            const dialog = page.locator('md-dialog.form-dialog');
            await expect(dialog).toBeVisible();
            await expect(dialog.getByLabel(chinese ? '显示名称' : 'Display name', { exact: true })).toHaveValue(connection.name);
            await expect(dialog.getByLabel(chinese ? '客户端 ID' : 'Client ID', { exact: true })).toBeDisabled();
            await expect(dialog.getByLabel(chinese ? '回调地址' : 'Callback URL', { exact: true })).toHaveValue(connection.callbackURL);
            await expect(page.locator('.social-connection-list form')).toHaveCount(0);
            await expect.poll(async () => {
                const bounds = await page.getByRole('dialog').boundingBox();
                return !!bounds && bounds.y >= 0 && bounds.y + bounds.height <= 813;
            }).toBe(true);
            expect(await dialog.locator('form').evaluate((form) => form.scrollWidth <= form.clientWidth)).toBe(true);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
            const display = await dialog.locator('.social-connection-display').evaluate((row) => {
                const icon = row.querySelector('.image-picker')!.getBoundingClientRect();
                const input = row.querySelector('md-outlined-text-field')!.shadowRoot!.querySelector('md-outlined-field')!.shadowRoot!.querySelector('.container')!.getBoundingClientRect();
                return { icon: { left: icon.left, top: icon.top, width: icon.width, height: icon.height }, input: { left: input.left, top: input.top, height: input.height } };
            });
            expect(display.icon.width).toBeCloseTo(80, 1);
            expect(display.icon.height).toBeCloseTo(80, 1);
            if (width === 1280) expect(Math.abs(display.icon.top + display.icon.height / 2 - display.input.top - display.input.height / 2)).toBeLessThanOrEqual(1);
            else {
                expect(display.input.left).toBeCloseTo(display.icon.left, 1);
                expect(display.input.top).toBeGreaterThan(display.icon.top + display.icon.height);
            }
            await page.screenshot({ path: test.info().outputPath(`connection-layout-${connection.type}-${locale}.png`) });
            await page.keyboard.press('Escape');
            await expect(dialog).toHaveCount(0);
            await expect(trigger).toBeFocused();
        }
        expect(state.writes).toHaveLength(0);
    });
}

test('keeps connector errors in the editor and supports creation, saving and archive confirmation', async ({ page, context }) => {
    const state = await administrator(context);
    await page.goto('/en-us/admin/social-connections');
    await page.getByRole('button', { name: 'Create connection', exact: true }).click();
    const editor = page.locator('md-dialog.form-dialog').filter({ has: page.locator('[slot="headline"]').filter({ hasText: /^(Create|Edit) connection$/ }) });
    await expect(editor).toBeVisible();
    await editor.getByLabel('Display name', { exact: true }).fill('Created preview');
    await editor.getByLabel('Client ID', { exact: true }).fill('preview-client');
    await editor.getByLabel('Client secret', { exact: true }).fill('test-only-secret');
    state.fail = true;
    await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(editor.getByRole('alert')).toBeVisible();
    await expect(editor.getByRole('alert')).toBeFocused();
    await expect(editor.getByRole('alert')).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('alert')).toHaveCount(1);
    state.fail = false;
    await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(editor.locator(':scope > [slot="headline"]')).toHaveText('Edit connection');
    await expect(editor.getByLabel('Callback URL', { exact: true })).toHaveValue(`${testOrigin}/api/auth/callback/new-connection`);
    await expect(editor.getByRole('checkbox', { name: 'Enabled', exact: true })).not.toBeChecked();
    await expect(editor.getByLabel('Client secret', { exact: true })).toHaveValue('');
    await expect(editor.getByRole('alert')).toHaveCount(0);
    await editor.getByLabel('Display name', { exact: true }).fill('Renamed preview');
    await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.social-connection-list').getByText('Renamed preview', { exact: true })).toBeAttached();
    await editor.getByRole('button', { name: 'Archive', exact: true }).click();
    const confirmation = page.locator('md-dialog.form-dialog').filter({ has: page.locator('[slot="headline"]').filter({ hasText: /^Archive$/ }) });
    await expect(confirmation).toBeVisible();
    await expect(editor).toHaveCount(0);
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: 'Archive', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => state.connections.find((connection) => connection.id === 'new-connection')?.archived).toBe(true);
});
