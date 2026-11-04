import { randomUUID } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { testOrigin } from './runtime';
import { defaultBranding } from '../../src/shared/branding';
import type { Identity } from '../../src/client/api';

async function machineFixture(context: BrowserContext, administrator = true) {
    const now = new Date().toISOString(), actorId = randomUUID();
    const identity: Identity = { browserAccountId: randomUUID(), user: { id: actorId, name: 'Machine administrator', email: 'admin@loginflare.test', emailVerified: true, role: administrator ? 'admin' : 'user', createdAt: now }, session: { id: randomUUID(), token: 'isolated-browser-session', userId: actorId, createdAt: now, expiresAt: new Date(Date.now() + 86400000).toISOString() } };
    type Application = { clientId: string; name: string; disabled: boolean; createdAt: string; roleIds: string[] };
    type Role = { id: string; name: string; description: string; createdAt: string; permissionIds: string[]; managementScopes: string[] };
    const permission = { id: randomUUID(), resourceId: randomUUID(), scope: 'orders:read', name: 'Read orders', description: '', resourceName: 'Orders' };
    const applications: Application[] = [], roles: Role[] = [], writes: { path: string; method: string; body: Record<string, unknown> | undefined }[] = [];
    const state = { secretNumber: 0, revocations: 0, pendingCreate: undefined as Promise<void> | undefined };
    const managementScopes = ['management:users:read', 'management:users:write', 'management:applications:read', 'management:applications:write', 'management:resources:read', 'management:resources:write', 'management:roles:read', 'management:roles:write', 'management:role-assignments:read', 'management:role-assignments:write', 'management:audit:read'];
    const issuer = `${testOrigin}/api/auth`, managementResource = 'urn:loginflare:management';
    const actorClientId = 'M'.repeat(32), audit = { id: randomUUID(), event: 'machine.token_issued', outcome: 'success', actorUserId: null, actorClientId, targetUserId: null, clientId: actorClientId, targetType: 'application', targetId: actorClientId, reason: null, requestId: 'isolated-machine-audit', ipAddress: '192.0.2.5', userAgent: 'Synthetic service', createdAt: now };
    const page = (items: unknown[]) => ({ items, pageInfo: { nextCursor: null, previousCursor: null } });
    const detail = (item: Application) => ({ ...item, issuer, managementResource, roles: roles.filter((role) => item.roleIds.includes(role.id)).map(({ id, name }) => ({ id, name })), scopes: [...new Set(roles.filter((role) => item.roleIds.includes(role.id)).flatMap((role) => [...role.managementScopes, ...role.permissionIds.filter((id) => id === permission.id).map(() => permission.scope)]))] });
    await context.route(`${testOrigin}/api/**`, async (route) => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
        const body = request.postData() && request.headers()['content-type']?.includes('application/json') ? request.postDataJSON() : undefined;
        let json: unknown = {}, status = 200;
        if (path === '/api/auth/get-session') json = identity;
        else if (path === '/api/browser/accounts') json = { accounts: [{ id: identity.browserAccountId, user: identity.user, status: 'active', lastUsedAt: now }], maximumAccounts: 5 };
        else if (path === '/api/branding') json = { ...defaultBranding, logoUrl: '/assets/logo.svg', revision: 0 };
        else if (path === '/api/config') json = { turnstileSiteKey: '1x00000000000000000000AA' };
        else if (path === '/api/admin/audit-logs') json = page([audit]);
        else if (path.startsWith('/api/admin/audit-logs/')) json = audit;
        else if (path.startsWith('/api/admin/machines')) {
            const parts = path.slice('/api/admin/machines/'.length).split('/');
            if (method !== 'GET') writes.push({ path, method, body });
            if (parts[0] === 'permissions') json = { permissions: [permission], managementScopes, managementResource };
            else if (parts[0] === 'applications' && parts.length === 1 && method === 'GET') json = { ...page(applications), issuer, managementResource };
            else if (parts[0] === 'applications' && parts.length === 1 && method === 'POST') {
                await state.pendingCreate;
                if (body.name === 'duplicate') { status = 409; json = { code: 'MACHINE_INPUT_INVALID', fieldErrors: { name: 'MACHINE_NAME_EXISTS' } }; }
                else {
                    const application = { clientId: 'A'.repeat(31) + String.fromCharCode(65 + applications.length), name: body.name, disabled: false, createdAt: now, roleIds: [] }; applications.push(application);
                    json = { ...application, clientSecret: `isolated-machine-secret-${++state.secretNumber}` };
                }
            } else if (parts[0] === 'applications') {
                const application = applications.find((item) => item.clientId === parts[1])!;
                if (parts[2] === 'rotate-secret') json = { clientSecret: `isolated-machine-secret-${++state.secretNumber}` };
                else if (parts[2] === 'revoke-tokens') { state.revocations++; json = { status: true }; }
                else if (parts[2] === 'roles') { application.roleIds = body.roleIds; json = { status: true }; }
                else { if (method === 'PATCH') Object.assign(application, body); json = detail(application); }
            } else if (parts[0] === 'roles' && parts.length === 1 && method === 'GET') json = page(roles);
            else if (parts[0] === 'roles' && parts.length === 1 && method === 'POST') {
                const role = { id: randomUUID(), ...body, createdAt: now } as Role; roles.push(role); json = role;
            } else if (parts[0] === 'roles') {
                const role = roles.find((item) => item.id === parts[1])!;
                if (method === 'PATCH') Object.assign(role, body);
                if (method === 'DELETE') { roles.splice(roles.indexOf(role), 1); for (const application of applications) application.roleIds = application.roleIds.filter((id) => id !== role.id); }
                json = role;
            }
        }
        await route.fulfill({ status, json }).catch(() => {});
    });
    return { identity, applications, roles, permission, writes, state, actorClientId };
}

