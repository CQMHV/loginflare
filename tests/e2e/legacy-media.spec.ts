import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { hashPassword } from 'better-auth/crypto';
import { expect, test } from './fixtures';
import { executeLocal, removeLocalFixtures } from './database';
import { testOrigin } from './runtime';
import { avatarWebp } from '../fixtures/avatars';

test('saved avatar URLs retain anonymous CORS and reuse the redirect across page loads', async ({ page, context, browser }) => {
    test.setTimeout(60_000);
    const id = randomUUID(), email = `ui-${randomUUID()}@loginflare.test`, password = 'Legacy-media-test-731!';
    const now = new Date().toISOString(), hashed = await hashPassword(password);
    executeLocal(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned, locale) VALUES ('${id}', 'Legacy avatar fixture', '${email}', 1, '${now}', '${now}', 'user', 0, 'en-US');
        INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ('${randomUUID()}', '${id}', 'credential', '${id}', '${hashed}', '${now}', '${now}');`);
    try {
        await page.goto('/en-us/login');
        await page.getByLabel('Email or username', { exact: true }).fill(email);
        await page.getByLabel('Password', { exact: true }).fill(password);
        await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await expect(page).toHaveURL('/en-us/account');
        const uploaded = await context.request.post(`${testOrigin}/api/account/avatar`, {
            headers: { Origin: testOrigin, 'Content-Type': 'image/webp' }, data: Buffer.from(avatarWebp, 'base64'),
        });
        expect(uploaded.status()).toBe(200);
        const { image } = await uploaded.json() as { image: string };
        const key = new URL(image).pathname.split('/').at(-1)!;
        expect(key).toMatch(/^[0-9a-f-]{36}$/);
        // Use the loopback alias shared by the native R2 endpoint. Its local
        // SSRF guard rejects Origin:null on three-origin redirect chains; real
        // public R2 domains use the configured anonymous wildcard CORS policy.
        const legacyOrigin = new URL(image).origin;
        const legacy = `${legacyOrigin}/avatars/${key}`;
        // A separate loopback origin represents an application holding an old
        // OIDC picture URL. It loads only the known local avatar, without JS.
        const site = createServer((_request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
            response.end(`<!doctype html><img src="${legacy}" crossorigin="anonymous" referrerpolicy="no-referrer">`);
        });
        await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
        const address = site.address();
        if (!address || typeof address === 'string') throw new Error('Expected a local test port');
        // Playwright routing disables the HTTP cache. This clean context has
        // no routes; the fixture document and all image URLs are loopback-only.
        const external = await browser.newContext({ serviceWorkers: 'block' });
        const invocations = new Set<string>(), errors: string[] = [];
        try {
            for (let index = 0; index < 3; index++) {
                const application = await external.newPage();
                application.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
                application.on('response', (response) => {
                    if (response.url() !== legacy) return;
                    expect(response.status()).toBe(302);
                    const headers = response.headers();
                    expect(headers['cache-control']).toBe('public, max-age=300');
                    expect(headers['access-control-allow-origin']).toBe('*');
                    expect(headers['x-loginflare-test-invocation']).toBeTruthy();
                    invocations.add(headers['x-loginflare-test-invocation']!);
                });
                await application.goto(`http://localhost:${address.port}/page-${index}`);
                await expect.poll(() => application.locator('img').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(256);
                await expect(application.locator('img')).toHaveJSProperty('crossOrigin', 'anonymous');
                await application.close();
            }
            expect(errors).toEqual([]);
            expect(invocations.size).toBe(1);
        } finally {
            await test.info().attach('legacy-media-observations', { body: JSON.stringify({ workerInvocations: invocations.size, errors }), contentType: 'application/json' });
            await external.close();
            await new Promise<void>((resolve, reject) => site.close((error) => error ? reject(error) : resolve()));
        }
    } finally { removeLocalFixtures([email]); }
});
