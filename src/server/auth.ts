import { betterAuth } from 'better-auth';
import { admin, captcha, jwt, username } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import { z } from 'zod';
import { validateConfig, type Env } from './config.ts';
import { sendAccountMail } from './mail.ts';
import { locales } from '../shared/locales.ts';
import { createOAuthPolicy } from './oauth-policy.ts';
import { emailManagement } from './emails';
import { databaseRateLimit } from './rate-limit';

export function createAuth(env: Env, delivery = { failed: false }, schedule?: (task: Promise<unknown>) => void) {
    validateConfig(env);
    const policy = createOAuthPolicy(env);
    async function send(user: { email: string; name: string; locale?: unknown }, url: string) {
        try {
            await sendAccountMail(env, user, url);
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
        },
        emailVerification: {
            sendOnSignUp: true,
            sendOnSignIn: false,
            autoSignInAfterVerification: false,
            sendVerificationEmail: ({ user, url }) => send(user, url),
        },
        verification: { disableCleanup: true },
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
            database: { validateSchema: false },
            useSecureCookies: env.APP_ENV !== 'development',
            ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
        },
        rateLimit: {
            enabled: true,
            customStorage: databaseRateLimit(env.DB),
            window: 60,
            max: 100,
            customRules: {
                '/sign-in/email': { window: 60, max: 5 },
                '/sign-in/username': { window: 60, max: 5 },
                '/sign-up/email': { window: 60, max: 3 },
                '/emails/recovery/start': { window: 60, max: 3 },
                '/emails/recovery/verify': { window: 60, max: 10 },
                '/emails/add': { window: 60, max: 5 },
                '/emails/resend': { window: 60, max: 5 },
                '/emails/verify': { window: 60, max: 10 },
                '/emails/set-primary': { window: 60, max: 5 },
                '/emails/remove': { window: 60, max: 5 },
                '/send-verification-email': { window: 60, max: 3 },
            },
        },
        plugins: [
            policy.plugin,
            emailManagement(env, schedule),
            admin({ defaultRole: 'user', adminRoles: ['admin'] }),
            username({ displayUsername: false }),
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
                endpoints: ['/sign-up/email', '/sign-in/email', '/sign-in/username', '/emails/recovery/start', '/send-verification-email'],
            }),
        ],
    });
}
