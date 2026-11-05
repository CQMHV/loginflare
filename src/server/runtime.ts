import type { Env } from './config';
import {
    ControlError, acquireLease, admit, admitAuthorization, applicationBuild, applicationBuildTime, controlCookie, drain, ensureControl, enterMaintenance,
    fencedBatch, guardedBucket, guardedDatabase, hashToken, readControl, readSession, readValue, releaseLease,
    releasePermit, renewLease, valueStatement, type ControlRecord, type ControlSession, type Permit,
} from './control';
import { handleSetup } from './setup';
import { advanceUpgrade, bundleHash, initialUpgradeProgress, type UpgradeProgress } from './upgrade';

type BusinessFetch = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> | Response;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
} });
const cookie = (token: string, env: Env) => `${controlCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800${env.APP_ENV === 'development' ? '' : '; Secure'}`;
function sourceAllowed(request: Request): boolean { return request.headers.get('origin') === new URL(request.url).origin; }
function sessionAllowed(session: ControlSession | null, control: ControlRecord): session is ControlSession {
    return !!session && session.purpose === 'maintenance' && session.taskId === control.taskId;
}

async function maintenance(request: Request, env: Env, control: ControlRecord, ctx: ExecutionContext): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/maintenance/')) return null;
    let session = await readSession(env.DB, request);
    if (path === '/api/maintenance/status' && request.method === 'GET' && control.mode === 'ready'
        && !control.cleanupPending && control.buildId !== applicationBuild(env) && applicationBuildTime(env) > control.buildTime) {
        // Status is also the remote CLI's entry point. Do not mistake the last
        // build's completed checkpoint for proof that this build is current.
        const previous = sessionAllowed(session, control) ? session.hash : undefined;
        control = await enterMaintenance(env.DB, applicationBuild(env), previous, applicationBuildTime(env));
        session = await readSession(env.DB, request);
    }
    const authorized = sessionAllowed(session, control);
    if (path === '/api/maintenance/status' && request.method === 'GET') {
        return json({ mode: control.mode, installed: control.installation === 'complete', authenticated: authorized,
            ...(authorized ? { taskId: control.taskId, buildId: applicationBuild(env), runtimeVersion: env.CF_VERSION_METADATA?.id ?? 'local',
                configRevision: env.LOGINFLARE_CONFIG_REVISION ?? '', cleanupPending: !!control.cleanupPending,
                progress: await readValue(env.DB, `upgrade:${control.taskId}`),
                backupConfirmed: !!await readValue(env.DB, `backup:${control.taskId}`),
                error: (await readValue<{ code: string }>(env.DB, `upgrade-error:${control.taskId}`))?.code,
                errorDetail: await readValue(env.DB, `upgrade-error:${control.taskId}`),
                adoptionRequired: control.mode === 'adoption' } : {}) });
    }
    if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    if (!sourceAllowed(request)) return json({ code: 'INVALID_ORIGIN' }, 403);
    if (path === '/api/maintenance/authorize') {
        if (!['ready', 'draining'].includes(control.mode)) throw new ControlError('MAINTENANCE_RECOVERY_REQUIRED', 401);
        // A freshly deployed build can authorize the task using the previous
        // schema, before any DDL. After the barrier, recovery uses write proof.
        const permit = await admitAuthorization(env.DB, control.buildId);
        try {
            const guarded = { ...env, DB: guardedDatabase(env.DB, permit) };
            const { browserRequest } = await import('./browser-accounts');
            const { createAuth } = await import('./auth');
            return await browserRequest(request, guarded, async (resolved) => {
                const identity = await createAuth(guarded).api.getSession({ headers: resolved.headers, query: { disableRefresh: true } });
                if (!identity || identity.user.role !== 'admin' || identity.user.banned || !identity.user.emailVerified) return json({ code: 'FORBIDDEN' }, 403);
                const token = crypto.randomUUID() + crypto.randomUUID();
                const granted = await guarded.DB.prepare(`INSERT INTO "lfControlSession" (hash,purpose,taskId,expiresAt)
                    SELECT ?,'maintenance',c.taskId,CAST(unixepoch('subsec') * 1000 AS INTEGER)+1800000
                    FROM "lfControl" c JOIN "user" u ON u.id=? JOIN "session" s ON s.userId=u.id AND s.id=?
                    WHERE c.id=1 AND c.taskId=? AND c.mode IN ('ready','draining')
                    AND NOT EXISTS (SELECT 1 FROM "lfControlValue" WHERE key='drained:'||c.taskId)
                    AND u.role='admin' AND COALESCE(u.banned,0)=0
                    AND u.emailVerified=1 AND s.expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now') RETURNING hash`)
                    .bind(await hashToken(token), identity.user.id, identity.session.id, control.taskId).first();
                if (!granted) return json({ code: 'FORBIDDEN' }, 403);
                const response = json({ authenticated: true }); response.headers.set('Set-Cookie', cookie(token, env)); return response;
            });
        } catch (error) {
            if (error instanceof ControlError) throw error;
            // An old auth schema may not be readable by this build. Do not
            // bootstrap ordinary authentication through a partial migration.
            throw new ControlError('MAINTENANCE_RECOVERY_REQUIRED', 401);
        } finally { await releasePermit(env.DB, permit); }
    }
    if (!authorized || !session) return json({ code: 'CONTROL_SESSION_REQUIRED' }, 401);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ code: 'INVALID_INPUT' }, 400);
    const reader = request.body?.getReader();
    let text = ''; let size = 0;
    const decoder = new TextDecoder();
    if (reader) try {
        while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > 16_384) { await reader.cancel(); return json({ code: 'PAYLOAD_TOO_LARGE' }, 413); }
            text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
    } finally { reader.releaseLock(); }
    let body: unknown;
    try { body = JSON.parse(text); } catch { return json({ code: 'INVALID_INPUT' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ code: 'INVALID_INPUT' }, 400);
    const input = body as Record<string, unknown>;
    if (path === '/api/maintenance/enter') {
        if (input.backupConfirmed !== true) return json({ code: 'BACKUP_CONFIRMATION_REQUIRED' }, 400);
        if (control.cleanupPending) throw new ControlError('SETUP_CLEANUP_REQUIRED');
        if (control.mode === 'adoption') {
            // No platform API currently proves that legacy uninstrumented
            // invocations have drained. A checkbox/timer must not bypass this.
            return json({ code: 'VERIFIED_LEGACY_DRAIN_REQUIRED', releaseBlocker: true }, 409);
        }
        const state = await enterMaintenance(env.DB, applicationBuild(env), session.hash, applicationBuildTime(env));
        if (!['draining', 'migrating', 'checking', 'failed'].includes(state.mode)) throw new ControlError('NO_ACTIVE_UPGRADE');
        const lease = await acquireLease(env.DB, state.taskId);
        const assertion = crypto.randomUUID();
        try { await fencedBatch(env.DB, lease, [env.DB.prepare(`INSERT INTO "lfControlFence" (id,valid)
            SELECT ?,CASE WHEN EXISTS (SELECT 1 FROM "lfControlSession" WHERE hash=? AND purpose='maintenance'
            AND taskId=? AND expiresAt>CAST(unixepoch('subsec')*1000 AS INTEGER)) THEN 1 ELSE 0 END`)
            .bind(assertion, session.hash, state.taskId), valueStatement(env.DB, `backup:${state.taskId}`, true),
            env.DB.prepare('DELETE FROM "lfControlFence" WHERE id=?').bind(assertion)]); }
        finally { await releaseLease(env.DB, lease); }
        return json({ mode: state.mode, taskId: state.taskId, backupConfirmed: true });
    }
    if (path !== '/api/maintenance/advance') return json({ code: 'NOT_FOUND' }, 404);
    if (!['draining', 'migrating', 'checking', 'failed'].includes(control.mode)) return json({ code: 'NO_ACTIVE_UPGRADE' }, 409);
    if (!await readValue<boolean>(env.DB, `backup:${control.taskId}`)) return json({ code: 'BACKUP_CONFIRMATION_REQUIRED' }, 409);
    const lease = await acquireLease(env.DB, control.taskId);
    const timer = setInterval(() => { void renewLease(env.DB, lease).catch(() => { /* Commit fencing is authoritative. */ }); }, 15_000);
    try {
        const key = `upgrade:${control.taskId}`;
        const progress = await readValue<UpgradeProgress>(env.DB, key) ?? initialUpgradeProgress();
        if (control.targetBuildId !== applicationBuild(env)) {
            // A newer repair build may resume the exact same immutable package.
            // An old isolate or a changed package cannot retarget this task.
            if (applicationBuildTime(env) <= control.targetBuildTime || progress.bundleHash !== bundleHash) throw new ControlError('UPGRADE_BUILD_CHANGED');
            await fencedBatch(env.DB, lease, [env.DB.prepare('UPDATE "lfControl" SET targetBuildId=?,targetBuildTime=?,revision=revision+1 WHERE id=1')
                .bind(applicationBuild(env), applicationBuildTime(env))]);
        }
        if (!await readValue<boolean>(env.DB, `drained:${control.taskId}`)) await drain(env.DB, lease);
        if (progress.phase === 'complete') {
            // The last checkpoint may have committed even if its response was
            // lost. Finalization is idempotent and never reruns historical SQL.
            await fencedBatch(env.DB, lease, [env.DB.prepare(`UPDATE "lfControl" SET mode='ready',buildId=targetBuildId,
                buildTime=targetBuildTime,revision=revision+1 WHERE id=1`), valueStatement(env.DB, `upgrade-error:${control.taskId}`, null)]);
            return json({ mode: 'ready', progress });
        }
        const next = await advanceUpgrade({ db: env.DB, progress, confirmUnverifiableKey: input.confirmUnverifiableKey === true,
            commit: async (statements, value) => fencedBatch(env.DB, lease, [...statements, valueStatement(env.DB, key, value),
                valueStatement(env.DB, `upgrade-error:${control.taskId}`, null),
                env.DB.prepare(`UPDATE "lfControl" SET mode=?,buildId=CASE WHEN ?='complete' THEN targetBuildId ELSE buildId END,
                    buildTime=CASE WHEN ?='complete' THEN targetBuildTime ELSE buildTime END, revision=revision+1 WHERE id=1`)
                    .bind(value.phase === 'complete' ? 'ready' : ['schema', 'columns', 'rows', 'avatars', 'origins'].includes(value.phase) ? 'checking' : 'migrating', value.phase, value.phase)]),
        }, env.BETTER_AUTH_SECRET);
        return json({ mode: next.phase === 'complete' ? 'ready' : 'migrating', progress: next });
    } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'UPGRADE_STEP_FAILED';
        const detail = { code, migration: error instanceof Error && 'migration' in error ? error.migration : null,
            result: ['UPGRADE_STEP_FAILED', 'MIGRATION_COMMIT_UNCONFIRMED'].includes(code) ? 'commit-unconfirmed'
                : code === 'MIGRATION_FILE_ROLLED_BACK' ? 'current-file-rolled-back' : 'validation-failed', previousFilesRemainCommitted: true };
        await fencedBatch(env.DB, lease, [valueStatement(env.DB, `upgrade-error:${control.taskId}`, detail),
            env.DB.prepare('UPDATE "lfControl" SET mode=\'failed\',revision=revision+1 WHERE id=1')]).catch(() => {});
        return json({ ...detail, progress: await readValue(env.DB, `upgrade:${control.taskId}`) }, error instanceof ControlError ? error.status : 409);
    } finally { clearInterval(timer); await releaseLease(env.DB, lease); }
}

