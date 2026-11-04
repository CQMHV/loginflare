import { applicationCreateSchema } from '../../../src/shared/application-validation';
import { managementResource, type ManagementScope } from '../../../src/shared/machines';
import type { z } from 'zod';
import type { ManagementWorkerBindings } from '../worker-configuration';

export { managementResource, type ManagementScope };
export type LoginApplicationInput = z.infer<typeof applicationCreateSchema>;
export interface ManagedApplication {
    clientId: string;
    name: string;
    type: 'web' | 'spa';
    clientSecret?: string;
}
export interface AuditPage {
    items: Array<{ id: string; event: string; outcome: 'success' | 'failure'; createdAt: string }>;
    pageInfo: { nextCursor: string | null; previousCursor: string | null };
}
export class ManagementApiError extends Error {
    constructor(readonly code: string, readonly status: number, readonly writeMayHaveCompleted = false) { super(code); }
}
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safeCode(value: unknown, fallback: string): string {
    return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(value) ? value : fallback;
}
function issuerConfiguration(env: ManagementWorkerBindings) {
    let issuer: URL;
    try { issuer = new URL(env.AUTH_ISSUER); }
    catch { throw new ManagementApiError('INVALID_CONFIGURATION', 0); }
    const loopback = issuer.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname);
    if ((issuer.protocol !== 'https:' && !loopback) || issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== '/api/auth'
        || env.AUTH_ISSUER !== env.AUTH_ISSUER.trim() || !env.MACHINE_CLIENT_ID || !env.MACHINE_CLIENT_SECRET
        || env.MACHINE_CLIENT_ID.startsWith('replace-') || env.MACHINE_CLIENT_SECRET.startsWith('replace-')) throw new ManagementApiError('INVALID_CONFIGURATION', 0);
    return { issuer: env.AUTH_ISSUER, api: `${issuer.origin}/api/management/v1` };
}
async function json(response: Response, maximum: number, writing: boolean): Promise<unknown> {
    const reader = response.body?.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maximum) { await reader.cancel(); throw new ManagementApiError('RESPONSE_TOO_LARGE', response.status, writing); }
        chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new ManagementApiError('INVALID_RESPONSE', response.status, writing); }
    if (!response.ok) {
        const fallback = response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : 'MANAGEMENT_REQUEST_FAILED';
        throw new ManagementApiError(record(payload) ? safeCode(payload.code ?? payload.error, fallback) : fallback, response.status, writing && response.status >= 500);
    }
    if (!response.headers.get('content-type')?.includes('application/json')) throw new ManagementApiError('INVALID_RESPONSE', response.status, writing);
    return payload;
}
async function exchange(env: ManagementWorkerBindings, issuer: string, scopes: ManagementScope[]) {
    const scope = [...new Set(scopes)].sort().join(' ');
    if (!scope) throw new ManagementApiError('SCOPE_REQUIRED', 0);
    let response: Response;
    try {
        response = await fetch(`${issuer}/oauth2/token`, {
            method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
            headers: {
                Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: `Basic ${btoa(`${encodeURIComponent(env.MACHINE_CLIENT_ID)}:${encodeURIComponent(env.MACHINE_CLIENT_SECRET)}`)}`,
            },
            body: new URLSearchParams({ grant_type: 'client_credentials', resource: managementResource, scope }),
        });
    } catch { throw new ManagementApiError('TOKEN_SERVICE_UNAVAILABLE', 0); }
    const value = await json(response, 16_384, false);
    if (!record(value) || typeof value.access_token !== 'string' || value.access_token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.access_token)
        || value.token_type !== 'Bearer' || typeof value.expires_in !== 'number' || !Number.isInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 300
        || typeof value.scope !== 'string' || [...new Set(value.scope.split(' ').filter(Boolean))].sort().join(' ') !== scope
        || value.refresh_token !== undefined || value.id_token !== undefined) throw new ManagementApiError('INVALID_TOKEN_RESPONSE', response.status);
    return { value: value.access_token, expiresAt: Date.now() + value.expires_in * 1000 };
}

