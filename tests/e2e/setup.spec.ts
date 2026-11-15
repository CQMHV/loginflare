import { expect, test } from '@playwright/test';
import { testOrigin } from './runtime';

test('setup shows Cloudflare progress, then only requests the email link on the formal domain', async ({ page }) => {
    let statusRequests = 0;
    await page.route('**/api/setup/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/status')) {
            const ready = ++statusRequests >= 2;
            await route.fulfill({ json: { step: ready ? 'ready' : 'sending', canonical: ready, canStart: !ready,
                publicUrl: ready ? testOrigin : undefined, completed: false, branding: { name: 'Example Accounts', logoUrl: '/favicon.svg' } } });
        } else if (path.endsWith('/start')) {
            expect(route.request().postDataJSON()).toEqual({});
            await route.fulfill({ status: 202, json: {} });
        } else if (path.endsWith('/invite')) {
            expect(route.request().postDataJSON()).toEqual({ locale: 'en-US' });
            await route.fulfill({ status: 202, json: {} });
        } else throw new Error(`Unexpected path: ${path}`);
    });
    await page.goto('/en-us/setup');
    await expect(page.locator('.setup-brand')).toHaveText('Example Accounts');
    await expect(page).toHaveTitle('Example Accounts');
    await expect(page.getByText('Configuring email delivery')).toBeVisible();
    await page.getByRole('button', { name: 'Send setup link' }).click();
    await expect(page.getByText('Check that mailbox for the link.')).toBeVisible();
    await expect(page.locator('input')).toHaveCount(0);
});

test('an email link opens username and password setup without persisting the proof', async ({ page }) => {
    const token = 'a'.repeat(64);
    await page.route('**/api/setup/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/status')) await route.fulfill({ json: {
            step: 'ready', canonical: true, publicUrl: testOrigin, completed: false, branding: { name: 'Example Accounts', logoUrl: '/favicon.svg' }, canStart: false,
        } });
        else if (path.endsWith('/claim')) {
            expect(route.request().postDataJSON()).toEqual({ token, username: 'first_admin', password: 'Example test password only', locale: 'en-US' });
            await route.fulfill({ json: {} });
        } else throw new Error(`Unexpected path: ${path}`);
    });
    await page.goto(`/en-us/setup#${token}`);
    await page.getByLabel('Username').fill('first_admin');
    await page.getByLabel('Password').fill('Example test password only');
    await expect(page).toHaveURL(/\/en-us\/setup$/);
    await page.getByRole('button', { name: 'Create administrator' }).click();
    await expect(page.getByText('Installation is complete.')).toBeVisible();
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(token);
});