/** A permit lives until all scheduled request work has settled. Only its own
 * terminal record can disappear; wall-clock expiry is never drain evidence. */
function trackedContext(ctx: ExecutionContext, tasks: Promise<unknown>[]): ExecutionContext {
    return new Proxy(ctx, { get(target, property) {
        if (property === 'waitUntil') return (promise: Promise<unknown>) => { tasks.push(promise); target.waitUntil(promise); };
        const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
}
async function finishTasks(db: D1Database, permit: Permit, tasks: Promise<unknown>[]): Promise<void> {
    // Tasks can enqueue further tasks; don't release on an initial snapshot.
    let index = 0;
    while (index < tasks.length) { const current = tasks.slice(index); index = tasks.length; await Promise.allSettled(current); }
    await releasePermit(db, permit);
}

async function dispatchInner(request: Request, env: Env, ctx: ExecutionContext, business: BusinessFetch): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/assets/') || path === '/favicon.svg' || (env.APP_ENV === 'development' && ['/node_modules/', '/@', '/src/'].some((prefix) => path.startsWith(prefix)))) {
        return env.ASSETS.fetch(request);
    }
    // Even an unavailable database or an unsupported control protocol must not
    // prevent the independent recovery shell from opening.
    if (path === '/setup' || path === '/maintenance' || /^\/(en-us|zh-cn)\/(setup|maintenance)(\/verified)?\/?$/.test(path)) {
        if (!['GET', 'HEAD'].includes(request.method)) return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
        return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
    }
    try {
        let control = await ensureControl(env);
        const handled = await handleSetup(request, env, ctx);
        if (handled) return handled;
        const maintenanceResponse = await maintenance(request, env, control, ctx);
        if (maintenanceResponse) return maintenanceResponse;
        if (control.mode === 'ready' && control.buildId !== applicationBuild(env)) {
            if (control.cleanupPending) throw new ControlError('SETUP_CLEANUP_REQUIRED', 503);
            if (!applicationBuildTime(env) || applicationBuildTime(env) <= control.buildTime) throw new ControlError('STALE_APPLICATION_BUILD', 503);
            control = await enterMaintenance(env.DB, applicationBuild(env), undefined, applicationBuildTime(env));
        }
        if (path === '/api/health') return json({ status: control.mode === 'ready' ? 'ok' : 'maintenance' }, control.mode === 'ready' ? 200 : 503);
        if (control.mode !== 'ready') {
            if (path.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method)) return json({ code: control.mode === 'setup' ? 'SETUP_REQUIRED' : 'MAINTENANCE_REQUIRED' }, 503);
            const locale = path.startsWith('/zh-cn') ? 'zh-cn' : 'en-us';
            return Response.redirect(new URL(`/${locale}/${control.mode === 'setup' ? 'setup' : 'maintenance'}`, request.url), 302);
        }
        if (control.configRevision && control.configRevision !== env.LOGINFLARE_CONFIG_REVISION) throw new ControlError('CONFIGURATION_NOT_OBSERVED', 503);
        const permit = await admit(env.DB, applicationBuild(env));
        const tasks: Promise<unknown>[] = [];
        const scoped = { ...env, DB: guardedDatabase(env.DB, permit), AVATARS: guardedBucket(env.AVATARS, env.DB, permit) };
        try { return await business(request, scoped, trackedContext(ctx, tasks)); }
        finally {
            if (tasks.length) ctx.waitUntil(finishTasks(env.DB, permit, tasks));
            else await releasePermit(env.DB, permit);
        }
    } catch (error) {
        if (!(error instanceof ControlError)) console.error(JSON.stringify({ event: 'control_unavailable', code: 'CONTROL_UNAVAILABLE' }));
        return json({ code: error instanceof ControlError ? error.code : 'CONTROL_UNAVAILABLE' }, error instanceof ControlError ? error.status : 503);
    }
}

