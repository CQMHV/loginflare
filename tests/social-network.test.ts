import { afterEach, expect, it, vi } from 'vitest';
import { publicAddress, publicUrl, socialFetch } from '../src/server/social-network';

const dns = vi.hoisted(() => ({ addresses: ['93.184.216.34'] }));
vi.mock('node:dns/promises', () => ({ resolve4: async () => dns.addresses, resolve6: async () => [] }));
afterEach(() => { vi.unstubAllGlobals(); dns.addresses = ['93.184.216.34']; });
it.each(['http://example.com', 'https://localhost', 'https://metadata.google.internal', 'https://127.0.0.1', 'https://10.0.0.1', 'https://169.254.169.254', 'https://2130706433', 'https://[::ffff:127.0.0.1]', 'https://[fc00::1]', 'https://example.com:8443', 'https://user:secret@example.com'])('rejects non-public URLs: %s', (url) => {
    expect(() => publicUrl(url)).toThrow();
});
it.each(['0.0.0.0', '100.64.0.1', '172.31.0.1', '192.168.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '198.18.0.1', '224.0.0.1', '::1', 'fe80::1', '2001:db8::1'])('rejects reserved addresses: %s', (ip) => expect(publicAddress(ip)).toBe(false));
it.each(['2001:0000:1:2:3:4:5:6', '2001:20::1', '3fff::1', '192.88.99.1'])('rejects noncanonical/reserved global-looking addresses: %s', (ip) => expect(publicAddress(ip)).toBe(false));
it('rejects mixed public/private DNS and cross-host redirects before forwarding credentials', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://other.example.com/userinfo' } }));
    vi.stubGlobal('fetch', fetcher); dns.addresses = ['93.184.216.34', '10.0.0.1'];
    await expect(socialFetch('https://idp.example.com/userinfo')).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    dns.addresses = ['93.184.216.34'];
    await expect(socialFetch('https://idp.example.com/userinfo', { headers: { Authorization: 'Bearer secret' } })).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('bounds responses and redirect chains including discovery/JWKS requests', async () => {
    vi.stubGlobal('fetch', async () => new Response('too much content'));
    await expect(socialFetch('https://idp.example.com/discovery', {}, 5)).rejects.toThrow();
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: '/loop' } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(socialFetch('https://idp.example.com/loop')).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(4);
});
