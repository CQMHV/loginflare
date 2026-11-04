import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/server/index';
import { harness, origin } from './helpers';
import { connectManagement } from '../examples/management-worker/src/client';
import { pollAuditLogs } from '../examples/management-worker/src/index';

beforeEach(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

it('uses real client credentials to provision an application, assign a business role and poll audit before credential rotation', async () => {
    const browser = harness(), outbound: Array<{ path: string; bearer: boolean }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return Response.json({ success: true });
        if (new URL(request.url).origin !== origin) throw new Error('Unexpected network destination');
        outbound.push({ path: new URL(request.url).pathname, bearer: request.headers.get('authorization')?.startsWith('Bearer ') ?? false });
        expect(request.headers.get('cookie')).toBeNull();
        const ctx = createExecutionContext();
        const response = await app.fetch(request, browser.bindings, ctx);
        await waitOnExecutionContext(ctx);
        return response;
    });
    const administrator = await browser.administrator();
    await browser.verify('automation-target@example.test');
    const userId = await env.DB.prepare('SELECT "id" FROM "user" WHERE "email" = ?').bind('automation-target@example.test').first<string>('id');
    expect(userId).toBeTruthy();
    const businessRole = await browser.request('/api/admin/access/roles', { cookie: administrator, body: { name: 'Provisioned business role', permissionIds: [] } });
    expect(businessRole.status, await businessRole.clone().text()).toBe(201);
    const { id: roleId } = await businessRole.json<{ id: string }>();
    const role = await browser.request('/api/admin/machines/roles', { cookie: administrator, body: {
        name: 'Trusted provisioner', managementScopes: ['management:audit:read', 'management:applications:write', 'management:role-assignments:write'],
    } });
    expect(role.status, await role.clone().text()).toBe(201);
    const { id: machineRoleId } = await role.json<{ id: string }>();
    const machine = await browser.request('/api/admin/machines/applications', { cookie: administrator, body: { name: 'Integration automation' } });
    expect(machine.status, await machine.clone().text()).toBe(201);
    const identity = await machine.json<{ clientId: string; clientSecret: string }>();
    const assigned = await browser.request(`/api/admin/machines/applications/${identity.clientId}/roles`, { cookie: administrator, method: 'PUT', body: { roleIds: [machineRoleId] } });
    expect(assigned.status, await assigned.clone().text()).toBe(200);
    const configuration = { AUTH_ISSUER: `${origin}/api/auth`, MACHINE_CLIENT_ID: identity.clientId, MACHINE_CLIENT_SECRET: identity.clientSecret };
    const management = await connectManagement(configuration, ['management:applications:write', 'management:role-assignments:write']);
    const created = await management.createLoginApplication({
        name: 'Provisioned SPA', type: 'spa', redirectUris: ['https://provisioned.example.test/callback'],
        postLogoutRedirectUris: ['https://provisioned.example.test/'], scopes: ['openid', 'profile'],
    });
    expect(created).toMatchObject({ name: 'Provisioned SPA', type: 'spa' }); expect(created.clientSecret).toBeUndefined();
    await management.replaceUserRoles(userId!, [roleId]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "apiUserRole" WHERE "userId" = ? AND "roleId" = ?').bind(userId, roleId).first<number>('n')).toBe(1);
    expect((await pollAuditLogs(configuration)).count).toBeGreaterThan(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "auditLog" WHERE "actorClientId" = ? AND "event" = ?').bind(identity.clientId, 'management.application.created').first<number>('n')).toBe(1);
    const rotated = await browser.request(`/api/admin/machines/applications/${identity.clientId}/rotate-secret`, { cookie: administrator, body: {} });
    expect(rotated.status, await rotated.clone().text()).toBe(200);
    await expect(management.replaceUserRoles(userId!, [])).rejects.toMatchObject({ status: 401 });
    await expect(pollAuditLogs(configuration)).rejects.toMatchObject({ status: 401 });
    expect(outbound.filter((request) => request.path.startsWith('/api/management/v1')).every((request) => request.bearer)).toBe(true);
});
