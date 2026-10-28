import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { prepareExampleTls } from '../../examples/setup-tls.mjs';
import { removeLocalApplications, removeLocalFixtures } from './database';
import { snapshotEmails, waitForMail } from './mailbox';

test.use({
    ignoreHTTPSErrors: true,
    launchOptions: {
        args: ['--host-resolver-rules=MAP web.localhost 127.0.0.1, MAP spa.localhost 127.0.0.1'],
    },
});

const emails: string[] = [];
const applicationIds: string[] = [];
const processes: ChildProcess[] = [];

test.afterEach(async () => {
    for (const child of processes) {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
        await new Promise<void>((resolveExit) => {
            child.once('exit', () => resolveExit());
            child.kill();
        });
    }
    processes.length = 0;
    removeLocalApplications(applicationIds);
    applicationIds.length = 0;
    removeLocalFixtures(emails);
    emails.length = 0;
});

function startProcess(args: string[], env: Record<string, string>): { child: ChildProcess; output: () => string } {
    const child = spawn(process.execPath, args, {
        cwd: process.cwd(), env: { ...process.env, ...env }, stdio: 'pipe', windowsHide: true,
    });
    processes.push(child);
    let output = '';
    child.stdout?.on('data', (data: Buffer) => { output = `${output}${data}`.slice(-4_000); });
    child.stderr?.on('data', (data: Buffer) => { output = `${output}${data}`.slice(-4_000); });
    child.on('error', (error) => { output = `${output}${error.message}`.slice(-4_000); });
    return { child, output: () => output };
}

async function waitForExample(port: number, host: string, process: ReturnType<typeof startProcess>): Promise<void> {
    await expect.poll(async () => {
        if (process.child.exitCode !== null) throw new Error(`Example startup failed: ${process.output()}`);
        return await new Promise<boolean>((resolveReady) => {
            const request = httpsRequest({
                hostname: '127.0.0.1', port, path: '/', servername: host, rejectUnauthorized: false,
                headers: { Host: `${host}:${port}` }, timeout: 2_000,
            }, (response) => {
                response.resume();
                resolveReady(response.statusCode === 200);
            });
            request.on('error', () => resolveReady(false));
            request.on('timeout', () => request.destroy());
            request.end();
        });
    }, { timeout: 30_000, message: `Local HTTPS example ${host} should start` }).toBe(true);
}

