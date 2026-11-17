import { expect, type Response } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { test } from './fixtures';
import { snapshotEmails, waitForMail } from './mailbox';
import { testOrigin } from './runtime';
import { removeLocalFixtures } from './database';

const fixtureEmails: string[] = [];
test.afterEach(() => { removeLocalFixtures(fixtureEmails); fixtureEmails.length = 0; });

test('loads management code on demand and consolidates a completed browser login', async ({ page, context }, testInfo) => {
    const username = `perf${randomUUID().replaceAll('-', '').slice(0, 12)}`, password = 'Local-performance-regression-20261116!';
    const email = `ui-${randomUUID()}@loginflare.test`;
    fixtureEmails.push(email);
    const before = await snapshotEmails();
    const signup = await context.request.post(`${testOrigin}/api/auth/sign-up/email`, {
        headers: { Origin: testOrigin, 'x-captcha-response': 'isolated-e2e-captcha-token' },
        data: { email, username, password, name: 'Performance regression', locale: 'en-US', callbackURL: `${testOrigin}/en-us/verified` },
    });
    expect(signup.status()).toBe(200);
    const verified = await context.request.get(await waitForMail(before, 'verify'));
    expect(verified.status()).toBe(302);
    const scripts: string[] = [], requests: string[] = [], scriptBodies: Promise<number>[] = [], staticResponses: Response[] = [];
    page.on('response', (response) => {
        if (new URL(response.url()).origin === testOrigin && new URL(response.url()).pathname.startsWith('/assets/')) staticResponses.push(response);
        if (new URL(response.url()).origin === testOrigin && response.request().resourceType() === 'script') scriptBodies.push(response.body().then((body) => body.length));
    });
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.origin !== testOrigin) return;
        if (request.resourceType() === 'script') scripts.push(url.pathname);
        if (url.pathname.startsWith('/api/')) requests.push(`${request.method()} ${url.pathname}`);
    });
    const document = await page.goto('/en-us/login');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    expect(await document!.headerValue('X-Loginflare-Test-Worker')).toBe('1');
    expect(staticResponses.length).toBeGreaterThan(0);
    for (const response of staticResponses) {
        expect(await response.headerValue('X-Loginflare-Test-Worker'), response.url()).toBeNull();
        expect(await response.headerValue('X-Content-Type-Options'), response.url()).toBe('nosniff');
    }
    expect(scripts.some((path) => /\/(AccessManagement|Applications|Machines|Webhooks|BrandingSettings|MfaSettings|Emails)-/.test(path))).toBe(false);
    const coldScriptBytes = (await Promise.all(scriptBodies)).reduce((sum, size) => sum + size, 0);
    // Keep headroom below the pre-split 1.34 MB login payload.
    expect(coldScriptBytes).toBeLessThan(1_100_000);
    await page.getByRole('textbox', { name: 'Email or username', exact: true }).fill(username);
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
    requests.length = 0;
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your profile', exact: true })).toBeVisible();
    const loginRequests = [...requests];
    const loginAccountReads = loginRequests.filter((path) => path === 'GET /api/browser/accounts').length;
    expect(loginRequests.filter((path) => path === 'GET /api/auth/get-session')).toHaveLength(1);
    expect(loginAccountReads).toBeLessThanOrEqual(1);
    expect(loginRequests.length).toBeLessThanOrEqual(5);
    const menuStart = requests.length;
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByText('Performance regression', { exact: true })).toBeVisible();
    // A fresh cached list needs no read; an uncached first opening needs at most one.
    const menuRequests = requests.slice(menuStart);
    expect(menuRequests.filter((path) => path === 'GET /api/browser/accounts').length).toBeLessThanOrEqual(1);
    expect(requests.filter((path) => path === 'GET /api/auth/get-session')).toHaveLength(1);
    expect(requests.length).toBeLessThanOrEqual(6);
    await testInfo.attach('local-performance.json', { body: JSON.stringify({ coldScriptBytes, loginRequests, menuRequests }, null, 4), contentType: 'application/json' });
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Security', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Set up authenticator', exact: true })).toBeVisible();
    expect(scripts.some((path) => /\/MfaSettings-/.test(path))).toBe(true);
});
