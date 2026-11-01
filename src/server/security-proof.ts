import type { GenericEndpointContext } from 'better-auth';
import { APIError } from 'better-auth/api';
import type { Env } from './config';
import type { SecurityPurpose } from '../shared/social';

export type SecurityAuthorization = { credentialHash: string } | { proofId: string; sessionId: string };
export function securityError(code = 'SOCIAL_REAUTH_REQUIRED'): never { throw new APIError('BAD_REQUEST', { code, message: code }); }

export async function requireSecurity(ctx: GenericEndpointContext, env: Env, purpose: SecurityPurpose, password?: string): Promise<SecurityAuthorization> {
    const identity = ctx.context.session;
    if (!identity || identity.user.banned || !identity.user.emailVerified) throw new APIError('UNAUTHORIZED', { code: 'UNAUTHORIZED' });
    const credential = await ctx.context.internalAdapter.findCredentialAccount(identity.user.id);
    if (credential?.password) {
        if (!password || !await ctx.context.password.verify({ hash: credential.password, password })) securityError('INVALID_PASSWORD');
        return { credentialHash: credential.password };
    }
    const cookie = ctx.context.createAuthCookie('security_proof');
    const id = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
    if (!id) securityError();
    const claimed = await env.DB.prepare(`UPDATE "securityProof" SET "used" = 1
        WHERE "id" = ? AND "userId" = ? AND "sessionId" = ? AND "purpose" = ? AND "used" = 0 AND "expiresAt" > ?
        AND EXISTS (SELECT 1 FROM "session" s JOIN "user" u ON u."id" = s."userId" WHERE s."id" = "securityProof"."sessionId"
            AND s."expiresAt" > ? AND COALESCE(u."banned", 0) = 0 AND u."emailVerified" = 1)
        RETURNING "id"`).bind(id, identity.user.id, identity.session.id, purpose, Date.now(), new Date().toISOString()).first();
    if (!claimed) securityError();
    return { proofId: id, sessionId: identity.session.id };
}

/** Conditions travel to the final D1 write, including after asynchronous mail or object work. */
export function securityGuard(authorization: SecurityAuthorization, userExpression: string): { sql: string; values: string[] } {
    if ('credentialHash' in authorization) return {
        sql: `EXISTS (SELECT 1 FROM "account" a WHERE a."userId" = ${userExpression} AND a."providerId" = 'credential' AND a."password" = ?)`,
        values: [authorization.credentialHash],
    };
    return {
        sql: `EXISTS (SELECT 1 FROM "securityProof" p JOIN "session" s ON s."id" = p."sessionId"
            WHERE p."id" = ? AND p."userId" = ${userExpression} AND p."sessionId" = ? AND p."used" = 1 AND p."expiresAt" > ? AND s."expiresAt" > ?)`,
        values: [authorization.proofId, authorization.sessionId, String(Date.now()), new Date().toISOString()],
    };
}
