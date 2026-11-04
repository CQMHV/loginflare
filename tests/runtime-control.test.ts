import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import worker from '../src/server/index';
import { ensureControl, enterMaintenance, issueSession, readControl } from '../src/server/control';
import type { Env } from '../src/server/config';
import { initialUpgradeProgress } from '../src/server/upgrade';
import { harness, cookies } from './helpers';
import { interceptSql } from './sql-race';

const bindings: Env = { ...env };
async function request(path: string, cookie?: string, body?: object, current = bindings) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`http://localhost:5173${path}`, { method: body ? 'POST' : 'GET',
        headers: { Origin: 'http://localhost:5173', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined }), current, ctx);
    await waitOnExecutionContext(ctx); return response;
}
beforeEach(async () => { await reset(); });

it('serves both control pages and status with no business tables, branding, or authentication configuration', async () => {
    for (const path of ['/en-us/setup', '/zh-cn/maintenance']) {
        const response = await request(path);
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
        expect(await response.text()).toContain('Loginflare');
    }
    expect((await (await request('/api/setup/status')).json()) as object).toMatchObject({ mode: 'setup', authenticated: false });
    expect((await (await request('/api/maintenance/status')).json()) as object).toMatchObject({ mode: 'setup', authenticated: false });
    expect((await (await request('/api/auth/sign-up/email', undefined, { email: 'outside@example.test' })).json()) as object).toMatchObject({ code: 'SETUP_REQUIRED' });
});

it('allows the Vite development preamble and HMR on standalone control pages only in development', async () => {
    for (const path of ['/setup', '/en-us/maintenance']) {
        const development = await request(path);
        expect(development.headers.get('Content-Security-Policy')).toMatch(/script-src[^;]*'unsafe-inline'/);
        expect(development.headers.get('Content-Security-Policy')).toMatch(/connect-src[^;]*ws:\/\/localhost:5173/);
        for (const APP_ENV of ['staging', 'production'] as const) {
            const deployed = await request(path, undefined, undefined, { ...bindings, APP_ENV });
            expect(deployed.status).toBe(200);
            expect(deployed.headers.get('Content-Security-Policy')).not.toMatch(/script-src[^;]*'unsafe-inline'/);
            expect(deployed.headers.get('Content-Security-Policy')).not.toContain('ws://');
            expect(deployed.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
        }
    }
});

it('does not bypass an unconfirmed R2 operation when a failed drain is retried', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await ensureControl(bindings);
    const control = await enterMaintenance(env.DB, 'development');
    await env.DB.prepare('INSERT INTO lfControlValue (key,value) VALUES (?,?)').bind(`backup:${control.taskId}`, 'true').run();
    const token = await issueSession(env.DB, 'maintenance', control.taskId);
    const cookie = `loginflare.control=${token}`;
    await env.DB.prepare(`INSERT INTO lfControlEffect (id,scopeId,generation,kind,payload,status,createdAt)
        VALUES ('unknown-r2','old-permit',0,'r2:delete','{}','pending',0)`).run();
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await request('/api/maintenance/advance', cookie, {});
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'EXTERNAL_RESULT_UNCONFIRMED', progress: null });
        expect((await readControl(env.DB)).mode).toBe('failed');
    }
    expect((await request('/zh-cn/maintenance')).status).toBe(200);
});

it('rejects a resumed old application build without reopening maintenance or retargeting the instance', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await ensureControl(bindings);
    await env.DB.prepare("UPDATE lfControl SET buildId='new-build',targetBuildId='new-build',buildTime=20,targetBuildTime=20 WHERE id=1").run();
    const old = { ...bindings, APP_ENV: 'production' as const, LOGINFLARE_BUILD_ID: 'old-build', LOGINFLARE_BUILD_TIME: '10' };
    const response = await request('/api/config', undefined, undefined, old);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'STALE_APPLICATION_BUILD' });
    expect(await readControl(env.DB)).toMatchObject({ mode: 'ready', buildId: 'new-build', targetBuildId: 'new-build' });
});

it('keeps an existing uninstrumented database in adoption and rejects attempts to replace drain evidence with a checkbox', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const production = { ...bindings, APP_ENV: 'production' as const, LOGINFLARE_BUILD_ID: 'bridge', LOGINFLARE_BUILD_TIME: '1' };
    const control = await ensureControl(production);
    const token = await issueSession(env.DB, 'maintenance', control.taskId);
    const response = await request('/api/maintenance/enter', `loginflare.control=${token}`, { backupConfirmed: true,
        legacyDrainEvidence: { waitedSeconds: 5, confirmed: true } }, production);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'VERIFIED_LEGACY_DRAIN_REQUIRED', releaseBlocker: true });
    expect((await readControl(env.DB)).mode).toBe('adoption');
});

it('opens the recovery shell even when the control protocol itself cannot be read by this build', async () => {
    await ensureControl(bindings);
    await env.DB.prepare('UPDATE lfControl SET protocolVersion=99 WHERE id=1').run();
    expect((await request('/en-us/maintenance')).status).toBe(200);
    const status = await request('/api/maintenance/status');
    expect(status.status).toBe(503);
    expect(await status.json()).toEqual({ code: 'UNSUPPORTED_CONTROL_PROTOCOL' });
});

