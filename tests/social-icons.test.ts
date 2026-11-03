import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/server/index';
import { defaultConnectionConfig, type SocialConnection } from '../src/shared/social';
import { maximumImageBytes } from '../src/shared/image-limits';
import { maintainDatabase } from '../src/server/maintenance';
import { avatarPng, avatarJpeg, avatarWebp, avatarWebpWithMetadata } from './fixtures/avatars';
import { harness, origin, session } from './helpers';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#6750a4"/></svg>';
const settings = { name: 'Custom provider', type: 'google', config: { ...defaultConnectionConfig('google'), clientId: 'icon-client' }, clientSecret: 'test-only-icon-secret', enabled: false, archived: false, revision: 0 };
beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Request(input, init).url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected network');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });
async function admin() { const client = harness(); return { client, cookie: await client.administrator() }; }
async function upload(cookie = '', body: BodyInit = svg, contentType = 'image/svg+xml', bindings = harness().bindings, headers = {}) {
    const context = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}/api/admin/social-connections/icon`, {
        method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': contentType, ...headers }, body,
    }), bindings, context);
    await waitOnExecutionContext(context); return response;
}
async function icon(cookie: string) {
    const response = await upload(cookie);
    expect(response.status).toBe(200);
    return response.json<{ iconId: string; iconUrl: string }>();
}
async function create(client: ReturnType<typeof harness>, cookie: string, iconId?: string) {
    const response = await client.request('/api/admin/social-connections', { cookie, body: { ...settings, ...(iconId ? { iconId } : {}) } });
    expect(response.status, await response.clone().text()).toBe(201);
    return response.json<SocialConnection>();
}
async function update(client: ReturnType<typeof harness>, cookie: string, row: SocialConnection, overrides: Record<string, unknown>) {
    return client.request(`/api/admin/social-connections/${row.id}`, { cookie, method: 'PATCH', body: { ...settings, revision: row.revision, ...overrides } });
}

it('restricts icon uploads to active verified administrators and the exact Origin', async () => {
    const client = harness();
    expect((await upload()).status).toBe(401);
    await client.verify(); const user = await client.signin();
    expect((await upload(user)).status).toBe(403);
    const cookie = await client.administrator();
    expect((await upload(cookie, svg, 'image/svg+xml', client.bindings, { Origin: 'https://elsewhere.test' })).status).toBe(403);
    expect((await upload(cookie)).status).toBe(200);
});

it('validates SVG and raster uploads, sanitizes raster metadata, and enforces payload limits', async () => {
    const { cookie } = await admin();
    for (const body of ['', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://elsewhere.test/a.png"/></svg>', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>']) {
        expect((await upload(cookie, body)).status).toBe(400);
    }
    expect((await upload(cookie, 'x'.repeat(maximumImageBytes + 1))).status).toBe(413);
    expect((await upload(cookie, 'not an image', 'image/png')).status).toBe(400);
    const oversized = Uint8Array.from(Buffer.from(avatarPng, 'base64'));
    new DataView(oversized.buffer).setUint32(16, 2049);
    expect((await upload(cookie, oversized.buffer, 'image/png')).status).toBe(400);
    for (const fixture of [avatarPng, avatarJpeg, avatarWebpWithMetadata]) {
        const decoded = Uint8Array.from(Buffer.from(fixture, 'base64'));
        const response = await upload(cookie, decoded.buffer, 'image/png');
        expect(response.status, await response.clone().text()).toBe(200);
        const value = await response.json<{ iconId: string }>();
        const stored = await env.AVATARS.get(`social-icons/${value.iconId}`);
        expect(stored).not.toBeNull();
        const bytes = new Uint8Array(await stored!.arrayBuffer());
        expect(bytes.byteLength).toBeLessThanOrEqual(decoded.length);
        expect(new TextDecoder().decode(bytes)).not.toContain('fixture-private-location');
    }
});

it('applies the same inclusive upload limit to avatars, logos and icons without trusting Content-Length', async () => {
    const { client, cookie } = await admin();
    const paths = ['/api/account/avatar', '/api/admin/branding/logo', '/api/admin/social-connections/icon'];
    const send = async (path: string, bytes: Uint8Array, headers: Record<string, string> = {}) => {
        const context = createExecutionContext();
        const response = await app.fetch(new Request(`${origin}${path}`, {
            method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'image/webp', ...headers }, body: new Uint8Array(bytes).buffer,
        }), client.bindings, context);
        await waitOnExecutionContext(context); return response;
    };
    const oversized = new Uint8Array(maximumImageBytes + 1);
    const headerVariants: Record<string, string>[] = [{}, { 'Content-Length': String(oversized.length) }, { 'Content-Length': '1' }];
    for (const path of paths) {
        for (const headers of headerVariants) {
            const response = await send(path, oversized, headers);
            expect(response.status, path).toBe(413);
            expect(await response.json()).toEqual({ code: 'IMAGE_UPLOAD_TOO_LARGE' });
        }
    }
    expect((await env.AVATARS.list()).objects).toHaveLength(0);
    for (const table of ['userAvatar', 'brandLogo', 'socialIcon']) {
        expect(await env.DB.prepare(`SELECT count(*) AS count FROM "${table}"`).first('count'), table).toBe(0);
    }

    const original = Uint8Array.from(Buffer.from(avatarWebp, 'base64'));
    const boundary = new Uint8Array(maximumImageBytes);
    boundary.set(original);
    boundary.set(new TextEncoder().encode('EXIF'), original.length);
    const view = new DataView(boundary.buffer);
    view.setUint32(original.length + 4, boundary.length - original.length - 8, true);
    view.setUint32(4, boundary.length - 8, true);
    for (const path of paths) {
        const response = await send(path, boundary);
        expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
    }
    const objects = (await env.AVATARS.list()).objects;
    expect(objects).toHaveLength(3);
    expect(objects.every((object) => object.size < maximumImageBytes)).toBe(true);
    for (const table of ['userAvatar', 'brandLogo', 'socialIcon']) {
        expect(await env.DB.prepare(`SELECT count(*) AS count FROM "${table}"`).first('count'), table).toBe(1);
    }
});

it('serves same-origin icons with safe headers, HEAD and conditional caching', async () => {
    const { client, cookie } = await admin(), value = await icon(cookie);
    expect(value.iconUrl).toBe(`/social/icons/${value.iconId}`);
    const response = await client.request(value.iconUrl);
    expect(response.status).toBe(200); expect(await response.text()).toBe(svg);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const head = await client.request(value.iconUrl, { method: 'HEAD' });
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    for (const method of ['GET', 'HEAD']) expect((await client.request(value.iconUrl, { method, headers: { 'If-None-Match': response.headers.get('etag')! } })).status).toBe(304);
    expect((await client.request('/social/icons/not-an-id')).status).toBe(404);
});

it('persists an optional icon, exposes only its display URL, and allows changing it after identity locking', async () => {
    const { client, cookie } = await admin(), first = await icon(cookie), second = await icon(cookie);
    let row = await create(client, cookie, first.iconId);
    expect(row).toMatchObject(first);
    expect(await env.DB.prepare('SELECT "deleteAfter" FROM "socialIcon" WHERE "id" = ?').bind(first.iconId).first('deleteAfter')).toBeNull();
    await env.DB.prepare('UPDATE "socialConnection" SET "identityLocked" = 1 WHERE "id" = ?').bind(row.id).run();
    const response = await update(client, cookie, row, { enabled: true, iconId: second.iconId });
    expect(response.status, await response.clone().text()).toBe(200); row = await response.json<SocialConnection>();
    expect(row).toMatchObject(second);
    const providers = await (await client.request('/api/social/providers')).json<{ providers: Record<string, unknown>[] }>();
    expect(providers.providers).toEqual([{ id: row.id, name: settings.name, type: 'google', iconUrl: second.iconUrl }]);
    const identity = (await session(client, cookie))!;
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT INTO "account" ("id", "userId", "providerId", "accountId", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)')
        .bind('linked-social-icon', identity.user.id, row.id, 'icon-subject', now, now).run();
    const security = await (await client.request('/api/auth/social/security', { cookie })).json<{ identities: { iconUrl: string; type: string }[] }>();
    expect(security.identities[0]).toMatchObject({ type: 'google', iconUrl: second.iconUrl });
    await env.DB.prepare('UPDATE "socialConnection" SET "enabled" = 0, "iconId" = NULL WHERE "id" = ?').bind(row.id).run();
    const disabled = await (await client.request('/api/auth/social/security', { cookie })).json<{ identities: { type: string; enabled: boolean; iconUrl: string | null }[] }>();
    expect(disabled.identities[0]).toMatchObject({ type: 'google', enabled: false, iconUrl: null });
    await env.DB.prepare('UPDATE "socialConnection" SET "enabled" = 1, "iconId" = ? WHERE "id" = ?').bind(second.iconId, row.id).run();
    const unchanged = await update(client, cookie, row, { name: 'Renamed provider' });
    expect((await unchanged.json<SocialConnection>()).iconId).toBe(second.iconId);
});

it('rejects arbitrary, missing or expired references and preserves the winner on concurrent edits', async () => {
    const { client, cookie } = await admin(), value = await icon(cookie), row = await create(client, cookie);
    for (const iconId of ['https://elsewhere.test/a.svg', crypto.randomUUID()]) expect((await update(client, cookie, row, { iconId })).status).toBe(400);
    const outcomes = await Promise.all(['First', 'Second'].map((name) => update(client, cookie, row, { name, iconId: value.iconId })));
    expect(outcomes.map((response) => response.status).sort()).toEqual([200, 409]);
    const expired = await icon(cookie);
    await env.DB.prepare('UPDATE "socialIcon" SET "deleteAfter" = ? WHERE "id" = ?').bind(Date.now() - 1, expired.iconId).run();
    expect((await client.request('/api/admin/social-connections', { cookie, body: { ...settings, iconId: expired.iconId } })).status).toBe(400);
    const listed = await (await client.request('/api/admin/social-connections', { cookie })).json<{ connections: SocialConnection[] }>();
    expect((await update(client, cookie, listed.connections[0]!, { iconId: expired.iconId })).status).toBe(400);
    await maintainDatabase(client.bindings, Date.now() + 6 * 60_000);
    expect(await env.AVATARS.head(`social-icons/${expired.iconId}`)).toBeNull();
    expect(await env.AVATARS.head(`social-icons/${value.iconId}`)).not.toBeNull();
});

it('retains shared icons until their final reference is removed and cleans abandoned drafts', async () => {
    const { client, cookie } = await admin(), value = await icon(cookie), draft = await icon(cookie);
    const first = await create(client, cookie, value.iconId), second = await create(client, cookie, value.iconId);
    const removed = await update(client, cookie, first, { iconId: null });
    expect(removed.status).toBe(200);
    expect(await env.DB.prepare('SELECT "deleteAfter" FROM "socialIcon" WHERE "id" = ?').bind(value.iconId).first('deleteAfter')).toBeNull();
    await maintainDatabase(client.bindings, Date.now() + 66 * 60_000);
    expect(await env.AVATARS.head(`social-icons/${draft.iconId}`)).toBeNull();
    expect(await env.AVATARS.head(`social-icons/${value.iconId}`)).not.toBeNull();
    await env.DB.prepare('DELETE FROM "socialConnection" WHERE "id" = ?').bind(second.id).run();
    expect(await env.DB.prepare('SELECT "deleteAfter" FROM "socialIcon" WHERE "id" = ?').bind(value.iconId).first('deleteAfter')).toBeTypeOf('number');
    await maintainDatabase(client.bindings, Date.now() + 66 * 60_000);
    expect(await env.AVATARS.head(`social-icons/${value.iconId}`)).toBeNull();
});

it('cannot attach an icon collected after preflight but before the atomic configuration update', async () => {
    const { client, cookie } = await admin(), value = await icon(cookie), row = await create(client, cookie);
    let collected = false;
    const database = new Proxy(env.DB, { get(target, property) {
        if (property === 'prepare') return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.startsWith('UPDATE "socialConnection" SET')) return statement;
            return new Proxy(statement, { get(prepared, operation) {
                if (operation === 'bind') return (...values: Parameters<D1PreparedStatement['bind']>) => {
                    const bound = prepared.bind(...values);
                    return new Proxy(bound, { get(query, method) {
                        if (method === 'run') return async () => {
                            await env.DB.prepare('UPDATE "socialIcon" SET "deleteAfter" = ? WHERE "id" = ?').bind(Date.now() - 6 * 60_000, value.iconId).run();
                            await maintainDatabase(client.bindings); collected = true;
                            return query.run();
                        };
                        const member = Reflect.get(query, method); return typeof member === 'function' ? member.bind(query) : member;
                    } });
                };
                const member = Reflect.get(prepared, operation); return typeof member === 'function' ? member.bind(prepared) : member;
            } });
        };
        const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member;
    } });
    const context = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}/api/admin/social-connections/${row.id}`, {
        method: 'PATCH', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, revision: row.revision, iconId: value.iconId }),
    }), { ...client.bindings, DB: database }, context);
    await waitOnExecutionContext(context);
    expect(collected).toBe(true);
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ code: 'SOCIAL_ICON_UNAVAILABLE' });
    expect(await env.DB.prepare('SELECT "iconId" FROM "socialConnection" WHERE "id" = ?').bind(row.id).first('iconId')).toBeNull();
    expect(await env.AVATARS.head(`social-icons/${value.iconId}`)).toBeNull();
});

it('does not return an upload from a session revoked while its image was stored', async () => {
    const { client, cookie } = await admin(), identity = (await session(client, cookie))!;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const bucket = new Proxy(env.AVATARS, { get(target, property) {
        if (property === 'put') return async (...args: Parameters<R2Bucket['put']>) => { entered(); await gate; return target.put(...args); };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const pending = upload(cookie, svg, 'image/svg+xml', { ...client.bindings, AVATARS: bucket });
    await ready; await env.DB.prepare('DELETE FROM "session" WHERE "id" = ?').bind(identity.session.id).run(); release();
    expect((await pending).status).toBe(401);
    await maintainDatabase(client.bindings, Date.now() + 66 * 60_000);
    expect((await env.AVATARS.list({ prefix: 'social-icons/' })).objects).toHaveLength(0);
});
