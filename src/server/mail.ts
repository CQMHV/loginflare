import type { Env } from './config.ts';
import { isLocale, localeToPath, type Locale } from '../shared/locales.ts';
import { readBranding } from './branding-settings';
import { renderMail } from './mail-template';

type MailUser = { email: string; name: string; locale?: unknown; id?: string };
const copy = {
    'en-US': {
        verify: ['Verify your email', 'Confirm your email address to finish setting up your {{brand}} account.', 'Verify email'],
    },
    'zh-CN': {
        verify: ['验证你的邮箱', '请确认邮箱地址，完成 {{brand}} 账号注册。', '验证邮箱'],
    },
} satisfies Record<Locale, { verify: string[] }>;

export async function sendAccountMail(env: Env, user: MailUser, sourceUrl: string): Promise<void> {
    const brand = await readBranding(env.DB);
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
    const [subject, template, label] = copy[locale].verify;
    const introduction = template!.replace('{{brand}}', brand.name);
    const link = url.toString();
    try {
        await env.EMAIL.send({
            to: user.email,
            from: { email: env.EMAIL_FROM, name: brand.name },
            subject: `${subject} · ${brand.name}`,
            ...renderMail({ brand, origin: env.AUTH_URL, locale, title: subject!, introduction, action: { label: label!, url: link } }),
        });
    } catch {
        throw new Error('EMAIL_DELIVERY_FAILED');
    }
}

export async function sendInstallationMail(env: Env, email: string, token: string, locale: Locale): Promise<void> {
    const brand = await readBranding(env.DB);
    const link = new URL(`/${localeToPath[locale]}/setup`, env.AUTH_URL);
    link.hash = token;
    const chinese = locale === 'zh-CN';
    const subject = chinese ? `创建 ${brand.name} 管理员` : `Create your ${brand.name} administrator`;
    const message = chinese ? '打开此链接设置用户名和密码。链接仅可使用一次，20 分钟后失效。'
        : 'Open this link to choose your username and password. It can be used once and expires in 20 minutes.';
    await env.EMAIL.send({
        to: email, from: { email: env.EMAIL_FROM, name: brand.name }, subject,
        ...renderMail({ brand, origin: env.AUTH_URL, locale,
            title: chinese ? '创建首个管理员' : 'Create the first administrator', introduction: message,
            action: { label: chinese ? '创建管理员' : 'Create administrator', url: link.toString() } }),
    });
}

export async function sendEmailCode(env: Env, user: MailUser, code: string, purpose: 'verify' | 'recovery' | 'social'): Promise<void> {
    const brand = await readBranding(env.DB);
    const locale = isLocale(user.locale) ? user.locale : 'en-US';
    const chinese = locale === 'zh-CN';
    const subject = purpose === 'social' ? chinese ? '完成第三方账号注册' : 'Complete your social sign-up' : purpose === 'verify'
        ? chinese ? '验证新增邮箱' : 'Verify your additional email'
        : chinese ? '账号密码恢复验证码' : 'Account password recovery code';
    const introduction = chinese ? `你的 ${brand.name} 验证码是：` : `Your ${brand.name} verification code is:`;
    const expiry = chinese ? '验证码在 10 分钟后失效，且只能使用一次。' : 'This code expires in 10 minutes and can only be used once.';
    try {
        await env.EMAIL.send({
            to: user.email,
            from: { email: env.EMAIL_FROM, name: brand.name },
            subject: `${subject} · ${brand.name}`,
            ...renderMail({ brand, origin: env.AUTH_URL, locale, title: subject, introduction, code, note: expiry }),
        });
    } catch {
        throw new Error('EMAIL_DELIVERY_FAILED');
    }
}