/** Construct inside one trusted invocation; no token, secret, or pending request is cached globally. */
export async function connectManagement(env: ManagementWorkerBindings, scopes: ManagementScope[]) {
    const { issuer, api } = issuerConfiguration(env);
    const requested = new Set(scopes), token = await exchange(env, issuer, scopes);
    async function request(path: string, required: ManagementScope, body?: unknown, method: 'GET' | 'POST' | 'PUT' = 'GET') {
        if (!requested.has(required)) throw new ManagementApiError('MISSING_SCOPE', 403);
        if (token.expiresAt <= Date.now()) throw new ManagementApiError('TOKEN_EXPIRED', 401);
        let response: Response;
        try {
            response = await fetch(`${api}${path}`, {
                method, redirect: 'manual', signal: AbortSignal.timeout(5000),
                headers: { Accept: 'application/json', Authorization: `Bearer ${token.value}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            });
        } catch { throw new ManagementApiError('MANAGEMENT_SERVICE_UNAVAILABLE', 0, method !== 'GET'); }
        // Writes are never retried: a lost response can follow a committed change.
        return json(response, 262_144, method !== 'GET');
    }
    return {
        async createLoginApplication(input: LoginApplicationInput): Promise<ManagedApplication> {
            const data = applicationCreateSchema.safeParse(input);
            if (!data.success) throw new ManagementApiError('INVALID_APPLICATION', 400);
            const result = await request('/applications', 'management:applications:write', data.data, 'POST');
            if (!record(result) || typeof result.clientId !== 'string' || !result.clientId || typeof result.name !== 'string'
                || result.type !== 'web' && result.type !== 'spa' || result.type === 'web' && typeof result.clientSecret !== 'string') throw new ManagementApiError('INVALID_RESPONSE', 200, true);
            return { clientId: result.clientId, name: result.name, type: result.type, ...(typeof result.clientSecret === 'string' ? { clientSecret: result.clientSecret } : {}) };
        },
        async replaceUserRoles(userId: string, roleIds: string[]): Promise<void> {
            if (!userId || userId.length > 255 || /[\u0000-\u001f\u007f]/.test(userId) || roleIds.length > 100 || new Set(roleIds).size !== roleIds.length
                || roleIds.some((roleId) => !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(roleId))) throw new ManagementApiError('INVALID_ROLE_ASSIGNMENT', 400);
            await request(`/users/${encodeURIComponent(userId)}/roles`, 'management:role-assignments:write', { roleIds }, 'PUT');
        },
        async listAuditLogs(options: { limit?: number; cursor?: string } = {}): Promise<AuditPage> {
            const limit = options.limit ?? 20;
            if (!Number.isInteger(limit) || limit < 1 || limit > 100 || options.cursor && options.cursor.length > 2048) throw new ManagementApiError('INVALID_PAGINATION', 400);
            const query = new URLSearchParams({ limit: String(limit), ...(options.cursor ? { cursor: options.cursor } : {}) });
            const result = await request(`/audit-logs?${query}`, 'management:audit:read');
            if (!record(result) || !Array.isArray(result.items) || result.items.length > limit || !result.items.every((item) => record(item) && typeof item.id === 'string' && typeof item.event === 'string'
                && ['success', 'failure'].includes(String(item.outcome)) && typeof item.createdAt === 'string') || !record(result.pageInfo)
                || ![result.pageInfo.nextCursor, result.pageInfo.previousCursor].every((cursor) => cursor === null || typeof cursor === 'string' && cursor.length <= 2048)) throw new ManagementApiError('INVALID_RESPONSE', 200);
            return {
                items: result.items.map((item) => ({ id: String(item.id), event: String(item.event), outcome: item.outcome === 'success' ? 'success' : 'failure', createdAt: String(item.createdAt) })),
                pageInfo: { nextCursor: typeof result.pageInfo.nextCursor === 'string' ? result.pageInfo.nextCursor : null, previousCursor: typeof result.pageInfo.previousCursor === 'string' ? result.pageInfo.previousCursor : null },
            };
        },
    };
}
