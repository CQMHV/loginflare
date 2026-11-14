export type AuthFailure = 'PASSKEY_NOT_AVAILABLE' | 'TURNSTILE_UNAVAILABLE' | 'DATABASE_ERROR' | 'AUTH_INTERNAL_ERROR';
export interface AuthRequestState { failed: boolean; failure?: AuthFailure }

/** Classify internal errors without retaining SQL, parameters, URLs or credentials. */
export function classifyAuthFailure(error: unknown): AuthFailure {
    const seen = new Set<object>();
    let database = false;
    for (let depth = 0; depth < 6 && error && typeof error === 'object' && !seen.has(error); depth++) {
        seen.add(error);
        const item = error as { message?: unknown; cause?: unknown };
        const message = typeof item.message === 'string' ? item.message : '';
        if (/^(?:D1_ERROR:\s*)?PASSKEY_NOT_AVAILABLE:\s*SQLITE_CONSTRAINT(?:_TRIGGER)?(?:\s+\(extended:\s*SQLITE_CONSTRAINT_TRIGGER\))?$/.test(message)) return 'PASSKEY_NOT_AVAILABLE';
        database ||= message.startsWith('D1_ERROR:') || /:\s*SQLITE_[A-Z_]+(?:\s|$)/.test(message);
        error = item.cause;
    }
    return database ? 'DATABASE_ERROR' : 'AUTH_INTERNAL_ERROR';
}
