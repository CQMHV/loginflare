import { expect, test as base, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { testOrigin } from './runtime';

/** Test-only browser emulation; production still validates the real server-side challenge. */
export async function installOfflineRoutes(context: BrowserContext) {
    const allowed = (url: URL) => url.origin === testOrigin || (['web.localhost', 'spa.localhost', '127.0.0.1'].includes(url.hostname) && ['5181', '5182'].includes(url.port));
    // Independent emulated clients must not share the loopback rate-limit bucket.
    const clientAddress = `2001:db8:${randomBytes(12).toString('hex').match(/.{4}/g)!.join(':')}`;
    const clientHeaders = (url: URL, headers: Record<string, string> = {}) => url.origin === testOrigin && url.pathname.startsWith('/api/')
        ? { 'cf-connecting-ip': clientAddress, ...headers } : headers;
    // Playwright's APIRequestContext bypasses browser routing; guard it separately.
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']) {
        const original = Reflect.get(context.request, method);
        Object.defineProperty(context.request, method, { configurable: true, value: (...arguments_: unknown[]) => {
            if (typeof arguments_[0] !== 'string' || !allowed(new URL(arguments_[0], testOrigin))) throw new Error('E2E API requests must remain local.');
            const options = arguments_[1] ?? {};
            if (typeof options !== 'object') throw new Error('Expected API request options.');
            const requestOptions = options as NonNullable<Parameters<APIRequestContext['fetch']>[1]>;
            // APIRequestContext redirects bypass browser route handlers.
            return Reflect.apply(original, context.request, [arguments_[0], { ...requestOptions, headers: clientHeaders(new URL(arguments_[0], testOrigin), requestOptions.headers), maxRedirects: 0 }]);
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
            await route.continue({ headers: clientHeaders(url, route.request().headers()) });
            return;
        }
        if (url.protocol === 'data:' || url.protocol === 'blob:') { await route.continue(); return; }
        await route.abort('blockedbyclient');
    });
}

export const test = base.extend({
    context: async ({ context }, use) => { await installOfflineRoutes(context); await use(context); },
});
export async function switchArea(page: Page, name: string) {
    await page.locator('.area-selector').getByRole('button').click();
    await page.getByRole('menuitem', { name, exact: true }).click();
}

/** Install both listeners before interaction and wait for the actual animation
 * lifecycle. A visible option can still be moving with an opening menu. */
export async function selectMaterialOption(select: Locator, option: Locator) {
    const lifecycle = await select.evaluateHandle((element) => {
        const opened = new Promise<void>((resolve) => element.addEventListener('opened', () => resolve(), { once: true }));
        const closed = new Promise<void>((resolve) => element.addEventListener('closed', () => resolve(), { once: true }));
        return { opened, closed };
    });
    try {
        await select.getByRole('combobox').click();
        await lifecycle.evaluate((events) => events.opened);
        await option.click();
        await lifecycle.evaluate((events) => events.closed);
    } finally { await lifecycle.dispose(); }
}

export { expect };
export type { Page } from '@playwright/test';
