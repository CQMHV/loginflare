import { test, expect } from './fixtures';
import { testOrigin } from './runtime';
import { browserAccountStorageKey } from '../../src/client/browser-account-selection';

test('isolated installation UI advances migrations and requires the original authorized browser to finish', async ({ page, context }, testInfo) => {
    let authenticated = false; let prepared = 0; let configured = 0; let candidate = false; let verified = false;
    let installed = false; let cleanupPending = false; let cleanupCalls = 0; let finishCalls = 0;
    const forbidden: string[] = [];
    const submitted: Record<string, unknown>[] = [];
    await context.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        const respond = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        if (path === '/api/setup/status') return respond({ mode: installed ? 'ready' : 'installing', installation: installed ? 'complete' : 'installing', installed, authenticated,
            step: configured >= 2 ? 'candidate' : configured === 1 ? 'sending' : prepared >= 3 ? 'services' : 'database', schemaReady: prepared >= 3,
            configObserved: configured >= 2, candidateCreated: candidate, candidateEmail: candidate ? 'setup-admin@example.test' : undefined,
            candidateVerified: verified, cleanupPending, turnstileSiteKey: configured >= 2 ? 'isolated-widget' : undefined,
            buildId: 'browser-fixture-build', runtimeVersion: 'browser-fixture-runtime', configRevision: configured >= 2 ? 'revision-1' : '',
            progress: { phase: prepared >= 3 ? 'complete' : 'migrations', committed: Array.from({ length: prepared }, (_, index) => `000${index + 1}.sql`) } });
        if (path === '/api/setup/authenticate') { authenticated = true; return respond({ authenticated }); }
        if (path === '/api/setup/prepare') { prepared++; return respond({ pending: prepared < 3 }, prepared < 3 ? 202 : 200); }
        if (path === '/api/setup/options') return respond({ zones: [{ id: 'a'.repeat(32), name: 'example.test' }] });
        if (path === '/api/setup/configure') { configured++; return respond({ pending: configured < 2 }, configured < 2 ? 202 : 200); }
        if (path === '/api/setup/candidate') { submitted.push(route.request().postDataJSON()); candidate = true; return respond({ candidate: true }); }
        if (path === '/api/setup/finish') { finishCalls++; installed = true; cleanupPending = true; return respond({ installed, cleanupPending }); }
        if (path === '/api/setup/cleanup') { cleanupCalls++; cleanupPending = cleanupCalls < 2; return respond({ cleanupPending }, cleanupPending ? 202 : 200); }
        forbidden.push(path); return respond({ code: 'UNEXPECTED_BUSINESS_REQUEST' }, 503);
    });
    await page.goto('/en-us/setup');
    await expect(page.getByRole('heading', { name: 'Verify deployment ownership' })).toBeVisible();
    await page.getByLabel('Cloudflare User API Token').fill('browser-only-install-token-000000000');
    await page.getByRole('button', { name: 'Verify and continue' }).click();
    await page.getByRole('button', { name: 'Prepare database' }).click();
    await expect(page.getByRole('heading', { name: 'Connect services' })).toBeVisible();
    expect(prepared).toBe(3);
    await page.screenshot({ path: testInfo.outputPath('setup-services.png'), fullPage: true });
    await page.getByRole('button', { name: 'Load my domains' }).click();
    await page.getByLabel('Sender email address').fill('no-reply@notify.example.test');
    await page.getByLabel('Sending domain', { exact: true }).selectOption('a'.repeat(32));
    await page.getByRole('button', { name: 'Configure and continue' }).click();
    await expect(page.getByRole('heading', { name: 'Create your administrator' })).toBeVisible();
    await page.getByLabel('Display name').fill('Installation admin');
    await page.getByLabel('Username', { exact: true }).fill('installation_admin');
    await page.getByLabel('Administrator email').fill('setup-admin@example.test');
    await page.getByLabel('Password', { exact: true }).fill('Private-install-password-812!');
    await page.getByRole('button', { name: 'Create account and send verification' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    expect(submitted[0]).toMatchObject({ email: 'setup-admin@example.test', locale: 'en-US', captchaToken: 'isolated-e2e-captcha-token' });
    const otherDevice = await context.newPage();
    verified = true;
    await otherDevice.goto('/en-us/setup/verified');
    await expect(otherDevice.getByRole('heading', { name: 'Email verified' })).toBeVisible();
    expect(finishCalls).toBe(0);
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await page.getByRole('button', { name: 'Finish installation' }).click();
    await expect(page.getByRole('heading', { name: 'Your account center is ready' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove temporary credentials' }).click();
    await expect(page.getByRole('button', { name: 'Remove temporary credentials' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove temporary credentials' }).click();
    await expect(page.getByRole('button', { name: 'Remove temporary credentials' })).toHaveCount(0);
    expect(finishCalls).toBe(1);
    expect(forbidden).toEqual([]);
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(storage).not.toContain('browser-only-install-token');
    expect(storage).not.toContain('Private-install-password');
});

test('maintenance UI recovers independently of business APIs and blocks unverified legacy adoption', async ({ page, context }) => {
    const requested: string[] = [];
    await context.route('**/api/**', async (route) => {
        const path = new URL(route.request().url()).pathname; requested.push(path);
        const value = path === '/api/maintenance/status'
            ? { mode: 'adoption', installed: true, authenticated: true, error: 'VERIFIED_LEGACY_DRAIN_REQUIRED', progress: { phase: 'keys' } }
            : { code: 'UNEXPECTED_REQUEST' };
        await route.fulfill({ status: path === '/api/maintenance/status' ? 200 : 503, contentType: 'application/json', body: JSON.stringify(value) });
    });
    await page.goto('/zh-cn/maintenance');
    await expect(page.getByRole('heading', { name: '安装维护' })).toBeVisible();
    await expect(page.getByRole('button', { name: '继续升级' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '进入维护' })).toBeDisabled();
    await expect(page.getByText(/勾选确认或固定等待不能作为证据/)).toBeVisible();
    expect(requested.every((path) => path === '/api/maintenance/status')).toBe(true);
});

test('reserved candidate email without a completed account keeps the creation form available', async ({ page, context }) => {
    await context.route('**/api/setup/status', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        mode: 'installing', installed: false, authenticated: true, schemaReady: true, configObserved: true,
        candidateCreated: false, candidateEmail: 'reserved-admin@example.test', candidateVerified: false,
        turnstileSiteKey: 'isolated-widget', progress: { phase: 'complete' },
    }) }));
    await page.goto('/en-us/setup');
    await expect(page.getByRole('heading', { name: 'Create your administrator' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toHaveCount(0);
    await expect(page.getByLabel('Administrator email')).toHaveValue('reserved-admin@example.test');
    await expect(page.getByLabel('Administrator email')).toHaveAttribute('readonly', '');
    await expect(page.getByLabel('Password', { exact: true })).toBeEditable();
});

test('a new build already draining still requires persisted backup confirmation before advancing', async ({ page, context }) => {
    let backupConfirmed = false; let advances = 0; let entered = false;
    await context.route('**/api/maintenance/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/maintenance/enter') { entered = true; backupConfirmed = true; }
        if (path === '/api/maintenance/advance') { expect(entered).toBe(true); advances++; }
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(path.endsWith('/status') ? {
            mode: advances >= 2 ? 'ready' : 'draining', installed: true, authenticated: true, backupConfirmed,
            progress: { phase: advances >= 2 ? 'complete' : 'migrations', committed: advances ? ['0001.sql'] : [] },
        } : { backupConfirmed }) });
    });
    await page.goto('/en-us/maintenance');
    await expect(page.getByRole('button', { name: 'Continue upgrade' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Enter maintenance' })).toBeDisabled();
    await page.getByLabel('I have verified the D1 recovery point and matching object-storage backup.').check();
    await page.getByRole('button', { name: 'Enter maintenance' }).click();
    await expect(page.getByRole('button', { name: 'Continue upgrade' })).toBeVisible();
    expect(advances).toBe(0);
    await page.getByRole('button', { name: 'Continue upgrade' }).click();
    await expect(page.getByRole('button', { name: 'Enter maintenance' })).toBeVisible();
    expect(advances).toBe(2);
});

test('configuration refresh restores the selected values without resetting an unsaved draft', async ({ page, context }) => {
    const selected = { authUrl: 'https://accounts.example.test', emailFrom: 'no-reply@notify.example.test', zoneId: 'b'.repeat(32), siteZoneId: 'b'.repeat(32) };
    let saved = false; let observed = false;
    const submitted: Record<string, unknown>[] = [];
    await context.route('**/api/setup/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        let value: unknown;
        if (path === '/api/setup/status') value = { mode: 'installing', installed: false, authenticated: true, schemaReady: true,
            configObserved: observed, step: saved ? 'sending' : 'services', configuration: saved ? selected : undefined,
            authUrl: observed ? selected.authUrl : undefined, progress: { phase: 'complete' } };
        else if (path === '/api/setup/options') { expect(route.request().postDataJSON()).toEqual({}); value = { zones: [{ id: selected.zoneId, name: 'example.test' }] }; }
        else if (path === '/api/setup/configure') { submitted.push(route.request().postDataJSON()); observed = true; value = { configObserved: true }; }
        else value = { code: 'UNEXPECTED_REQUEST' };
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    });
    await page.goto('/en-us/setup');
    await page.getByLabel('Public HTTPS address').fill('https://draft.example.test');
    await page.getByLabel('Sender email address').fill('draft@draft.example.test');
    await page.getByRole('button', { name: 'Refresh status' }).click();
    await expect(page.getByLabel('Public HTTPS address')).toHaveValue('https://draft.example.test');
    await expect(page.getByLabel('Sender email address')).toHaveValue('draft@draft.example.test');
    saved = true;
    await page.reload();
    await expect(page.getByLabel('Public HTTPS address')).toHaveValue(selected.authUrl);
    await expect(page.getByLabel('Public HTTPS address')).toHaveAttribute('readonly', '');
    await expect(page.getByLabel('Sender email address')).toHaveValue(selected.emailFrom);
    await expect(page.getByLabel('Sending domain', { exact: true })).toHaveValue(selected.zoneId);
    await expect(page.getByLabel('Sending domain', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Load my domains' }).click();
    await expect(page.getByLabel('Sending domain', { exact: true })).toHaveValue(selected.zoneId);
    await expect(page.getByLabel('Website domain (for a custom address)')).toHaveValue(selected.siteZoneId);
    await page.getByRole('button', { name: 'Configure and continue' }).click();
    await expect(page.getByRole('heading', { name: 'Continue on your public address' })).toBeVisible();
    expect(submitted).toEqual([selected]);
});

for (const selection of ['administrator', 'none', 'invalid'] as const) {
    test(`maintenance administrator authorization preserves the tab account selection: ${selection}`, async ({ page, context }) => {
        const administratorId = '28ad084b-8b27-4984-b8d9-93ce5171bbd0';
        const selected = selection === 'administrator' ? administratorId : selection === 'invalid' ? 'not-an-account-id' : null;
        // Two active-cookie fixtures reproduce the ambiguity that requires an explicit tab account.
        await context.addCookies([
            { name: 'better-auth.session_token_multi-admin', value: 'admin-session-cookie', url: testOrigin, httpOnly: true },
            { name: 'better-auth.session_token_multi-user', value: 'user-session-cookie', url: testOrigin, httpOnly: true },
        ]);
        await page.addInitScript(({ key, value, administrator }) => {
            if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key);
            // A different storage surface and stale flow must not become implicit authorization.
            localStorage.setItem(key, administrator);
            sessionStorage.setItem('loginflare.auth-flow', 'b4c8f21a-a152-4bda-99a4-9cc8082143d9');
        }, { key: browserAccountStorageKey, value: selected, administrator: administratorId });
        let authenticated = false;
        const authorization: Record<string, string>[] = [];
        const statusHeaders: Record<string, string>[] = [];
        const unexpected: string[] = [];
        await context.route('**/api/**', async (route) => {
            const path = new URL(route.request().url()).pathname;
            const headers = await route.request().allHeaders();
            if (path === '/api/maintenance/status') {
                statusHeaders.push(headers);
                await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ mode: 'ready', installed: true, authenticated }) });
            } else if (path === '/api/maintenance/authorize') {
                authorization.push(headers);
                authenticated = headers['x-loginflare-account'] === administratorId;
                await route.fulfill({ status: authenticated ? 200 : 403, contentType: 'application/json',
                    body: JSON.stringify(authenticated ? { authenticated: true } : { code: 'FORBIDDEN' }) });
            } else {
                unexpected.push(path);
                await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'UNEXPECTED_BUSINESS_QUERY' }) });
            }
        });
        await page.goto('/en-us/maintenance');
        await page.getByRole('button', { name: 'Continue with administrator session' }).click();
        await expect.poll(() => authorization.length).toBe(1);
        expect(authorization[0]['x-loginflare-account']).toBe(selection === 'administrator' ? administratorId : undefined);
        expect(authorization[0]['x-loginflare-flow']).toBeUndefined();
        expect(authorization[0].cookie).toContain('better-auth.session_token_multi-admin=admin-session-cookie');
        expect(authorization[0].cookie).toContain('better-auth.session_token_multi-user=user-session-cookie');
        expect(statusHeaders.every((headers) => headers['x-loginflare-account'] === undefined)).toBe(true);
        if (selection === 'administrator') await expect(page.getByRole('button', { name: 'Enter maintenance' })).toBeVisible();
        else await expect(page.getByRole('alert')).toContainText('FORBIDDEN');
        expect(unexpected).toEqual([]);
    });
}
