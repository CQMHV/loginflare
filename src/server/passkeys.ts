import { passkey } from '@better-auth/passkey';
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx, sessionMiddleware } from 'better-auth/api';
import { z } from 'zod';
import type { Env } from './config';
import { requireSecurity, securityGuard, type SecurityAuthorization } from './security-proof';
import { readBrowserFlow } from './browser-accounts';
import type { GenericEndpointContext } from 'better-auth';

const password = z.string().max(128).optional();
const name = z.string().trim().min(1).max(100);
const active = `u."emailVerified" = 1 AND coalesce(u."banned", 0) = 0 AND u."deletionRequestedAt" IS NULL`;
const fail = (code = 'PASSKEY_NOT_AVAILABLE'): never => { throw new APIError('BAD_REQUEST', { code, message: code }); };
interface Registration { userId: string; sessionId: string; authorization: SecurityAuthorization }
interface Authentication { userId: string; passkeyId: string | null; browserFlowId: string | null }
const mfaPaths = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);

/** Keep upstream WebAuthn verification; compose account policy around its endpoints. */
export function accountPasskeys(env: Env, rpName: string) {
    const authentications = new WeakMap<object, Authentication | null>();
    async function mfaAuthentication(ctx: GenericEndpointContext) {
        if (authentications.has(ctx.context)) return authentications.get(ctx.context)!;
        if (await getSessionFromCtx(ctx)) { authentications.set(ctx.context, null); return null; }
        const challenge = await ctx.getSignedCookie(ctx.context.createAuthCookie('two_factor').name, ctx.context.secret);
        if (!challenge) return null;
        const record = await ctx.context.internalAdapter.findVerificationValue(`login-mfa:${challenge}`);
        // Old challenges did not retain their authentication source. They must
        // restart sign-in rather than silently becoming password MFA.
        if (!record) throw new APIError('UNAUTHORIZED', { code: 'INVALID_TWO_FACTOR_COOKIE', message: 'Invalid two factor cookie' });
        const binding: Authentication = JSON.parse(record.value);
        if (binding.passkeyId) {
            const flow = ctx.headers && await readBrowserFlow(env, ctx.headers);
            if (!flow || flow.id !== binding.browserFlowId || flow.status !== 'pending' || flow.userId !== binding.userId) fail();
        }
        authentications.set(ctx.context, binding);
        return binding;
    }
    const plugin = passkey({
        rpID: new URL(env.AUTH_URL).hostname, rpName, origin: env.AUTH_URL,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        registration: {
            requireSession: true,
            async afterVerification({ ctx, verification, context }) {
                const info = verification.registrationInfo;
                if (!info || !info.userVerified) return fail('PASSKEY_USER_VERIFICATION_REQUIRED');
                const binding: Registration = JSON.parse(context ?? 'null');
                if (!binding || binding.userId !== ctx.context.session?.user.id || binding.sessionId !== ctx.context.session.session.id) fail();
                const guard = securityGuard(binding.authorization, 'u."id"');
                const credentialId = info.credential.id;
                // The insert trigger rechecks this authorization at the actual native
                // credential write, after any asynchronous adapter work.
                const inserted = await env.DB.prepare(`INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
                    SELECT ?, ?, ?, ?, ?, ? FROM "user" u JOIN "session" s ON s."userId" = u."id"
                    WHERE u."id" = ? AND s."id" = ? AND s."expiresAt" > ? AND s."oauthRevokedAt" IS NULL AND ${active} AND ${guard.sql}`)
                    .bind(crypto.randomUUID(), `passkey:register:${credentialId}`, JSON.stringify(binding), new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), new Date().toISOString(), binding.userId, binding.sessionId, new Date().toISOString(), ...guard.values).run();
                if (!inserted.meta.changes) fail();
            },
        },
        authentication: { afterVerification({ verification }) {
            if (!verification.authenticationInfo.userVerified) fail('PASSKEY_USER_VERIFICATION_REQUIRED');
        } },
    });
    const native = plugin.endpoints;
    return { ...plugin, hooks: { before: [{
        matcher: (ctx: { path?: string }) => mfaPaths.has(ctx.path ?? ''),
        handler: createAuthMiddleware(async (ctx) => { await mfaAuthentication(ctx); }),
    }] }, init() { return { options: { databaseHooks: { session: { create: {
        async before(session: { userId: string }, ctx: GenericEndpointContext | null) {
            if (!ctx) return;
            if (mfaPaths.has(ctx.path ?? '')) {
                const binding = await mfaAuthentication(ctx);
                if (!binding) return;
                if (binding.userId !== session.userId) fail();
                if (!binding.passkeyId) return;
                // Keep the original ID even after deletion: the existing SQL
                // session guard rejects a credential lost at the final write.
                return { data: { ...session, passkeyId: binding.passkeyId } };
            }
            if (ctx.path !== '/passkey/verify-authentication') return;
            const flow = ctx.headers && await readBrowserFlow(env, ctx.headers);
            if (!flow || flow.status !== 'pending') return fail('BROWSER_FLOW_EXPIRED');
            const id = await env.DB.prepare('SELECT "id" FROM "passkey" WHERE "credentialID" = ? AND "userId" = ?').bind(ctx.body?.response?.id, session.userId).first<string>('id');
            if (!id) return fail();
            authentications.set(ctx.context, { userId: session.userId, passkeyId: id, browserFlowId: flow.id });
            return { data: { ...session, passkeyId: id } };
        },
    } }, verification: { create: {
        async before(record: { identifier: string; value: string; expiresAt: Date }, ctx: GenericEndpointContext | null) {
            if (!ctx || !/^2fa-(?!attempts-)/.test(record.identifier)) return;
            const binding = ctx.path === '/passkey/verify-authentication' ? authentications.get(ctx.context)
                : { userId: record.value, passkeyId: null, browserFlowId: null };
            if (!binding || binding.userId !== record.value) fail();
            // Mark every source BEFORE the native challenge, including password
            // and social login. Absence must never imply a non-passkey source.
            await ctx.context.internalAdapter.createVerificationValue({ identifier: `login-mfa:${record.identifier}`, value: JSON.stringify(binding), expiresAt: record.expiresAt });
        },
    } } } } }; }, endpoints: {
        ...native,
        generatePasskeyRegistrationOptions: createAuthEndpoint('/passkey/generate-register-options', {
            method: 'POST', use: [sessionMiddleware], body: z.object({ password }).strict(),
        }, async (ctx) => {
            const identity = ctx.context.session;
            const authorization = await requireSecurity(ctx, env, 'passkeys/add', ctx.body.password);
            if (!await env.DB.prepare(`SELECT 1 FROM "user" u WHERE u."id" = ? AND ${active}`).bind(identity.user.id).first()) fail();
            const context: Registration = { userId: identity.user.id, sessionId: identity.session.id, authorization };
            // Enrollment already proved the current password/provider. Scope the
            // native age override here; the final insert still requires that
            // exact fresh authorization and a live, matching session.
            const generated = await native.generatePasskeyRegistrationOptions({ ...ctx, context: { ...ctx.context, sessionConfig: { ...ctx.context.sessionConfig, freshAge: 0 } }, method: 'GET', body: undefined, query: { context: JSON.stringify(context) }, asResponse: false, returnHeaders: true, returnStatus: false });
            for (const cookie of generated.headers.getSetCookie()) ctx.responseHeaders.append('set-cookie', cookie);
            return ctx.json(generated.response);
        }),
        verifyPasskeyRegistration: createAuthEndpoint('/passkey/verify-registration', {
            method: 'POST', use: [sessionMiddleware], body: z.object({ response: z.record(z.string(), z.unknown()), name: name.optional() }).strict(),
        }, async (ctx) => {
            const verified = await native.verifyPasskeyRegistration({ ...ctx, context: { ...ctx.context, sessionConfig: { ...ctx.context.sessionConfig, freshAge: 0 } }, body: { ...ctx.body, createSession: false }, asResponse: false, returnHeaders: true, returnStatus: false });
            for (const cookie of verified.headers.getSetCookie()) ctx.responseHeaders.append('set-cookie', cookie);
            return ctx.json(verified.response);
        }),
        generatePasskeyAuthenticationOptions: createAuthEndpoint('/passkey/generate-authenticate-options', { method: 'GET' }, async (ctx) => {
            const flow = ctx.headers && await readBrowserFlow(env, ctx.headers);
            if (!flow || flow.status !== 'pending') fail('BROWSER_FLOW_EXPIRED');
            const generated = await native.generatePasskeyAuthenticationOptions({ ...ctx, asResponse: false, returnHeaders: true, returnStatus: false });
            for (const cookie of generated.headers.getSetCookie()) ctx.responseHeaders.append('set-cookie', cookie);
            return ctx.json({ ...generated.response, userVerification: 'required' as const });
        }),
        listPasskeys: createAuthEndpoint('/passkey/list-user-passkeys', { method: 'GET', use: [sessionMiddleware] }, async (ctx) => {
            const rows = await env.DB.prepare(`SELECT "id", "name", "deviceType", "backedUp", "createdAt" FROM "passkey" WHERE "userId" = ? ORDER BY "createdAt", "id"`).bind(ctx.context.session.user.id).all();
            return ctx.json(rows.results);
        }),
        deletePasskey: createAuthEndpoint('/passkey/delete-passkey', { method: 'POST', use: [sessionMiddleware], body: z.object({ id: z.string().max(255), password }).strict() }, async (ctx) => {
            const authorization = await requireSecurity(ctx, env, 'passkeys/delete', ctx.body.password), guard = securityGuard(authorization, 'u."id"');
            const removed = await env.DB.prepare(`DELETE FROM "passkey" WHERE "id" = ? AND "userId" = ?
                AND EXISTS (SELECT 1 FROM "user" u WHERE u."id" = "passkey"."userId" AND ${active} AND ${guard.sql})
                AND (EXISTS (SELECT 1 FROM "passkey" p WHERE p."userId" = "passkey"."userId" AND p."id" <> "passkey"."id")
                    OR EXISTS (SELECT 1 FROM "account" a LEFT JOIN "socialConnection" c ON c."id" = a."providerId" WHERE a."userId" = "passkey"."userId"
                        AND ((a."providerId" = 'credential' AND a."password" IS NOT NULL) OR (c."enabled" = 1 AND c."archived" = 0)))) RETURNING "id"`)
                .bind(ctx.body.id, ctx.context.session.user.id, ...guard.values).first();
            if (!removed) fail('PASSKEY_DELETE_REJECTED');
            return ctx.json({ status: true });
        }),
        updatePasskey: createAuthEndpoint('/passkey/update-passkey', { method: 'POST', use: [sessionMiddleware], body: z.object({ id: z.string().max(255), name, password }).strict() }, async (ctx) => {
            const authorization = await requireSecurity(ctx, env, 'passkeys/rename', ctx.body.password), guard = securityGuard(authorization, 'u."id"');
            const updated = await env.DB.prepare(`UPDATE "passkey" SET "name" = ? WHERE "id" = ? AND "userId" = ?
                AND EXISTS (SELECT 1 FROM "user" u WHERE u."id" = "passkey"."userId" AND ${active} AND ${guard.sql}) RETURNING "id"`)
                .bind(ctx.body.name, ctx.body.id, ctx.context.session.user.id, ...guard.values).first();
            if (!updated) fail();
            return ctx.json({ status: true });
        }),
    } };
}
