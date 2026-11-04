import { APIError } from 'better-auth/api';
import { getOAuthProviderApi, type OAuthClaimExtensionInput, type OAuthProviderExtension } from '@better-auth/oauth-provider';
import type { Env } from './config';

export const identityScopes = ['openid', 'profile', 'email', 'offline_access'];
export async function businessScopeCatalog(env: Env): Promise<string[]> {
    return (await env.DB.prepare('SELECT "scope" FROM "apiPermission" ORDER BY "scope" LIMIT 1000').all<{ scope: string }>()).results.map((row) => row.scope);
}
export async function permittedApiScopes(env: Env, userId: string, clientId: string, resources: string[], scopes: string[]): Promise<boolean> {
    const apiResources = resources.filter((value) => value !== `${env.AUTH_URL}/api/auth/oauth2/userinfo`);
    const business = scopes.filter((scope) => !identityScopes.includes(scope));
    if (!apiResources.length) return business.length === 0;
    if (apiResources.length !== 1 || new Set(scopes).size !== scopes.length) return false;
    const row = await env.DB.prepare(`SELECT r."id" FROM "oauthResource" r JOIN "oauthClientResource" link ON link."resourceId" = r."identifier"
        JOIN "oauthClient" client ON client."clientId" = link."clientId" JOIN "user" u ON u."id" = ?
        WHERE r."identifier" = ? AND coalesce(r."disabled", 0) = 0 AND link."clientId" = ? AND client."referenceId" = 'loginflare'
        AND coalesce(client."disabled", 0) = 0 AND u."emailVerified" = 1 AND coalesce(u."banned", 0) = 0`)
        .bind(userId, apiResources[0], clientId).first<{ id: string }>();
    if (!row) return false;
    const allowed = await env.DB.prepare(`SELECT COUNT(DISTINCT p."scope") AS n FROM "apiPermission" p
        JOIN "apiRolePermission" rp ON rp."permissionId" = p."id" JOIN "apiUserRole" ur ON ur."roleId" = rp."roleId"
        WHERE p."resourceId" = ? AND ur."userId" = ? AND p."scope" IN (SELECT value FROM json_each(?))`)
        .bind(row.id, userId, JSON.stringify(business)).first<number>('n');
    return allowed === business.length;
}
export async function knownApiScopes(env: Env, clientId: string, resources: string[], scopes: string[]): Promise<boolean> {
    const business = scopes.filter((scope) => !identityScopes.includes(scope));
    if (!resources.length) return business.length === 0;
    if (resources.length !== 1) return false;
    const resource = await env.DB.prepare(`SELECT r."id" FROM "oauthResource" r JOIN "oauthClientResource" link ON link."resourceId" = r."identifier"
        WHERE r."identifier" = ? AND coalesce(r."disabled", 0) = 0 AND link."clientId" = ?`).bind(resources[0], clientId).first<{ id: string }>();
    if (!resource) return false;
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM "apiPermission" WHERE "resourceId" = ? AND "scope" IN (SELECT value FROM json_each(?))').bind(resource.id, JSON.stringify(business)).first<number>('n');
    return count === business.length;
}
async function grantIdentifier(env: Env, input: OAuthClaimExtensionInput): Promise<string | null> {
    const provider = getOAuthProviderApi(input.ctx, input.opts, input.grantType);
    if (input.grantType === 'authorization_code' && typeof input.ctx.body?.code === 'string') return provider.hashToken(input.ctx.body.code, 'authorization_code');
    if (input.grantType === 'refresh_token' && typeof input.ctx.body?.refresh_token === 'string') {
        const token = await provider.hashToken(input.ctx.body.refresh_token, 'refresh_token');
        return env.DB.prepare('SELECT "authorizationCodeId" FROM "oauthRefreshToken" WHERE "token" = ? AND "userId" = ? AND "clientId" = ?')
            .bind(token, input.user?.id ?? '', input.client.clientId).first<string>('authorizationCodeId');
    }
    return null;
}
export function apiAccessClaims(env: Env): OAuthProviderExtension {
    return { claims: {
    async userInfo(input) {
        if (!await activeApiToken(env, input.jwt)) throw new APIError('UNAUTHORIZED', { error: 'invalid_token', error_description: 'The API authorization is unavailable.' });
        return {};
    },
    async accessToken(input) {
        const resources = input.resources?.filter((value) => value !== `${env.AUTH_URL}/api/auth/oauth2/userinfo`) ?? [];
        if (!resources.length && input.scopes.every((scope) => identityScopes.includes(scope))) return {};
        const invalid = () => new APIError('BAD_REQUEST', { error: 'invalid_scope', error_description: 'The requested API access is unavailable.' });
        if (!input.user?.id || !await permittedApiScopes(env, input.user.id, input.client.clientId, resources, input.scopes)) throw invalid();
        const authorizationCodeId = await grantIdentifier(env, input);
        if (!authorizationCodeId) throw invalid();
        const snapshot = await env.DB.prepare(`SELECT s."scopes", s."resources" FROM "apiGrantScope" s JOIN "oauthGrantPolicy" g ON g."authorizationCodeId" = s."authorizationCodeId"
            WHERE g."authorizationCodeId" = ? AND g."userId" = ? AND g."clientId" = ? AND g."revokedAt" IS NULL`)
            .bind(authorizationCodeId, input.user.id, input.client.clientId).first<{ scopes: string; resources: string }>();
        if (!snapshot || !await permittedApiScopes(env, input.user.id, input.client.clientId, JSON.parse(snapshot.resources) as string[], snapshot.scopes.split(' ').filter(Boolean))) throw invalid();
        // JWT resource tokens do not have native oauthAccessToken rows. Retain
        // their grant until the longest permitted JWT has expired as well.
        const now = new Date().toISOString();
        const updated = await env.DB.prepare(`UPDATE "oauthGrantPolicy" SET "activatedAt" = coalesce("activatedAt", ?), "gcAfter" = max("gcAfter", ?)
            WHERE "authorizationCodeId" = ? AND "revokedAt" IS NULL`).bind(now, new Date(Date.now() + 3_600_000).toISOString(), authorizationCodeId).run();
        if (!updated.meta.changes) throw invalid();
        return { lf_grant: authorizationCodeId };
    } } };
}

/** Called only after native introspection has authenticated the caller and JWT. */
export async function activeApiToken(env: Env, payload: Record<string, unknown>): Promise<boolean> {
    const audience = typeof payload.aud === 'string' ? [payload.aud] : Array.isArray(payload.aud) && payload.aud.every((value) => typeof value === 'string') ? payload.aud as string[] : [];
    const resources = audience.filter((value) => value !== `${env.AUTH_URL}/api/auth/oauth2/userinfo`);
    if (!resources.length) return true;
    if (typeof payload.sub !== 'string' || typeof payload.client_id !== 'string' || typeof payload.scope !== 'string' || typeof payload.lf_grant !== 'string') return false;
    const grant = await env.DB.prepare('SELECT 1 FROM "oauthGrantPolicy" WHERE "authorizationCodeId" = ? AND "userId" = ? AND "clientId" = ? AND "revokedAt" IS NULL')
        .bind(payload.lf_grant, payload.sub, payload.client_id).first();
    return !!grant && permittedApiScopes(env, payload.sub, payload.client_id, resources, payload.scope.split(' ').filter(Boolean));
}
