import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { expect } from 'vitest';
import type { createAuth } from '../src/server/auth';
import app from '../src/server/index';

export const origin = 'http://localhost:5173';
export const password = 'Integration-password-812!';
type RuntimeEnv = Parameters<typeof createAuth>[0];

export interface RecordedMail {
    subject: string;
    text: string;
    html: string;
    to: unknown;
}

export function harness() {
    const messages: RecordedMail[] = [];
    let failMail = false;
    const bindings: RuntimeEnv = {
        ...env,
        EMAIL: {
            async send(message) {
                if (failMail) throw new Error('Test mail delivery failure');
                if (!('subject' in message)) throw new Error('Expected a structured email');
                messages.push({
                    subject: message.subject,
                    text: message.text ?? '',
                    html: message.html ?? '',
                    to: message.to,
                });
                return { messageId: crypto.randomUUID() };
            },
        },
    };

    async function request(path: string, options: {
        body?: Record<string, unknown>;
        cookie?: string;
        method?: string;
        captcha?: boolean;
        headers?: Record<string, string>;
    } = {}) {
        const headers = new Headers({
            Origin: origin,
            'CF-Connecting-IP': '192.0.2.10',
            ...options.headers,
        });
        if (options.body) headers.set('Content-Type', 'application/json');
        if (options.cookie) headers.set('Cookie', options.cookie);
        if (options.captcha !== false) headers.set('x-captcha-response', 'test-captcha-token');
        const ctx = createExecutionContext();
        const response = await app.fetch(new Request(new URL(path, origin), {
            method: options.method ?? (options.body ? 'POST' : 'GET'),
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
            redirect: 'manual',
        }), bindings, ctx);
        await waitOnExecutionContext(ctx);
        return response;
    }

    async function signup(email = 'person@example.test', locale = 'en-US') {
        const response = await request('/api/auth/sign-up/email', {
            body: {
                name: 'Test Person', email, password, locale,
                callbackURL: `${origin}/${locale === 'zh-CN' ? 'zh-cn' : 'en-us'}/verified`,
            },
        });
        expect(response.status, await response.clone().text()).toBe(200);
        return response;
    }

    async function verify(email = 'person@example.test', locale = 'en-US') {
        await signup(email, locale);
        const url = mailUrl(messages.at(-1));
        const response = await request(url);
        expect([200, 302]).toContain(response.status);
        return response;
    }

    async function signin(email = 'person@example.test', candidate = password) {
        const response = await request('/api/auth/sign-in/email', {
            body: { email, password: candidate },
        });
        expect(response.status, await response.clone().text()).toBe(200);
        const cookie = cookies(response);
        expect(cookie).toContain('session_token=');
        return cookie;
    }

    async function administrator(email = 'admin@example.test') {
        await verify(email);
        await env.DB.prepare('UPDATE "user" SET "role" = ? WHERE "email" = ? AND "emailVerified" = 1')
            .bind('admin', email).run();
        return signin(email);
    }

    return { bindings, messages, request, signup, verify, signin, administrator,
        setMailFailure(value: boolean) { failMail = value; } };
}

export function cookies(response: Response) {
    return response.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

export function mailUrl(mail: RecordedMail | undefined) {
    if (!mail) throw new Error('No captured email');
    const match = mail.text.match(/https?:\/\/[^\s<>"']+/);
    if (!match) throw new Error('No URL in captured email');
    return match[0];
}

export function mailCode(mail: RecordedMail | undefined) {
    if (!mail) throw new Error('No captured email');
    const match = mail.text.match(/\b[0-9]{6}\b/);
    if (!match) throw new Error('No six-digit code in captured email');
    return match[0];
}

export async function addVerifiedEmail(client: ReturnType<typeof harness>, cookie: string, email: string) {
    const added = await client.request('/api/auth/emails/add', { cookie, body: { email, password } });
    expect(added.status, await added.clone().text()).toBe(200);
    const challenge = await added.json<{ emailId: string; challengeId: string }>();
    const verified = await client.request('/api/auth/emails/verify', {
        cookie, body: { challengeId: challenge.challengeId, code: mailCode(client.messages.at(-1)) },
    });
    expect(verified.status, await verified.clone().text()).toBe(200);
    return challenge.emailId;
}

export async function recoveryToken(client: ReturnType<typeof harness>, identifier = 'person@example.test', email = identifier) {
    const started = await client.request('/api/auth/emails/recovery/start', { body: { identifier, email } });
    expect(started.status, await started.clone().text()).toBe(200);
    const { challengeId } = await started.json<{ challengeId: string }>();
    const verified = await client.request('/api/auth/emails/recovery/verify', {
        body: { challengeId, code: mailCode(client.messages.at(-1)) },
    });
    expect(verified.status, await verified.clone().text()).toBe(200);
    const { token } = await verified.json<{ token: string }>();
    expect(token).toBeTruthy();
    return token;
}

export async function session(client: ReturnType<typeof harness>, cookie: string) {
    const response = await client.request('/api/auth/get-session', { cookie });
    if (response.status === 401 || response.status === 403) return null;
    return response.json<{ user: { id: string; name: string; email: string; username?: string | null; locale: string; role: string };
        session: { id: string; token: string } } | null>();
}
