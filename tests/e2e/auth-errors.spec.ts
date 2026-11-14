import { expect, test } from './fixtures';
import { randomUUID } from 'node:crypto';
import { testOrigin } from './runtime';
import { snapshotEmails, waitForMail } from './mailbox';
import { removeLocalFixtures } from './database';
import { authenticatorCode } from '../totp';

const emails: string[] = [], password = 'Auth-error-browser-password-814!';
test.afterEach(() => { removeLocalFixtures(emails); emails.length = 0; });

for (const chinese of [false, true]) test(`reports verification outages and removed-passkey MFA in ${chinese ? 'Chinese' : 'English'}`, async ({ page, context }) => {
    test.setTimeout(150_000);
    const locale = chinese ? 'zh-cn' : 'en-us', email = `ui-${randomUUID()}@loginflare.test`, username = 'error_' + randomUUID().replaceAll('-', '').slice(0, 20);
    emails.push(email);
    const before = await snapshotEmails();
    const signup = await page.request.post(`${testOrigin}/api/auth/sign-up/email`, { headers: { Origin: testOrigin, 'x-captcha-response': 'isolated-e2e-captcha-token' }, data: {
        name: 'Authentication error fixture', email, username, password, locale: chinese ? 'zh-CN' : 'en-US', callbackURL: `${testOrigin}/${locale}/verified`,
    } });
    expect(signup.status(), await signup.text()).toBe(200);
    await page.goto(await waitForMail(before, 'verify'));
    await page.goto(`/${locale}/login`);
    await page.getByLabel(chinese ? '邮箱或用户名' : 'Email or username', { exact: true }).fill(chinese ? username : email);
    await page.getByLabel(chinese ? '密码' : 'Password', { exact: true }).fill(password);
    const path = '/api/auth/sign-in/' + (chinese ? 'username' : 'email');
    await page.route(testOrigin + path, (route) => route.continue({ headers: { ...route.request().headers(), 'x-captcha-response': 'isolated-e2e-captcha-unavailable' } }), { times: 1 });
    const failed = page.waitForResponse((response) => response.url().endsWith(path));
    const login = page.getByRole('button', { name: chinese ? '登录' : 'Sign in', exact: true });
    await login.click();
    const unavailable = await failed;
    expect(unavailable.status()).toBe(503); expect(await unavailable.json()).toMatchObject({ code: 'TURNSTILE_UNAVAILABLE' });
    await expect(page.getByRole('alert')).toContainText(chinese ? '安全验证服务暂时不可用，请稍后重试。' : 'Security verification is temporarily unavailable. Please try again.');
    expect(await (await page.request.get(`${testOrigin}/api/auth/get-session`)).json()).toBeNull();
    await expect(login).toBeEnabled(); await login.click();
    await expect(page).toHaveURL(`/${locale}/account`);

    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(`/${locale}/account/security`);
    await page.getByRole('button', { name: chinese ? '添加通行密钥' : 'Add passkey', exact: true }).click();
    const dialog = page.locator('md-dialog.form-dialog');
    await dialog.getByLabel(chinese ? '当前密码' : 'Current password', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: chinese ? '验证并继续' : 'Verify and continue', exact: true }).click();
    await dialog.getByLabel(chinese ? '通行密钥名称' : 'Passkey name', { exact: true }).fill('Error boundary key');
    const registered = page.waitForResponse((response) => response.url().endsWith('/api/auth/passkey/verify-registration'));
    await dialog.getByRole('button', { name: chinese ? '添加通行密钥' : 'Add passkey', exact: true }).click();
    expect((await registered).status()).toBe(200);
    const keys = await (await page.request.get(`${testOrigin}/api/auth/passkey/list-user-passkeys`)).json();
    expect(keys).toHaveLength(1);
    const enabled = await page.request.post(`${testOrigin}/api/auth/two-factor/enable`, { headers: { Origin: testOrigin }, data: { password } });
    expect(enabled.status()).toBe(200);
    const setup = await enabled.json();
    expect((await page.request.post(`${testOrigin}/api/auth/two-factor/verify-totp`, { headers: { Origin: testOrigin }, data: { code: await authenticatorCode(setup.totpURI) } })).status()).toBe(200);
    const started = await page.request.post(`${testOrigin}/api/browser/auth-flows`, { headers: { Origin: testOrigin }, data: { kind: 'login', locale: chinese ? 'zh-CN' : 'en-US' } });
    const { flowId } = await started.json(); expect(flowId).toBeTruthy();
    await page.goto(`/${locale}/login?flow=${flowId}`);
    await page.getByRole('button', { name: chinese ? '使用通行密钥登录' : 'Sign in with a passkey', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/two-factor\\?`));
    expect((await page.request.post(`${testOrigin}/api/auth/passkey/delete-passkey`, { headers: { Origin: testOrigin }, data: { id: keys[0].id, password } })).status()).toBe(200);
    const message = chinese ? '通行密钥或账号不可用，请重新认证后再试。' : 'The passkey or account is unavailable. Reauthenticate and try again.';
    for (const backup of [false, true]) {
        if (backup) await page.getByRole('button', { name: chinese ? '使用恢复码' : 'Use a recovery code', exact: true }).click();
        await page.getByLabel(backup ? chinese ? '恢复码' : 'Recovery code' : chinese ? '验证器动态码' : 'Authenticator code', { exact: true }).fill(backup ? setup.backupCodes[0] : await authenticatorCode(setup.totpURI));
        const rejected = page.waitForResponse((response) => response.url().endsWith('/api/auth/two-factor/verify-' + (backup ? 'backup-code' : 'totp')));
        await page.getByRole('button', { name: chinese ? '验证并登录' : 'Verify sign-in', exact: true }).click();
        const response = await rejected;
        expect(response.status()).toBe(400); expect(await response.json()).toMatchObject({ code: 'PASSKEY_NOT_AVAILABLE' });
        await expect(page.getByRole('alert')).toContainText(message);
    }
});
