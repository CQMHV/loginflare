import type { Locale } from '../shared/locales';
import { browserContextHeaders, browserContextVersion, clearBrowserFlow } from './browser-context';

export interface User {
    id: string;
    name: string;
    username?: string | null;
    image?: string | null;
    email: string;
    emailVerified: boolean;
    twoFactorEnabled?: boolean;
    role?: string | null;
    locale?: Locale | null;
    banned?: boolean | null;
    banReason?: string | null;
    createdAt: string;
}

export interface Session {
    id: string;
    token: string;
    userId: string;
    createdAt: string;
    expiresAt: string;
    ipAddress?: string | null;
    userAgent?: string | null;
}

export interface Identity {
    user: User;
    session: Session;
    browserAccountId?: string;
}

export class ApiError extends Error {
    constructor(public code: string, public status: number, public retryAfterMs = 0, public fieldErrors?: Record<string, string>) {
        super(code);
    }
}

export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return fetchJson<T>(`/api/auth${path}`, body, undefined, undefined, signal);
}

export async function fetchJson<T>(path: string, body?: unknown, captchaToken?: string, method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', signal?: AbortSignal): Promise<T> {
    const version = browserContextVersion();
    const headers: Record<string, string> = { Accept: 'application/json', ...browserContextHeaders() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (captchaToken) headers['x-captcha-response'] = captchaToken;

    let response: Response;
    try {
        response = await fetch(path, {
            method: method ?? (body === undefined ? 'GET' : 'POST'),
            credentials: 'same-origin',
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
        });
    } catch (cause) {
        if (signal?.aborted) throw cause;
        throw new ApiError('NETWORK_ERROR', 0);
    }

    const publicRequest = ['/api/config', '/api/branding', '/api/social/providers', '/api/health'].includes(path.split('?', 1)[0]);
    const current = () => publicRequest || browserContextVersion() === version;
    try {
        const payload = await readResponse<T>(response, current);
        if (!publicRequest && payload && typeof payload === 'object' && 'browserFlowComplete' in payload && payload.browserFlowComplete === true) clearBrowserFlow();
        return payload;
    } catch (cause) {
        if (!current()) throw new ApiError('BROWSER_FLOW_EXPIRED', 409);
        if (!publicRequest && cause instanceof ApiError && cause.code === 'BROWSER_FLOW_EXPIRED') clearBrowserFlow();
        throw cause;
    }
}

export async function readResponse<T>(response: Response, current: () => boolean = () => true): Promise<T> {
    const payload: unknown = await response.json().catch(() => null);
    if (!current()) throw new ApiError('BROWSER_FLOW_EXPIRED', 409);
    if (!response.ok) {
        const code = payload && typeof payload === 'object' && 'code' in payload
            && typeof payload.code === 'string' ? payload.code
            : response.status === 429 ? 'TOO_MANY_REQUESTS'
            : response.status === 401 ? 'UNAUTHORIZED'
            : response.status === 403 ? 'FORBIDDEN' : 'UNKNOWN_ERROR';
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
        const fields = payload && typeof payload === 'object' && 'fieldErrors' in payload ? payload.fieldErrors : undefined;
        const fieldErrors = fields && typeof fields === 'object' && !Array.isArray(fields)
            ? Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === 'string')) as Record<string, string> : undefined;
        throw new ApiError(code, response.status, Math.max(0, retryAfterMs || 0), fieldErrors);
    }
    return payload as T;
}

export async function captchaRequest<T>(path: string, body: unknown, token: string): Promise<T> {
    return fetchJson<T>(`/api/auth${path}`, body, token);
}

export function errorCode(error: unknown): string {
    return error instanceof ApiError ? error.code : 'UNKNOWN_ERROR';
}