test('standard Web and SPA clients sign in, refresh, restore, and sign out over local HTTPS', async ({ page }) => {
    test.setTimeout(180_000);
    prepareExampleTls();
    const email = `ui-${randomUUID()}@loginflare.test`;
    emails.push(email);
    const before = await snapshotEmails();
    await page.goto('/en-us/signup');
    await page.getByLabel('Display name', { exact: true }).fill('OIDC Browser Person');
    await page.getByLabel('Username', { exact: true }).fill(`ui_${randomUUID().replaceAll('-', '').slice(0, 20)}`);
    await page.getByLabel('Email address', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill('OIDC-browser-password-739!');
    await page.getByLabel('Confirm password', { exact: true }).fill('OIDC-browser-password-739!');
    await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
    await page.goto(await waitForMail(before, 'verify'));
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    execFileSync(process.execPath, ['scripts/database.mjs', 'promote', '--email', email, '--local'], {
        cwd: process.cwd(), stdio: 'pipe', timeout: 30_000,
    });
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Email or username', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill('OIDC-browser-password-739!');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL('/en-us/account');

    async function register(type: 'web' | 'spa', host: string, port: number) {
        const response = await page.request.post('/api/admin/applications', {
            headers: { Origin: 'http://localhost:5173' },
            data: {
                name: `ui-oauth-${randomUUID()}-${type}`, type,
                redirectUris: [`https://${host}:${port}/callback`],
                postLogoutRedirectUris: [`https://${host}:${port}/logout-callback`],
                scopes: ['openid', 'profile', 'email', 'offline_access'],
            },
        });
        expect(response.status()).toBe(201);
        const result = await response.json() as { application: { clientId: string }; clientSecret?: string };
        applicationIds.push(result.application.clientId);
        return result;
    }

    const web = await register('web', 'web.localhost', 5181);
    const spa = await register('spa', 'spa.localhost', 5182);
    expect(web.clientSecret).toBeTruthy();
    expect(spa.clientSecret).toBeUndefined();
    const webProcess = startProcess(['examples/server-web/server.mjs'], {
        LOGINFLARE_ISSUER: 'http://localhost:5173/api/auth',
        LOGINFLARE_CLIENT_ID: web.application.clientId,
        LOGINFLARE_CLIENT_SECRET: web.clientSecret!,
    });
    const require = createRequire(import.meta.url);
    const vitePackage = require.resolve('vite/package.json');
    const viteMetadata = JSON.parse(readFileSync(vitePackage, 'utf8')) as { bin: { vite: string } };
    const spaProcess = startProcess([resolve(dirname(vitePackage), viteMetadata.bin.vite), '--config', 'examples/spa/vite.config.ts'], {
        VITE_LOGINFLARE_ISSUER: 'http://localhost:5173/api/auth',
        VITE_LOGINFLARE_CLIENT_ID: spa.application.clientId,
    });
    await Promise.all([
        waitForExample(5181, 'web.localhost', webProcess),
        waitForExample(5182, 'spa.localhost', spaProcess),
    ]);

    await page.goto('https://web.localhost:5181');
    await page.getByRole('button', { name: 'Sign in with Loginflare', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Authorize application', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('identity request failed');
    await page.getByRole('button', { name: 'Sign in again', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Authorize application', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Signed in', exact: true })).toBeVisible();
    await expect(page.locator('pre')).toContainText(email);
    await page.getByRole('button', { name: 'Refresh tokens', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Signed in', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out of this app', exact: true }).click();
    await expect(page.getByText('You are signed out of this application.', { exact: true })).toBeVisible();
    const retainedSession = await page.request.get('http://localhost:5173/api/auth/get-session');
    expect((await retainedSession.json()).user.email).toBe(email);
    await page.getByRole('button', { name: 'Sign in with Loginflare', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Signed in', exact: true })).toBeVisible();

    // Local logout remains available when the provider cannot confirm remote revocation.
    const applicationPath = `http://localhost:5173/api/admin/applications/${web.application.clientId}`;
    expect((await page.request.patch(applicationPath, { headers: { Origin: 'http://localhost:5173' }, data: { disabled: true } })).status()).toBe(200);
    await page.getByRole('button', { name: 'Sign out of this app', exact: true }).click();
    await expect(page.getByText('You are signed out of this application.', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Remote token revocation could not be confirmed.');
    expect((await page.request.patch(applicationPath, { headers: { Origin: 'http://localhost:5173' }, data: { disabled: false } })).status()).toBe(200);
    await page.getByRole('button', { name: 'Sign in with Loginflare', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Signed in', exact: true })).toBeVisible();

    await page.goto('https://spa.localhost:5182');
    await page.getByRole('button', { name: 'Sign in with Loginflare', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Authorize application', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Signed in.');
    await expect(page.locator('#profile')).toContainText(email);
    await page.getByRole('button', { name: 'Refresh tokens', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Signed in.');
    const storedValues = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)]);
    expect(storedValues.some((value) => /access_token|refresh_token|id_token/.test(value))).toBe(false);
    await page.reload();
    await expect(page.getByRole('status')).toContainText('Signed in.');
    await expect(page.locator('#profile')).toContainText(email);
    await page.getByRole('button', { name: 'Sign out of this app', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('signed out');
    await page.getByRole('button', { name: 'Sign in with Loginflare', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Signed in.');
    const confirmationPage = await page.context().newPage();
    await confirmationPage.goto(`http://localhost:5173/api/auth/oauth2/end-session?${new URLSearchParams({
        client_id: spa.application.clientId, post_logout_redirect_uri: 'https://spa.localhost:5182/logout-callback',
    })}`);
    await expect(confirmationPage.getByRole('heading', { name: 'Confirm logout', exact: true })).toBeVisible();
    const confirmed = confirmationPage.waitForResponse((response) => response.url().endsWith('/api/auth/oauth2/end-session/confirm'));
    await confirmationPage.getByRole('button', { name: 'Confirm logout', exact: true }).click();
    const confirmedResponse = await confirmed;
    expect(confirmedResponse.request().headers().origin).toBe('http://localhost:5173');
    expect(confirmedResponse.status()).toBe(302);
    expect(confirmedResponse.headers().location).toBe('https://spa.localhost:5182/logout-callback');
    await expect(confirmationPage).toHaveURL('https://spa.localhost:5182/');
    await expect(confirmationPage.getByRole('status')).toContainText('signed out');
    expect(await (await page.request.get('http://localhost:5173/api/auth/get-session')).json()).toBeNull();
    await confirmationPage.close();
    await page.getByRole('button', { name: 'Sign out of this app and Loginflare', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('signed out');
    expect(await (await page.request.get('http://localhost:5173/api/auth/get-session')).json()).toBeNull();
    await page.goto('https://web.localhost:5181');
    await page.getByRole('button', { name: 'Sign out of this app and Loginflare', exact: true }).click();
    await expect(page.getByText('You are signed out of this application.', { exact: true })).toBeVisible();
});
