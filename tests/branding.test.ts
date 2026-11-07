import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/server/index';
import { brandColors } from '../src/shared/brand-colors';
import { colorSchemes, defaultBranding, type Branding } from '../src/shared/branding';
import { maximumImageBytes } from '../src/shared/image-limits';
import { maintainDatabase } from '../src/server/maintenance';
import { sendAccountMail, sendEmailCode, sendInstallationMail } from '../src/server/mail';
import { harness, origin, password, session } from './helpers';
import { avatarPng, avatarJpeg, avatarWebpWithMetadata } from './fixtures/avatars';

const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="80" height="40" fill="#6750a4"/></svg>';
beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Request(input, init).url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected network');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

it.each(['en-US', 'zh-CN'] as const)('uses current branding in every %s email, including after another rename', async (locale) => {
    const { client, cookie } = await admin();
    for (const name of ['Example & <Accounts>', 'Renamed identity service']) {
        await update(client, cookie, await current(client), { name });
        client.messages.length = 0;
        await sendAccountMail(client.bindings, { email: 'mail@example.test', name: 'Person', locale }, `${origin}/api/auth/verify-email?token=fixture`);
        for (const purpose of ['verify', 'recovery', 'social'] as const) {
            await sendEmailCode(client.bindings, { email: 'mail@example.test', name: 'Person', locale }, '123456', purpose);
        }
        await sendInstallationMail(client.bindings, 'owner@example.test', 'a'.repeat(64), locale);
        expect(client.messages).toHaveLength(5);
        for (const message of client.messages) {
            expect(message.from).toEqual({ email: client.bindings.EMAIL_FROM, name });
            expect(message.subject).toContain(name);
            expect(message.subject + message.text + message.html).not.toContain('Loginflare');
            expect(message.html).not.toContain('<Accounts>');
        }
    }
});

