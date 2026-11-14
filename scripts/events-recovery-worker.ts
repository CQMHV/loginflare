// Local recovery harness only; never imported by the application build.
import { deliverWebhooks } from '../src/server/webhook-delivery';
import receiver from '../examples/webhook-receiver/src/index';
import { exportAudit } from '../examples/audit-export/src/index';
import { interceptSql } from '../tests/sql-race';
import type { Env } from '../src/server/config';

export default {
    async fetch(request: Request, env: Env & { INBOX: D1Database; ARCHIVE: D1Database; RECOVERY_KEY: string; WEBHOOK_SECRET: string; AUTH_ISSUER: string; MACHINE_CLIENT_ID: string; MACHINE_CLIENT_SECRET: string }) {
        if (!env.RECOVERY_KEY || request.headers.get('X-Recovery-Key') !== env.RECOVERY_KEY || request.method !== 'POST') return new Response('Isolated recovery only', { status: 403 });
        switch (new URL(request.url).pathname) {
            case '/__receive': return receiver.fetch(new Request('https://receiver.example.com/webhooks', request), { DB: env.INBOX, WEBHOOK_SECRET: env.WEBHOOK_SECRET });
            case '/__lost-completion': {
                const fault = interceptSql(env.DB, /UPDATE "webhookAttempt" SET "outcome" = \?/, async () => { throw new Error('SIMULATED_COMPLETION_WRITE_LOSS'); });
                try { await deliverWebhooks({ ...env, DB: fault.proxy }); } catch { return Response.json({ code: 'SIMULATED_COMPLETION_WRITE_LOSS' }, { status: 503 }); }
                throw new Error('Expected lost completion was not exercised');
            }
            case '/__deliver': return Response.json(await deliverWebhooks(env));
            case '/__archive': {
                try { return Response.json(await exportAudit({ DB: env.ARCHIVE, AUTH_ISSUER: env.AUTH_ISSUER, MACHINE_CLIENT_ID: env.MACHINE_CLIENT_ID, MACHINE_CLIENT_SECRET: env.MACHINE_CLIENT_SECRET })); }
                catch { return Response.json({ code: 'ARCHIVE_INTERRUPTED' }, { status: 503 }); }
            }
            default: return new Response('Not found', { status: 404 });
        }
    },
};
