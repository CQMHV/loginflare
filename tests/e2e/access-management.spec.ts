import { randomUUID } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { expect, test } from './fixtures';
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
        const navigation = page.getByRole('navigation', { name: labels.navigation, exact: true });
        await expect(navigation.getByRole('group')).toHaveCount(4);
        for (const name of labels.groups) await expect(navigation.getByRole('group', { name, exact: true })).toBeVisible();
        await expect(navigation.getByRole('link')).toHaveCount(9);
        const guide = page.getByRole('region', { name: labels.guide, exact: true });
        await expect(guide).toContainText(labels.signIn);
        await expect(guide.getByRole('link', { name: labels.developer, exact: true })).toHaveAttribute('href', `/${language}/developer/applications`);
        await expect(guide.getByRole('listitem')).toHaveCount(3);
        await page.screenshot({ path: test.info().outputPath(`access-guide-${language}.png`), fullPage: true });
        const roles = navigation.getByRole('link', { name: labels.roles, exact: true });
        await roles.click();
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
            await roles.click();
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
        await dialog.getByRole('button', { name: labels.save, exact: true }).click();
        await expect(dialog.getByText(zh ? '请输入不含查询参数、片段和用户凭据的完整 HTTPS 地址。' : 'Enter an absolute HTTPS URL without a query, fragment or user credentials.', { exact: true })).toBeVisible();
        expect(state.writes).toHaveLength(0);
        await dialog.getByLabel(labels.identifier, { exact: true }).fill('https://api.example.test/orders');
        await dialog.getByLabel(labels.ttl, { exact: true }).fill('300');
        await dialog.getByRole('button', { name: labels.save, exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await page.getByRole('link', { name: 'Orders', exact: true }).click();
        await page.getByRole('button', { name: labels.createPermission, exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
        await dialog.getByLabel(labels.permissionName, { exact: true }).fill('Read orders');
        await dialog.getByLabel(labels.scope, { exact: true }).fill('orders:read');
        await dialog.getByRole('button', { name: labels.save, exact: true }).click();
        await expect(page.getByText('orders:read', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: labels.link, exact: true }).click();
        dialog = page.locator('md-dialog.form-dialog');
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
        await dialog.getByRole('button', { name: labels.save, exact: true }).click();
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
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
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
