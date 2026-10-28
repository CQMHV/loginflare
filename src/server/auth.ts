import { betterAuth } from 'better-auth';
import { admin, captcha, jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import { z } from 'zod';
import { validateConfig, type Env } from './config.ts';
import { sendAccountMail } from './mail.ts';
import { locales } from '../shared/locales.ts';
import { createOAuthPolicy } from './oauth-policy.ts';

export function createAuth(env: Env, delivery = { failed: false }) {
    validateConfig(env);
    const policy = createOAuthPolicy(env);
    async function send(kind: 'verify' | 'reset', user: { email: string; name: string; locale?: unknown }, url: string) {
        try {
            await sendAccountMail(env, kind, user, url);
        } catch (error) {
            delivery.failed = true;
            throw error;
        }
    }
    return betterAuth({
        appName: 'Loginflare',
        baseURL: env.AUTH_URL,
        basePath: '/api/auth',
        disabledPaths: ['/token'],
        secret: env.BETTER_AUTH_SECRET,
        database: env.DB,
        trustedOrigins: [env.AUTH_URL],
        telemetry: { enabled: false },
        logger: { disabled: true },
        emailAndPassword: {
            enabled: true,
            requireEmailVerification: true,
            revokeSessionsOnPasswordReset: true,
            onPasswordReset: policy.onPasswordReset,
            sendResetPassword: ({ user, url }) => send('reset', user, url),
        },
        emailVerification: {
            sendOnSignUp: true,
            sendOnSignIn: false,
            autoSignInAfterVerification: false,
            sendVerificationEmail: ({ user, url }) => send('verify', user, url),
        },
        user: {
            additionalFields: {
                locale: {
                    type: 'string',
                    required: false,
                    defaultValue: 'en-US',
                    input: true,
                    validator: { input: z.enum(locales) },
                },
            },
            changeEmail: { enabled: false },
            deleteUser: { enabled: false },
        },
        session: { cookieCache: { enabled: false } },
        advanced: {
            useSecureCookies: env.APP_ENV !== 'development',
            ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
        },
        rateLimit: {
            enabled: true,
            storage: 'database',
            window: 60,
            max: 100,
            customRules: {
                '/sign-in/email': { window: 60, max: 5 },
                '/sign-up/email': { window: 60, max: 3 },
                '/request-password-reset': { window: 60, max: 3 },
                '/send-verification-email': { window: 60, max: 3 },
            },
        },
        plugins: [
            policy.plugin,
            admin({ defaultRole: 'user', adminRoles: ['admin'] }),
            jwt({
                jwks: { keyPairConfig: { alg: 'RS256' } },
                jwt: { issuer: `${env.AUTH_URL}/api/auth` },
                disableSettingJwtHeader: true,
            }),
            oauthProvider({
                extensions: [policy.extension],
                loginPage: '/en-us/login',
                consentPage: '/en-us/consent',
                scopes: ['openid', 'profile', 'email', 'offline_access'],
                grantTypes: ['authorization_code', 'refresh_token'],
                allowDynamicClientRegistration: false,
                allowUnauthenticatedClientRegistration: false,
                clientReference: () => 'loginflare',
                clientPrivileges: ({ user }) => user?.role === 'admin' && !user?.banned,
            }),
            captcha({
                provider: 'cloudflare-turnstile',
                secretKey: env.TURNSTILE_SECRET_KEY,
                endpoints: ['/sign-up/email', '/sign-in/email', '/request-password-reset', '/send-verification-email'],
            }),
        ],
    });
}
