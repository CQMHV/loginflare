import { createAuthClient } from 'better-auth/client';
import { usernameClient } from 'better-auth/client/plugins';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { ApiError } from './api';
import { browserContextHeaders, browserContextVersion, browserFlowId, prepareOAuthRedirect } from './browser-context';

const authClient = createAuthClient({
    basePath: '/api/auth',
    disableDefaultFetchPlugins: true,
    plugins: [usernameClient({ displayUsername: false }), oauthProviderClient()],
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
    const flowId = browserFlowId();
    const query = [oauthSearch(search), flowId ? new URLSearchParams({ flow: flowId }).toString() : '', extra ? new URLSearchParams(extra).toString() : ''].filter(Boolean).join('&');
    return query ? `${path}?${query}` : path;
}

export async function providerRequest(path: string, body: Record<string, unknown>, captchaToken?: string) {
    const version = browserContextVersion(), page = `${window.location.pathname}${window.location.search}`;
    try {
        const result = await authClient.$fetch<{ redirect?: boolean; url?: string; twoFactorRedirect?: boolean; browserAccountId?: string }>(path, {
            method: 'POST', body,
            headers: { ...browserContextHeaders(), ...(captchaToken ? { 'x-captcha-response': captchaToken } : {}) },
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
        if (browserContextVersion() !== version || `${window.location.pathname}${window.location.search}` !== page) throw new ApiError('BROWSER_FLOW_EXPIRED', 409);
        if (result.data?.redirect && result.data.url) {
            const destination = new URL(result.data.url, window.location.origin);
            if (!['https:', 'http:'].includes(destination.protocol)) throw new ApiError('INVALID_OAUTH_QUERY', 400);
            prepareOAuthRedirect(destination.href, result.data.browserAccountId, oauthSearch(destination.search));
            window.location.assign(destination.href);
        }
        return result.data;
    } catch (cause) {
        if (cause instanceof ApiError) throw cause;
        throw new ApiError('NETWORK_ERROR', 0);
    }
}
