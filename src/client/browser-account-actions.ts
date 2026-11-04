import type { Locale } from '../shared/locales';
import { ApiError, fetchJson, request, type Identity, type User } from './api';
import { browserFlowId, browserFlowKind, browserFlowOAuthQuery, clearBrowserFlow, priorBrowserAccount, rememberBrowserFlow, selectBrowserAccount, selectBrowserFlowAccount, selectedBrowserAccount } from './browser-context';

export interface BrowserAccountSummary {
    id: string;
    user: Pick<User, 'id' | 'name' | 'email' | 'image' | 'role'>;
    status: 'active' | 'signed-out';
    lastUsedAt: string;
}
export interface BrowserAccountList { accounts: BrowserAccountSummary[]; maximumAccounts: number }
export const browserAccountsKey = ['browser-accounts'] as const;
async function discardBrowserFlow() {
    const id = browserFlowId();
    if (id) {
        try { await fetchJson(`/api/browser/auth-flows/${encodeURIComponent(id)}`, undefined, undefined, 'DELETE'); }
        catch (cause) { if (!(cause instanceof ApiError && (cause.code === 'BROWSER_FLOW_EXPIRED' || cause.status === 404))) throw cause; }
    }
    clearBrowserFlow();
}
export async function startBrowserFlow(kind: 'login' | 'add' | 'reauth' | 'oauth' | 'security', locale: Locale, accountId?: string, oauthQuery?: string) {
    if (browserFlowId()) await discardBrowserFlow();
    const result = await fetchJson<{ flowId: string }>('/api/browser/auth-flows', { kind: kind === 'security' ? 'reauth' : kind, locale, ...(accountId ? { accountId } : {}), ...(oauthQuery ? { oauth_query: oauthQuery } : {}) });
    rememberBrowserFlow(result.flowId, kind, oauthQuery, accountId);
    return result.flowId;
}
export async function ensureBrowserFlow(locale: Locale, oauthQuery?: string) {
    if (browserFlowId() && browserFlowOAuthQuery() !== (oauthQuery ?? '')) {
        await discardBrowserFlow();
    }
    if (!browserFlowId()) await startBrowserFlow(oauthQuery ? 'oauth' : 'login', locale, undefined, oauthQuery);
}
export async function completeBrowserLogin(result?: { browserAccountId?: string }, keepFlow = false) {
    const identity = result?.browserAccountId ? undefined : await request<(Identity & { browserAccountId?: string }) | null>('/get-session');
    const accountId = result?.browserAccountId ?? identity?.browserAccountId;
    if (accountId) {
        const sensitive = browserFlowKind() === 'security';
        selectBrowserFlowAccount(accountId);
        if (!keepFlow && !sensitive) {
            if (browserFlowId()) await fetchJson(`/api/browser/auth-flows/${encodeURIComponent(browserFlowId())}`, undefined, undefined, 'DELETE');
            clearBrowserFlow();
        }
        if (!sensitive || accountId !== selectedBrowserAccount()) selectBrowserAccount(accountId);
        window.dispatchEvent(new Event('loginflare:accounts-changed'));
    }
}
export async function cancelBrowserFlow() {
    const flowId = browserFlowId(), previous = priorBrowserAccount() || selectedBrowserAccount();
    if (flowId) await discardBrowserFlow();
    else clearBrowserFlow();
    selectBrowserAccount(previous);
    return previous;
}
