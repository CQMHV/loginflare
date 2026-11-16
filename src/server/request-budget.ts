import type { Env } from './config';

/** Only the edge-provided address is trusted. Group IPv6 rotation within a /64. */
export function requestSource(address: string | null) {
    if (!address) return 'unknown';
    const ip = address.trim().toLowerCase();
    if (ip.startsWith('::ffff:') && ip.slice(7).includes('.')) return ip.slice(7);
    if (!ip.includes(':')) return ip;
    const [left, right] = ip.split('::');
    const prefix = left ? left.split(':') : [], suffix = right ? right.split(':') : [];
    const groups = right === undefined ? prefix : [...prefix, ...Array(Math.max(0, 8 - prefix.length - suffix.length)).fill('0'), ...suffix];
    return groups.slice(0, 4).map((group) => group.padStart(4, '0')).join(':') + '::/64';
}

export async function admitRequest(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (['GET', 'HEAD'].includes(request.method) && (path === '/api/health' || path.startsWith('/assets/') || path === '/favicon.svg')) return true;
    const key = `${env.LOGINFLARE_WORKER_NAME ?? 'loginflare'}:${requestSource(request.headers.get('CF-Connecting-IP'))}`;
    return (await env.REQUEST_LIMITER.limit({ key })).success;
}
