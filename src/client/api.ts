import type { Locale } from '../shared/locales';

export interface User {
    id: string;
    name: string;
    username?: string | null;
    email: string;
    emailVerified: boolean;
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
}

export class ApiError extends Error {
    constructor(public code: string, public status: number) {
        super(code);
    }
}

export async function request<T>(path: string, body?: unknown): Promise<T> {
    return fetchJson<T>(`/api/auth${path}`, body);
}

export async function fetchJson<T>(path: string, body?: unknown, captchaToken?: string, method?: 'GET' | 'POST' | 'PATCH'): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (captchaToken) headers['x-captcha-response'] = captchaToken;

    let response: Response;
    try {
        response = await fetch(path, {
            method: method ?? (body === undefined ? 'GET' : 'POST'),
            credentials: 'same-origin',
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new ApiError('NETWORK_ERROR', 0);
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const code = payload && typeof payload === 'object' && 'code' in payload
            && typeof payload.code === 'string' ? payload.code
            : response.status === 429 ? 'TOO_MANY_REQUESTS'
            : response.status === 401 ? 'UNAUTHORIZED'
            : response.status === 403 ? 'FORBIDDEN' : 'UNKNOWN_ERROR';
        throw new ApiError(code, response.status);
    }
    return payload as T;
}

export async function captchaRequest<T>(path: string, body: unknown, token: string): Promise<T> {
    return fetchJson<T>(`/api/auth${path}`, body, token);
}

export function errorCode(error: unknown): string {
    return error instanceof ApiError ? error.code : 'UNKNOWN_ERROR';
}