export async function dispatch(request: Request, env: Env, ctx: ExecutionContext, business: BusinessFetch): Promise<Response> {
    const response = await dispatchInner(request, env, ctx, business);
    const headers = new Headers(response.headers);
    if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'no-referrer');
    if (!headers.has('X-Content-Type-Options')) headers.set('X-Content-Type-Options', 'nosniff');
    if (!headers.has('X-Frame-Options')) headers.set('X-Frame-Options', 'DENY');
    const controlPage = /^\/(?:setup|maintenance)$|^\/(en-us|zh-cn)\/(setup|maintenance)(\/verified)?\/?$/.test(new URL(request.url).pathname);
    if ((controlPage || headers.get('Content-Type')?.includes('text/html')) && !headers.has('Content-Security-Policy')) {
        headers.set('Cache-Control', 'no-store');
        // The independent shell bypasses the application's header middleware,
        // including the allowances required by Vite's React Refresh preamble.
        const development = env.APP_ENV === 'development';
        headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self' https://challenges.cloudflare.com${development ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; connect-src 'self' https://challenges.cloudflare.com${development ? ' ws://localhost:5173' : ''}; frame-src https://challenges.cloudflare.com; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function scheduledControl(env: Env, ctx: ExecutionContext, task: (env: Env) => Promise<unknown>): Promise<void> {
    const control = await ensureControl(env);
    if (control.mode !== 'ready' || control.buildId !== applicationBuild(env) || env.LOGINFLARE_TRANSITION === '1'
        || (control.configRevision && control.configRevision !== env.LOGINFLARE_CONFIG_REVISION)) return;
    const permit = await admit(env.DB, applicationBuild(env));
    try { await task({ ...env, DB: guardedDatabase(env.DB, permit), AVATARS: guardedBucket(env.AVATARS, env.DB, permit) }); }
    finally { await releasePermit(env.DB, permit); }
}
