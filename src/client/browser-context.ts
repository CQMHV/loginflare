const accountKey = 'loginflare.account';
const flowKey = 'loginflare.auth-flow';
const kindKey = 'loginflare.auth-flow-kind';
const priorKey = 'loginflare.auth-return-account';
const oauthKey = 'loginflare.auth-oauth-query';
const flowAccountKey = 'loginflare.auth-flow-account';
const targetKey = 'loginflare.auth-target-account';
export const browserContextEvent = 'loginflare:browser-context';
let contextVersion = 0;
export const browserContextVersion = () => contextVersion;

function read(key: string): string {
    try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; }
}
function write(key: string, value: string) {
    try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { /* Authentication still requires the server's HttpOnly cookies. */ }
}
export const selectedBrowserAccount = () => read(accountKey);
export const browserFlowId = () => read(flowKey);
export const browserFlowKind = () => read(kindKey);
export const priorBrowserAccount = () => read(priorKey);
export const browserFlowOAuthQuery = () => read(oauthKey);
export const browserFlowTargetAccount = () => read(targetKey);

// A callback identifies its own flow; the server verifies browser possession.
if (typeof window !== 'undefined') {
    const flow = new URLSearchParams(window.location.search).get('flow');
    if (flow && /^[a-f0-9-]{36}$/i.test(flow)) write(flowKey, flow);
}

export function browserContextHeaders(): Record<string, string> {
    const accountId = selectedBrowserAccount(), flowId = browserFlowId();
    const selectedForFlow = !flowId || browserFlowKind() === 'security' || read(flowAccountKey) === accountId;
    return { ...(accountId && selectedForFlow ? { 'X-Loginflare-Account': accountId } : {}), ...(flowId ? { 'X-Loginflare-Flow': flowId } : {}) };
}
export function selectBrowserFlowAccount(accountId: string) { write(flowAccountKey, accountId); }
export function selectBrowserAccount(accountId: string, notify = true) {
    write(accountKey, accountId);
    if (!notify) return;
    contextVersion++;
    window.dispatchEvent(new Event('loginflare:clear-sensitive'));
    for (const key of ['loginflare.security-intent.social', 'loginflare.security-intent.emails']) write(key, '');
    window.dispatchEvent(new Event(browserContextEvent));
}
export function rememberBrowserFlow(flowId: string, kind: string, oauthQuery = '', target = '') {
    if (!browserFlowId()) write(priorKey, selectedBrowserAccount());
    write(flowKey, flowId); write(kindKey, kind); write(oauthKey, oauthQuery); write(flowAccountKey, ''); write(targetKey, target);
    contextVersion++;
    if (kind !== 'security') window.dispatchEvent(new Event(browserContextEvent));
}
export function clearBrowserFlow() {
    contextVersion++;
    write(flowKey, ''); write(kindKey, ''); write(priorKey, ''); write(oauthKey, ''); write(flowAccountKey, ''); write(targetKey, '');
}
export function prepareOAuthRedirect(destination: string, accountId?: string, oauthQuery?: string) {
    if (accountId) { selectBrowserFlowAccount(accountId); selectBrowserAccount(accountId, false); }
    const url = new URL(destination, window.location.origin);
    const internalPage = url.origin === window.location.origin && /^\/(?:en-us|zh-cn)\/(?:consent|login|signup|verify-email|verified|two-factor|select-account|social\/complete)\/?$/.test(url.pathname);
    if (internalPage && oauthQuery) write(oauthKey, oauthQuery);
    if (url.origin !== window.location.origin || !internalPage && !url.pathname.startsWith('/api/auth/')) clearBrowserFlow();
}
export function flowPath(path: string) {
    const flowId = browserFlowId();
    if (!flowId) return path;
    const url = new URL(path, window.location.origin);
    url.searchParams.set('flow', flowId);
    return `${url.pathname}${url.search}${url.hash}`;
}
