import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/server/index';
import { publicAssetsBase } from '../src/shared/public-assets';
import { validateConfig } from '../src/server/config';
import { migrateAvatarUrls } from '../scripts/public-assets.mjs';
import { maintainDatabase } from '../src/server/maintenance';
import { harness, origin, session } from './helpers';
import { avatarWebp } from './fixtures/avatars';
import { publicImageSource } from '../src/shared/avatars';

const base = 'https://images.example.test';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>';
beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Request(input, init).url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected network');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

it('renders only exact configured public avatar keys and canonical existing issuer links', () => {
    const id = crypto.randomUUID(), allowed = `${base}/${id}`, legacy = `${origin}/avatars/${id}`;
    const avatarImageSource = (image: string, origin: string, publicBase?: string) => publicImageSource(image, origin, publicBase, 'avatar');
    expect(avatarImageSource(allowed, origin, base)).toBe(allowed);
    expect(avatarImageSource(legacy, origin, base)).toBe(legacy);
    expect(avatarImageSource(allowed, origin)).toBeUndefined();
    const local = 'http://127.0.0.1:5174/cdn-cgi/local/r2/public/isolated-avatars';
    expect(avatarImageSource(`${local}/${id}`, origin, local)).toBe(`${local}/${id}`);
    for (const value of [base + '.attacker.test/' + id, `${base}/branding/${id}`, `${base}/avatars/${id}`, allowed + '?x=1', allowed + '#x', `https://user:pass@images.example.test/${id}`, 'javascript:alert(1)', 'data:image/svg+xml,test', 'https://elsewhere.test/' + id, base + '/not-an-id', `${origin}/avatars/${id}/other`]) {
        expect(avatarImageSource(value, origin, base), value).toBeUndefined();
    }
    expect(publicImageSource(`/social/icons/${id}`, origin, base, 'social-icon')).toBe(`/social/icons/${id}`);
    expect(publicImageSource(`${base}/social-icons/${id}`, origin, base, 'social-icon')).toBe(`${base}/social-icons/${id}`);
    for (const value of [`${base}/${id}`, `${base}/social-icons/${id}?x=1`, `https://elsewhere.test/social-icons/${id}`, `${base}.attacker.test/social-icons/${id}`]) {
        expect(publicImageSource(value, origin, base, 'social-icon'), value).toBeUndefined();
    }
});

it('accepts only explicit public media origins, with narrowly scoped local endpoints', () => {
    expect(publicAssetsBase(undefined)).toBeNull();
    expect(publicAssetsBase('')).toBeNull();
    expect(publicAssetsBase(base, false, 'https://auth.example.test')).toBe(base);
    const local = `${origin}/cdn-cgi/local/r2/public/test-avatars`;
    expect(publicAssetsBase(local, true, origin)).toBe(local);
    for (const value of ['http://images.example.test', base + '/', base + '/files', base + '?a=b', base + '#a', 'https://user:password@images.example.test', 'https://example.r2.dev', 'https://localhost', base + ':444', base + ";script-src 'unsafe-inline'", base + '\n']) {
        expect(() => publicAssetsBase(value)).toThrow();
    }
    expect(() => publicAssetsBase(base, false, base)).toThrow();
    expect(() => publicAssetsBase(local)).toThrow();
    expect(() => publicAssetsBase(`${origin}/cdn-cgi/local/r2/s3`, true)).toThrow();
    expect(() => validateConfig({ ...harness().bindings, PUBLIC_ASSETS_URL: 'http://images.example.test' })).toThrow('Invalid PUBLIC_ASSETS_URL');
});

