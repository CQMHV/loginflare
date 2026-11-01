import { isIP } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';

export class SocialNetworkError extends Error { constructor() { super('SOCIAL_PROVIDER_UNAVAILABLE'); } }

export function publicAddress(address: string): boolean {
    if (isIP(address) === 4) {
        const [a, b, c] = address.split('.').map(Number) as [number, number, number];
        return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b))
            || (a === 192 && b === 88 && c === 99) || (a === 198 && [18, 19].includes(b))
            || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
    }
    // Only global-unicast IPv6; reject mapped IPv4, NAT64, ULA, link-local and multicast.
    if (isIP(address) !== 6) return false;
    const canonical = new URL(`https://[${address}]`).hostname.slice(1, -1).toLowerCase();
    const [first, second] = canonical.split(':');
    return /^[23][0-9a-f]{3}:/.test(canonical) && first !== '2002' && first !== '3fff'
        && !(first === '2001' && (Number.parseInt(second || '0', 16) < 0x200 || second === 'db8'));
}

export function publicUrl(value: string): URL {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')
        || (!isIP(host) && !host.includes('.')) || host.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
        || (isIP(host) && !publicAddress(host))) throw new SocialNetworkError();
    return url;
}

export async function checkResolution(url: URL) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(hostname)) return;
    const records = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
    const addresses = records.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    if (!addresses.length || addresses.some((address) => !publicAddress(address))) throw new SocialNetworkError();
}

/** Fetch only public HTTPS destinations, bound both duration and bytes, and never forward credentials across redirects. */
export async function socialFetch(source: string, init: RequestInit = {}, limit = 262_144): Promise<{ bytes: Uint8Array; contentType: string }> {
    let url = publicUrl(source);
    for (let redirects = 0; redirects <= 3; redirects++) {
        await checkResolution(url);
        const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            const next = publicUrl(new URL(response.headers.get('location') ?? '', url).href);
            if ((init.method && init.method !== 'GET') || next.origin !== url.origin) throw new SocialNetworkError();
            url = next;
            continue;
        }
        if (!response.ok || Number(response.headers.get('content-length') ?? 0) > limit) { await response.body?.cancel(); throw new SocialNetworkError(); }
        const reader = response.body?.getReader();
        if (!reader) throw new SocialNetworkError();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                length += part.value.length;
                if (length > limit) throw new SocialNetworkError();
                chunks.push(part.value);
            }
        } finally { await reader.cancel(); }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return { bytes, contentType: response.headers.get('content-type') ?? '' };
    }
    throw new SocialNetworkError();
}

export async function socialJson(source: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const { bytes } = await socialFetch(source, init);
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SocialNetworkError();
    return value as Record<string, unknown>;
}