it('uses the current brand for authenticator enrollment and the public management API title', async () => {
    const { client, cookie } = await admin();
    await update(client, cookie, await current(client), { name: 'Example Accounts' });
    const enrollment = await client.request('/api/auth/two-factor/enable', { cookie, body: { password } });
    expect(enrollment.status, await enrollment.clone().text()).toBe(200);
    const { totpURI } = await enrollment.json<{ totpURI: string }>();
    const uri = new URL(totpURI);
    expect(uri.searchParams.get('issuer')).toBe('Example Accounts');
    expect(decodeURIComponent(uri.pathname)).toContain('Example Accounts:');
    const document = await client.request('/api/management/v1/openapi.json');
    expect((await document.json<{ info: { title: string } }>()).info.title).toBe('Example Accounts Management API');
});
async function admin() { const client = harness(); return { client, cookie: await client.administrator() }; }
async function current(client = harness()) { return (await client.request('/api/branding')).json<Branding>(); }
async function update(client: ReturnType<typeof harness>, cookie: string, value: Branding, overrides = {}) {
    return client.request('/api/admin/branding', { method: 'PUT', cookie, body: { name: value.name, primaryColor: value.primaryColor, colorScheme: value.colorScheme, logoId: value.logoId, revision: value.revision, ...overrides } });
}
async function upload(cookie: string, content = svg, bindings = harness().bindings) {
    const context = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}/api/admin/branding/logo`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'image/svg+xml' }, body: content }), bindings, context);
    await waitOnExecutionContext(context); return response;
}

it('exposes public branding and requires an active verified administrator and exact Origin for writes', async () => {
    const client = harness(), value = await current(client);
    expect(value).toMatchObject({ name: 'Loginflare', primaryColor: '#f38020', colorScheme: 'tonal-spot', logoId: null, logoUrl: '/assets/logo.svg', revision: 0 });
    expect((await client.request('/api/admin/branding')).status).toBe(401);
    await client.verify(); const user = await client.signin();
    expect((await update(client, user, value, { name: 'Forbidden' })).status).toBe(403);
    const administrator = await client.administrator();
    expect((await client.request('/api/admin/branding', { method: 'PUT', cookie: administrator, headers: { Origin: 'https://elsewhere.test' }, body: {} })).status).toBe(403);
    expect((await client.request('/api/admin/branding', { cookie: administrator })).status).toBe(200);
});

it('persists settings atomically, rejects malformed values, and prevents concurrent lost updates', async () => {
    const { client, cookie } = await admin(), value = await current(client);
    for (const overrides of [{ name: '' }, { name: 'x\r\nInjected: value' }, { primaryColor: 'red; color:black' }, { colorScheme: 'arbitrary' }, { colorScheme: null }, { logoId: 'https://elsewhere.test/logo.svg' }, { arbitrary: true }]) {
        expect((await update(client, cookie, value, overrides)).status).toBe(400);
    }
    const outcomes = await Promise.all(['First brand', 'Second brand'].map((name) => update(client, cookie, value, { name, primaryColor: '#6750A4' })));
    expect(outcomes.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await current(client)).toMatchObject({ primaryColor: '#6750a4', revision: 1 });
});

it('uses Material-derived roles with readable foreground pairs in both schemes', () => {
    const luminance = (hex: string) => {
        const values = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255).map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
        return .2126 * values[0]! + .7152 * values[1]! + .0722 * values[2]!;
    };
    for (const variant of colorSchemes) {
        for (const seed of ['#f38020', '#6750a4', '#ffffff', '#000000', '#00ff00']) {
            for (const colors of Object.values(brandColors(seed, variant))) {
                expect(Object.keys(colors)).toHaveLength(49);
                expect(Object.values(colors).every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
                for (const [fill, content] of [['primary', 'on-primary'], ['primary-container', 'on-primary-container'], ['surface', 'on-surface']]) {
                    const a = luminance(colors[fill!]!), b = luminance(colors[content!]!);
                    expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toBeGreaterThanOrEqual(4.45);
                }
            }
        }
    }
    expect(brandColors('#6750a4', defaultBranding.colorScheme).light.primary).not.toBe(brandColors('#f38020', defaultBranding.colorScheme).light.primary);
});

it('persists every supported scheme and publishes matching palettes to HTML and mail', async () => {
    const { client, cookie } = await admin();
    for (const colorScheme of colorSchemes) {
        const response = await update(client, cookie, await current(client), { colorScheme });
        expect(response.status).toBe(200);
        const value = await response.json<Branding>();
        expect(value.colorScheme).toBe(colorScheme);
        expect(value.colors).toEqual(brandColors(value.primaryColor, colorScheme));
        expect((await current(client)).colorScheme).toBe(colorScheme);
    }
    await update(client, cookie, await current(client), { colorScheme: 'monochrome' });
    const value = await current(client);
    expect(value.colors.light.primary).toBe('#000000');
    const response = await app.fetch(new Request(`${origin}/en-us/login`), { ...client.bindings, ASSETS: { ...client.bindings.ASSETS, fetch: async () => new Response('<html><head><title></title></head></html>', { headers: { 'Content-Type': 'text/html' } }) } }, createExecutionContext());
    expect(await response.text()).toContain('monochrome');
    await client.signup('scheme-mail@example.test');
    expect(client.messages.at(-1)?.html).toContain(`background:${value.colors.light.primary}`);
});

it('preserves SVG vectors and serves isolated immutable image responses without database reads', async () => {
    const { client, cookie } = await admin();
    const uploaded = await upload(cookie); expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const logo = await uploaded.json<{ logoId: string; logoUrl: string }>();
    expect((await update(client, cookie, await current(client), { logoId: logo.logoId })).status).toBe(200);
    const bindings = { ...client.bindings, DB: new Proxy(env.DB, { get() { throw new Error('Asset reads must not use D1'); } }) };
    const response = await app.fetch(new Request(`${origin}${logo.logoUrl}`), bindings, createExecutionContext());
    expect(response.status).toBe(200); expect(await response.text()).toBe(svg);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('content-disposition')).toBe('attachment');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    const etag = response.headers.get('etag')!;
    expect((await app.fetch(new Request(`${origin}${logo.logoUrl}`, { headers: { 'If-None-Match': etag } }), bindings, createExecutionContext())).status).toBe(304);
});

it('rejects active, externally referencing, malformed and oversized SVGs', async () => {
    const { cookie } = await admin();
    for (const content of [svg.replace('<rect', '<script>alert(1)</script><rect'), svg.replace('<rect', '<foreignObject/><rect'), svg.replace('<rect', '<image href="https://elsewhere.test/private"/><rect'), svg.replace('fill="#6750a4"', 'fill="url(https://elsewhere.test/paint.svg#color)"'), svg.replace('<rect', '<animateMotion/><rect'), svg.replace('<rect', '<style>@import "https://elsewhere.test/a.css";</style><rect'), svg.replace('<rect', '<rect onload="alert(1)"/><rect'), '<!DOCTYPE svg [<!ENTITY x "expanded">]>' + svg, '<svg']) {
        expect((await upload(cookie, content)).status).toBe(400);
    }
    const oversized = await upload(cookie, svg.padEnd(maximumImageBytes + 1));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ code: 'IMAGE_UPLOAD_TOO_LARGE' });
    expect((await env.AVATARS.list()).objects).toHaveLength(0);
});

it('validates static raster logos by content and serves their actual MIME types', async () => {
    const { client, cookie } = await admin();
    for (const [source, mime] of [[avatarPng, 'image/png'], [avatarJpeg, 'image/jpeg'], [avatarWebpWithMetadata, 'image/webp']]) {
        const bytes = Uint8Array.from(atob(source!), (value) => value.charCodeAt(0));
        const context = createExecutionContext();
        const result = await app.fetch(new Request(`${origin}/api/admin/branding/logo`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: bytes.buffer }), client.bindings, context);
        await waitOnExecutionContext(context); expect(result.status).toBe(200);
        const logo = await result.json<{ logoUrl: string }>();
        const asset = await app.fetch(new Request(`${origin}${logo.logoUrl}`), client.bindings, createExecutionContext());
        expect(asset.headers.get('content-type')).toBe(mime);
        expect(new TextDecoder().decode(await asset.arrayBuffer())).not.toContain('fixture-private-location');
    }
});

it('cleans expired logo drafts and replaced logos while retaining the published logo', async () => {
    const { client, cookie } = await admin();
    const first = await (await upload(cookie)).json<{ logoId: string }>();
    const draft = await (await upload(cookie)).json<{ logoId: string }>();
    await update(client, cookie, await current(client), { logoId: first.logoId });
    const second = await (await upload(cookie)).json<{ logoId: string }>();
    await update(client, cookie, await current(client), { logoId: second.logoId });
    await maintainDatabase(client.bindings, Date.now() + 66 * 60_000);
    expect(await env.AVATARS.head(`branding/${first.logoId}`)).toBeNull();
    expect(await env.AVATARS.head(`branding/${draft.logoId}`)).toBeNull();
    expect(await env.AVATARS.head(`branding/${second.logoId}`)).not.toBeNull();
    expect((await current(client)).logoId).toBe(second.logoId);
});

it('does not publish a logo uploaded by a session that was revoked during storage', async () => {
    const { client, cookie } = await admin(), identity = (await session(client, cookie))!;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const bucket = new Proxy(env.AVATARS, { get(target, property) {
        if (property === 'put') return async (...args: Parameters<R2Bucket['put']>) => { entered(); await gate; return target.put(...args); };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const pending = upload(cookie, svg, { ...client.bindings, AVATARS: bucket });
    await ready; await env.DB.prepare('DELETE FROM "session" WHERE "id" = ?').bind(identity.session.id).run(); release();
    expect((await pending).status).toBe(401); expect((await current(client)).logoId).toBeNull();
    await maintainDatabase(client.bindings, Date.now() + 66 * 60_000);
    expect((await env.AVATARS.list()).objects).toHaveLength(0);
});

it('escapes branding in HTML bootstrap metadata and transactional mail', async () => {
    const { client, cookie } = await admin(), name = 'Example </title><script>alert(1)</script> &quot; Co';
    await update(client, cookie, await current(client), { name });
    const response = await app.fetch(new Request(`${origin}/en-us/login`), { ...client.bindings, ASSETS: { ...client.bindings.ASSETS, fetch: async () => new Response('<!doctype html><html><head><title>Loginflare</title><meta name="description"><link rel="icon"></head><body></body></html>', { headers: { 'Content-Type': 'text/html' } }) } }, createExecutionContext());
    const html = await response.text();
    const scripts: string[] = [];
    let hydratedName = '';
    await new HTMLRewriter().on('script', { element(element) { scripts.push(element.tagName); } })
        .on('html', { element(element) { hydratedName = JSON.parse(element.getAttribute('data-branding')!.replaceAll('&quot;', '"')).name; } }).transform(new Response(html)).text();
    expect(scripts).toEqual([]); expect(hydratedName).toBe(name);
    expect(html).toContain('&lt;script&gt;');
    await client.signup('brand-mail@example.test');
    expect(client.messages.at(-1)?.subject).toContain(name);
    expect(client.messages.at(-1)?.html).toContain('&lt;script&gt;');
    expect(client.messages.at(-1)?.html).not.toContain('<script>alert(1)</script>');
});
