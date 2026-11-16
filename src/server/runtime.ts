import { validateConfig, type Env } from './config';
import { advanceInstallation, handleSetup, instanceEnv, readInstallation, setupPage } from './setup';
import { admitRequest } from './request-budget';

type BusinessFetch = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> | Response;
const readMethod = (request: Request) => request.method === 'GET' || request.method === 'HEAD';
const json = (code: string, status: number) => Response.json({ code }, { status, headers: { 'Cache-Control': 'no-store' } });

async function dispatchInner(request: Request, env: Env, ctx: ExecutionContext, business: BusinessFetch): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    if (readMethod(request) && path === '/api/health') return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
    if (readMethod(request) && path === '/api/readiness') {
        try {
            if (env.APP_ENV === 'development') {
                await env.DB.prepare('SELECT 1').first();
                validateConfig(env);
            } else {
                const row = await readInstallation(env.DB);
                if (!row?.completedAt || row.step !== 'ready' || row.origin !== url.origin) throw new Error('Not ready');
                await instanceEnv(env, row, true);
            }
            return Response.json({ status: 'ready' }, { headers: { 'Cache-Control': 'no-store' } });
        } catch {
            return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        }
    }
    if (path === '/maintenance' || /^\/(en-us|zh-cn)\/maintenance\/?$/.test(path) || /^\/api\/maintenance(?:\/|$)/.test(path)) {
        return json('NOT_FOUND', 404);
    }
    const setupApi = path.startsWith('/api/setup/'), setup = setupPage.test(path);
    const local = env.APP_ENV === 'development';
    if (readMethod(request) && (path.startsWith('/assets/') || path === '/favicon.svg'
        || (local && ['/node_modules/', '/@', '/src/'].some((prefix) => path.startsWith(prefix))))) {
        return env.ASSETS.fetch(request);
    }
    if (local) {
        if (setup && readMethod(request)) return env.ASSETS.fetch(new Request(new URL('/', url), request));
        if (setupApi) return json('NOT_FOUND', 404);
        return business(request, env, ctx);
    }
    try {
        const row = await readInstallation(env.DB);
        const canonical = url.origin === row?.origin;
        if (setupApi) return handleSetup(request, env, row);
        if (row?.step === 'ready') {
            if (!canonical && readMethod(request) && !path.startsWith('/api/') && !path.startsWith('/.well-known/')) {
                return Response.redirect(new URL(row.completedAt ? '/' : '/setup', row.origin), 302);
            }
            if (canonical && row.completedAt) {
                if (setup && readMethod(request)) return Response.redirect(new URL('/', row.origin), 302);
                return business(request, await instanceEnv(env, row), ctx);
            }
        }
        if (setup && readMethod(request)) return env.ASSETS.fetch(new Request(new URL('/', url), request));
        if (readMethod(request) && !path.startsWith('/api/') && !path.startsWith('/.well-known/')) {
            return Response.redirect(new URL('/setup', url), 302);
        }
        return json('SETUP_REQUIRED', 503);
    } catch {
        return json('INSTALLATION_UNAVAILABLE', 503);
    }
}

export async function dispatch(request: Request, env: Env, ctx: ExecutionContext, business: BusinessFetch): Promise<Response> {
    let response: Response;
    try {
        response = await admitRequest(request, env) ? await dispatchInner(request, env, ctx, business)
            : new Response(JSON.stringify({ code: 'TOO_MANY_REQUESTS' }), { status: 429, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '60' } });
    } catch {
        console.error(JSON.stringify({ event: 'request_dispatch_failed' }));
        response = json('REQUEST_FAILED', 503);
    }
    const headers = new Headers(response.headers);
    if (response.status === 429 && !headers.has('Retry-After')) headers.set('Retry-After', headers.get('X-Retry-After') ?? '60');
    if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'no-referrer');
    if (!headers.has('X-Content-Type-Options')) headers.set('X-Content-Type-Options', 'nosniff');
    if (!headers.has('X-Frame-Options')) headers.set('X-Frame-Options', 'DENY');
    if (headers.get('Content-Type')?.includes('text/html') && !headers.has('Content-Security-Policy')) {
        headers.set('Cache-Control', 'no-store');
        const development = env.APP_ENV === 'development';
        headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self'${development ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; connect-src 'self'${development ? ' ws://localhost:5173' : ''}; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function runScheduled(env: Env, task: (env: Env) => Promise<unknown>): Promise<void> {
    if (env.APP_ENV === 'development') { await task(env); return; }
    if (env.CF_SETUP_TOKEN) await advanceInstallation(env);
    const row = await readInstallation(env.DB);
    if (row?.completedAt) await task(await instanceEnv(env, row));
}
