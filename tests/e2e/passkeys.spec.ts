import { expect, test } from './fixtures';
import { testOrigin } from './runtime';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { snapshotEmails, waitForMail } from './mailbox';
import { removeLocalApplications, removeLocalFixtures } from './database';

const emails: string[] = [], clients: string[] = [];
const password = 'Passkey-browser-password-814!';
test.afterEach(() => { removeLocalApplications(clients); removeLocalFixtures(emails); emails.length = 0; clients.length = 0; });

for (const chinese of [false, true]) test(`manages and signs in with passkeys in ${chinese ? 'Chinese' : 'English'}`, async ({ page, context }) => {
    test.setTimeout(150_000);
    const locale = chinese ? 'zh-cn' : 'en-us', email = `ui-${randomUUID()}@loginflare.test`; emails.push(email);
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: chinese ? 'internal' : 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const before = await snapshotEmails();
    const created = await page.request.post(`${testOrigin}/api/auth/sign-up/email`, { headers: { Origin: testOrigin, 'x-captcha-response': 'isolated-e2e-captcha-token' }, data: {
        name: 'Passkey browser fixture', username: 'pk_' + randomUUID().replaceAll('-', '').slice(0, 20), email, password, locale: chinese ? 'zh-CN' : 'en-US', callbackURL: `${testOrigin}/${locale}/verified`,
    } });
    expect(created.status(), await created.text()).toBe(200);
    await page.goto(await waitForMail(before, 'verify'));
    await page.goto(`/${locale}/login`);
    await page.getByLabel(chinese ? '邮箱或用户名' : 'Email or username', { exact: true }).fill(email);
    await page.getByLabel(chinese ? '密码' : 'Password', { exact: true }).fill(password);
    const signIn = page.getByRole('button', { name: chinese ? '登录' : 'Sign in', exact: true });
    await expect(signIn).toBeEnabled(); await signIn.click(); await expect(page).toHaveURL(`/${locale}/account`);
    await page.goto(`/${locale}/account/security`);
    const card = page.locator('section.card').filter({ has: page.getByRole('heading', { name: chinese ? '通行密钥' : 'Passkeys', exact: true }) });
    const dialog = page.locator('md-dialog.form-dialog');
    async function verify() {
        await dialog.getByLabel(chinese ? '当前密码' : 'Current password', { exact: true }).fill(password);
        await dialog.getByRole('button', { name: chinese ? '验证并继续' : 'Verify and continue', exact: true }).click();
    }
    const add = chinese ? '添加通行密钥' : 'Add passkey', rename = chinese ? '重命名通行密钥' : 'Rename passkey', remove = chinese ? '删除通行密钥' : 'Delete passkey';
    await card.getByRole('button', { name: add, exact: true }).click(); await verify();
    await dialog.getByLabel(chinese ? '通行密钥名称' : 'Passkey name', { exact: true }).fill('Browser device');
    const registered = page.waitForResponse((r) => r.url().endsWith('/api/auth/passkey/verify-registration'));
    await dialog.getByRole('button', { name: add, exact: true }).click(); expect((await registered).status()).toBe(200);
    await expect(card.getByText('Browser device', { exact: false })).toBeVisible();
    const saved = await cdp.send('WebAuthn.getCredentials', { authenticatorId }); expect(saved.credentials).toHaveLength(1);
    expect(saved.credentials[0]!.isResidentCredential).toBe(true);
    await card.getByRole('button', { name: rename, exact: true }).click(); await verify();
    await dialog.getByLabel(chinese ? '通行密钥名称' : 'Passkey name', { exact: true }).fill('Renamed device');
    await dialog.getByRole('button', { name: rename, exact: true }).click(); await expect(card.getByText('Renamed device', { exact: false })).toBeVisible();
    await card.getByRole('button', { name: add, exact: true }).click(); await verify();
    await dialog.getByLabel(chinese ? '通行密钥名称' : 'Passkey name', { exact: true }).fill('Cancelled device');
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
    const pending = page.waitForResponse((r) => r.url().endsWith('/api/auth/passkey/generate-register-options'));
    await dialog.getByRole('button', { name: add, exact: true }).click(); expect((await pending).status()).toBe(200);
    await page.goto(`/${locale}/account`);
    expect((await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials).toHaveLength(1);
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
    // Clear the browser's Loginflare sessions while retaining its authenticator.
    const signedOut = await page.request.post(`${testOrigin}/api/browser/accounts/sign-out-all`, { headers: { Origin: testOrigin }, data: {} }); expect(signedOut.ok()).toBe(true);
    await page.goto(`/${locale}/select-account`);
    await page.getByRole('button', { name: `Account: ${email}`, exact: true }).or(page.getByRole('button', { name: `账号：${email}`, exact: true })).click();
    await page.getByRole('button', { name: chinese ? '使用通行密钥登录' : 'Sign in with a passkey', exact: true }).click();
    await expect(page).toHaveURL(`/${locale}/account`);
    if (!chinese) {
        const callback = 'https://passkey-app.example.test/callback';
        await page.route('https://passkey-app.example.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Passkey callback</title>' }));
        const application = await page.request.post(`${testOrigin}/api/developer/applications`, { headers: { Origin: testOrigin }, data: { name: 'ui-oauth-' + randomUUID(), type: 'spa', redirectUris: [callback], postLogoutRedirectUris: ['https://passkey-app.example.test/'], scopes: ['openid'] } });
        expect(application.status()).toBe(201); const { application: app } = await application.json(); clients.push(app.clientId);
        const second = `ui-${randomUUID()}@loginflare.test`; emails.push(second); const mail = await snapshotEmails();
        const signup = await page.request.post(`${testOrigin}/api/auth/sign-up/email`, { headers: { Origin: testOrigin, 'x-captcha-response': 'isolated-e2e-captcha-token' }, data: { name: 'Second account', username: 'pk_' + randomUUID().replaceAll('-', '').slice(0, 20), email: second, password, callbackURL: `${testOrigin}/en-us/verified` } });
        expect(signup.status()).toBe(200); await page.request.get(await waitForMail(mail, 'verify'));
        const secondLogin = await page.request.post(`${testOrigin}/api/auth/sign-in/email`, { headers: { Origin: testOrigin, 'x-captcha-response': 'isolated-e2e-captcha-token' }, data: { email: second, password } }); expect(secondLogin.status()).toBe(200);
        const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
        const query = new URLSearchParams({ client_id: app.clientId, redirect_uri: callback, response_type: 'code', scope: 'openid', code_challenge: challenge, code_challenge_method: 'S256', state: 'passkey-state', nonce: 'passkey-nonce', prompt: 'login' });
        await page.goto(`${testOrigin}/api/auth/oauth2/authorize?${query}`);
        await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
        await expect(page.getByText(`Signed in as ${email}`, { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Allow', exact: true }).click(); await expect(page).toHaveURL(/^https:\/\/passkey-app\.example\.test\/callback\?/);
        const url = new URL(page.url()); expect(url.searchParams.get('state')).toBe('passkey-state'); expect(url.searchParams.get('code')).toBeTruthy();
        query.set('prompt', 'select_account'); query.set('state', 'passkey-selection');
        await page.goto(`${testOrigin}/api/auth/oauth2/authorize?${query}`);
        await expect(page.getByRole('heading', { name: 'Choose an account', exact: true })).toBeVisible();
        await page.getByRole('button', { name: `Account: ${email}`, exact: true }).click();
        await expect(page).toHaveURL(/^https:\/\/passkey-app\.example\.test\/callback\?/);
        expect(new URL(page.url()).searchParams.get('state')).toBe('passkey-selection');
    }
    await page.goto(`/${locale}/account/security`);
    await card.getByRole('button', { name: remove, exact: true }).click(); await verify();
    await dialog.getByRole('button', { name: remove, exact: true }).click();
    await expect(card.getByText(chinese ? '尚未登记通行密钥。' : 'No passkeys registered.', { exact: true })).toBeVisible();
    const stillSaved = await cdp.send('WebAuthn.getCredentials', { authenticatorId }); expect(stillSaved.credentials).toHaveLength(1);
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
});
