import type { BrowserContext, Locator, Page } from '@playwright/test';
import { expect, test, selectMaterialOption } from './fixtures';
import { testOrigin } from './runtime';
import type { Identity } from '../../src/client/api';
import { defaultConnectionConfig, type ConnectionType, type SocialConnection } from '../../src/shared/social';

type Reorder = { order: string[]; previousOrder: string[] };

async function connections(context: BrowserContext) {
    const now = new Date().toISOString();
    const actor: Identity = {
        user: { id: 'sorting-admin', name: 'Sorting Administrator', email: 'sorting@loginflare.test', emailVerified: true, role: 'admin', createdAt: now },
        session: { id: 'sorting-session', token: 'test-only-sorting-session', userId: 'sorting-admin', createdAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    };
    const types: ConnectionType[] = ['google', 'github', 'oidc'];
    const state = {
        connections: types.map((type, position): SocialConnection => ({
            id: `sorting-${type}`, name: `${type} preview`, type, position, revision: position + 1,
            config: { ...defaultConnectionConfig(type), clientId: `${type}-sorting-client` },
            hasSecret: true, enabled: position === 0, archived: position === 2, identityLocked: false, linkedAccounts: 0,
            callbackURL: `${testOrigin}/api/auth/callback/sorting-${type}`, iconId: null, iconUrl: null,
        })),
        fail: false, writes: [] as Reorder[], otherWrites: [] as string[],
    };
    await context.route(`${testOrigin}/api/auth/get-session`, (route) => route.fulfill({ json: actor }));
    await context.route(`${testOrigin}/api/admin/social-connections**`, async (route) => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (request.method() === 'GET') { await route.fulfill({ json: { connections: state.connections } }); return; }
        if (path !== '/api/admin/social-connections/reorder') {
            state.otherWrites.push(path);
            await route.fulfill({ status: 400, json: { code: 'INVALID_INPUT' } }); return;
        }
        const body = request.postDataJSON() as Reorder;
        state.writes.push(body);
        if (state.fail || JSON.stringify(body.previousOrder) !== JSON.stringify(state.connections.map(({ id }) => id))) {
            await route.fulfill({ status: 409, json: { code: 'SOCIAL_CONNECTION_CONFLICT' } }); return;
        }
        state.connections = body.order.map((id, position) => ({ ...state.connections.find((item) => item.id === id)!, position }));
        await route.fulfill({ json: { connections: state.connections } });
    });
    return state;
}

function cards(page: Page) { return page.locator('.social-connection-list > .social-sortable-connection'); }
async function visibleOrder(page: Page) {
    return cards(page).evaluateAll((elements) => elements.map((element) => element.getAttribute('data-connection-id')));
}
function handle(page: Page, name: string, chinese = false) {
    return page.getByRole('button', { name: chinese ? `调整 ${name} 的顺序` : `Reorder ${name}`, exact: true });
}
async function drag(page: Page, source: Locator, target: Locator) {
    await source.scrollIntoViewIfNeeded();
    const start = (await source.boundingBox())!, end = (await target.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 + 12, { steps: 3 });
    await expect(source).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.move(start.x + start.width / 2, end.y + end.height / 2, { steps: 15 });
}

test('saves a mouse drag once, keeps configuration revisions and synchronizes the new order across tabs', async ({ page, context }) => {
    const state = await connections(context);
    const original = state.connections.map(({ id }) => id);
    const revisions = state.connections.map(({ id, revision }) => ({ id, revision }));
    await page.goto('/en-us/admin/social-connections');
    await expect(cards(page)).toHaveCount(3);
    const peer = await context.newPage(); await peer.goto('/en-us/admin/social-connections');
    await expect(cards(peer)).toHaveCount(3); await page.bringToFront();
    await drag(page, handle(page, 'google preview'), cards(page).nth(1));
    expect(state.writes).toHaveLength(0);
    await page.mouse.up();
    const expected = [original[1]!, original[0]!, original[2]!];
    await expect.poll(() => visibleOrder(page)).toEqual(expected);
    await expect.poll(() => state.writes.length).toBe(1);
    expect(state.writes[0]).toEqual({ order: expected, previousOrder: original });
    expect(state.connections.map(({ id, revision }) => ({ id, revision })).sort((a, b) => a.id.localeCompare(b.id)))
        .toEqual(revisions.sort((a, b) => a.id.localeCompare(b.id)));
    await peer.bringToFront();
    await expect.poll(() => visibleOrder(peer)).toEqual(expected);
    await page.reload(); await expect.poll(() => visibleOrder(page)).toEqual(expected);
    expect(state.otherWrites).toHaveLength(0);
    await peer.close();
});