it('recovers the terminal upgrade checkpoint after its response is lost without rerunning migration SQL', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await ensureControl(bindings);
    const state = await enterMaintenance(env.DB, 'development');
    const progress = { ...initialUpgradeProgress(), phase: 'complete' };
    await env.DB.batch([
        env.DB.prepare('INSERT INTO lfControlValue (key,value) VALUES (?,?)').bind(`upgrade:${state.taskId}`, JSON.stringify(progress)),
        env.DB.prepare('INSERT INTO lfControlValue (key,value) VALUES (?,?)').bind(`drained:${state.taskId}`, 'true'),
        env.DB.prepare('INSERT INTO lfControlValue (key,value) VALUES (?,?)').bind(`backup:${state.taskId}`, 'true'),
        env.DB.prepare("UPDATE lfControl SET mode='failed' WHERE id=1"),
    ]);
    const original = await env.DB.prepare("SELECT sql FROM sqlite_schema WHERE name='user'").first('sql');
    const token = await issueSession(env.DB, 'maintenance', state.taskId);
    const response = await request('/api/maintenance/advance', `loginflare.control=${token}`, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'ready', progress: { phase: 'complete' } });
    expect((await readControl(env.DB)).mode).toBe('ready');
    expect(await env.DB.prepare("SELECT sql FROM sqlite_schema WHERE name='user'").first('sql')).toBe(original);
});

it('authorizes an administrator into a task-bound maintenance session and atomically closes admission', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const client = harness();
    const native = await client.administrator();
    const response = await client.request('/api/maintenance/authorize', { cookie: native, body: {} });
    expect(response.status).toBe(200);
    const entered = await client.request('/api/maintenance/enter', { cookie: cookies(response), body: { backupConfirmed: true } });
    expect(entered.status).toBe(200);
    expect((await readControl(env.DB)).mode).toBe('draining');
    expect((await client.request('/api/auth/get-session', { cookie: native })).status).toBe(503);
});

it('does not grant maintenance authority when the administrator is demoted at the actual session write', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const client = harness();
    const native = await client.administrator();
    const database = interceptSql(env.DB, /INSERT INTO "lfControlSession"/i, async () => {
        await env.DB.prepare("UPDATE \"user\" SET role='user' WHERE email='admin@example.test'").run();
    });
    client.bindings.DB = database.proxy;
    const response = await client.request('/api/maintenance/authorize', { cookie: native, body: {} });
    expect(database.invoked()).toBe(true);
    expect(response.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM lfControlSession WHERE purpose='maintenance'").first('n')).toBe(0);
});

it('lets the existing administrator authorize automatic draining but requires a durable backup confirmation before DDL', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const client = harness();
    const native = await client.administrator();
    const state = await enterMaintenance(env.DB, 'development');
    const response = await client.request('/api/maintenance/authorize', { cookie: native, body: {} });
    expect(response.status).toBe(200);
    const maintenance = cookies(response);
    expect(await (await client.request('/api/maintenance/status', { cookie: maintenance })).json()).toMatchObject({ backupConfirmed: false });
    const denied = await client.request('/api/maintenance/advance', { cookie: maintenance, body: {} });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ code: 'BACKUP_CONFIRMATION_REQUIRED' });
    expect((await readControl(env.DB)).mode).toBe('draining');
    const confirmation = await client.request('/api/maintenance/enter', { cookie: maintenance, body: { backupConfirmed: true } });
    expect(confirmation.status).toBe(200);
    expect(await confirmation.json()).toMatchObject({ taskId: state.taskId, backupConfirmed: true });
    expect((await client.request('/api/maintenance/advance', { cookie: maintenance, body: { confirmUnverifiableKey: true } })).status).toBe(200);
    const expiredSchema = await client.request('/api/maintenance/authorize', { cookie: native, body: {} });
    expect(expiredSchema.status).toBe(401);
    expect(await expiredSchema.json()).toMatchObject({ code: 'MAINTENANCE_RECOVERY_REQUIRED' });
});

it('starts a new task from maintenance status on a newer build and rebinds the authorized session', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const state = await ensureControl(bindings);
    const token = await issueSession(env.DB, 'maintenance', state.taskId);
    await env.DB.prepare('INSERT INTO lfControlValue (key,value) VALUES (?,?)')
        .bind(`upgrade:${state.taskId}`, JSON.stringify({ ...initialUpgradeProgress(), phase: 'complete' })).run();
    const newer = { ...bindings, APP_ENV: 'production' as const, LOGINFLARE_BUILD_ID: 'next-build', LOGINFLARE_BUILD_TIME: '25' };
    const response = await request('/api/maintenance/status', `loginflare.control=${token}`, undefined, newer);
    const status = await response.json<{ mode: string; taskId: string }>();
    expect(status).toMatchObject({ mode: 'draining', authenticated: true, progress: null, backupConfirmed: false });
    expect(status.taskId).not.toBe(state.taskId);
    expect(await readControl(env.DB)).toMatchObject({ mode: 'draining', targetBuildId: 'next-build' });
});
