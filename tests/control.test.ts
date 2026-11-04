import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import {
    acquireLease, admit, beginEffect, drain, ensureControl, enterMaintenance, fencedBatch, finishEffect, guardedBucket, guardedDatabase,
    issueSession, readControl, readSession, releaseLease,
} from '../src/server/control';
import type { Env } from '../src/server/config';

const bindings: Env = { ...env, APP_ENV: 'development' };
beforeEach(async () => {
    await reset();
    await env.DB.prepare('CREATE TABLE "user" (id TEXT PRIMARY KEY)').run();
    await env.DB.prepare('CREATE TABLE "controlFixture" (id TEXT PRIMARY KEY)').run();
    await ensureControl(bindings);
});

it('serializes simultaneous executors and fences a resumed expired owner in the committing transaction', async () => {
    const state = await readControl(env.DB);
    const attempts = await Promise.allSettled([acquireLease(env.DB, state.taskId), acquireLease(env.DB, state.taskId)]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const first = attempts.find((result) => result.status === 'fulfilled')!;
    if (first.status !== 'fulfilled') throw new Error('Missing lease');
    await env.DB.prepare('UPDATE "lfControl" SET leaseUntil=0 WHERE id=1').run();
    const next = await acquireLease(env.DB, state.taskId);
    expect(next.generation).toBeGreaterThan(first.value.generation);
    await expect(fencedBatch(env.DB, first.value, [env.DB.prepare('INSERT INTO "controlFixture" VALUES (?)').bind('stale')]))
        .rejects.toThrow('EXECUTION_LEASE_LOST');
    expect(await env.DB.prepare('SELECT * FROM "controlFixture"').all()).toMatchObject({ results: [] });
    await fencedBatch(env.DB, next, [env.DB.prepare('INSERT INTO "controlFixture" VALUES (?)').bind('current')]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "controlFixture"').first('n')).toBe(1);
    await releaseLease(env.DB, first.value);
    expect((await readControl(env.DB)).owner).toBe(next.owner);
});

it('closes admission atomically and blocks old SQL after the drain generation advances', async () => {
    const permit = await admit(env.DB, 'development');
    const scoped = guardedDatabase(env.DB, permit);
    await enterMaintenance(env.DB, 'next-build', undefined, 1);
    await expect(admit(env.DB, 'development')).rejects.toThrow('MAINTENANCE_REQUIRED');
    await scoped.prepare('INSERT INTO "controlFixture" VALUES (?)').bind('before-drain').run();
    const state = await readControl(env.DB);
    const lease = await acquireLease(env.DB, state.taskId);
    await drain(env.DB, lease);
    await expect(scoped.prepare('INSERT INTO "controlFixture" VALUES (?)').bind('late').run()).rejects.toThrow('MAINTENANCE_REQUIRED');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "controlFixture"').first('n')).toBe(1);
});

it('cannot declare R2 drained while a deletion is in flight, including after lease takeover', async () => {
    let markStarted!: () => void;
    let markCompleted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const completed = new Promise<void>((resolve) => { markCompleted = resolve; });
    const bucket = new Proxy(env.AVATARS, { get(target, key) {
        if (key === 'delete') return async () => { markStarted(); await completed; };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const permit = await admit(env.DB, 'development');
    const deletion = guardedBucket(bucket, env.DB, permit).delete('immutable-old-object');
    await started;
    const state = await enterMaintenance(env.DB, 'next-build', undefined, 1);
    const old = await acquireLease(env.DB, state.taskId);
    await expect(drain(env.DB, old)).rejects.toThrow('EXTERNAL_RESULT_UNCONFIRMED');
    await env.DB.prepare('UPDATE "lfControl" SET leaseUntil=0 WHERE id=1').run();
    const next = await acquireLease(env.DB, state.taskId);
    await expect(drain(env.DB, next)).rejects.toThrow('EXTERNAL_RESULT_UNCONFIRMED');
    markCompleted(); await deletion;
    await drain(env.DB, next);
    expect((await readControl(env.DB)).mode).toBe('migrating');
});

it('keeps an uncertain R2 result pending rather than treating a failed request as no effect', async () => {
    const bucket = new Proxy(env.AVATARS, { get(target, key) {
        if (key === 'delete') return async () => { throw new Error('Response lost'); };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(guardedBucket(bucket, env.DB, await admit(env.DB, 'development')).delete('old-object')).rejects.toThrow('Response lost');
    const state = await enterMaintenance(env.DB, 'next', undefined, 1);
    await expect(drain(env.DB, await acquireLease(env.DB, state.taskId))).rejects.toThrow('EXTERNAL_RESULT_UNCONFIRMED');
});

it('uses independent random sessions that survive installation-token removal and reject unsupported protocols', async () => {
    const control = await readControl(env.DB);
    const token = await issueSession(env.DB, 'cleanup', control.taskId);
    const request = new Request('https://example.test/api/setup/status', { headers: { Cookie: `loginflare.control=${token}` } });
    expect((await readSession(env.DB, request))?.purpose).toBe('cleanup');
    expect(await env.DB.prepare('SELECT hash FROM "lfControlSession"').first('hash')).not.toBe(token);
    await env.DB.prepare('UPDATE "lfControl" SET protocolVersion=2 WHERE id=1').run();
    await expect(ensureControl(bindings)).rejects.toThrow('UNSUPPORTED_CONTROL_PROTOCOL');
});

it('resumes bootstrap if the control tables committed before the initial instance row', async () => {
    await env.DB.prepare('DELETE FROM "lfControl"').run();
    const state = await ensureControl(bindings);
    expect(state.protocolVersion).toBe(1);
    expect(state.instanceId).toBeTruthy();
    expect((await ensureControl(bindings)).instanceId).toBe(state.instanceId);
});

it('allows a nonconflicting recovery proof while uncertain R2 work continues to block migration', async () => {
    const state = await enterMaintenance(env.DB, 'development');
    await env.DB.prepare(`INSERT INTO lfControlEffect (id,scopeId,generation,kind,payload,status,createdAt)
        VALUES ('uncertain-r2','old-request',0,'r2:delete','{}','pending',0)`).run();
    const lease = await acquireLease(env.DB, state.taskId);
    const proof = await beginEffect(env.DB, lease, 'maintenance-challenge', { name: 'LF_CONTROL_CHALLENGE_test' });
    await finishEffect(env.DB, lease, proof, 'done');
    await expect(drain(env.DB, lease)).rejects.toThrow('EXTERNAL_RESULT_UNCONFIRMED');
});
