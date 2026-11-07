import { betterAuth } from 'better-auth';
import { admin, captcha, jwt, multiSession, twoFactor, username } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import { z } from 'zod';
import { validateConfig, type Env } from './config.ts';
import { sendAccountMail } from './mail.ts';
import { locales } from '../shared/locales.ts';
import { createOAuthPolicy } from './oauth-policy.ts';
import { emailManagement } from './emails';
import { databaseRateLimit } from './rate-limit';
import { socialAuthentication } from './social-auth';
import type { LoadedConnection } from './social-connections';
import { applicationPolicy, applicationPrivileges, type ApplicationManagement } from './application-policy';
import { browserAccounts, browserSessionPlugin } from './browser-accounts';
import { auditAuthentication } from './audit';
import { apiAccessClaims } from './api-access-policy';
import { managementScopes } from '../shared/machines';
import { defaultBranding } from '../shared/branding';

export function createAuth(env: Env, delivery = { failed: false }, schedule?: (task: Promise<unknown>) => void, selected?: LoadedConnection, management?: ApplicationManagement, businessScopes: string[] = [], brandName: string = defaultBranding.name) {
    validateConfig(env);
    const policy = createOAuthPolicy(env);
    const multifactor = twoFactor({ issuer: brandName, allowPasswordless: true });
    const passwordMfa = multifactor.hooks.after[0]!.matcher;
    multifactor.hooks.after[0]!.matcher = (context) => passwordMfa(context)
        || context.path === '/callback/:id' || context.path === '/social/verify-email';
    async function send(user: { email: string; name: string; locale?: unknown }, url: string) {
        try {
            await sendAccountMail(env, user, url);
        } catch (error) {
            delivery.failed = true;
            throw error;
        }
    }
    return betterAuth({
        appName: brandName,
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
        account: { updateAccountOnSignIn: false, accountLinking: {
            enabled: true, disableImplicitLinking: true, allowDifferentEmails: true,
            trustedProviders: selected ? [selected.id] : [], updateUserInfoOnLink: false,
        } },
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
        session: { cookieCache: { enabled: false }, additionalFields: { socialFlowId: { type: 'string', required: false, input: false } } },
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
                '/verify-password': { window: 60, max: 5 },
                '/emails/recovery/start': { window: 60, max: 3 },
                '/emails/recovery/verify': { window: 60, max: 10 },
                '/emails/add': { window: 60, max: 5 },
                '/emails/resend': { window: 60, max: 5 },
                '/emails/verify': { window: 60, max: 10 },
                '/emails/set-primary': { window: 60, max: 5 },
                '/emails/remove': { window: 60, max: 5 },
                '/send-verification-email': { window: 60, max: 3 },
                '/social/start': { window: 60, max: 20 },
                '/social/email': { window: 60, max: 5 },
                '/social/verify-email': { window: 60, max: 10 },
                '/social/unlink': { window: 60, max: 5 },
                '/social/set-password': { window: 60, max: 5 },
            },
        },
        plugins: [
            applicationPolicy(management),
            policy.plugin,
            emailManagement(env, schedule),
            admin({ defaultRole: 'user', adminRoles: ['admin'] }),
            username({ displayUsername: false }),
            multifactor,
            socialAuthentication(env, selected),
            browserSessionPlugin(env),
            multiSession({ maximumSessions: 5 }),
            jwt({
                jwks: { keyPairConfig: { alg: 'RS256' } },
                jwt: { issuer: `${env.AUTH_URL}/api/auth` },
                disableSettingJwtHeader: true,
            }),
            oauthProvider({
                extensions: [policy.extension, apiAccessClaims(env)],
                loginPage: '/en-us/login',
                consentPage: '/en-us/consent',
                selectAccount: {
                    page: '/en-us/select-account',
                    shouldRedirect: async ({ headers }) => (await browserAccounts(env, headers)).filter((account) => account.status === 'active').length > 1,
                },
                scopes: ['openid', 'profile', 'email', 'offline_access', ...managementScopes, ...businessScopes],
                enforcePerClientResources: true,
                grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'],
                m2mAccessTokenExpiresIn: 300,
                allowDynamicClientRegistration: false,
                allowUnauthenticatedClientRegistration: false,
                clientReference: () => 'loginflare',
                clientPrivileges: async ({ user, session, action, clientId }) => {
                    if (!management) return user?.role === 'admin' && !user.banned && user.emailVerified;
                    if (!user || !session || user.id !== management.userId || session.id !== management.sessionId
                        || action === 'delete' || action === 'configure-client-credentials-scopes') return false;
                    return applicationPrivileges(env, management, clientId, ['create', 'update', 'rotate'].includes(action));
                },
            }),
            captcha({
                provider: 'cloudflare-turnstile',
                secretKey: env.TURNSTILE_SECRET_KEY,
                endpoints: ['/sign-up/email', '/sign-in/email', '/sign-in/username', '/emails/recovery/start', '/send-verification-email'],
            }),
            auditAuthentication(env),
        ],
    });
}
