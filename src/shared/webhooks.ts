export const businessEventTypes = ['user.created', 'email.verified', 'user.updated', 'user.suspended', 'user.restored', 'user.deleted'] as const;
export type BusinessEventType = typeof businessEventTypes[number];
export interface BusinessEvent {
    version: 'v1'; id: string; type: BusinessEventType; occurredAt: string;
    subject: { type: 'user'; id: string }; data: Record<string, unknown>;
}
const encode = (bytes: Uint8Array) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
export async function webhookSignature(secret: string, timestamp: string, body: string) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return 'v1=' + encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`))));
}
export async function verifyWebhook(secret: string, timestamp: string, signature: string, body: string, now = Date.now()): Promise<BusinessEvent> {
    if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^v1=[a-f0-9]{64}$/.test(signature)) throw new Error('INVALID_SIGNATURE');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const mac = Uint8Array.from(signature.slice(3).match(/../g)!, (value) => Number.parseInt(value, 16));
    if (!await crypto.subtle.verify('HMAC', key, mac, new TextEncoder().encode(`${timestamp}.${body}`))) throw new Error('INVALID_SIGNATURE');
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_EVENT');
    const event = value as BusinessEvent;
    if (event.version !== 'v1' || !/^[a-f0-9]{32}$/.test(event.id) || !businessEventTypes.includes(event.type)
        || !event.subject || event.subject.type !== 'user' || typeof event.subject.id !== 'string' || !event.subject.id || event.subject.id.length > 255
        || typeof event.occurredAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.occurredAt) || !Number.isFinite(Date.parse(event.occurredAt))
        || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) throw new Error('INVALID_EVENT');
    const keys = (value: object, expected: string[]) => Object.keys(value).sort().join(',') === [...expected].sort().join(',');
    if (!keys(event, ['version', 'id', 'type', 'occurredAt', 'subject', 'data']) || !keys(event.subject, ['type', 'id'])) throw new Error('INVALID_EVENT');
    const validData = event.type === 'user.created' ? keys(event.data, ['emailVerified']) && typeof event.data.emailVerified === 'boolean'
        : event.type === 'email.verified' ? keys(event.data, ['primary']) && typeof event.data.primary === 'boolean'
        : event.type === 'user.updated' ? keys(event.data, ['fields']) && Array.isArray(event.data.fields) && event.data.fields.length > 0 && event.data.fields.length <= 5
            && new Set(event.data.fields).size === event.data.fields.length && event.data.fields.every((field) => ['name', 'username', 'email', 'image', 'locale'].includes(field))
        : keys(event.data, []);
    if (!validData) throw new Error('INVALID_EVENT');
    return event;
}