it('returns direct image URLs throughout uploads, session, branding and provider APIs', async () => {
    const client = harness(); client.bindings.PUBLIC_ASSETS_URL = base;
    const cookie = await client.administrator();
    async function upload(path: string, data: string | ArrayBuffer, type: string) {
        const context = createExecutionContext();
        const response = await app.fetch(new Request(`${origin}${path}`, { method: 'POST', body: data,
            headers: { Origin: origin, Cookie: cookie, 'Content-Type': type } }), client.bindings, context);
        await waitOnExecutionContext(context);
        expect(response.status, await response.clone().text()).toBe(200);
        return response;
    }
    const avatar = await (await upload('/api/account/avatar', Uint8Array.from(atob(avatarWebp), (c) => c.charCodeAt(0)).buffer, 'image/webp')).json<{ image: string }>();
    expect(avatar.image).toMatch(/^https:\/\/images\.example\.test\/[a-f0-9-]{36}$/);
    expect((await session(client, cookie))!.user.image).toBe(avatar.image);
    const photo = await env.DB.prepare('SELECT "id", "url", "deleteAfter" FROM "userAvatar"').first<{ id: string; url: string; deleteAfter: number | null }>();
    expect(photo).toMatchObject({ url: avatar.image, deleteAfter: null });
    expect((await env.AVATARS.head(photo!.id))!.httpMetadata?.cacheControl).toBe('public, max-age=300');
    expect(await client.bindings.PRIVATE!.head(photo!.id)).toBeNull();
    const logo = await (await upload('/api/admin/branding/logo', svg, 'image/svg+xml')).json<{ logoId: string; logoUrl: string }>();
    expect(logo.logoUrl).toBe(`${base}/branding/${logo.logoId}`);
    const settings = await (await client.request('/api/admin/branding', { cookie })).json<Record<string, unknown>>();
    const saved = await client.request('/api/admin/branding', { cookie, method: 'PUT', body: {
        name: settings.name, primaryColor: settings.primaryColor, colorScheme: settings.colorScheme, revision: settings.revision, logoId: logo.logoId,
    } });
    expect(saved.status).toBe(200); expect(await saved.json()).toMatchObject(logo);
    expect(await (await client.request('/api/branding')).json()).toMatchObject(logo);
    const page = await app.fetch(new Request(`${origin}/en-us/account`), { ...client.bindings, ASSETS: { ...client.bindings.ASSETS, fetch: async () => new Response('<html><head><link rel="icon" href="/favicon.svg"></head></html>', { headers: { 'Content-Type': 'text/html' } }) } }, createExecutionContext());
    const html = await page.text();
    expect(html).toContain(`href="${logo.logoUrl}"`);
    expect(html).toContain(`data-public-assets-url="${base}"`);
    const policy = page.headers.get('Content-Security-Policy')!;
    expect(policy.match(/img-src[^;]+/)![0]).toContain(base);
    expect(policy.match(/script-src[^;]+/)![0]).not.toContain(base);
    expect(policy.match(/connect-src[^;]+/)![0]).not.toContain(base);
    const icon = await (await upload('/api/admin/social-connections/icon', svg, 'image/svg+xml')).json<{ iconId: string; iconUrl: string }>();
    expect(icon.iconUrl).toBe(`${base}/social-icons/${icon.iconId}`);
    const now = new Date().toISOString(), provider = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO "socialConnection" ("id", "name", "type", "config", "enabled", "iconId", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
        .bind(provider, 'Public icon', 'google', '{}', icon.iconId, now, now).run();
    expect(await (await client.request('/api/social/providers')).json()).toMatchObject({ providers: [{ iconUrl: icon.iconUrl }] });
    const identity = (await session(client, cookie))!;
    await env.DB.prepare('INSERT INTO "account" ("id", "userId", "providerId", "accountId", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), identity.user.id, provider, 'public-media-subject', now, now).run();
    expect(await (await client.request('/api/auth/social/security', { cookie })).json()).toMatchObject({ identities: [{ iconUrl: icon.iconUrl }] });
    expect(await (await client.request('/api/admin/social-connections', { cookie })).json()).toMatchObject({ connections: [{ iconUrl: icon.iconUrl }] });
    expect((await client.request('/api/account/avatar', { cookie, method: 'DELETE' })).status).toBe(200);
    expect((await session(client, cookie))!.user.image).toBeNull();
    await maintainDatabase(client.bindings, Date.now() + 66 * 60_000);
    expect(await env.AVATARS.head(photo!.id)).toBeNull();
});

it('redirects old public image links without R2 or D1 reads and rejects invalid IDs', async () => {
    const client = harness();
    const deniedDb = new Proxy(env.DB, { get() { throw new Error('No D1 reads'); } });
    const deniedBucket = new Proxy(env.AVATARS, { get() { throw new Error('No R2 reads'); } });
    const bindings = { ...client.bindings, PUBLIC_ASSETS_URL: base, DB: deniedDb, AVATARS: deniedBucket };
    const id = crypto.randomUUID();
    for (const [path, key] of [['avatars', id], ['branding/logos', `branding/${id}`], ['social/icons', `social-icons/${id}`]]) {
        for (const method of ['GET', 'HEAD']) {
            const response = await app.fetch(new Request(`${origin}/${path}/${id}?ignored=1`, { method }), bindings, createExecutionContext());
            expect(response.status).toBe(302); expect(response.headers.get('Location')).toBe(`${base}/${key}`);
            expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
            expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
            expect(response.headers.has('Set-Cookie')).toBe(false);
        }
        expect((await app.fetch(new Request(`${origin}/${path}/invalid`), bindings, createExecutionContext())).status).toBe(404);
    }
});

const query = (batch: { sql: string; params: (string | number)[] }[]) => env.DB.batch<{ id: string }>(batch.map(({ sql, params }) => env.DB.prepare(sql).bind(...params)));

it('migrates existing avatar URLs atomically, preserves ownership and expiry, and remains collectable', async () => {
    const client = harness(); await client.verify(); const cookie = await client.signin();
    const user = (await session(client, cookie))!.user;
    const active = crypto.randomUUID(), abandoned = crypto.randomUUID(), orphan = crypto.randomUUID();
    const expired = Date.now() - 10 * 60_000;
    for (const [id, owner, deletion] of [[active, user.id, null], [abandoned, user.id, expired], [orphan, null, expired]] as const) {
        await env.DB.prepare('INSERT INTO "userAvatar" ("id", "userId", "url", "createdAt", "deleteAfter") VALUES (?, ?, ?, ?, ?)')
            .bind(id, owner, `${origin}/avatars/${id}`, Date.now(), deletion).run();
        await env.AVATARS.put(id, 'test-image');
    }
    await env.DB.prepare('UPDATE "user" SET "image" = ? WHERE "id" = ?').bind(`${origin}/avatars/${active}`, user.id).run();
    const foreign = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT INTO "user" ("id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?, ?)')
        .bind(foreign, 'Other user', 'other@example.test', `${origin}/avatars/${active}`, now, now).run();
    const before = await env.DB.prepare('SELECT "url", "deleteAfter" FROM "userAvatar" ORDER BY "id"').all();
    await expect(migrateAvatarUrls(async (batch) => batch.length === 3
        ? query([...batch, { sql: 'INSERT INTO missing_table VALUES (1)', params: [] }]) : query(batch), base)).rejects.toThrow();
    expect((await env.DB.prepare('SELECT "url", "deleteAfter" FROM "userAvatar" ORDER BY "id"').all()).results).toEqual(before.results);
    expect((await session(client, cookie))!.user.image).toBe(`${origin}/avatars/${active}`);
    expect(await migrateAvatarUrls(query, base)).toBe(3);
    expect((await session(client, cookie))!.user.image).toBe(`${base}/${active}`);
    expect(await env.DB.prepare('SELECT "image" FROM "user" WHERE "id" = ?').bind(foreign).first('image')).toBe(`${origin}/avatars/${active}`);
    expect(await env.DB.prepare('SELECT "deleteAfter" FROM "userAvatar" WHERE "id" = ?').bind(active).first('deleteAfter')).toBeNull();
    expect(await env.DB.prepare('SELECT "deleteAfter" FROM "userAvatar" WHERE "id" = ?').bind(abandoned).first('deleteAfter')).toBe(expired);
    expect(await migrateAvatarUrls(query, base)).toBe(0);
    await maintainDatabase(client.bindings);
    expect(await env.AVATARS.head(active)).not.toBeNull();
    expect(await env.AVATARS.head(abandoned)).toBeNull(); expect(await env.AVATARS.head(orphan)).toBeNull();
    expect(await migrateAvatarUrls(query, `${origin}/avatars`)).toBe(1);
    expect((await session(client, cookie))!.user.image).toBe(`${origin}/avatars/${active}`);
    expect(await env.DB.prepare('SELECT "deleteAfter" FROM "userAvatar" WHERE "id" = ?').bind(active).first('deleteAfter')).toBeNull();
});

it('pages large URL changes and can safely resume an interrupted migration', async () => {
    const ids = Array.from({ length: 205 }, () => crypto.randomUUID()).sort();
    await env.DB.batch(ids.map((id) => env.DB.prepare('INSERT INTO "userAvatar" ("id", "url", "createdAt", "deleteAfter") VALUES (?, ?, 1, 2)').bind(id, `${origin}/avatars/${id}`)));
    let writes = 0;
    await expect(migrateAvatarUrls(async (batch) => { if (batch.length === 3 && ++writes === 2) throw new Error('Interrupted'); return query(batch); }, base)).rejects.toThrow('Interrupted');
    expect(await env.DB.prepare('SELECT count(*) FROM "userAvatar" WHERE "url" = ? || \'/\' || "id"').bind(base).first('count(*)')).toBe(200);
    expect(await migrateAvatarUrls(query, base)).toBe(5);
    expect(await env.DB.prepare('SELECT count(*) FROM "userAvatar" WHERE "deleteAfter" = 2').first('count(*)')).toBe(205);
    await expect(migrateAvatarUrls(query, base, { deadline: Date.now() - 1 })).rejects.toThrow('time budget');
});
