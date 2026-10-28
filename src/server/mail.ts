import type { Env } from './config.ts';
import { isLocale, localeToPath, type Locale } from '../shared/locales.ts';

type MailUser = { email: string; name: string; locale?: unknown };
const copy = {
    'en-US': {
        verify: ['Verify your email', 'Confirm your email address to finish setting up your Loginflare account.', 'Verify email'],
        ignore: 'If you did not request this email, you can safely ignore it.',
    },
    'zh-CN': {
        verify: ['验证你的邮箱', '请确认邮箱地址，完成 Loginflare 账号注册。', '验证邮箱'],
        ignore: '如果你没有发起此请求，可以忽略这封邮件。',
    },
} satisfies Record<Locale, { verify: string[]; ignore: string }>;

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export async function sendAccountMail(env: Env, user: MailUser, sourceUrl: string): Promise<void> {
    const locale = isLocale(user.locale) ? user.locale : 'en-US';
    const path = localeToPath[locale];
    const url = new URL(sourceUrl);
    if (url.origin !== env.AUTH_URL) throw new Error('Invalid mail origin');
    const callback = new URL(`${env.AUTH_URL}/${path}/verified`);
    const originalCallback = url.searchParams.get('callbackURL');
    if (originalCallback) {
        const original = new URL(originalCallback, env.AUTH_URL);
        if (original.origin !== env.AUTH_URL) throw new Error('Invalid mail callback origin');
        // Preserve the provider-signed flow query while the account preference
        // determines the email and result-page language.
        callback.search = original.search;
    }
    url.searchParams.set('callbackURL', callback.toString());
    const [subject, introduction, label] = copy[locale].verify;
    const link = url.toString();
    try {
        await env.EMAIL.send({
            to: user.email,
            from: { email: env.EMAIL_FROM, name: 'Loginflare' },
            subject: `${subject} · Loginflare`,
            text: `${introduction}\n\n${link}\n\n${copy[locale].ignore}`,
            html: `<!doctype html><html lang="${locale}"><body style="margin:0;background:#f5f6f8;font-family:Arial,sans-serif;color:#20242c"><main style="max-width:520px;margin:40px auto;background:white;padding:40px;border-radius:16px"><p style="font-weight:700;color:#d75a21">Loginflare</p><h1 style="font-size:24px">${escapeHtml(subject)}</h1><p>${escapeHtml(introduction)}</p><p style="margin:32px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:14px 22px;background:#d75a21;color:white;border-radius:8px;text-decoration:none">${escapeHtml(label)}</a></p><p style="font-size:13px;color:#68707d">${escapeHtml(copy[locale].ignore)}</p></main></body></html>`,
        });
    } catch {
        throw new Error('EMAIL_DELIVERY_FAILED');
    }
}

export async function sendEmailCode(env: Env, user: MailUser, code: string, purpose: 'verify' | 'recovery'): Promise<void> {
    const locale = isLocale(user.locale) ? user.locale : 'en-US';
    const chinese = locale === 'zh-CN';
    const subject = purpose === 'verify'
        ? chinese ? '验证新增邮箱' : 'Verify your additional email'
        : chinese ? '账号密码恢复验证码' : 'Account password recovery code';
    const introduction = chinese ? '你的 Loginflare 验证码是：' : 'Your Loginflare verification code is:';
    const expiry = chinese ? '验证码在 10 分钟后失效，且只能使用一次。' : 'This code expires in 10 minutes and can only be used once.';
    try {
        await env.EMAIL.send({
            to: user.email,
            from: { email: env.EMAIL_FROM, name: 'Loginflare' },
            subject: `${subject} · Loginflare`,
            text: `${introduction}\n\n${code}\n\n${expiry}\n\n${copy[locale].ignore}`,
            html: `<!doctype html><html lang="${locale}"><body style="font-family:Arial,sans-serif;color:#20242c"><main style="max-width:520px;margin:40px auto;padding:32px"><h1>${escapeHtml(subject)}</h1><p>${introduction}</p><p style="font-size:32px;letter-spacing:6px;font-weight:bold">${code}</p><p>${expiry}</p><p>${copy[locale].ignore}</p></main></body></html>`,
        });
    } catch {
        throw new Error('EMAIL_DELIVERY_FAILED');
    }
}
