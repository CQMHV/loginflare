import type { BetterAuthPlugin, GenericEndpointContext } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware, sessionMiddleware } from 'better-auth/api';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { parseSetCookieHeader, setSessionCookie } from 'better-auth/cookies';
import { generateState, parseState, generateIdTokenNonce, handleOAuthUserInfo, linkOAuthAccount } from 'better-auth/oauth2';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { z } from 'zod';
import type { Env } from './config';
import { connection, publicProviders, type LoadedConnection } from './social-connections';
import { buildSocialProvider } from './social-provider';
import { requireSecurity, securityGuard, type SecurityAuthorization } from './security-proof';
import { securityPurposes, type SecurityPurpose } from '../shared/social';
import { locales, localizedPath, type Locale } from '../shared/locales';
import { sendEmailCode } from './mail';
import { consumeEmailQuota } from './email-operations';
import { socialFetch } from './social-network';
import { inspectImage } from '../shared/avatars';
import { maximumSourceBytes } from '../shared/image-limits';

interface Profile { subject: string; email?: string; verified: boolean; name: string; image?: string }
interface FlowData {
    locale: Locale; oauthQuery: string; action?: SecurityPurpose; profile?: Profile;
    authorization?: SecurityAuthorization; codeHash?: string; email?: string; verifiedSessionId?: string;
}
interface Flow {
    id: string; connectionId: string; revision: number; browserHash: string;
    purpose: 'login' | 'link' | 'reauth' | 'test'; userId: string | null; sessionId: string | null;
    stage: string; data: string; attempts: number; expiresAt: number;
}
const lifetime = 600_000;
const flowInput = z.object({
    connectionId: z.string().uuid(), locale: z.enum(locales),
    purpose: z.enum(['login', 'link', 'reauth', 'test']).default('login'),
    action: z.enum(securityPurposes).optional(), oauth_query: z.string().max(12000).optional(), password: z.string().max(128).optional(),
}).strict();
const emailInput = z.object({ email: z.email().max(254).transform((value) => value.toLowerCase()) }).strict();
const codeInput = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();