test('supports keyboard sorting for disabled and archived connections without an order field in their details', async ({ page, context }) => {
    const state = await connections(context);
    const original = state.connections.map(({ id }) => id);
    await page.goto('/en-us/admin/social-connections');
    const disabled = handle(page, 'github preview');
    await disabled.focus(); await disabled.press('Space');
    await expect(disabled).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
    const expected = [original[0]!, original[2]!, original[1]!];
    await expect.poll(() => visibleOrder(page)).toEqual(expected);
    await expect.poll(() => state.writes.length).toBe(1);
    await expect(handle(page, 'oidc preview')).toBeEnabled();
    const archived = cards(page).filter({ hasText: 'oidc preview' });
    await archived.getByRole('button', { name: 'Edit connection', exact: true }).click();
    const dialog = page.locator('md-dialog.form-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Display order', { exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(state.otherWrites).toHaveLength(0);
});

test('cancels a keyboard drag without saving and rolls back a failed reorder before allowing a retry', async ({ page, context }) => {
    const state = await connections(context);
    const original = state.connections.map(({ id }) => id);
    await page.goto('/en-us/admin/social-connections');
    const first = handle(page, 'google preview');
    await first.focus(); await first.press('Space');
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => visibleOrder(page)).toEqual(original);
    expect(state.writes).toHaveLength(0);
    state.fail = true;
    await drag(page, first, cards(page).nth(1)); await page.mouse.up();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect.poll(() => state.writes.length).toBe(1);
    await expect.poll(() => visibleOrder(page)).toEqual(original);
    state.fail = false;
    await drag(page, first, cards(page).nth(1)); await page.mouse.up();
    await expect.poll(() => state.writes.length).toBe(2);
    await expect.poll(() => visibleOrder(page)).toEqual([original[1]!, original[0]!, original[2]!]);
    expect(state.otherWrites).toHaveLength(0);
});

test.describe('touch sorting', () => {
    test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
    test('reorders through a touch handle on a narrow Chinese screen without horizontal overflow', async ({ page, context }) => {
        const state = await connections(context);
        const original = state.connections.map(({ id }) => id);
        await page.goto('/zh-cn/admin/social-connections');
        const source = handle(page, 'google preview', true);
        await expect(source).toBeVisible();
        const start = (await source.boundingBox())!, target = (await cards(page).nth(1).boundingBox())!;
        const session = await context.newCDPSession(page);
        const point = { x: start.x + start.width / 2, y: start.y + start.height / 2, id: 1 };
        try {
            await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
            await expect(source).toHaveAttribute('aria-pressed', 'true');
            for (let index = 1; index <= 15; index++) {
                await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y + (target.y + target.height / 2 - point.y) * index / 15 }] });
            }
            await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await expect.poll(() => visibleOrder(page)).toEqual([original[1]!, original[0]!, original[2]!]);
            await expect.poll(() => state.writes.length).toBe(1);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
            await page.screenshot({ path: test.info().outputPath('touch-connection-order-zh-cn.png') });
        } finally { await session.detach(); }
    });
});

test('offers branded presets while keeping sorting out of the connection editor', async ({ page, context }) => {
    const state = await connections(context);
    await page.goto('/en-us/admin/social-connections');
    await page.getByRole('button', { name: 'Create connection', exact: true }).click();
    const editor = page.locator('md-dialog.form-dialog');
    await expect(editor.getByLabel('Display order', { exact: true })).toHaveCount(0);
    for (const [name, css, scopes] of [
        ['Microsoft', '.provider-icon-microsoft', 'openid profile email'],
        ['Discord', '.provider-icon-discord', 'identify email'],
        ['X', '.provider-icon-x', 'users.read tweet.read'],
        ['Telegram', '.provider-icon-telegram', 'openid profile'],
    ] as const) {
        const combobox = page.getByRole('combobox', { name: 'Provider type', exact: true });
        await selectMaterialOption(editor.locator('md-outlined-select').filter({ has: combobox }),
            editor.getByRole('option', { name, exact: true }));
        await expect(editor.locator(css)).toBeVisible();
        await expect(editor.getByLabel('Scopes (space separated)', { exact: true })).toHaveValue(scopes);
        await expect(editor.getByLabel('Client ID', { exact: true })).toBeVisible();
        await expect(editor.getByLabel('Authorization endpoint', { exact: true })).toHaveCount(0);
        await expect(editor.getByLabel('Token endpoint', { exact: true })).toHaveCount(0);
        await expect(editor.getByLabel('Discovery URL', { exact: true })).toHaveCount(0);
        await expect(editor.getByLabel('Issuer', { exact: true })).toHaveCount(0);
    }
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(state.writes).toHaveLength(0); expect(state.otherWrites).toHaveLength(0);
});
