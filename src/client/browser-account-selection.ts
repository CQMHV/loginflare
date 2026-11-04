/** Shared storage identity only; importing this module never starts an auth flow or query. */
export const browserAccountStorageKey = 'loginflare.account';

export function selectedBrowserAccountId(): string {
    try {
        const value = sessionStorage.getItem(browserAccountStorageKey) ?? '';
        return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : '';
    } catch {
        // Storage access is optional; server authorization still requires the browser's cookies.
        return '';
    }
}
