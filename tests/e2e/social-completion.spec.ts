import type { BrowserContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { testOrigin } from './runtime';
import { randomUUID } from 'node:crypto';
import type { Identity } from '../../src/client/api';
import { defaultBranding } from '../../src/shared/branding';

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

async function authenticatedCompletion(context: BrowserContext) {
    const now = new Date().toISOString(), flowId = randomUUID(), nextFlowId = randomUUID();
    function identity(name: string): Identity {
        const id = randomUUID();
        return { browserAccountId: randomUUID(), user: { id, name, email: `${name.toLowerCase()}@loginflare.test`, emailVerified: true, role: 'user', createdAt: now }, session: { id: randomUUID(), token: 'isolated-completion-test-token', userId: id, createdAt: now, expiresAt: new Date(Date.now() + 86400000).toISOString() } };
    }
    const original = identity('Original'), social = identity('Social');
    const state = { identityReads: 0, finishes: 0, deletionStarted: false, initialGate: undefined as Promise<void> | undefined, manualGate: undefined as Promise<void> | undefined, deletionGate: undefined as Promise<void> | undefined, expiredDeletion: false };
    await context.addInitScript(({ flowId, accountId }) => {
        if (sessionStorage.getItem('loginflare.auth-flow')) return;
        sessionStorage.setItem('loginflare.auth-flow', flowId);
        sessionStorage.setItem('loginflare.auth-flow-kind', 'add');
        sessionStorage.setItem('loginflare.account', accountId);
        sessionStorage.setItem('loginflare.auth-return-account', accountId);
        window.addEventListener('loginflare:clear-sensitive', () => { document.documentElement.dataset.testIdentityChanges = String(Number(document.documentElement.dataset.testIdentityChanges ?? 0) + 1); });
    }, { flowId, accountId: original.browserAccountId! });
    await context.route(`${testOrigin}/api/**`, async (route) => {
        const request = route.request(), path = new URL(request.url()).pathname, headers = request.headers();
        let json: unknown = {}, status = 200;
        if (path === '/api/auth/get-session') {
            const count = ++state.identityReads;
            if (count === 1) await state.initialGate;
            if (count === 2) await state.manualGate;
            json = headers['x-loginflare-flow'] === nextFlowId ? null : !headers['x-loginflare-flow'] && headers['x-loginflare-account'] === original.browserAccountId ? original : social;
        } else if (path === '/api/auth/social/flow') json = { stage: 'authenticated', purpose: 'login' };
        else if (path === '/api/auth/social/finish') { state.finishes++; json = { redirect: '/en-us/account', browserAccountId: social.browserAccountId }; }
        else if (path === `/api/browser/auth-flows/${flowId}` && request.method() === 'DELETE') {
            state.deletionStarted = true; await state.deletionGate;
            if (state.expiredDeletion) { status = 401; json = { code: 'BROWSER_FLOW_EXPIRED' }; } else json = { status: true };
        } else if (path === '/api/browser/auth-flows') json = { flowId: nextFlowId };
        else if (path === '/api/browser/accounts/select') json = { accountId: original.browserAccountId, identity: original };
        else if (path === '/api/browser/accounts') json = { maximumAccounts: 5, accounts: [original, social].map((item) => ({ id: item.browserAccountId, user: item.user, status: 'active', lastUsedAt: now })) };
        else if (path === '/api/auth/social/security') json = { hasPassword: true, providers: [], identities: [] };
        else if (path === '/api/social/providers') json = { providers: [] };
        else if (path === '/api/config') json = { turnstileSiteKey: '1x00000000000000000000AA' };
        else if (path === '/api/branding') json = { ...defaultBranding, logoUrl: '/assets/logo.svg', revision: 0 };
        await route.fulfill({ status, json }).catch(() => {});
    });
    return { state, flowId, nextFlowId, original, social };
}

test('finishes social authentication when the initial identity resolves during Continue', async ({ page, context }) => {
    const { state, flowId, social } = await authenticatedCompletion(context);
    let releaseInitial!: () => void, releaseManual!: () => void;
    state.initialGate = new Promise((resolve) => { releaseInitial = resolve; });
    state.manualGate = new Promise((resolve) => { releaseManual = resolve; });
    try {
        await page.goto(`/en-us/social/complete?flow=${flowId}`);
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect.poll(() => state.identityReads).toBe(2);
        releaseInitial();
        await expect(page.locator('html')).toHaveAttribute('data-test-identity-changes', '1');
        releaseManual();
        await expect(page).toHaveURL('/en-us/account');
        await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Social');
        expect(state.finishes).toBe(1);
        expect(await page.evaluate(() => sessionStorage.getItem('loginflare.account'))).toBe(social.browserAccountId);
    } finally { releaseInitial(); releaseManual(); }
});

test('ignores an expired completion response after switching accounts and starting a new flow', async ({ page, context }) => {
    const { state, flowId, nextFlowId, original } = await authenticatedCompletion(context);
    let release!: () => void; state.deletionGate = new Promise((resolve) => { release = resolve; }); state.expiredDeletion = true;
    try {
        await page.goto(`/en-us/social/complete?flow=${flowId}`);
        await expect(page.locator('html')).toHaveAttribute('data-test-identity-changes', '1');
        const response = page.waitForResponse((response) => response.url().endsWith(`/api/browser/auth-flows/${flowId}`) && response.request().method() === 'DELETE');
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await expect.poll(() => state.deletionStarted).toBe(true);
        await page.getByRole('link', { name: 'Loginflare', exact: true }).click();
        await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Social');
        await page.getByRole('button', { name: 'Account menu', exact: true }).click();
        await page.getByRole('button', { name: 'Account: original@loginflare.test', exact: true }).click();
        await expect(page.getByLabel('Display name', { exact: true })).toHaveValue('Original');
        await page.getByRole('button', { name: 'Account menu', exact: true }).click();
        await page.getByRole('button', { name: 'Add an account', exact: true }).click();
        await expect(page).toHaveURL(`/en-us/login?flow=${nextFlowId}`);
        release(); await (await response).finished();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(await page.evaluate(() => sessionStorage.getItem('loginflare.auth-flow'))).toBe(nextFlowId);
        expect(await page.evaluate(() => sessionStorage.getItem('loginflare.account'))).toBe(original.browserAccountId);
        await expect(page.getByLabel('Email or username', { exact: true })).toBeVisible();
    } finally { release(); }
});

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
