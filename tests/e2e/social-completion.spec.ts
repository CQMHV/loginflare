import type { BrowserContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { testOrigin } from './runtime';

async function pendingEmail(context: BrowserContext) {
    const state = {
        email: 'first@loginflare.test', stage: 'code',
        sent: [] as string[], verified: [] as string[],
        failure: undefined as string | undefined, pending: undefined as Promise<void> | undefined,
    };
    await context.route(`${testOrigin}/api/auth/**`, async (route) => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (path === '/api/auth/get-session') await route.fulfill({ json: null });
        else if (path === '/api/auth/social/flow') await route.fulfill({ json: { stage: state.stage, email: state.email, purpose: 'login' } });
        else if (path === '/api/auth/social/email' && request.method() === 'POST') {
            const { email } = request.postDataJSON(); state.sent.push(email);
            await state.pending;
            if (state.failure) { await route.fulfill({ status: 400, json: { code: state.failure } }); return; }
            state.email = email; state.stage = 'code';
            await route.fulfill({ json: { status: true } });
        } else if (path === '/api/auth/social/verify-email' && request.method() === 'POST') {
            state.verified.push(request.postDataJSON().code);
            await route.fulfill({ status: 400, json: { code: 'INVALID_VERIFICATION_CODE' } });
        } else await route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
    });
    return state;
}

const translations = {
    'en-us': { resend: 'Resend verification code', change: 'Change email address', send: 'Send verification code', verify: 'Verify email', code: 'Verification code', email: 'Email address', failure: 'We couldn’t send this email. Please try again.' },
    'zh-cn': { resend: '重新发送验证码', change: '修改邮箱', send: '发送验证码', verify: '验证邮箱', code: '验证码', email: '邮箱地址', failure: '邮件发送失败，请重试。' },
};

for (const locale of ['en-us', 'zh-cn'] as const) {
    test(`resends a social email code directly and preserves input after a failed attempt in ${locale}`, async ({ page, context }) => {
        const state = await pendingEmail(context), text = translations[locale];
        await page.setViewportSize({ width: locale === 'zh-cn' ? 375 : 1280, height: 812 });
        await page.goto(`/${locale}/social/complete`);
        const code = page.getByLabel(text.code, { exact: true });
        const resend = page.getByRole('button', { name: text.resend, exact: true });
        const change = page.getByRole('button', { name: text.change, exact: true });
        const verify = page.getByRole('button', { name: text.verify, exact: true });
        await code.fill('123456');
        let release!: () => void;
        state.pending = new Promise<void>((resolve) => { release = resolve; });
        try {
            await resend.click();
            await expect.poll(() => state.sent).toEqual(['first@loginflare.test']);
            await expect(resend).toBeDisabled();
            await expect(change).toBeDisabled();
            await expect(verify).toBeDisabled();
            await expect(code).toBeDisabled();
            expect(state.verified).toHaveLength(0);
        } finally { release(); state.pending = undefined; }
        await expect(code).toHaveValue('');
        await expect(page.locator('.feedback-toast')).toContainText('first@loginflare.test');
        await expect(page.getByLabel(text.email, { exact: true })).toHaveCount(0);
        await code.fill('654321'); state.failure = 'EMAIL_DELIVERY_FAILED';
        await resend.click();
        await expect(page.getByRole('alert')).toHaveText(text.failure);
        await expect(code).toHaveValue('654321');
        await expect(resend).toBeEnabled();
        await expect(change).toBeEnabled();
        await expect(verify).toBeEnabled();
        state.failure = undefined;
        await resend.click();
        await expect(code).toHaveValue('');
        await expect(page.getByRole('alert')).toHaveCount(0);
        expect(state.sent).toEqual(Array(3).fill('first@loginflare.test'));
        expect(state.verified).toHaveLength(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });

    test(`changes a social registration email separately without sending until confirmed in ${locale}`, async ({ page, context }) => {
        const state = await pendingEmail(context), text = translations[locale];
        await page.goto(`/${locale}/social/complete`);
        await page.getByLabel(text.code, { exact: true }).fill('123456');
        await page.getByRole('button', { name: text.change, exact: true }).click();
        expect(state.sent).toHaveLength(0);
        const email = page.getByLabel(text.email, { exact: true });
        await expect(email).toHaveValue('first@loginflare.test');
        await expect(page.getByLabel(text.code, { exact: true })).toHaveCount(0);
        await email.fill('changed@loginflare.test'); state.failure = 'SOCIAL_ACCOUNT_NOT_LINKED';
        await page.getByRole('button', { name: text.send, exact: true }).click();
        await expect(page.getByRole('alert')).toBeVisible();
        await expect(email).toHaveValue('changed@loginflare.test');
        await expect(page.getByLabel(text.code, { exact: true })).toHaveCount(0);
        state.failure = undefined;
        await page.getByRole('button', { name: text.send, exact: true }).click();
        await expect(page.getByLabel(text.code, { exact: true })).toHaveValue('');
        await expect(page.getByRole('status').filter({ hasText: 'changed@loginflare.test' })).toBeVisible();
        await expect(page.getByRole('alert')).toHaveCount(0);
        expect(state.sent).toEqual(['changed@loginflare.test', 'changed@loginflare.test']);
        expect(state.verified).toHaveLength(0);
    });
}
