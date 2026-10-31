import { expect, test } from './fixtures';

test('uses self-hosted MD3 fonts when ready before the first text rendering', async ({ page, context }) => {
    const fontResponses: { url: string; status: number }[] = [];
    page.on('response', (response) => {
        if (response.request().resourceType() === 'font') fontResponses.push({ url: response.url(), status: response.status() });
    });
    let releaseApp!: () => void;
    const appGate = new Promise<void>((resolve) => { releaseApp = resolve; });
    await page.route('**/assets/index-*.js', async (route) => { await appGate; await route.continue(); });
    try {
        await page.goto('/zh-cn/login', { waitUntil: 'commit' });
        await page.waitForFunction(() => document.fonts.size > 0);
        // Exercise the fast/ready case independently of the late-font cases
        // below: optional fonts must be available before text is first drawn.
        await page.evaluate(() => Promise.all([
            document.fonts.load('500 16px "Roboto Variable"', 'Loginflare'),
            document.fonts.load('400 32px "Noto Sans SC Variable"', '欢迎回来账号管理'),
        ]));
    } finally { releaseApp(); }
    await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible();
    const fonts = await page.evaluate(async () => {
        const weights = [400, 500, 700];
        const loaded = await Promise.all(weights.flatMap((weight) => [
            document.fonts.load(`${weight} 16px "Roboto Variable"`, 'Loginflare'),
            document.fonts.load(`${weight} 16px "Noto Sans SC Variable"`, '账号管理'),
        ]));
        await document.fonts.ready;
        const root = getComputedStyle(document.documentElement);
        const input = document.querySelector('md-outlined-text-field')?.shadowRoot?.querySelector('input');
        return {
            loaded: loaded.map((faces) => faces.length > 0 && faces.every((face) => face.status === 'loaded')),
            pageFamily: root.fontFamily,
            materialFamily: input ? getComputedStyle(input).fontFamily : '',
            synthesis: root.fontSynthesis,
        };
    });
    expect(fonts.loaded).toEqual(Array(6).fill(true));
    expect(fonts.pageFamily).toContain('Roboto Variable');
    expect(fonts.pageFamily).toContain('Noto Sans SC Variable');
    expect(fonts.materialFamily).toBe(fonts.pageFamily);
    expect(fonts.synthesis).toBe('none');
    // Computed font-family alone cannot prove that the browser used a webfont.
    const client = await context.newCDPSession(page);
    try {
        await client.send('DOM.enable');
        await client.send('CSS.enable');
        const { root } = await client.send('DOM.getDocument');
        for (const [selector, family] of [['.brand', /Roboto/], ['.auth-form-container h2', /Noto Sans SC/]] as const) {
            const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
            const { fonts: rendered } = await client.send('CSS.getPlatformFontsForNode', { nodeId });
            expect(rendered.some((font) => font.isCustomFont && font.glyphCount > 0 && family.test(font.familyName))).toBe(true);
        }
    } finally { await client.detach(); }
    expect(fontResponses.some((response) => response.url.includes('/roboto-'))).toBe(true);
    expect(fontResponses.some((response) => response.url.includes('/noto-sans-sc-'))).toBe(true);
    expect(fontResponses.every((response) => new URL(response.url).origin === new URL(page.url()).origin && response.status === 200)).toBe(true);
    const resources = await page.evaluate(() => performance.getEntriesByType('resource')
        .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming && entry.name.endsWith('.woff2'))
        .map((entry) => ({ url: entry.name, bytes: entry.encodedBodySize })));
    await test.info().attach('font-loading.json', { body: JSON.stringify(resources, null, 2), contentType: 'application/json' });
});

test('keeps text readable and forms usable when font downloads fail', async ({ page }) => {
    await page.route('**/*.woff2', (route) => route.abort('failed'));
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/zh-cn/login');
    await page.evaluate(async () => { await document.fonts.ready; });
    await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible();
    const email = page.getByLabel('邮箱或用户名', { exact: true });
    await email.fill('font-fallback@example.test');
    await expect(email).toHaveValue('font-fallback@example.test');
    expect(await page.evaluate(() => ({
        fits: document.documentElement.scrollWidth <= innerWidth,
        optional: [...document.fonts].every((face) => face.display === 'optional'),
        failed: [...document.fonts].some((face) => face.status === 'error'),
    }))).toEqual({ fits: true, optional: true, failed: true });
});

for (const locale of ['en-us', 'zh-cn']) {
    for (const width of [1280, 375]) {
        test(`keeps rendered text stable when fonts arrive late at ${width}px in ${locale}`, async ({ page }) => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            let requests = 0;
            await page.route('**/*.woff2', async (route) => { requests++; await gate; await route.continue(); });
            try {
                await page.setViewportSize({ width, height: 812 });
                await page.goto(`/${locale}/login`, { waitUntil: 'domcontentloaded' });
                await page.locator('.auth-form-container h2').waitFor({ state: 'visible' });
                // Deliberately hold fonts beyond the browser's short optional
                // blocking period; this is the network condition being tested.
                await page.waitForTimeout(500);
                const measure = () => page.evaluate(() => ['.auth-top .brand', '.auth-form-container h2', '.section-description', '.check-label', '.auth-crosslink'].map((selector) => {
                    const element = document.querySelector(selector)!;
                    const range = document.createRange();
                    range.selectNodeContents(element);
                    const text = range.getBoundingClientRect(), box = element.getBoundingClientRect();
                    return { selector, x: box.x, y: box.y, width: box.width, height: box.height, textX: text.x, textY: text.y, textWidth: text.width, textHeight: text.height, lines: range.getClientRects().length };
                }));
                const before = await measure();
                expect(requests).toBeGreaterThan(0);
                release();
                await page.evaluate(async () => { await document.fonts.ready; });
                expect(await measure()).toEqual(before);
                expect(await page.evaluate(() => [...document.fonts].every((face) => face.display === 'optional'))).toBe(true);
            } finally { release(); }
        });
    }
}