for (const language of ['en-us', 'zh-cn'] as const) {
    const chinese = language === 'zh-cn';
    test(`setup explains failed steps and keeps diagnostic codes in ${language}`, async ({ page }) => {
        let code = '';
        const cases = [
            ['CLOUDFLARE_PERMISSION_DENIED', chinese ? 'Cloudflare 拒绝了安装授权' : 'Cloudflare denied setup access'],
            ['USER_API_TOKEN_REQUIRED', chinese ? '不能使用账户 API 令牌' : 'not an Account API Token'],
            ['CLOUDFLARE_RATE_LIMITED', chinese ? '等待安装程序自动检查进度' : 'checks progress automatically'],
            ['CLOUDFLARE_RESULT_UNCERTAIN', chinese ? '之前的请求可能已经成功' : 'A previous request may have succeeded'],
            ['DNS_CONFLICT', chinese ? '发现冲突的 DNS 记录' : 'A DNS record conflicts'],
            ['EMAIL_DNS_PENDING', chinese ? '正在等待 Cloudflare 验证发信域名' : 'Waiting for Cloudflare to verify the sending domain'],
            ['UNRECOGNIZED_PROVIDER_ERROR', chinese ? '当前安装步骤未能完成' : 'This installation step could not be completed'],
        ];
        await page.route('**/api/setup/**', async (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path.endsWith('/status')) await route.fulfill({ json: {
                step: 'sending', canonical: false, canStart: true, completed: false, error: code,
                detail: code === 'DNS_CONFLICT' ? 'CNAME auth.example.test (record-a)' : undefined,
                branding: { name: 'Example Accounts', logoUrl: '/favicon.svg' },
            } });
            else if (path.endsWith('/start')) await route.fulfill({ status: 202, json: {} });
            else throw new Error(`Unexpected path: ${path}`);
        });
        await page.setViewportSize({ width: chinese ? 375 : 1280, height: 812 });
        for (const [failure, message] of cases) {
            code = failure!;
            await page.goto(`/${language}/setup`);
            const notice = page.locator('.setup-notice');
            await expect(notice.locator('p').first()).toContainText(message!);
            await expect(notice.getByText(code, { exact: true })).toBeVisible();
            await expect(notice).toHaveAttribute('role', code === 'EMAIL_DNS_PENDING' ? 'status' : 'alert');
            await expect(page.getByText(chinese ? '当前步骤: 配置邮件发送' : 'Current step: Configuring email delivery', { exact: true })).toBeVisible();
            await expect(page.getByRole('link', { name: chinese ? '部署与恢复说明' : 'Deployment and recovery guide', exact: true })).toHaveAttribute('href', `https://github.com/CQMHV/loginflare/blob/main/docs/deployment${chinese ? '.zh-CN' : ''}.md`);
            if (code === 'DNS_CONFLICT') await expect(notice).toContainText('CNAME auth.example.test (record-a)');
            if (code === 'CLOUDFLARE_RESULT_UNCERTAIN') {
                await expect(notice).toContainText(chinese ? '不要通过重复创建或删除资源来重试' : 'Do not create replacements or delete resources to retry');
                await page.screenshot({ path: test.info().outputPath(`setup-uncertain-${language}.png`), fullPage: true });
            }
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
    });

    test(`setup identifies the Worker secrets without starting incomplete configuration in ${language}`, async ({ page }) => {
        let starts = 0, code = '';
        await page.route('**/api/setup/**', async (route) => {
            if (new URL(route.request().url()).pathname.endsWith('/status')) await route.fulfill({ json: {
                step: 'target', canonical: false, canStart: false, completed: false, error: code,
                branding: { name: 'Example Accounts', logoUrl: '/favicon.svg' },
            } });
            else { starts++; await route.fulfill({ status: 400, json: {} }); }
        });
        await page.setViewportSize({ width: chinese ? 375 : 1280, height: 812 });
        for (const failure of ['', 'DEPLOYMENT_INPUTS_REQUIRED', 'DEPLOYMENT_TOKEN_REQUIRED']) {
            code = failure;
            await page.goto(`/${language}/setup`);
            for (const name of ['SETUP_ORIGIN', 'SETUP_ADMIN_EMAIL', 'CF_SETUP_TOKEN']) await expect(page.getByText(name, { exact: true })).toBeVisible();
            const guidance = page.getByText(chinese ? /设置 → 变量和机密/ : /Settings → Variables and Secrets/);
            await expect(guidance).toHaveCount(1);
            await expect(guidance).toBeVisible();
            await expect(page.locator('input')).toHaveCount(0);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
        await page.screenshot({ path: test.info().outputPath(`setup-configuration-${language}.png`), fullPage: true });
        expect(starts).toBe(0);
    });

    test(`setup clears recovered progress failures and retains invitation errors until retry in ${language}`, async ({ page }) => {
        let statuses = 0, invitations = 0;
        await page.route('**/api/setup/**', async (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path.endsWith('/status')) {
                const ready = ++statuses >= 2;
                await route.fulfill({ json: { step: ready ? 'ready' : 'target', canonical: ready, canStart: !ready,
                    completed: false, branding: { name: 'Example Accounts', logoUrl: '/favicon.svg' } } });
            } else if (path.endsWith('/start')) await route.fulfill({ status: 503, json: { code: 'INSTALLATION_UNAVAILABLE' } });
            else if (path.endsWith('/invite')) {
                const failed = ++invitations === 1;
                await route.fulfill({ status: failed ? 503 : 202, json: failed ? { code: 'EMAIL_DELIVERY_FAILED' } : {} });
            } else throw new Error(`Unexpected path: ${path}`);
        });
        await page.goto(`/${language}/setup`);
        await expect(page.getByRole('alert')).toContainText('INSTALLATION_UNAVAILABLE');
        const invite = page.getByRole('button', { name: chinese ? '发送安装链接' : 'Send setup link', exact: true });
        await expect(invite).toBeVisible();
        await expect(page.getByRole('alert')).toHaveCount(0);
        await invite.click();
        await expect(page.getByRole('alert')).toContainText('EMAIL_DELIVERY_FAILED');
        await invite.click();
        await expect(page.getByRole('alert')).toHaveCount(0);
        await expect(page.getByText(chinese ? /请到该邮箱查收安装链接/ : /Check that mailbox for the link/)).toBeVisible();
        expect(statuses).toBe(2); expect(invitations).toBe(2);
    });
}
