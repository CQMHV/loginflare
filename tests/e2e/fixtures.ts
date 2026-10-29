import { expect, test as base, type BrowserContext } from '@playwright/test';
import { testOrigin } from './runtime';

/** Test-only browser emulation; production still validates the real server-side challenge. */
export async function installOfflineRoutes(context: BrowserContext) {
    const allowed = (url: URL) => url.origin === testOrigin || (['web.localhost', 'spa.localhost', '127.0.0.1'].includes(url.hostname) && ['5181', '5182'].includes(url.port));
    // Playwright's APIRequestContext bypasses browser routing; guard it separately.
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']) {
        const original = Reflect.get(context.request, method);
        Object.defineProperty(context.request, method, { configurable: true, value: (...arguments_: unknown[]) => {
            if (typeof arguments_[0] !== 'string' || !allowed(new URL(arguments_[0], testOrigin))) throw new Error('E2E API requests must remain local.');
            const options = arguments_[1] ?? {};
            if (typeof options !== 'object') throw new Error('Expected API request options.');
            // APIRequestContext redirects bypass browser route handlers.
            return Reflect.apply(original, context.request, [arguments_[0], { ...options, maxRedirects: 0 }]);
        } });
    }
    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === 'challenges.cloudflare.com' && url.pathname === '/turnstile/v0/api.js') {
            await route.fulfill({ contentType: 'text/javascript', body: `window.turnstile = {
                render(element, options) { const id = 'e2e-' + Math.random(); const marker = document.createElement('span');
                    marker.dataset.widget = id; marker.dataset.theme = options.theme; marker.textContent = 'Local verification'; element.appendChild(marker);
                    queueMicrotask(() => options.callback('isolated-e2e-captcha-token')); return id; },
                remove(id) { document.querySelector('[data-widget="' + id + '"]')?.remove(); }
            };` });
            return;
        }
        if (allowed(url)) {
            await route.continue();
            return;
        }
        if (url.protocol === 'data:' || url.protocol === 'blob:') { await route.continue(); return; }
        await route.abort('blockedbyclient');
    });
}

export const test = base.extend({
    context: async ({ context }, use) => { await installOfflineRoutes(context); await use(context); },
});
export { expect };
export type { Page } from '@playwright/test';
