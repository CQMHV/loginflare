import { createAuthClient } from 'better-auth/client';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { ApiError } from './api';

const authClient = createAuthClient({
    basePath: '/api/auth',
    plugins: [oauthProviderClient()],
});

// Preserve the provider's declared query segments verbatim when moving between
// account pages. Page-only email/reset-token parameters are not OAuth state.
// The provider client builds request bodies; only the server verifies signatures.
export function oauthSearch(search: string): string {
    const parameters = new URLSearchParams(search);
    const names = parameters.getAll('ba_param');
    if (!parameters.has('sig') || names.length === 0) return '';
    const signedNames = new Set([...names, 'ba_param', 'sig']);
    return search.replace(/^\?/, '').split('&').filter((segment) => {
        const key = new URLSearchParams(segment).keys().next().value;
        return key !== undefined && signedNames.has(key);
    }).join('&');
}

export function withOAuthSearch(path: string, search: string, extra?: Record<string, string>): string {
    const query = [oauthSearch(search), extra ? new URLSearchParams(extra).toString() : ''].filter(Boolean).join('&');
    return query ? `${path}?${query}` : path;
}

export async function providerRequest(path: string, body: Record<string, unknown>, captchaToken?: string) {
    try {
        const result = await authClient.$fetch<{ redirect?: boolean; url?: string }>(path, {
            method: 'POST', body,
            headers: captchaToken ? { 'x-captcha-response': captchaToken } : undefined,
        });
        if (result.error) {
            const error = result.error;
            const code = 'code' in error && typeof error.code === 'string' && error.code ? error.code
                : 'error' in error && ['invalid_signature', 'invalid_request'].includes(String(error.error)) ? 'INVALID_OAUTH_QUERY'
                : error.status === 429 ? 'TOO_MANY_REQUESTS'
                : error.status === 401 ? 'UNAUTHORIZED'
                : error.status === 403 ? 'FORBIDDEN' : 'UNKNOWN_ERROR';
            throw new ApiError(code, error.status);
        }
        return result.data;
    } catch (cause) {
        if (cause instanceof ApiError) throw cause;
        throw new ApiError('NETWORK_ERROR', 0);
    }
}
