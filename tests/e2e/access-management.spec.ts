import { randomUUID } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { expect, test, openNavigation } from './fixtures';
import { testOrigin } from './runtime';
import { defaultBranding } from '../../src/shared/branding';
import type { Identity } from '../../src/client/api';

async function accessFixture(context: BrowserContext, administrator = true) {
    const now = new Date().toISOString();
    const identity: Identity = { browserAccountId: randomUUID(), user: { id: randomUUID(), name: 'Administrator', email: 'admin@loginflare.test', emailVerified: true, role: administrator ? 'admin' : 'user', createdAt: now }, session: { id: randomUUID(), token: 'test-only-private-token', userId: '', createdAt: now, expiresAt: new Date(Date.now() + 86400000).toISOString() } };
    identity.session.userId = identity.user.id;
    type Permission = { id: string; resourceId: string; name: string; scope: string; description: string; createdAt: string };
    type Resource = { id: string; name: string; identifier: string; description: string; disabled: boolean; accessTokenTtl: number; createdAt: string; permissions: Permission[] };
    type Role = { id: string; name: string; description: string; createdAt: string; permissionIds: string[]; permissions: Permission[] };
    const resources: Resource[] = [], roles: Role[] = [], linked: { clientId: string; name: string; createdAt: string }[] = [], assigned: string[] = [];
    const writes: { path: string; method: string; body: Record<string, unknown> | undefined }[] = [];
    const event = { id: randomUUID(), event: 'access.role.created', outcome: 'success', actorUserId: identity.user.id, targetUserId: null, clientId: 'example-client', targetType: 'role', targetId: 'reader', reason: null, requestId: 'test-request-id', ipAddress: '192.0.2.1', userAgent: 'Local browser test', createdAt: now };
    const user = { ...identity.user, id: 'member-user', email: 'member@loginflare.test', name: 'Member', role: 'user' };
    const page = (items: unknown[]) => ({ items, pageInfo: { nextCursor: null, previousCursor: null } });
    await context.route(`${testOrigin}/api/**`, async (route) => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
        const body = request.postData() && request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : undefined;
        let json: unknown = {}, status = 200;
        const choices = (items: unknown[]) => {
            const offset = url.searchParams.get('cursor') === 'second-page' ? 20 : 0;
            return { items: items.slice(offset, offset + 20), pageInfo: { nextCursor: items.length > offset + 20 ? 'second-page' : null, previousCursor: offset ? 'first-page' : null } };
        };
        if (path === '/api/auth/get-session') json = identity;
        else if (path === '/api/browser/accounts') json = { accounts: [{ id: identity.browserAccountId, user: identity.user, status: 'active', lastUsedAt: now }], maximumAccounts: 5 };
        else if (path === '/api/branding') json = { ...defaultBranding, logoUrl: '/assets/logo.svg', revision: 0 };
        else if (path === '/api/config') json = { turnstileSiteKey: '1x00000000000000000000AA' };
        else if (path === '/api/auth/admin/get-user') json = user;
        else if (path === '/api/oauth/consent') json = { client: { clientId: 'example-client', name: 'Example application' }, scopes: ['openid', ...resources.flatMap((item) => item.permissions.map((permission) => permission.scope))], resource: resources[0], permissions: resources.flatMap((item) => item.permissions) };
        else if (path === '/api/admin/audit-logs') json = page([event]);
        else if (path.startsWith('/api/admin/audit-logs/')) json = event;
        else if (path === '/api/admin/machines/roles') json = page([]);
        else if (path === '/api/admin/users') json = page([identity.user, user]);
        else if (['/api/admin/applications', '/api/admin/machines/applications', '/api/admin/webhooks/deliveries'].includes(path)) json = page([]);
        else if (path.startsWith('/api/admin/access/')) {
            const subpath = path.slice('/api/admin/access'.length), parts = subpath.split('/').filter(Boolean);
            if (method !== 'GET') writes.push({ path, method, body });
            if (subpath === '/resources' && method === 'GET') json = page(resources);
            else if (subpath === '/resources' && method === 'POST') {
                const resource = { id: randomUUID(), ...body, disabled: false, createdAt: now, permissions: [] } as Resource; resources.push(resource); json = resource;
            } else if (parts[0] === 'resources' && parts.length === 2) {
                const resource = resources.find((item) => item.id === parts[1])!;
                if (method === 'PATCH') Object.assign(resource, body);
                if (method === 'DELETE') resources.splice(resources.indexOf(resource), 1);
                json = resource;
            } else if (parts[0] === 'resources' && parts[2] === 'permissions' && method === 'POST') {
                const resource = resources.find((item) => item.id === parts[1])!;
                const permission = { id: randomUUID(), resourceId: resource.id, ...body, createdAt: now } as Permission; resource.permissions.push(permission); json = permission;
            } else if (parts[0] === 'resources' && parts[2] === 'applications') {
                if (method === 'GET') json = page(linked);
                else if (method === 'POST') {
                    if (body.clientId === 'unavailable') { status = 404; json = { code: 'APPLICATION_NOT_FOUND' }; }
                    else linked.push({ clientId: body.clientId, name: 'Example application', createdAt: now });
                } else if (method === 'DELETE') linked.splice(linked.findIndex((item) => item.clientId === parts[3]), 1);
            } else if (subpath === '/permissions') json = choices(resources.flatMap((item) => item.permissions));
            else if (parts[0] === 'permissions') {
                for (const resource of resources) {
                    const permission = resource.permissions.find((item) => item.id === parts[1]);
                    if (permission && method === 'PATCH') Object.assign(permission, body);
                    if (permission && method === 'DELETE') resource.permissions.splice(resource.permissions.indexOf(permission), 1);
                }
            } else if (subpath === '/roles' && method === 'GET') json = choices(roles);
            else if (subpath === '/roles' && method === 'POST') {
                const role = { id: randomUUID(), ...body, createdAt: now, permissions: [] } as Role; roles.push(role); json = role;
            } else if (parts[0] === 'roles' && parts.length === 2) {
                const role = roles.find((item) => item.id === parts[1])!;
                if (method === 'PATCH') Object.assign(role, body);
                if (method === 'DELETE') roles.splice(roles.indexOf(role), 1);
                json = role;
            } else if (parts[0] === 'users' && parts[2] === 'roles') {
                if (method === 'PUT') assigned.splice(0, assigned.length, ...body.roleIds);
                json = { roles: roles.filter((item) => assigned.includes(item.id)) };
            }
        }
        await route.fulfill({ status, json });
    });
    return { resources, roles, linked, assigned, writes, event, user };
}

