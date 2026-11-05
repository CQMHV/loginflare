import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import app from '../src/server/index';
import { maintainDatabase } from '../src/server/maintenance';
import { inspectImage } from '../src/shared/avatars';
import { maximumImageBytes } from '../src/shared/image-limits';
import { avatarJpeg, avatarPng, avatarWebp, avatarWebpWithMetadata, sourcePng } from './fixtures/avatars';
import { harness, origin, session } from './helpers';
import { interceptSql } from './sql-race';

const bytes = (base64 = avatarWebp) => Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new Request(input, init).url !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') throw new Error('Unexpected network');
        return Response.json({ success: true });
    });
});
afterEach(async () => { vi.unstubAllGlobals(); await reset(); });

async function avatarRequest(cookie?: string, body: Uint8Array | null = bytes(), bindings = harness().bindings, headers: Record<string, string> = {}, method = body ? 'POST' : 'DELETE') {
    const context = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}/api/account/avatar`, {
        method, headers: { Origin: origin, ...(body ? { 'Content-Type': 'image/webp' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? new Uint8Array(body).buffer : undefined,
    }), bindings, context);
    await waitOnExecutionContext(context);
    return response;
}
async function actor() {
    const client = harness(); await client.verify();
    const cookie = await client.signin();
    return { client, cookie, identity: (await session(client, cookie))! };
}
async function image(response: Response) {
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json<{ image: string }>()).image;
}

it('imports only into an empty avatar and preserves a concurrent/manual photo', async () => {
    const { client, cookie } = await actor();
    const imported = await image(await avatarRequest(cookie, bytes(), client.bindings, { 'X-Avatar-Import': 'if-empty' }));
    const manual = await image(await avatarRequest(cookie, bytes(), client.bindings));
    expect(manual).not.toBe(imported);
    const skipped = await avatarRequest(cookie, bytes(), client.bindings, { 'X-Avatar-Import': 'if-empty' });
    expect(await skipped.json()).toMatchObject({ imported: false });
    expect((await session(client, cookie))!.user.image).toBe(manual);
    await avatarRequest(cookie, null, client.bindings);
    const retried = await image(await avatarRequest(cookie, bytes(), client.bindings, { 'X-Avatar-Import': 'if-empty' }));
    expect(retried).not.toBe(manual);
});

it('stores an owned normalized avatar, strips metadata, and serves it without an identity/database read', async () => {
    const { client, cookie, identity } = await actor();
    const url = await image(await avatarRequest(cookie, bytes(avatarWebpWithMetadata), client.bindings));
    expect((await session(client, cookie))!.user).toMatchObject({ id: identity.user.id, image: url });
    expect(await env.DB.prepare('SELECT "deleteAfter" FROM "userAvatar" WHERE "url" = ?').bind(url).first('deleteAfter')).toBeNull();
    const database = new Proxy(env.DB, { get() { throw new Error('Image reads must not use D1'); } });
    const publicBindings = { ...client.bindings, DB: database };
    const get = await app.fetch(new Request(url), publicBindings, createExecutionContext());
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/webp');
    expect(get.headers.get('cache-control')).toBe('public, max-age=300');
    expect(get.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(get.headers.get('access-control-allow-origin')).toBe('*');
    expect(get.headers.has('set-cookie')).toBe(false);
    const data = new Uint8Array(await get.arrayBuffer());
    expect(new TextDecoder().decode(data)).not.toContain('fixture-private-location');
    expect(inspectImage(data)).toMatchObject({ width: 256, height: 256 });
    const conditional = await app.fetch(new Request(url, { headers: { 'If-None-Match': get.headers.get('etag')! } }), publicBindings, createExecutionContext());
    expect(conditional.status).toBe(304);
    const head = await app.fetch(new Request(url, { method: 'HEAD' }), publicBindings, createExecutionContext());
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe(String(data.length));
});

it('requires same-origin eligible sessions and keeps direct native image changes closed', async () => {
    expect((await avatarRequest()).status).toBe(401);
    const { client, cookie, identity } = await actor();
    expect((await avatarRequest(cookie, bytes(), client.bindings, { Origin: 'https://other.example.test' })).status).toBe(403);
    expect((await client.request('/api/auth/update-user', { cookie, body: { image: 'https://external.example.test/avatar' } })).status).toBe(400);
    await env.DB.prepare('UPDATE "user" SET banned = 1 WHERE id = ?').bind(identity.user.id).run();
    expect((await avatarRequest(cookie, bytes(), client.bindings)).status).toBe(403);
    expect((await env.AVATARS.list()).objects).toHaveLength(0);
});

it('rejects unsafe, malformed, oversized, wrongly typed and non-normalized uploads', async () => {
    const { client, cookie } = await actor();
    for (const [data, type, expected] of [
        [new TextEncoder().encode('<svg onload="alert(1)"/>'), 'image/svg+xml', 400],
        [bytes().subarray(0, 30), 'image/webp', 400],
        [bytes(), 'text/html', 400],
        [bytes(avatarPng), 'image/png', 400],
        [bytes(avatarJpeg), 'image/jpeg', 400],
        [bytes(avatarPng), 'image/webp', 400],
        [bytes(sourcePng), 'image/png', 400],
        [new Uint8Array(maximumImageBytes + 1), 'image/webp', 413],
    ] as const) expect((await avatarRequest(cookie, data, client.bindings, { 'Content-Type': type })).status).toBe(expected);
    expect((await env.AVATARS.list()).objects).toHaveLength(0);
    expect((await session(client, cookie))!.user.image).toBeNull();
});

it('removes JPEG/WebP metadata, handles JPEG marker fill, and rejects animation or mismatched WebP dimensions', () => {
    const privateData = new TextEncoder().encode('fixture-private-location');
    const jpeg = bytes(avatarJpeg);
    const annotated = new Uint8Array(jpeg.length + privateData.length + 5);
    annotated.set(jpeg.subarray(0, 2));
    annotated.set([255, 255, 0xe1, 0, privateData.length + 2], 2);
    annotated.set(privateData, 7); annotated.set(jpeg.subarray(2), 7 + privateData.length);
    expect(new TextDecoder().decode(inspectImage(annotated).sanitized())).not.toContain('fixture-private-location');
    const webp = bytes(avatarWebp);
    const chunk = (type: string, data: Uint8Array) => {
        const result = new Uint8Array(8 + data.length + data.length % 2);
        result.set(new TextEncoder().encode(type)); new DataView(result.buffer).setUint32(4, data.length, true); result.set(data, 8);
        return result;
    };
    const extended = chunk('VP8X', new Uint8Array([0x2c, 0, 0, 0, 255, 0, 0, 255, 0, 0]));
    const frames: Uint8Array[] = [];
    for (let at = 12; at < webp.length;) {
        const type = String.fromCharCode(...webp.subarray(at, at + 4));
        const length = new DataView(webp.buffer).getUint32(at + 4, true), end = at + 8 + length + length % 2;
        if (['VP8 ', 'VP8L', 'ALPH'].includes(type)) frames.push(webp.subarray(at, end));
        at = end;
    }
    const chunks = [extended, ...frames, ...['EXIF', 'XMP ', 'ICCP'].map((type) => chunk(type, privateData))];
    const decorated = new Uint8Array(12 + chunks.reduce((sum, value) => sum + value.length, 0));
    decorated.set(webp.subarray(0, 12));
    let offset = 12;
    for (const value of chunks) { decorated.set(value, offset); offset += value.length; }
    new DataView(decorated.buffer).setUint32(4, decorated.length - 8, true);
    const clean = inspectImage(decorated).sanitized();
    expect(clean[20]).toBe(0);
    expect(new TextDecoder().decode(clean)).not.toContain('fixture-private-location');
    decorated[20] = 2;
    expect(() => inspectImage(decorated)).toThrow();
    decorated[20] = 0; decorated[24] = 254;
    expect(() => inspectImage(decorated)).toThrow();
});

it('allows larger source dimensions and rejects dimensions beyond the source bounds before decoding', () => {
    const png = (width: number, height: number) => {
        const data = bytes(avatarPng);
        const header = new DataView(data.buffer);
        header.setUint32(16, width); header.setUint32(20, height);
        return data;
    };
    for (const [width, height] of [[10_000, 3_000], [16_384, 6_000], [6_000, 16_384], [10_000, 10_000]]) {
        expect(inspectImage(png(width, height))).toMatchObject({ width, height });
    }
    for (const [width, height] of [[16_385, 1], [1, 16_385], [10_001, 10_000]]) {
        expect(() => inspectImage(png(width, height))).toThrow();
    }
});

it('atomically limits concurrent replacements and retires every obsolete file without losing the winner', async () => {
    const { client, cookie } = await actor();
    const replies = await Promise.all(Array.from({ length: 12 }, () => avatarRequest(cookie, bytes(), client.bindings)));
    expect(replies.filter((response) => response.status === 200)).toHaveLength(10);
    expect(replies.filter((response) => response.status === 429)).toHaveLength(2);
    expect(replies.find((response) => response.status === 429)?.headers.get('retry-after')).toBeTruthy();
    const current = (await session(client, cookie))!.user.image!;
    expect(await env.AVATARS.head(new URL(current).pathname.split('/').at(-1)!)).not.toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "userAvatar" WHERE "deleteAfter" IS NULL').first('n')).toBe(1);
    await maintainDatabase(client.bindings, Date.now() + 6 * 60_000);
    expect((await env.AVATARS.list()).objects).toHaveLength(1);
    expect((await avatarRequest(cookie, null, client.bindings)).status).toBe(200);
    expect((await session(client, cookie))!.user.image).toBeNull();
    await maintainDatabase(client.bindings, Date.now() + 6 * 60_000);
    expect((await env.AVATARS.list()).objects).toHaveLength(0);
});

it('does not attach a file after the uploading session is revoked', async () => {
    const { client, cookie, identity } = await actor();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const bucket = new Proxy(env.AVATARS, { get(target, property) {
        if (property === 'put') return async (...args: Parameters<R2Bucket['put']>) => { entered(); await gate; return target.put(...args); };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const pending = avatarRequest(cookie, bytes(), { ...client.bindings, AVATARS: bucket });
    await ready;
    await env.DB.prepare('DELETE FROM "session" WHERE id = ?').bind(identity.session.id).run();
    release(); expect((await pending).status).toBe(401);
    expect(await env.DB.prepare('SELECT image FROM "user" WHERE id = ?').bind(identity.user.id).first('image')).toBeNull();
    await maintainDatabase(client.bindings, Date.now() + 66 * 60_000);
    expect((await env.AVATARS.list()).objects).toHaveLength(0);
});

it('keeps failed storage writes collectable and never deletes a committed image after an uncertain database result', async () => {
    const { client, cookie } = await actor();
    const bucket = new Proxy(env.AVATARS, { get(target, property) {
        if (property === 'put') return async () => { throw new Error('Test R2 unavailable'); };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect((await avatarRequest(cookie, bytes(), { ...client.bindings, AVATARS: bucket })).status).toBe(503);
    const injection = interceptSql(env.DB, /^UPDATE "user" SET "image"/, async () => { throw new Error('Test response lost after commit'); }, true);
    expect((await avatarRequest(cookie, bytes(), { ...client.bindings, DB: injection.proxy })).status).toBe(503);
    expect(injection.invoked()).toBe(true);
    const current = (await session(client, cookie))!.user.image!;
    await maintainDatabase(client.bindings, Date.now() + 2 * 3_600_000);
    const objects = (await env.AVATARS.list()).objects;
    expect(objects.map((object) => object.key)).toEqual([new URL(current).pathname.split('/').at(-1)]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "userAvatar"').first('n')).toBe(1);
});

it('seeks expired assets in bounded indexed batches', async () => {
    const now = Date.now();
    await env.DB.batch(Array.from({ length: 501 }, () => {
        const id = crypto.randomUUID();
        return env.DB.prepare('INSERT INTO "userAvatar" (id, url, "createdAt", "deleteAfter") VALUES (?, ?, ?, ?)').bind(id, `${origin}/avatars/${id}`, now - 600_000, now - 600_000);
    }));
    const batches: number[] = [];
    const bucket = new Proxy(env.AVATARS, { get(target, property) {
        if (property === 'delete') return async (keys: string[]) => { batches.push(keys.length); return target.delete(keys); };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const result = await maintainDatabase({ DB: env.DB, AVATARS: bucket }, now);
    expect(result.batches).toBeLessThanOrEqual(20);
    expect(batches).toEqual([500, 1]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "userAvatar"').first('n')).toBe(0);
    const plan = await env.DB.prepare('EXPLAIN QUERY PLAN SELECT id FROM "userAvatar" WHERE "deleteAfter" <= ? ORDER BY "deleteAfter", id LIMIT 500').bind(now).all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join(' ')).toContain('userAvatar_deleteAfter_id_idx');
});

it('retires deleted owners and retries failed R2 collection before advancing metadata', async () => {
    const { client, cookie, identity } = await actor();
    const url = await image(await avatarRequest(cookie, bytes(), client.bindings));
    await env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(identity.user.id).run();
    const row = await env.DB.prepare('SELECT "userId", "deleteAfter" FROM "userAvatar" WHERE url = ?').bind(url).first<{ userId: string | null; deleteAfter: number | null }>();
    expect(row?.userId).toBeNull(); expect(row?.deleteAfter).toBeTypeOf('number');
    const bucket = new Proxy(env.AVATARS, { get(target, property) {
        if (property === 'delete') return async () => { throw new Error('Test collection unavailable'); };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(maintainDatabase({ DB: env.DB, AVATARS: bucket }, Date.now() + 600_000)).rejects.toThrow('Test collection unavailable');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "userAvatar"').first('n')).toBe(1);
    expect((await env.AVATARS.list()).objects).toHaveLength(1);
    await maintainDatabase(client.bindings, Date.now() + 600_000);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM "userAvatar"').first('n')).toBe(0);
    expect((await env.AVATARS.list()).objects).toHaveLength(0);
});

it('does not start R2 deletion when the candidate query exhausts the maintenance time budget', async () => {
    const now = Date.now(), id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO "userAvatar" (id, url, "createdAt", "deleteAfter") VALUES (?, ?, ?, ?)').bind(id, `${origin}/avatars/${id}`, now - 600_000, now - 600_000).run();
    let elapsed = 0;
    const injection = interceptSql(env.DB, /"deleteAfter" AS "expiresAt"/, async () => { elapsed = 20_001; }, true);
    const database = injection.proxy;
    const bucket = new Proxy(env.AVATARS, { get() { throw new Error('No R2 operation may start after the budget expires'); } });
    const result = await maintainDatabase({ DB: database, AVATARS: bucket }, now, () => elapsed);
    expect(result.budgetExhausted).toBe(true);
    expect(injection.invoked()).toBe(true);
    expect(await env.DB.prepare('SELECT id FROM "userAvatar" WHERE id = ?').bind(id).first('id')).toBe(id);
});
