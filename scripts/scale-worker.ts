// This entry is bundled only by scripts/scale.mjs into an ignored local folder.
// It is never imported by the production Worker or its build configuration.
import production from 'loginflare:production';
import { maintainDatabase } from '../src/server/maintenance';
import { databaseRateLimit } from '../src/server/rate-limit';
import { pageResult, readPageInput } from '../src/server/pagination';

// Benchmark output is aggregated by the Node harness. Terminal log delivery
// would otherwise dominate local timings; production source remains untouched.
console.log = () => {};

function meteredDatabase(database: D1Database) {
    let statements = 0;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
        get(target, property) {
            if (property === '__scaleNative') return target;
            if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
            const value = Reflect.get(target, property);
            if (['all', 'first', 'run', 'raw'].includes(String(property))) return (...values: unknown[]) => { statements++; return value.apply(target, values); };
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const proxy = new Proxy(database, {
        get(target, property) {
            if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql));
            if (property === 'batch') return (batch: D1PreparedStatement[]) => {
                statements += batch.length;
                return target.batch(batch.map((statement) => Reflect.get(statement, '__scaleNative') ?? statement));
            };
            const value = Reflect.get(target, property);
            if (property === 'exec') return (...values: unknown[]) => { statements++; return value.apply(target, values); };
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    return { database: proxy, count: () => statements };
}

export default {
    async fetch(request: Request, bindings: Cloudflare.Env & { SCALE_ACCESS_KEY: string }, context: ExecutionContext) {
        if (!bindings.SCALE_ACCESS_KEY || request.headers.get('x-scale-key') !== bindings.SCALE_ACCESS_KEY) return new Response('Isolated benchmark only', { status: 403 });
        const meter = meteredDatabase(bindings.DB);
        const env = {
            ...bindings, DB: meter.database,
            EMAIL: { async send() { return { messageId: 'isolated-scale-mail' }; } },
            ASSETS: { async fetch() { return new Response('Scale test asset stub'); } },
        };
        const url = new URL(request.url);
        let response: Response;
        if (url.pathname === '/__scale/rate') {
            const result = await databaseRateLimit(env.DB).consume(`scale-lane:${url.searchParams.get('lane') ?? '0'}`, { window: 60, max: 1_000_000_000 });
            response = Response.json(result);
        } else if (url.pathname === '/__scale/maintenance') {
            response = Response.json(await maintainDatabase(env));
        } else if (url.pathname === '/__scale/deep-cursor') {
            const anchor = await env.DB.prepare('SELECT "id", "createdAt" FROM "user" WHERE "id" = ?').bind(url.searchParams.get('id')).first<{ id: string; createdAt: string }>();
            if (!anchor) return new Response('Missing fixture', { status: 400 });
            const rows = await env.DB.prepare('SELECT "id", "createdAt" FROM "user" WHERE ("createdAt", "id") <= (?, ?) ORDER BY "createdAt" DESC, "id" DESC LIMIT 21').bind(anchor.createdAt, anchor.id).all<{ id: string; createdAt: string }>();
            const input = await readPageInput(new URL('/api/admin/users', bindings.AUTH_URL), bindings.BETTER_AUTH_SECRET, 'users', 'administrators', ['id', 'username', 'email']);
            response = Response.json(await pageResult(rows.results, input, bindings.BETTER_AUTH_SECRET, (row) => row));
        } else {
            response = await production.fetch(request, env, context);
        }
        const headers = new Headers(response.headers);
        headers.set('x-scale-sql-count', String(meter.count()));
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
};