async function digest(value: string) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function socialAuthentication(env: Env, selected?: LoadedConnection) {
    const encrypt = (value: FlowData) => symmetricEncrypt({ key: env.BETTER_AUTH_SECRET, data: JSON.stringify(value) });
    const unpack = async (flow: Flow): Promise<FlowData> => JSON.parse(await symmetricDecrypt({ key: env.BETTER_AUTH_SECRET, data: flow.data })) as FlowData;
    const liveFlow = `EXISTS (SELECT 1 FROM "socialFlow" f JOIN "socialConnection" c ON c."id" = f."connectionId"
        WHERE f."id" = ? AND f."stage" = ? AND f."data" = ? AND f."expiresAt" > ? AND c."revision" = f."revision" AND c."enabled" = 1 AND c."archived" = 0)`;
    const flowValues = (flow: Flow) => [flow.id, flow.stage, flow.data, Date.now()];
    const mfaRequests = new WeakMap<object, string | null>();
    async function mfaFlowId(ctx: GenericEndpointContext) {
        if (mfaRequests.has(ctx.context)) return mfaRequests.get(ctx.context)!;
        if (await currentUser(ctx).catch(() => null)) { mfaRequests.set(ctx.context, null); return null; }
        const name = ctx.context.createAuthCookie('two_factor').name;
        const challenge = await ctx.getSignedCookie(name, ctx.context.secret);
        if (!challenge) return null;
        const id = (await ctx.context.internalAdapter.findVerificationValue(`social-mfa:${challenge}`))?.value ?? null;
        mfaRequests.set(ctx.context, id);
        return id;
    }
    function fail(code = 'SOCIAL_FLOW_EXPIRED'): never { throw new APIError('BAD_REQUEST', { code, message: code }); }
    async function cookieFlow(ctx: GenericEndpointContext): Promise<Flow> {
        const cookie = ctx.context.createAuthCookie('social_flow');
        const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
        if (!value) return fail();
        const [id, browser] = value.split('.');
        const flow = await env.DB.prepare(`SELECT f.* FROM "socialFlow" f JOIN "socialConnection" c ON c."id" = f."connectionId"
            WHERE f."id" = ? AND f."browserHash" = ? AND f."expiresAt" > ? AND c."revision" = f."revision"
            AND c."archived" = 0 AND (c."enabled" = 1 OR f."purpose" = 'test')`)
            .bind(id ?? '', await digest(browser ?? ''), Date.now()).first<Flow>();
        if (!flow) return fail();
        if (flow.userId && ['link', 'reauth', 'test'].includes(flow.purpose)) {
            if (flow.stage === 'authorization') {
                const actor = await currentUser(ctx);
                if (actor.user.id !== flow.userId || actor.session.id !== flow.sessionId) fail();
            }
            const active = await env.DB.prepare(`SELECT 1 FROM "session" s JOIN "user" u ON u."id" = s."userId"
                WHERE s."id" = ? AND u."id" = ? AND COALESCE(u."banned", 0) = 0 AND u."emailVerified" = 1 AND s."expiresAt" > ?
                ${flow.purpose === 'test' ? `AND u."role" = 'admin'` : ''}`)
                .bind(flow.sessionId, flow.userId, new Date().toISOString()).first();
            if (!active) return fail();
        }
        return flow;
    }
    async function save(flow: Flow, data: FlowData, stage: string, userId = flow.userId) {
        const encrypted = await encrypt(data);
        const result = await env.DB.prepare(`UPDATE "socialFlow" SET "data" = ?, "stage" = ?, "userId" = ? WHERE "id" = ? AND "stage" = ? AND "data" = ? AND "expiresAt" > ?
            AND EXISTS (SELECT 1 FROM "socialConnection" c WHERE c."id" = "socialFlow"."connectionId" AND c."revision" = "socialFlow"."revision" AND c."archived" = 0 AND (c."enabled" = 1 OR "socialFlow"."purpose" = 'test'))`)
            .bind(encrypted, stage, userId, flow.id, flow.stage, flow.data, Date.now()).run();
        if (!result.meta.changes) fail();
        flow.stage = stage; flow.userId = userId; flow.data = encrypted;
    }
    async function currentUser(ctx: GenericEndpointContext) {
        const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
        const identity = await ctx.context.internalAdapter.findSession(typeof token === 'string' ? token : '');
        if (!identity || !(identity.session.expiresAt.getTime() > Date.now()) || identity.user.banned || !identity.user.emailVerified) throw new APIError('UNAUTHORIZED', { code: 'UNAUTHORIZED' });
        return identity;
    }
    async function establish(ctx: GenericEndpointContext, flow: Flow, data: FlowData) {
        const profile = data.profile!;
        const bound = await ctx.context.internalAdapter.findAccountByKey({ providerId: flow.connectionId, accountId: profile.subject });
        if (flow.purpose === 'reauth') {
            if (!bound || bound.userId !== flow.userId) fail('SOCIAL_WRONG_IDENTITY');
        }
        const existing = bound ? await ctx.context.internalAdapter.findUserById(bound.userId) : null;
        if (existing && (!existing.emailVerified || await env.DB.prepare('SELECT 1 FROM "user" WHERE "id" = ? AND "banned" = 1').bind(existing.id).first())) fail('USER_BANNED');
        const email = existing?.email ?? data.email ?? profile.email;
        if (!email || (!existing && !profile.verified && !data.email)) fail('EMAIL_NOT_VERIFIED');
        if (!existing) {
            const occupied = await env.DB.prepare('SELECT 1 FROM "userEmail" WHERE "email" = ? COLLATE NOCASE').bind(email).first();
            if (occupied) fail('SOCIAL_ACCOUNT_NOT_LINKED');
            if (!z.email().max(254).safeParse(email).success) fail('SOCIAL_INVALID_IDENTITY');
            // D1 does not support interactive adapter transactions. Provision the
            // user and identity in one batch before Better Auth creates a session.
            const id = crypto.randomUUID(), now = new Date().toISOString();
            await env.DB.batch([
                env.DB.prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", "role", "locale")
                    SELECT ?, ?, ?, 1, ?, ?, 'user', ? WHERE ${liveFlow}
                    AND NOT EXISTS (SELECT 1 FROM "account" WHERE "providerId" = ? AND "accountId" = ?)
                    AND NOT EXISTS (SELECT 1 FROM "userEmail" WHERE "email" = ? COLLATE NOCASE)`)
                    .bind(id, profile.name, email, now, now, data.locale, ...flowValues(flow), flow.connectionId, profile.subject, email),
                env.DB.prepare(`INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
                    SELECT ?, ?, ?, "id", ?, ? FROM "user" WHERE "id" = ?`)
                    .bind(crypto.randomUUID(), profile.subject, flow.connectionId, now, now, id),
            ]);
        }
        const result = await handleOAuthUserInfo(ctx, {
            userInfo: { id: profile.subject, email, emailVerified: true, name: existing?.name ?? profile.name, image: existing?.image ?? null },
            account: { providerId: flow.connectionId, accountId: profile.subject },
            overrideUserInfo: false, requireExactAccountBinding: true,
            disableSignUp: true,
        });
        if (result.error || !result.data) fail('SOCIAL_ACCOUNT_NOT_LINKED');
        const { session, user } = result.data!;
        if (!user.name.trim() && profile.name.trim()) {
            await env.DB.prepare(`UPDATE "user" SET "name" = ?, "updatedAt" = ? WHERE "id" = ? AND trim("name") = ''`)
                .bind(profile.name, new Date().toISOString(), user.id).run();
            user.name = profile.name;
        }
        data.verifiedSessionId = session.id;
        await save(flow, data, 'authenticated', user.id);
        await setSessionCookie(ctx, { session, user });
    }

    return {
        id: 'loginflare-social',
        async init(context) {
            // Only the explicitly selected connection is initialized; local login never depends on discovery.
            if (selected) context.socialProviders = [await buildSocialProvider(selected, context)];
            return { options: { databaseHooks: { session: { create: {
                async before(session, ctx) {
                    if (!ctx) return;
                    const callback = ['/callback/:id', '/social/verify-email'].includes(ctx.path ?? '');
                    const challenge = ['/two-factor/verify-totp', '/two-factor/verify-backup-code'].includes(ctx.path ?? '') ? await mfaFlowId(ctx) : null;
                    if (!callback && !challenge) return { data: { ...session, socialFlowId: null } };
                    const flow = await cookieFlow(ctx);
                    if (challenge && (challenge !== flow.id || flow.stage !== 'mfa')) fail();
                    return { data: { ...session, socialFlowId: flow.id } };
                },
            } } } } };
        },
        endpoints: {
            socialStart: createAuthEndpoint('/social/start', { method: 'POST', body: flowInput }, async (ctx) => {
                const value = ctx.body;
                if (!selected || value.connectionId !== selected.id) fail('SOCIAL_CONNECTION_NOT_FOUND');
                const provider = ctx.context.socialProviders[0];
                if (!provider) fail('SOCIAL_PROVIDER_UNAVAILABLE');
                const oauthQuery = value.oauth_query ?? '';
                if (oauthQuery && (value.purpose !== 'login' || !await verifyOAuthQueryParams(oauthQuery, ctx.context.secret))) fail('INVALID_OAUTH_QUERY');
                const data: FlowData = { locale: value.locale, oauthQuery, action: value.action };
                let userId: string | null = null, sessionId: string | null = null;
                if (value.purpose !== 'login') {
                    const identity = await currentUser(ctx);
                    userId = identity.user.id; sessionId = identity.session.id;
                    if (value.purpose === 'test' && identity.user.role !== 'admin') throw new APIError('FORBIDDEN', { code: 'FORBIDDEN' });
                    if (value.purpose === 'link') {
                        ctx.context.session = identity;
                        data.authorization = await requireSecurity(ctx, env, 'link', value.password);
                    }
                    if (value.purpose === 'reauth') {
                        if (!value.action) fail('INVALID_INPUT');
                        const bound = await env.DB.prepare('SELECT 1 FROM "account" WHERE "userId" = ? AND "providerId" = ?').bind(userId, selected.id).first();
                        if (!bound) fail('SOCIAL_WRONG_IDENTITY');
                    }
                } else if (!selected.enabled) fail('SOCIAL_CONNECTION_NOT_FOUND');
                const id = crypto.randomUUID(), browser = crypto.randomUUID() + crypto.randomUUID();
                await env.DB.prepare(`INSERT INTO "socialFlow" ("id", "connectionId", "revision", "browserHash", "purpose", "userId", "sessionId", "stage", "data", "expiresAt") VALUES (?, ?, ?, ?, ?, ?, ?, 'authorization', ?, ?)`)
                    .bind(id, selected.id, selected.revision, await digest(browser), value.purpose, userId, sessionId, await encrypt(data), Date.now() + lifetime).run();
                const cookie = ctx.context.createAuthCookie('social_flow', { maxAge: 600 });
                await ctx.setSignedCookie(cookie.name, `${id}.${browser}`, ctx.context.secret, cookie.attributes);
                const nonce = generateIdTokenNonce(provider!);
                const state = await generateState(ctx, { additionalData: { flowId: id, connectorId: selected.id }, idTokenNonce: nonce });
                const url = await provider!.createAuthorizationURL({ state: state.state, codeVerifier: state.codeVerifier,
                    idTokenNonce: nonce, redirectURI: `${env.AUTH_URL}/api/auth/callback/${selected.id}` });
                return ctx.json({ url: url.toString() });
            }),
            callbackOAuth: createAuthEndpoint('/callback/:id', {
                method: 'GET', query: z.object({ state: z.string(), code: z.string().optional(), error: z.string().optional(), iss: z.string().optional() }),
            }, async (ctx) => {
                const flow = await cookieFlow(ctx), data = await unpack(flow);
                const destination = localizedPath(data.locale, 'social/complete');
                try {
                    if (!selected || ctx.params.id !== flow.connectionId || selected.id !== flow.connectionId || flow.stage !== 'authorization') fail();
                    const state = await parseState(ctx);
                    if (state.flowId !== flow.id || state.connectorId !== flow.connectionId) fail();
                    await save(flow, data, 'exchanging');
                    if (ctx.query.error || !ctx.query.code) fail('SOCIAL_AUTH_CANCELLED');
                    const provider = ctx.context.socialProviders[0]!;
                    if (ctx.query.iss && provider.issuer && ctx.query.iss !== provider.issuer) fail('SOCIAL_INVALID_IDENTITY');
                    if (provider.requiresIdTokenNonce && !state.idTokenNonce) fail('SOCIAL_INVALID_IDENTITY');
                    const tokens = await provider.validateAuthorizationCode({ code: ctx.query.code!, codeVerifier: state.codeVerifier,
                        redirectURI: `${env.AUTH_URL}/api/auth/callback/${flow.connectionId}` });
                    if (!tokens) fail('SOCIAL_INVALID_IDENTITY');
                    const info = await provider.getUserInfo({ ...tokens, expectedIdTokenNonce: state.idTokenNonce });
                    if (!info) fail('SOCIAL_INVALID_IDENTITY');
                    const rawSubject = await provider.accountSubject({ tokens, profile: info!.data });
                    if ((typeof rawSubject !== 'string' && typeof rawSubject !== 'number') || !String(rawSubject).trim() || String(rawSubject).length > 512) fail('SOCIAL_INVALID_IDENTITY');
                    data.profile = { subject: String(rawSubject), email: info!.user.email?.toLowerCase(), verified: info!.user.emailVerified === true,
                        name: (info!.user.name ?? '').slice(0, 100), image: info!.user.image?.slice(0, 2048) };
                    // From here onward only the verified identity/profile is retained, never upstream tokens.
                    if (flow.purpose === 'test') { await save(flow, data, 'tested'); return ctx.redirect(destination); }
                    if (flow.purpose === 'link') {
                        const authorization = data.authorization!;
                        const guard = securityGuard(authorization, 'u."id"');
                        const valid = await env.DB.prepare(`SELECT 1 FROM "user" u WHERE u."id" = ? AND COALESCE(u."banned", 0) = 0 AND ${guard.sql}`)
                            .bind(flow.userId, ...guard.values).first();
                        if (!valid) fail('SOCIAL_REAUTH_REQUIRED');
                        const target = await ctx.context.internalAdapter.findUserById(flow.userId!);
                        if (!target) fail();
                        const now = new Date().toISOString();
                        // The final ownership, actor session, security confirmation
                        // and connection revision checks belong to the same write.
                        await env.DB.prepare(`INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
                            SELECT ?, ?, ?, u."id", ?, ? FROM "user" u WHERE u."id" = ? AND COALESCE(u."banned", 0) = 0 AND ${guard.sql} AND ${liveFlow}
                            AND EXISTS (SELECT 1 FROM "session" s WHERE s."id" = ? AND s."userId" = u."id" AND s."expiresAt" > ?)
                            AND NOT EXISTS (SELECT 1 FROM "account" a WHERE a."providerId" = ? AND a."accountId" = ?)`)
                            .bind(crypto.randomUUID(), data.profile.subject, flow.connectionId, now, now, flow.userId, ...guard.values, ...flowValues(flow), flow.sessionId, now, flow.connectionId, data.profile.subject).run();
                        const binding = await ctx.context.internalAdapter.findAccountByKey({ providerId: flow.connectionId, accountId: data.profile.subject });
                        if (!binding || binding.userId !== flow.userId) fail('SOCIAL_IDENTITY_IN_USE');
                        const linked = await linkOAuthAccount(ctx, { link: { userId: target!.id, email: target!.email },
                            userInfo: { name: target!.name, email: data.profile.email, emailVerified: data.profile.verified },
                            account: { providerId: flow.connectionId, accountId: data.profile.subject }, profile: {} });
                        if (!linked.linked) fail('SOCIAL_IDENTITY_IN_USE');
                        data.verifiedSessionId = flow.sessionId!;
                        await save(flow, data, 'linked');
                    } else {
                        const bound = await ctx.context.internalAdapter.findAccountByKey({ providerId: flow.connectionId, accountId: data.profile.subject });
                        if (flow.purpose !== 'reauth' && !bound && (!data.profile.email || !data.profile.verified)) await save(flow, data, 'email');
                        else await establish(ctx, flow, data);
                    }
                    return ctx.redirect(destination);
                } catch (error) {
                    await env.DB.prepare('DELETE FROM "socialFlow" WHERE "id" = ?').bind(flow.id).run();
                    const code = error instanceof APIError && typeof error.body?.code === 'string' ? error.body.code : 'SOCIAL_PROVIDER_UNAVAILABLE';
                    return ctx.redirect(`${destination}?error=${encodeURIComponent(code)}`);
                }
            }),
            socialStatus: createAuthEndpoint('/social/flow', { method: 'GET' }, async (ctx) => {
                const flow = await cookieFlow(ctx), data = await unpack(flow);
                if (flow.stage === 'tested') return ctx.json({ stage: 'tested', profile: data.profile, purpose: flow.purpose });
                if (['email', 'code'].includes(flow.stage)) return ctx.json({ stage: flow.stage, purpose: flow.purpose, email: data.email });
                if (flow.stage === 'mfa') return ctx.json({ stage: 'mfa', purpose: flow.purpose });
                const identity = await currentUser(ctx);
                if (identity.user.id !== flow.userId || identity.session.id !== data.verifiedSessionId) fail();
                return ctx.json({ stage: flow.stage, purpose: flow.purpose, hasAvatarSource: !!data.profile?.image && !identity.user.image });
            }),
            socialEmail: createAuthEndpoint('/social/email', { method: 'POST', body: emailInput }, async (ctx) => {
                const flow = await cookieFlow(ctx), data = await unpack(flow);
                if (!['email', 'code'].includes(flow.stage)) fail();
                const quota = await consumeEmailQuota(env.DB, `social:${flow.id}`);
                if (!quota || quota.count > 3) fail('TOO_MANY_REQUESTS');
                if (await env.DB.prepare('SELECT 1 FROM "userEmail" WHERE "email" = ? COLLATE NOCASE').bind(ctx.body.email).first()) fail('SOCIAL_ACCOUNT_NOT_LINKED');
                const values = new Uint32Array(1); let number: number;
                do { crypto.getRandomValues(values); number = values[0]!; } while (number >= 4_294_000_000);
                const code = String(number % 1_000_000).padStart(6, '0');
                data.email = ctx.body.email; data.codeHash = await digest(`${flow.id}:${code}`);
                await save(flow, data, 'code');
                try { await sendEmailCode(env, { email: data.email, name: data.profile?.name ?? '', locale: data.locale }, code, 'social'); }
                catch { await env.DB.prepare('DELETE FROM "socialFlow" WHERE "id" = ?').bind(flow.id).run(); fail('EMAIL_DELIVERY_FAILED'); }
                return ctx.json({ status: true });
            }),
            socialVerifyEmail: createAuthEndpoint('/social/verify-email', { method: 'POST', body: codeInput }, async (ctx) => {
                const flow = await cookieFlow(ctx), data = await unpack(flow);
                if (flow.stage !== 'code') fail();
                const attempt = await env.DB.prepare('UPDATE "socialFlow" SET "attempts" = "attempts" + 1 WHERE "id" = ? AND "attempts" < 5 RETURNING "id"').bind(flow.id).first();
                if (!attempt || data.codeHash !== await digest(`${flow.id}:${ctx.body.code}`)) fail('INVALID_CODE');
                await save(flow, data, 'verified-email');
                await establish(ctx, flow, data);
                return ctx.json({ status: true });
            }),
            socialFinish: createAuthEndpoint('/social/finish', { method: 'POST', body: z.object({ oauth_query: z.string().optional() }).strict() }, async (ctx) => {
                const flow = await cookieFlow(ctx), data = await unpack(flow);
                if (flow.stage === 'tested') {
                    await env.DB.prepare('DELETE FROM "socialFlow" WHERE "id" = ?').bind(flow.id).run();
                    return ctx.json({ redirect: localizedPath(data.locale, 'admin/social-connections') });
                }
                const identity = await currentUser(ctx);
                if (!['authenticated', 'linked'].includes(flow.stage) || identity.user.id !== flow.userId || identity.session.id !== data.verifiedSessionId) fail();
                const consumed = await env.DB.prepare('DELETE FROM "socialFlow" WHERE "id" = ? AND "stage" = ? RETURNING "id"').bind(flow.id, flow.stage).first();
                if (!consumed) fail();
                if (flow.purpose === 'reauth') {
                    const id = crypto.randomUUID();
                    await env.DB.prepare('INSERT INTO "securityProof" ("id", "userId", "sessionId", "purpose", "expiresAt") VALUES (?, ?, ?, ?, ?)')
                        .bind(id, identity.user.id, identity.session.id, data.action!, Date.now() + 300_000).run();
                    const cookie = ctx.context.createAuthCookie('security_proof', { maxAge: 300 });
                    await ctx.setSignedCookie(cookie.name, id, ctx.context.secret, cookie.attributes);
                }
                // The OAuth Provider's existing session-completion hook resumes
                // the signed request only here, after MFA and optional profile work.
                if (data.oauthQuery) await setSessionCookie(ctx, identity);
                return ctx.json({ redirect: localizedPath(data.locale, flow.purpose === 'login' ? 'account' : data.action?.startsWith('emails/') ? 'account/emails' : 'account/security'), oauthQuery: data.oauthQuery });
            }),
            socialAvatarSource: createAuthEndpoint('/social/avatar-source', { method: 'GET', use: [sessionMiddleware] }, async (ctx) => {
                const flow = await cookieFlow(ctx), data = await unpack(flow), identity = ctx.context.session;
                if (!['authenticated', 'linked'].includes(flow.stage) || identity.user.id !== flow.userId || identity.session.id !== data.verifiedSessionId || identity.user.image || !data.profile?.image) fail();
                const image = await socialFetch(data.profile.image, {}, maximumSourceBytes);
                const inspected = inspectImage(image.bytes);
                return new Response(Uint8Array.from(image.bytes).buffer, { headers: { 'Content-Type': inspected.mime, 'Cache-Control': 'no-store' } });
            }),
            socialSecurity: createAuthEndpoint('/social/security', { method: 'GET', use: [sessionMiddleware] }, async (ctx) => {
                const user = ctx.context.session.user;
                const identities = (await env.DB.prepare(`SELECT a."id", a."providerId", a."accountId", c."name", (c."enabled" = 1 AND c."archived" = 0) AS "enabled"
                    FROM "account" a JOIN "socialConnection" c ON c."id" = a."providerId" WHERE a."userId" = ? ORDER BY c."position", c."id"`).bind(user.id)
                    .all<{ id: string; providerId: string; accountId: string; name: string; enabled: number }>()).results.map((item) => ({ ...item, enabled: !!item.enabled }));
                const credential = await ctx.context.internalAdapter.findCredentialAccount(user.id);
                const cookie = ctx.context.createAuthCookie('security_proof'), proofId = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
                const proof = proofId ? await env.DB.prepare('SELECT "purpose", "expiresAt" FROM "securityProof" WHERE "id" = ? AND "userId" = ? AND "sessionId" = ? AND "used" = 0 AND "expiresAt" > ?')
                    .bind(proofId, user.id, ctx.context.session.session.id, Date.now()).first<{ purpose: string; expiresAt: number }>() : null;
                return ctx.json({ hasPassword: !!credential?.password, identities, providers: await publicProviders(env), proofPurpose: proof?.purpose, proofExpiresAt: proof?.expiresAt });
            }),
            socialUnlink: createAuthEndpoint('/social/unlink', { method: 'POST', use: [sessionMiddleware], body: z.object({ accountId: z.string(), password: z.string().optional() }).strict() }, async (ctx) => {
                const userId = ctx.context.session.user.id;
                const authorization = await requireSecurity(ctx, env, 'unlink', ctx.body.password), guard = securityGuard(authorization, '"account"."userId"');
                const removed = await env.DB.prepare(`DELETE FROM "account" WHERE "id" = ? AND "userId" = ? AND "providerId" <> 'credential' AND ${guard.sql}
                    AND EXISTS (SELECT 1 FROM "account" other LEFT JOIN "socialConnection" c ON c."id" = other."providerId"
                        WHERE other."userId" = "account"."userId" AND other."id" <> "account"."id"
                        AND ((other."providerId" = 'credential' AND other."password" IS NOT NULL) OR (c."enabled" = 1 AND c."archived" = 0))) RETURNING "id"`)
                    .bind(ctx.body.accountId, userId, ...guard.values).first();
                if (!removed) fail('SOCIAL_LAST_LOGIN_METHOD');
                return ctx.json({ status: true });
            }),
            socialSetPassword: createAuthEndpoint('/social/set-password', { method: 'POST', use: [sessionMiddleware], body: z.object({ newPassword: z.string().min(8).max(128) }).strict() }, async (ctx) => {
                const user = ctx.context.session.user;
                if ((await ctx.context.internalAdapter.findCredentialAccount(user.id))?.password) fail('INVALID_INPUT');
                const authorization = await requireSecurity(ctx, env, 'set-password'), guard = securityGuard(authorization, 'u."id"');
                const hash = await ctx.context.password.hash(ctx.body.newPassword), now = new Date().toISOString();
                const result = await env.DB.prepare(`INSERT INTO "account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
                    SELECT ?, u."id", 'credential', u."id", ?, ?, ? FROM "user" u WHERE u."id" = ? AND COALESCE(u."banned", 0) = 0 AND ${guard.sql}
                    AND NOT EXISTS (SELECT 1 FROM "account" a WHERE a."userId" = u."id" AND a."providerId" = 'credential')`)
                    .bind(crypto.randomUUID(), hash, now, now, user.id, ...guard.values).run();
                if (!result.meta.changes) fail('SOCIAL_REAUTH_REQUIRED');
                return ctx.json({ status: true });
            }),
        },
        hooks: { before: [{
            matcher: (ctx) => ['/two-factor/verify-totp', '/two-factor/verify-backup-code'].includes(ctx.path ?? ''),
            handler: createAuthMiddleware(async (ctx) => {
                const id = await mfaFlowId(ctx);
                if (!id) return;
                const flow = await cookieFlow(ctx);
                if (flow.id !== id || flow.stage !== 'mfa') fail();
            }),
        }, {
            matcher: (ctx) => ctx.path === '/social/finish',
            handler: createAuthMiddleware(async (ctx) => {
                const flow = await cookieFlow(ctx), data = await unpack(flow);
                if (data.oauthQuery) ctx.body.oauth_query = data.oauthQuery;
            }),
        }, {
            matcher: (ctx) => ['/two-factor/enable', '/two-factor/disable', '/two-factor/generate-backup-codes'].includes(ctx.path ?? ''),
            handler: createAuthMiddleware(async (ctx) => {
                const identity = await currentUser(ctx);
                ctx.context.session = identity;
                const credential = await ctx.context.internalAdapter.findCredentialAccount(identity.user.id);
                if (!credential?.password) await requireSecurity(ctx, env, ctx.path!.slice(1) as SecurityPurpose);
            }),
        }], after: [{
            matcher: (ctx) => ['/callback/:id', '/social/verify-email', '/two-factor/verify-totp', '/two-factor/verify-backup-code'].includes(ctx.path ?? ''),
            handler: createAuthMiddleware(async (ctx) => {
                const next = ctx.context.newSession;
                let flow: Flow;
                try { flow = await cookieFlow(ctx); } catch { return; }
                const data = await unpack(flow);
                if (flow.stage === 'authenticated' && !next && ['/callback/:id', '/social/verify-email'].includes(ctx.path ?? '')) {
                    const name = ctx.context.createAuthCookie('two_factor').name;
                    const challenge = parseSetCookieHeader(ctx.context.responseHeaders?.get('set-cookie') ?? '').get(name)?.value;
                    if (!challenge) fail();
                    await ctx.context.internalAdapter.createVerificationValue({ identifier: `social-mfa:${decodeURIComponent(challenge).split('.')[0]}`,
                        value: flow.id, expiresAt: new Date(Date.now() + lifetime) });
                    await save(flow, data, 'mfa');
                    return ctx.path === '/callback/:id' ? ctx.redirect(`${localizedPath(data.locale, 'two-factor')}?social=1`) : ctx.json({ twoFactorRedirect: true });
                }
                if (flow.stage === 'mfa' && next) {
                    if (next.user.id !== flow.userId) fail('SOCIAL_WRONG_IDENTITY');
                    data.verifiedSessionId = next.session.id;
                    await save(flow, data, 'authenticated');
                }
            }),
        }] },
    } satisfies BetterAuthPlugin;
}