for (const [language, width] of [['en-us', 1280], ['zh-cn', 375]] as const) test(`manages machine identities and roles with one-time secrets in ${language}`, async ({ page, context }) => {
    const fixture = await machineFixture(context), zh = language === 'zh-cn';
    const text = zh ? { createRole: '创建机器角色', roleName: '角色名称', save: '保存修改', createApplication: '创建机器应用', applicationName: '应用名称', secret: '客户端密钥', secretSaved: '我已保存密钥', assignRoles: '分配机器角色', rotate: '轮换客户端密钥', revoke: '撤销访问令牌', disable: '停用机器应用', enable: '启用机器应用', confirm: '确认', cancel: '取消', duplicate: '此名称已被使用。', managementPermission: '读取用户 (management:users:read)' }
        : { createRole: 'Create machine role', roleName: 'Role name', save: 'Save changes', createApplication: 'Create machine application', applicationName: 'Application name', secret: 'Client secret', secretSaved: 'I have saved the secret', assignRoles: 'Assign machine roles', rotate: 'Rotate client secret', revoke: 'Revoke access tokens', disable: 'Disable machine application', enable: 'Enable machine application', confirm: 'Confirm', cancel: 'Cancel', duplicate: 'This name is already in use.', managementPermission: 'Read users (management:users:read)' };
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/${language}/admin/machines/roles`);
    await page.getByRole('button', { name: text.createRole, exact: true }).click();
    let dialog = page.locator('md-dialog.form-dialog');
    await dialog.getByLabel(text.roleName, { exact: true }).fill('Report reader');
    await dialog.getByRole('checkbox', { name: 'Orders · Read orders (orders:read)', exact: true }).check();
    await dialog.getByRole('checkbox', { name: text.managementPermission, exact: true }).check();
    await dialog.getByRole('button', { name: text.save, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(fixture.roles[0].permissionIds).toEqual([fixture.permission.id]);
    expect(fixture.roles[0].managementScopes).toEqual(['management:users:read']);
    await page.goto(`/${language}/admin/machines/applications`);
    await page.getByRole('button', { name: text.createApplication, exact: true }).click();
    dialog = page.locator('md-dialog.form-dialog');
    await dialog.getByLabel(text.applicationName, { exact: true }).fill('duplicate');
    await dialog.getByRole('button', { name: text.save, exact: true }).click();
    await expect(dialog.getByText(text.duplicate, { exact: true })).toBeVisible();
    await dialog.getByLabel(text.applicationName, { exact: true }).fill('Report service');
    await dialog.getByRole('button', { name: text.save, exact: true }).click();
    await expect(dialog.getByLabel(text.secret, { exact: true })).toHaveValue('isolated-machine-secret-1');
    expect(await page.evaluate(() => JSON.stringify([sessionStorage, localStorage]))).not.toContain('isolated-machine-secret');
    await dialog.getByRole('button', { name: text.secretSaved, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${language}/admin/machines/applications/detail[?]clientId=`));
    await expect(page.getByLabel(text.secret, { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: text.assignRoles, exact: true }).click();
    dialog = page.locator('md-dialog.form-dialog');
    await dialog.getByRole('checkbox', { name: 'Report reader', exact: true }).check();
    await dialog.getByRole('button', { name: text.save, exact: true }).click();
    await expect(page.getByText('orders:read', { exact: true })).toBeVisible();
    await expect(page.getByText('management:users:read', { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`machine-application-${language}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: text.rotate, exact: true }).click();
    dialog = page.locator('md-dialog.form-dialog');
    await expect(dialog.getByLabel(text.secret, { exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: text.cancel, exact: true }).click();
    expect(fixture.state.secretNumber).toBe(1);
    await page.getByRole('button', { name: text.rotate, exact: true }).click();
    await dialog.getByRole('button', { name: text.confirm, exact: true }).click();
    await expect(dialog.getByLabel(text.secret, { exact: true })).toHaveValue('isolated-machine-secret-2');
    await dialog.getByRole('button', { name: text.secretSaved, exact: true }).click();
    await page.getByRole('button', { name: text.revoke, exact: true }).click();
    expect(fixture.state.revocations).toBe(0);
    await dialog.getByRole('button', { name: text.confirm, exact: true }).click();
    await expect.poll(() => fixture.state.revocations).toBe(1);
    await page.getByRole('button', { name: text.disable, exact: true }).click();
    expect(fixture.applications[0].disabled).toBe(false);
    await dialog.getByRole('button', { name: text.confirm, exact: true }).click();
    await expect(page.getByRole('button', { name: text.enable, exact: true })).toBeVisible();
    await page.getByRole('button', { name: text.enable, exact: true }).click();
    await expect.poll(() => fixture.applications[0].disabled).toBe(false);
    await page.reload();
    await expect(page.getByText('Report reader', { exact: true })).toBeVisible();
    await expect(page.getByLabel(text.secret, { exact: true })).toHaveCount(0);
});

test('does not reveal a delayed machine secret after pagehide', async ({ page, context }) => {
    const fixture = await machineFixture(context);
    let release!: () => void; fixture.state.pendingCreate = new Promise((resolve) => { release = resolve; });
    try {
        await page.goto('/en-us/admin/machines/applications');
        await page.getByRole('button', { name: 'Create machine application', exact: true }).click();
        await page.getByLabel('Application name', { exact: true }).fill('Background service');
        const response = page.waitForResponse((response) => response.url().endsWith('/api/admin/machines/applications') && response.request().method() === 'POST');
        await page.locator('md-dialog').getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect.poll(() => fixture.writes.length).toBe(1);
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
        release(); await (await response).finished();
        await expect(page.getByRole('link', { name: 'Background service', exact: true })).toBeVisible();
        await expect(page.getByLabel('Client secret', { exact: true })).toHaveCount(0);
        expect(await page.evaluate(() => document.body.innerText)).not.toContain('isolated-machine-secret');
    } finally { release(); }
});

test('synchronizes machine role changes across tabs and confirms deletion', async ({ page, context }) => {
    const fixture = await machineFixture(context), role = { id: randomUUID(), name: 'Old machine role', description: '', permissionIds: [], managementScopes: [], createdAt: new Date().toISOString() };
    fixture.roles.push(role); fixture.applications.push({ clientId: 'A'.repeat(32), name: 'Shared service', disabled: false, roleIds: [role.id], createdAt: new Date().toISOString() });
    await page.goto(`/en-us/admin/machines/applications/detail?clientId=${fixture.applications[0].clientId}`);
    await expect(page.getByText('Old machine role', { exact: true })).toBeVisible();
    const peer = await context.newPage();
    await peer.goto('/en-us/admin/machines/roles');
    await peer.getByRole('button', { name: 'Edit machine role: Old machine role', exact: true }).click();
    await peer.getByLabel('Role name', { exact: true }).fill('Updated machine role');
    await peer.locator('md-dialog').getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(peer.getByText('Updated machine role', { exact: true })).toBeVisible();
    await page.bringToFront();
    await expect(page.getByText('Updated machine role', { exact: true })).toBeVisible();
    await peer.bringToFront();
    await peer.getByRole('button', { name: 'Delete machine role: Updated machine role', exact: true }).click();
    expect(fixture.roles).toHaveLength(1);
    await peer.locator('md-dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(peer.getByText('No machine roles.', { exact: true })).toBeVisible();
    await page.bringToFront();
    await expect(page.getByText('No machine roles assigned.', { exact: true })).toBeVisible();
    await peer.close();
});

test('identifies machine actors separately in audit logs', async ({ page, context }) => {
    const fixture = await machineFixture(context);
    await page.goto(`/en-us/admin/audit-logs?lookupField=actorClientId&lookupValue=${fixture.actorClientId}`);
    await expect(page.locator('.machine-actor-label')).toBeVisible();
    await page.getByRole('button', { name: 'Details: machine.token_issued', exact: true }).click();
    const dialog = page.locator('md-dialog');
    await expect(dialog.getByText('Machine actor', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Actor user ID', { exact: true })).toBeVisible();
    await expect(dialog.getByText(fixture.actorClientId, { exact: true }).first()).toBeVisible();
});

test('keeps machine administration unavailable to ordinary accounts', async ({ page, context }) => {
    await machineFixture(context, false);
    for (const path of ['applications', 'roles']) {
        await page.goto(`/en-us/admin/machines/${path}`);
        await expect(page.getByText('403', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: /^Create machine/ })).toHaveCount(0);
    }
});
