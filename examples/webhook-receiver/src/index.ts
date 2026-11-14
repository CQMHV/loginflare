import { verifyWebhook } from '../../../src/shared/webhooks';
import type { WebhookReceiverBindings } from '../worker-configuration';

async function body(request: Request) {
    if (Number(request.headers.get('content-length') ?? 0) > 16_384) throw new Error('BODY_TOO_LARGE');
    const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
        if (reader) while (true) {
            const part = await reader.read(); if (part.done) break;
            length += part.value.byteLength; if (length > 16_384) throw new Error('BODY_TOO_LARGE');
            chunks.push(part.value);
        }
    } finally { if (reader) void reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
export default {
    async fetch(request: Request, env: WebhookReceiverBindings): Promise<Response> {
        const reply = (code: string, status: number) => Response.json({ code }, { status, headers: { 'Cache-Control': 'no-store' } });
        if (new URL(request.url).pathname !== '/webhooks') return reply('NOT_FOUND', 404);
        if (request.method !== 'POST') return reply('METHOD_NOT_ALLOWED', 405);
        if (!env.WEBHOOK_SECRET || !env.WEBHOOK_SECRET.startsWith('lfwh_')) return reply('NOT_CONFIGURED', 503);
        if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return reply('INVALID_INPUT', 400);
        let event;
        try {
            event = await verifyWebhook(env.WEBHOOK_SECRET, request.headers.get('Loginflare-Timestamp') ?? '', request.headers.get('Loginflare-Signature') ?? '', await body(request));
            if (event.id !== request.headers.get('Loginflare-Event-Id')) return reply('INVALID_EVENT_ID', 400);
        } catch { return reply('INVALID_WEBHOOK', 401); }
        try {
            // Durable inbox is the accepted business effect. Duplicate event IDs never replace it.
            // Add application writes to this same transaction, or process the inbox separately.
            const result = await env.DB.prepare('INSERT INTO "webhookInbox" ("id","type","payload","receivedAt") VALUES (?,?,?,?) ON CONFLICT ("id") DO NOTHING')
                .bind(event.id, event.type, JSON.stringify(event), new Date().toISOString()).run();
            return reply(result.meta.changes ? 'ACCEPTED' : 'DUPLICATE', 200);
        } catch { return reply('INBOX_UNAVAILABLE', 503); }
    },
} satisfies ExportedHandler<WebhookReceiverBindings>;