for (const language of ['en-us', 'zh-cn'] as const) for (const width of [1280, 375]) {
    test(`aligns administration search controls in ${language} at ${width}px`, async ({ page, context }) => {
        await accessFixture(context);
        await page.setViewportSize({ width, height: 900 });
        if (language === 'zh-cn') await page.addInitScript(() => localStorage.setItem('loginflare.theme', 'dark'));
        for (const path of ['audit-logs', 'users', 'applications', 'access/resources', 'access/roles', 'machines/roles', 'machines/applications', 'webhooks/deliveries']) {
            await page.goto(`/${language}/admin/${path}`);
            const bar = page.locator('.search-bar'), select = bar.locator('md-outlined-select'), input = bar.locator('md-outlined-text-field');
            const button = bar.getByRole('button', { name: language === 'zh-cn' ? '搜索' : 'Search', exact: true });
            await expect(select.getByRole('combobox')).toBeVisible();
            await expect(input.getByRole('textbox')).toBeVisible();
            await page.evaluate(() => document.fonts.ready);
            if (path === 'users') {
                await expect(page.getByRole('columnheader', { name: language === 'zh-cn' ? '用户' : 'User', exact: true })).toBeVisible();
                await expect(page.getByRole('cell', { name: language === 'zh-cn' ? '管理员' : 'Administrator', exact: true })).toBeVisible();
                await expect(page.getByRole('cell', { name: language === 'zh-cn' ? '普通用户' : 'User', exact: true })).toBeVisible();
            }
            if (path === 'audit-logs') await bar.screenshot({ path: test.info().outputPath(`search-audit-${language}-${width}.png`) });
            const [fieldBox, inputBox, buttonBox] = await Promise.all([select.boundingBox(), input.boundingBox(), button.boundingBox()]);
            expect(fieldBox).not.toBeNull(); expect(inputBox).not.toBeNull(); expect(buttonBox).not.toBeNull();
            if (width === 1280) {
                expect(Math.abs(fieldBox!.y - inputBox!.y), `${path}: align the field outlines above supporting text`).toBeLessThanOrEqual(1);
                expect(Math.abs(fieldBox!.y + fieldBox!.height / 2 - buttonBox!.y - buttonBox!.height / 2), `${path}: center the action against the field`).toBeLessThanOrEqual(1);
            } else {
                expect(fieldBox!.y + fieldBox!.height, `${path}: keep stacked fields separate`).toBeLessThanOrEqual(inputBox!.y);
                expect(inputBox!.y + inputBox!.height, `${path}: keep supporting text above the action`).toBeLessThanOrEqual(buttonBox!.y);
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path}: no page overflow`).toBe(true);
        }
    });
}

test('updates the selected text when a native Material Web option headline is translated', async ({ page }) => {
    await page.goto('/zh-cn/login');
    await page.evaluate(async () => {
        await customElements.whenDefined('md-outlined-select');
        const select = document.createElement('md-outlined-select');
        select.id = 'native-select'; select.label = 'Native select';
        const option = document.createElement('md-select-option');
        option.value = 'name'; option.selected = true;
        const headline = document.createElement('div');
        headline.slot = 'headline'; headline.textContent = '角色名称';
        option.appendChild(headline); select.appendChild(option); document.body.appendChild(select);
    });
    const select = page.locator('#native-select');
    const field = page.getByRole('combobox', { name: 'Native select', exact: true });
    await expect(field).toContainText('角色名称');
    await select.locator('div[slot="headline"]').evaluate((element) => { element.textContent = 'Role name'; });
    await expect(select.locator('div[slot="headline"]')).toHaveText('Role name');
    await expect(select).toHaveJSProperty('value', 'name');
    // Material Web 2.5.0 caches the selected headline. Keep its documented usage;
    // an upstream fix should make this an unexpected pass so we remove the marker.
    // https://material-web.dev/components/select/
    test.fail(true, 'Upstream Material Web does not refresh selected text after a headline translation.');
    await expect(field).toContainText('Role name');
});

test('updates the selected search field text when the administration language is translated', async ({ page, context }) => {
    await accessFixture(context);
    const query = '?lookupField=name&lookupValue=Support';
    await page.goto(`/zh-cn/admin/access/roles${query}`);
    const select = page.locator('.search-field md-outlined-select');
    await expect(select.getByRole('combobox', { name: '检索字段', exact: true })).toContainText('角色名称');
    await page.getByRole('button', { name: '语言', exact: true }).click();
    await page.getByRole('menuitem', { name: 'English', exact: true }).click();
    await expect(page).toHaveURL(`/en-us/admin/access/roles${query}`);
    await expect(page.getByRole('heading', { name: 'User roles', exact: true })).toBeVisible();
    await expect(select.locator('div[slot="headline"]')).toHaveText('Role name');
    await expect(select).toHaveJSProperty('value', 'name');
    await expect(page.getByLabel('Find a role', { exact: true })).toHaveValue('Support');
    // Mark only the display assertion; locale, option text and search state must pass.
    test.fail(true, 'Same Material Web selected-headline limitation as the native reproduction above.');
    await expect(select.getByRole('combobox', { name: 'Search by', exact: true })).toContainText('Role name');
});

for (const [language, width] of [['en-us', 1280], ['zh-cn', 375]] as const) {
    test(`explains access control and switches role types using grouped navigation in ${language}`, async ({ page, context }) => {
        const state = await accessFixture(context), zh = language === 'zh-cn';
        const labels = zh ? {
            navigation: '管理导航', groups: ['账号与登录', '应用接入', '访问控制', '运维与集成'], roles: '角色', types: '角色类型',
            user: '用户角色', service: '服务角色', guide: '什么时候需要 API 访问控制？',
            signIn: '如果只需要统一登录，在“开发者中心”接入应用即可，无需配置 API 资源或角色。', developer: '前往开发者中心', notFound: '找不到此页面',
        } : {
            navigation: 'Administration navigation', groups: ['Accounts & sign-in', 'Application integration', 'Access control', 'Operations & integrations'], roles: 'Roles', types: 'Role types',
            user: 'User roles', service: 'Service roles', guide: 'When do you need API access control?',
            signIn: 'For sign-in only, connect your app in the Developer center. API resources and roles are optional.', developer: 'Open Developer center', notFound: 'This page isn’t here',
        };
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/${language}/admin/access/resources`);
        await openNavigation(page);
        const navigation = page.getByRole('navigation', { name: labels.navigation, exact: true, includeHidden: true });
        await expect(navigation.getByRole('group')).toHaveCount(4);
        for (const name of labels.groups) await expect(navigation.getByRole('group', { name, exact: true })).toBeVisible();
        await expect(navigation.getByRole('link')).toHaveCount(9);
        const guide = page.getByRole('region', { name: labels.guide, exact: true });
        await expect(guide).toContainText(labels.signIn);
        await expect(guide.getByRole('link', { name: labels.developer, exact: true })).toHaveAttribute('href', `/${language}/developer/applications`);
        await expect(guide.getByRole('listitem')).toHaveCount(3);
        await page.screenshot({ path: test.info().outputPath(`access-guide-${language}.png`), fullPage: true });
        const roles = navigation.getByRole('link', { name: labels.roles, exact: true, includeHidden: true });
        await openNavigation(page); await roles.click();
        await expect(page).toHaveURL(`/${language}/admin/access/roles`);
        await expect(roles).toHaveAttribute('aria-current', 'page');
        const types = page.getByRole('navigation', { name: labels.types, exact: true });
        await expect(types.getByRole('link')).toHaveCount(2);
        const user = types.getByRole('link', { name: labels.user, exact: true }), service = types.getByRole('link', { name: labels.service, exact: true });
        await expect(user).toHaveAttribute('aria-current', 'page');
        await user.focus();
        await page.keyboard.press('Tab');
        await expect(service).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(`/${language}/admin/machines/roles`);
        await expect(page.getByRole('heading', { name: labels.service, exact: true })).toBeVisible();
        await expect(service).toHaveAttribute('aria-current', 'page');
        await expect(user).not.toHaveAttribute('aria-current');
        await expect(roles).toHaveAttribute('aria-current', 'page');
        await expect(navigation.getByRole('link', { name: labels.service, exact: true })).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath(`service-roles-${language}.png`), fullPage: true });
        await user.click();
        await expect(page).toHaveURL(`/${language}/admin/access/roles`);
        await expect(page.getByRole('heading', { name: labels.user, exact: true })).toBeVisible();
        await expect(user).toHaveAttribute('aria-current', 'page');
        await page.screenshot({ path: test.info().outputPath(`user-roles-${language}.png`), fullPage: true });
        for (const path of ['admin/machines/roles/', 'admin/Machines/Roles', 'admin/machines/roles//']) {
            await page.goto(`/${language}/admin/machines/roles`);
            // Exercise client routing; the server only serves canonical page paths.
            await page.evaluate((pathname) => {
                window.history.pushState(window.history.state, '', pathname);
                window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
            }, `/${language}/${path}`);
            await expect(page).toHaveURL(`/${language}/${path}`);
            if (path === 'admin/Machines/Roles') {
                await expect(page.getByRole('heading', { name: labels.notFound, exact: true })).toBeVisible();
                await expect(navigation).toHaveCount(0);
                continue;
            }
            await expect(page.getByRole('heading', { name: labels.service, exact: true })).toBeVisible();
            await expect(roles).toHaveAttribute('aria-current', 'page');
            await expect(roles).toHaveAttribute('href', `/${language}/admin/machines/roles`);
            await expect(service).toHaveAttribute('aria-current', 'page');
            await openNavigation(page); await roles.click();
            await expect(page).toHaveURL(`/${language}/admin/machines/roles`);
            await expect(page.getByRole('heading', { name: labels.service, exact: true })).toBeVisible();
        }
        await user.click();
        await expect(page).toHaveURL(`/${language}/admin/access/roles`);
        await expect(roles).toHaveAttribute('aria-current', 'page');
        await expect(roles).toHaveAttribute('href', `/${language}/admin/access/roles`);
        for (const path of ['admin/Machines/Roles', 'admin/machines/roles//']) {
            expect((await context.request.get(`/${language}/${path}`)).status()).toBe(404);
        }
        expect(state.writes).toEqual([]);
    });

    test(`manages API resources, permissions, user roles and audit details in ${language}`, async ({ page, context }) => {
        const state = await accessFixture(context), zh = language === 'zh-cn';
        await page.setViewportSize({ width, height: 900 });
        const labels = zh ? {
            createResource: '创建 API 资源', resourceName: '资源名称', identifier: 'API 标识', ttl: '访问令牌有效期（秒）', save: '保存修改', details: '详情',
            createPermission: '创建权限', permissionName: '权限名称', scope: '权限范围', createRole: '创建角色', roleName: '角色名称', roleNav: '用户角色',
            link: '允许应用访问', clientId: '客户端 ID', confirm: '确认', cancel: '取消', manageRoles: '管理用户角色', auditNav: '审计日志', eventDetail: '事件详情', close: '关闭',
        } : {
            createResource: 'Create API resource', resourceName: 'Resource name', identifier: 'API identifier', ttl: 'Access token lifetime (seconds)', save: 'Save changes', details: 'Details',
            createPermission: 'Create permission', permissionName: 'Permission name', scope: 'Permission scope', createRole: 'Create role', roleName: 'Role name', roleNav: 'User roles',
            link: 'Allow application', clientId: 'Client ID', confirm: 'Confirm', cancel: 'Cancel', manageRoles: 'Manage user roles', auditNav: 'Audit logs', eventDetail: 'Event details', close: 'Close',
        };
        await page.goto(`/${language}/admin/access/resources`);
        await page.getByRole('button', { name: labels.createResource, exact: true }).click();
        let dialog = page.locator('md-dialog.form-dialog');
        await dialog.getByLabel(labels.resourceName, { exact: true }).fill('Orders');
        await dialog.getByLabel(labels.identifier, { exact: true }).fill('http://api.example.test');
        await dialog.getByRole('button', { name: labels.createResource, exact: true }).click();
        await expect(dialog.getByText(zh ? '请输入不含查询参数、片段和用户凭据的完整 HTTPS 地址。' : 'Enter an absolute HTTPS URL without a query, fragment or user credentials.', { exact: true })).toBeVisible();
        expect(state.writes).toHaveLength(0);
        await dialog.getByLabel(labels.identifier, { exact: true }).fill('https://api.example.test/orders');
        await dialog.getByLabel(labels.ttl, { exact: true }).fill('300');
        await dialog.getByRole('button', { name: labels.createResource, exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await page.getByRole('link', { name: 'Orders', exact: true }).click();
        await page.getByRole('button', { name: labels.createPermission, exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
        await dialog.getByLabel(labels.permissionName, { exact: true }).fill('Read orders');
        await dialog.getByLabel(labels.scope, { exact: true }).fill('orders:read');
        await dialog.getByRole('button', { name: labels.createPermission, exact: true }).click();
        await expect(page.getByText('orders:read', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: labels.link, exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
        await expect(dialog.getByLabel(labels.clientId, { exact: true })).toHaveAccessibleDescription(language === 'zh-cn' ? /从“应用”中的登录应用详情复制客户端 ID/ : /Copy the client ID from the sign-in application/);
        await expect(dialog.getByRole('link', { name: language === 'zh-cn' ? '查看登录应用' : 'View sign-in applications', exact: true })).toHaveAttribute('href', `/${language}/admin/applications`);
        await dialog.getByLabel(labels.clientId, { exact: true }).fill('unavailable');
        await dialog.getByRole('button', { name: labels.confirm, exact: true }).click();
        await expect(dialog.getByRole('alert')).toBeVisible();
        await expect(page.locator('.access-item').getByRole('alert')).toHaveCount(0);
        await dialog.getByLabel(labels.clientId, { exact: true }).fill('example-client');
        await dialog.getByRole('button', { name: labels.confirm, exact: true }).click();
        await expect(page.getByText('Example application', { exact: true })).toBeVisible();
        await page.screenshot({ path: test.info().outputPath(`api-resource-${language}.png`), fullPage: true });
        await page.goto(`/${language}/admin/access/roles`);
        await page.getByRole('button', { name: labels.createRole, exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
        await dialog.getByLabel(labels.roleName, { exact: true }).fill('Order reader');
        await dialog.getByLabel('Read orders (orders:read)', { exact: true }).check();
        await dialog.getByRole('button', { name: labels.createRole, exact: true }).click();
        await expect(page.getByText('Order reader', { exact: true })).toBeVisible();
        expect(state.roles[0].permissionIds).toEqual([state.resources[0].permissions[0].id]);
        await page.goto(`/${language}/admin/users/detail?id=${state.user.id}`);
        await page.getByRole('button', { name: labels.manageRoles, exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
        await dialog.getByLabel('Order reader', { exact: true }).check();
        await dialog.getByRole('button', { name: labels.save, exact: true }).click();
        await expect(page.getByText('Order reader', { exact: true })).toBeVisible();
        expect(state.assigned).toEqual([state.roles[0].id]);
        expect(state.user.role).toBe('user');
        await page.goto(`/${language}/admin/audit-logs`);
        await page.getByRole('button', { name: `${labels.details}: ${state.event.event}`, exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
        await expect(page.getByRole('dialog', { name: labels.eventDetail, exact: true })).toBeVisible();
        await expect(dialog.getByText('test-request-id', { exact: true })).toBeVisible();
        await expect(dialog.getByText('test-only-private-token', { exact: true })).toHaveCount(0);
        await dialog.evaluate(async (element) => {
            const elements = [element, ...element.shadowRoot?.querySelectorAll('*') ?? []];
            await Promise.all(elements.flatMap((item) => item.getAnimations()).filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
        });
        await page.screenshot({ path: test.info().outputPath(`audit-event-${language}.png`), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await dialog.getByRole('button', { name: labels.close, exact: true }).click();
        await expect(dialog).toHaveCount(0);
    });
}

test('keeps business permission and role deletion behind confirmation dialogs', async ({ page, context }) => {
    const state = await accessFixture(context), now = new Date().toISOString();
    const resourceId = randomUUID(), permissionId = randomUUID(), roleId = randomUUID();
    state.resources.push({ id: resourceId, name: 'Orders', identifier: 'https://api.example.test/orders', description: '', accessTokenTtl: 300, disabled: false, createdAt: now, permissions: [{ id: permissionId, resourceId, name: 'Read orders', scope: 'orders:read', description: '', createdAt: now }] });
    state.roles.push({ id: roleId, name: 'Reader', description: '', permissionIds: [permissionId], permissions: [], createdAt: now });
    await page.goto(`/en-us/admin/access/resources/detail?id=${resourceId}`);
    await page.getByRole('button', { name: 'Delete permission: Read orders', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Delete permission', exact: true })).toBeVisible();
    expect(state.writes).toHaveLength(0);
    await page.locator('md-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(state.resources[0].permissions).toHaveLength(1);
    await page.goto('/en-us/admin/access/roles');
    await page.getByRole('button', { name: 'Delete role: Reader', exact: true }).click();
    expect(state.writes).toHaveLength(0);
    await page.locator('md-dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText('No user roles.', { exact: true })).toBeVisible();
    expect(state.roles).toHaveLength(0);
});

test('denies ordinary users access to API permission and audit management pages', async ({ page, context }) => {
    await accessFixture(context, false);
    for (const path of ['access/resources', 'access/roles', 'audit-logs']) {
        await page.goto(`/en-us/admin/${path}`);
        await expect(page.getByText('403', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Create API resource', exact: true })).toHaveCount(0);
    }
});

for (const language of ['en-us', 'zh-cn'] as const) {
    const chinese = language === 'zh-cn';
    test(`connects application and empty user role prerequisites in ${language}`, async ({ page, context }) => {
        const state = await accessFixture(context);
        await page.setViewportSize({ width: chinese ? 375 : 1280, height: 900 });
        await page.goto(`/${language}/admin/applications`);
        await expect(page.getByRole('link', { name: chinese ? '打开开发者中心' : 'Open Developer center', exact: true })).toHaveAttribute('href', `/${language}/developer/applications`);
        await page.goto(`/${language}/admin/users/detail?id=${state.user.id}`);
        await page.getByRole('button', { name: chinese ? '管理用户角色' : 'Manage user roles', exact: true }).click();
        let dialog = page.locator('md-dialog.form-dialog');
        await expect(dialog.getByText(chinese ? /尚未创建用户角色/ : /No user roles have been created/)).toBeVisible();
        const rolesLink = dialog.getByRole('link', { name: chinese ? '打开用户角色' : 'Open user roles', exact: true });
        await expect(rolesLink).toHaveAttribute('href', `/${language}/admin/access/roles`);
        await expect(rolesLink).toHaveAttribute('target', '_blank');
        await dialog.getByRole('button', { name: chinese ? '取消' : 'Cancel', exact: true }).click();
        await page.goto(`/${language}/admin/access/roles`);
        await page.getByRole('button', { name: chinese ? '创建角色' : 'Create role', exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
        await expect(dialog.getByText(chinese ? /也可以先保存空角色/ : /You can save an empty role/)).toBeVisible();
        const resourceLink = dialog.getByRole('link', { name: chinese ? '打开 API 资源' : 'Open API resources', exact: true });
        await expect(resourceLink).toHaveAttribute('href', `/${language}/admin/access/resources`);
        await expect(resourceLink).toHaveAttribute('target', '_blank');
        await dialog.getByLabel(chinese ? '角色名称' : 'Role name', { exact: true }).fill('Empty role for later');
        await page.screenshot({ path: test.info().outputPath(`role-prerequisites-${language}.png`), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await dialog.getByRole('button', { name: chinese ? '创建角色' : 'Create role', exact: true }).click();
        await expect(page.getByText('Empty role for later', { exact: true })).toBeVisible();
        expect(state.roles[0].permissionIds).toEqual([]);
        expect(state.user.role).toBe('user');
    });
    test(`does not describe an empty cursor page as missing permissions in ${language}`, async ({ page, context }) => {
        await accessFixture(context);
        await context.route('**/api/admin/access/permissions?**', async (route) => {
            const cursor = new URL(route.request().url()).searchParams.get('cursor');
            await route.fulfill({ json: { items: cursor ? [] : [{ id: 'permission-a', name: 'Read orders', scope: 'orders:read' }], pageInfo: { nextCursor: cursor ? null : 'second-page', previousCursor: cursor ? 'first-page' : null } } });
        });
        await page.goto(`/${language}/admin/access/roles`);
        await page.getByRole('button', { name: chinese ? '创建角色' : 'Create role', exact: true }).click();
        const dialog = page.locator('md-dialog.form-dialog');
        await dialog.getByRole('button', { name: chinese ? '下一页' : 'Next', exact: true }).click();
        await expect(dialog.getByText(chinese ? '本页暂无选项。' : 'No items on this page.', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('link', { name: chinese ? '打开 API 资源' : 'Open API resources', exact: true })).toHaveCount(0);
    });
}

for (const language of ['en-us', 'zh-cn'] as const) {
    const chinese = language === 'zh-cn';
    test(`explains exact searches and clears empty results across management pages in ${language}`, async ({ page, context }) => {
        const fixture = await accessFixture(context);
        await context.route('**/api/admin/**', async (route) => {
            if (new URL(route.request().url()).searchParams.get('lookupValue')) await route.fulfill({ json: { items: [], pageInfo: { nextCursor: null, previousCursor: null } } });
            else await route.fallback();
        });
        await page.setViewportSize({ width: chinese ? 375 : 1280, height: 812 });
        for (const [path, field, value, hint] of [
            ['users', 'email', 'nobody@example.test', chinese ? '不检索辅助邮箱' : 'alternate emails are not searched'],
            ['applications', 'name', 'Unknown app', chinese ? '完整名称' : 'complete name'],
            ['access/resources', 'identifier', 'https://unknown.example.test', chinese ? '精确的 API 标识' : 'exact API identifier'],
            ['access/roles', 'name', 'Unknown role', chinese ? '完整名称' : 'complete name'],
            ['machines/roles', 'name', 'Unknown service role', chinese ? '完整名称' : 'complete name'],
            ['machines/applications', 'clientId', 'unknown-client', chinese ? '完整客户端 ID' : 'complete client ID'],
            ['audit-logs', 'event', 'unknown.event', chinese ? '原始事件码' : 'event code'],
            ['webhooks/deliveries', 'status', 'failed', 'succeeded'],
        ]) {
            await page.goto(`/${language}/admin/${path}?${new URLSearchParams({ lookupField: field, lookupValue: value })}`);
            const bar = page.locator('.search-bar'), input = bar.getByRole('textbox');
            await expect(input).toHaveAccessibleDescription(new RegExp(hint));
            await expect(page.getByText(chinese ? '没有符合此检索条件的结果。' : 'No results match this search.', { exact: true })).toBeVisible();
            await expect(page.locator('.empty-state code')).toHaveText(value);
            const [searchBox, resetBox] = await Promise.all([
                bar.getByRole('button', { name: chinese ? '搜索' : 'Search', exact: true }).boundingBox(),
                bar.getByRole('button', { name: chinese ? '清除检索' : 'Clear search', exact: true }).boundingBox(),
            ]);
            expect(Math.abs(searchBox!.y + searchBox!.height / 2 - resetBox!.y - resetBox!.height / 2), path).toBeLessThanOrEqual(1);
            await expect(page.locator('.pagination').getByRole('button')).toHaveCount(0);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
            if (path === 'audit-logs') await page.screenshot({ path: test.info().outputPath(`empty-search-${language}.png`), fullPage: true });
            await bar.getByRole('button', { name: chinese ? '清除检索' : 'Clear search', exact: true }).click();
            await expect(page).toHaveURL(`/${language}/admin/${path}`);
            await expect(input).toHaveValue('');
            await expect(bar.getByRole('button', { name: chinese ? '清除检索' : 'Clear search', exact: true })).toHaveCount(0);
        }
        await page.goto(`/${language}/admin/audit-logs`);
        await expect(page.locator('tbody .audit-event-code')).toHaveText(fixture.event.event);
        await expect(page.locator('tbody').getByRole('link', { name: fixture.event.actorUserId, exact: true })).toHaveAttribute('href', `/${language}/admin/users/detail?id=${fixture.event.actorUserId}`);
        fixture.event.event = 'unknown.event';
        await page.reload();
        await expect(page.locator('tbody').getByText('unknown.event', { exact: true })).toHaveCount(1);
        await expect(page.locator('tbody .audit-event-code')).toHaveCount(0);
    });

    test(`distinguishes an empty filtered cursor page from no search matches in ${language}`, async ({ page, context }) => {
        const fixture = await accessFixture(context);
        fixture.resources.push({ id: randomUUID(), name: 'Orders', identifier: 'https://api.example.test', description: '', accessTokenTtl: 300, disabled: false, createdAt: new Date().toISOString(), permissions: [] });
        await context.route('**/api/admin/access/resources?**', async (route) => {
            if (new URL(route.request().url()).searchParams.has('cursor')) await route.fulfill({ json: { items: [], pageInfo: { nextCursor: null, previousCursor: 'previous-page' } } });
            else await route.fallback();
        });
        await page.setViewportSize({ width: chinese ? 375 : 1280, height: 812 });
        const filter = new URLSearchParams({ lookupField: 'name', lookupValue: 'Orders' });
        await page.goto(`/${language}/admin/access/resources?${filter}&cursor=after-deletion`);
        await expect(page.getByText(chinese ? '本页暂无记录，请返回最新一页继续查看。' : 'No items on this page. Return to the latest page to continue.', { exact: true })).toBeVisible();
        await expect(page.getByText(chinese ? '没有符合此检索条件的结果。' : 'No results match this search.', { exact: true })).toHaveCount(0);
        await expect(page.locator('.empty-state code')).toHaveText('Orders');
        await expect(page.locator('.search-bar').getByRole('textbox')).toHaveValue('Orders');
        await page.screenshot({ path: test.info().outputPath(`empty-filtered-page-${language}.png`), fullPage: true });
        await page.getByRole('button', { name: chinese ? '返回最新' : 'Return to latest', exact: true }).click();
        await expect(page).toHaveURL(`/${language}/admin/access/resources?${filter}`);
        await expect(page.getByRole('link', { name: 'Orders', exact: true })).toBeVisible();
    });

    test(`focuses submitted field errors without interrupting corrections and avoids unchanged resource saves in ${language}`, async ({ page, context }) => {
        const fixture = await accessFixture(context);
        await page.setViewportSize({ width: chinese ? 375 : 1280, height: 812 });
        await page.goto(`/${language}/admin/access/resources`);
        await page.getByRole('button', { name: chinese ? '创建 API 资源' : 'Create API resource', exact: true }).click();
        const dialog = page.locator('md-dialog.form-dialog'), identifier = dialog.getByLabel(chinese ? 'API 标识' : 'API identifier', { exact: true });
        const ttl = dialog.getByLabel(chinese ? '访问令牌有效期（秒）' : 'Access token lifetime (seconds)', { exact: true });
        const create = dialog.getByRole('button', { name: chinese ? '创建 API 资源' : 'Create API resource', exact: true });
        await dialog.getByLabel(chinese ? '资源名称' : 'Resource name', { exact: true }).fill('Orders');
        await identifier.fill('http://invalid.example.test'); await ttl.fill('0');
        await create.click();
        await expect(identifier).toBeFocused();
        expect(fixture.writes).toHaveLength(0);
        await identifier.fill('https://api.example.test');
        await expect(identifier).toBeFocused();
        await create.click();
        await expect(ttl).toBeFocused();
        await ttl.fill('300'); await create.click();
        await expect(dialog).toHaveCount(0);
        await page.getByRole('link', { name: 'Orders', exact: true }).click();
        await page.locator('.page-heading').getByRole('button', { name: chinese ? '编辑' : 'Edit', exact: true }).click();
        const save = dialog.getByRole('button', { name: chinese ? '保存修改' : 'Save changes', exact: true });
        await expect(save).toBeDisabled();
        await expect(dialog.getByRole('status')).toContainText(chinese ? '没有未保存的更改' : 'No unsaved changes');
        const description = dialog.getByLabel(chinese ? '描述' : 'Description', { exact: true });
        await description.fill('Changed'); await expect(save).toBeEnabled();
        await description.fill(''); await expect(save).toBeDisabled();
        expect(fixture.writes).toHaveLength(1);
    });

    for (const width of [320, 375]) test(`keeps mobile navigation compact and keyboard accessible at ${width}px in ${language}`, async ({ page, context }) => {
        await accessFixture(context);
        await page.setViewportSize({ width, height: 812 });
        await page.goto(`/${language}/admin/users`);
        const toggle = page.getByRole('button', { name: chinese ? '导航' : 'Navigation', exact: true });
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        const heading = page.getByRole('heading', { level: 1 });
        expect((await heading.boundingBox())!.y).toBeLessThan(320);
        await toggle.press('Enter');
        const nav = page.getByRole('navigation', { name: chinese ? '管理导航' : 'Administration navigation', exact: true });
        await expect(nav.getByRole('link')).toHaveCount(9);
        await expect(nav.getByRole('group')).toHaveCount(4);
        await expect(nav.getByRole('link', { name: chinese ? '用户' : 'Users', exact: true })).toHaveAttribute('aria-current', 'page');
        await page.keyboard.press('Tab');
        await expect(nav.getByRole('link').first()).toBeFocused();
        await page.keyboard.press('Escape'); await expect(toggle).toBeFocused();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await toggle.press('Enter');
        await nav.getByRole('link', { name: chinese ? 'API 资源' : 'API resources', exact: true }).click();
        await expect(page).toHaveURL(`/${language}/admin/access/resources`);
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: test.info().outputPath(`compact-navigation-${language}-${width}.png`), fullPage: true });
        await page.setViewportSize({ width: 1280, height: 900 });
        await expect(toggle).toBeHidden(); await expect(nav).toBeVisible();
        await expect(nav.getByRole('link', { name: chinese ? 'API 资源' : 'API resources', exact: true })).toHaveAttribute('aria-current', 'page');
        const current = nav.getByRole('link', { name: chinese ? 'API 资源' : 'API resources', exact: true });
        await current.focus();
        await page.setViewportSize({ width, height: 812 });
        await expect(nav).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(current).toBeFocused();
        await expect(current).toBeInViewport();
        await page.keyboard.press('Escape');
        await expect(toggle).toBeFocused();
        await page.setViewportSize({ width: 1280, height: 900 });
        await expect(toggle).toBeHidden();
        await expect(current).toBeFocused();
        await expect(current).toBeInViewport();
    });
}

test('retains role permission selections across cursor pages', async ({ page, context }) => {
    const state = await accessFixture(context), now = new Date().toISOString(), resourceId = randomUUID();
    const permissions = Array.from({ length: 21 }, (_, index) => ({ id: randomUUID(), resourceId, name: `Permission ${index + 1}`, scope: `items:read-${index + 1}`, description: '', createdAt: now }));
    state.resources.push({ id: resourceId, name: 'Items', identifier: 'https://api.example.test/items', description: '', accessTokenTtl: 300, disabled: false, createdAt: now, permissions });
    await page.goto('/en-us/admin/access/roles');
    await page.getByRole('button', { name: 'Create role', exact: true }).click();
    const dialog = page.locator('md-dialog');
    await dialog.getByLabel('Role name', { exact: true }).fill('Paged permissions');
    await dialog.getByRole('checkbox', { name: 'Permission 1 (items:read-1)', exact: true }).check();
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await dialog.getByRole('checkbox', { name: 'Permission 21 (items:read-21)', exact: true }).check();
    await expect(dialog.getByText('2 selected', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Return to latest', exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: 'Permission 1 (items:read-1)', exact: true })).toBeChecked();
    await dialog.getByRole('button', { name: 'Create role', exact: true }).click();
    await expect(page.getByText('Paged permissions', { exact: true })).toBeVisible();
    expect(state.roles[0].permissionIds).toEqual([permissions[0].id, permissions[20].id]);
});

test('names the protected API and business permission on the consent screen', async ({ page, context }) => {
    const state = await accessFixture(context), now = new Date().toISOString(), resourceId = randomUUID();
    state.resources.push({ id: resourceId, name: 'Orders API', identifier: 'https://api.example.test/orders', description: '', accessTokenTtl: 300, disabled: false, createdAt: now, permissions: [{ id: randomUUID(), resourceId, name: 'Read orders', scope: 'orders:read', description: 'Read the order list.', createdAt: now }] });
    await page.goto('/en-us/consent?client_id=example-client&scope=openid+orders%3Aread&sig=isolated-ui-query&ba_param=client_id&ba_param=scope');
    await expect(page.getByText('Orders API', { exact: true })).toBeVisible();
    await expect(page.getByText('https://api.example.test/orders', { exact: true })).toBeVisible();
    await expect(page.getByText('Read the order list.', { exact: true })).toBeVisible();
    await expect(page.getByText('oauth.scope_orders:read', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
});
