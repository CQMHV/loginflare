import { connectManagement, ManagementApiError } from './client';
import type { ManagementWorkerBindings } from '../worker-configuration';

/** A bounded latest-page check, not an exactly-once audit export pipeline. */
export async function pollAuditLogs(env: ManagementWorkerBindings) {
    const management = await connectManagement(env, ['management:audit:read']);
    const page = await management.listAuditLogs({ limit: 100 });
    return { count: page.items.length, hasMore: page.pageInfo.nextCursor !== null };
}

export default {
    fetch(request: Request) {
        const path = new URL(request.url).pathname;
        return Response.json(path === '/health' && request.method === 'GET' ? { status: 'ok' } : { error: 'not_found' }, {
            status: path === '/health' && request.method === 'GET' ? 200 : 404,
            headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
        });
    },
    async scheduled(_controller, env) {
        try {
            const result = await pollAuditLogs(env);
            console.log(JSON.stringify({ event: 'management_audit_poll', ...result }));
        } catch (error) {
            // No token, secret, raw body, URL, user or application data is logged.
            const code = error instanceof ManagementApiError ? error.code : 'MANAGEMENT_REQUEST_FAILED';
            console.error(JSON.stringify({ event: 'management_audit_poll_failed', code }));
            throw new Error('Management audit poll failed');
        }
    },
} satisfies ExportedHandler<ManagementWorkerBindings>;
