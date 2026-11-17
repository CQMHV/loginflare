/** Public media is an explicit deployment setting, separate from the issuer. */
export function publicAssetsBase(value: string | undefined, development = false, authUrl?: string): string | null {
    if (value === undefined || value === '') return null;
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const local = development && loopback;
    const localPath = /^\/cdn-cgi\/local\/r2\/public\/[a-zA-Z0-9_-]+$/.test(url.pathname);
    const publicHost = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(url.hostname) && url.hostname.length <= 253;
    if (url.username || url.password || url.search || url.hash
        || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
        || (!local && (!publicHost || loopback || url.port || url.pathname !== '/' || url.hostname === 'r2.dev' || url.hostname.endsWith('.r2.dev')))
        || (local && url.pathname !== '/' && !localPath)
        || (!local && authUrl && url.origin === new URL(authUrl).origin)
        || value !== (url.pathname === '/' ? url.origin : url.origin + url.pathname)) {
        throw new Error('PUBLIC_ASSETS_URL must be a separate HTTPS origin (a loopback R2 public endpoint is allowed in development).');
    }
    return url.pathname === '/' ? url.origin : url.origin + url.pathname;
}
