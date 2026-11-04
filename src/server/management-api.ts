import { Hono, type Context } from 'hono';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { createAuth } from './auth';
import { activeMachineToken, finishMachineWrite, machineWriteGuard, type MachinePrincipal } from './machine-policy';
import { managementResource, type ManagementScope } from '../shared/machines';
import { createAccessManagement, type AccessEnv } from './access-management';
import { createAuditLogs, auditStatement, writeAudit, type AuditEvent } from './audit';
import { databaseRateLimit } from './rate-limit';
import { clientRegistration, newClientSecret } from './client-registration';
import { applicationCreateSchema, applicationUpdateSchema, applicationFieldErrors } from '../shared/application-validation';
import { PaginationError, pageBoundary, pageResult, readPageInput } from './pagination';
import { machineError } from './machines';
import { managementOpenApi } from './management-openapi';
import type { Env } from './config';

type ManagementEnv = AccessEnv;
const prefix = '/api/management/v1';
export async function authenticateMachine(env: Env, headers: Headers): Promise<MachinePrincipal | null> {
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(headers.get('authorization') ?? '');
    if (!match || match[1]!.length > 8192) return null;
    // Key-store failures remain operational errors, rather than invalid credentials.
    const keys = await createAuth(env).api.getJwks();
    let verified: Awaited<ReturnType<typeof jwtVerify>>;
    try {
        // Read our native public keys directly; no network lookup or token-supplied key URL.
        verified = await jwtVerify(match[1]!, createLocalJWKSet(keys), {
            algorithms: ['RS256'], issuer: `${env.AUTH_URL}/api/auth`, audience: managementResource,
            requiredClaims: ['sub', 'client_id', 'iat', 'exp', 'jti'],
        });
    } catch { return null; }
    const { payload, protectedHeader } = verified;
    const audience = typeof payload.aud === 'string' ? [payload.aud] : payload.aud;
    if (protectedHeader.typ !== 'at+jwt' || audience?.length !== 1 || payload.cnf !== undefined
        || payload.azp !== payload.client_id || typeof payload.client_id !== 'string' || typeof payload.scope !== 'string'
        || typeof payload.jti !== 'string' || !payload.jti.length || payload.jti.length > 128
        || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat! > Math.floor(Date.now() / 1000)
        || payload.exp! - payload.iat! > 300 || !await activeMachineToken(env, payload)) return null;
    return { clientId: payload.client_id, scopes: payload.scope.split(' ').filter(Boolean), version: payload.lf_machine_version as number, expiresAt: payload.exp! };
}
function scopeFor(path: string, method: string): ManagementScope | null {
    const group = /^\/users\/[^/]+\/roles\/?$/.test(path) ? 'role-assignments'
        : path.startsWith('/users') ? 'users' : path.startsWith('/applications') ? 'applications'
        : path.startsWith('/resources') || path.startsWith('/permissions') ? 'resources'
        : path.startsWith('/roles') ? 'roles' : path.startsWith('/audit-logs') ? 'audit' : null;
    if (!group || (group === 'audit' && method !== 'GET')) return null;
    return `management:${group}:${method === 'GET' ? 'read' : 'write'}` as ManagementScope;
}
export const managementApi = new Hono<ManagementEnv>();
managementApi.onError((error, c) => {
    if (error instanceof PaginationError) return c.json({ code: error.code }, 400);
    if (error instanceof z.ZodError) return c.json({ code: 'INVALID_INPUT' }, 400);
    const known = machineError(error); if (known) return c.json({ code: known.code, fieldErrors: known.fieldErrors }, known.status);
    throw error;
});
managementApi.get('/openapi.json', (c) => c.json(managementOpenApi));
managementApi.use('*', async (c, next) => {
    const path = c.req.path.slice(prefix.length), required = scopeFor(path, c.req.method);
    if (!required) return c.json({ code: 'NOT_FOUND' }, 404);
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method)) return c.json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    const incoming = await databaseRateLimit(c.env.DB).consume(`loginflare:management-incoming:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`, { window: 60, max: 200 });
    if (!incoming.allowed) { c.header('Retry-After', String(incoming.retryAfter)); return c.json({ code: 'TOO_MANY_REQUESTS' }, 429); }
    // Browser cookies and account selectors are deliberately irrelevant here.
    const principal = await authenticateMachine(c.env, c.req.raw.headers);
    if (!principal) {
        await writeAudit(c.env, { event: 'management.authentication_failed', outcome: 'failure', reason: 'INVALID_TOKEN' }, c.req.raw.headers);
        c.header('WWW-Authenticate', 'Bearer error="invalid_token"'); return c.json({ code: 'UNAUTHORIZED' }, 401);
    }
    c.set('machine', principal); c.set('managementScope', required); c.set('actorId', `machine:${principal.clientId}`);
    if (!principal.scopes.includes(required)) {
        await writeAudit(c.env, { event: 'management.access_denied', outcome: 'failure', actorClientId: principal.clientId, targetType: required.split(':')[1], reason: 'INSUFFICIENT_SCOPE' }, c.req.raw.headers);
        c.header('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${required}"`);
        return c.json({ code: 'INSUFFICIENT_SCOPE' }, 403);
    }
    if (['POST', 'PATCH', 'PUT'].includes(c.req.method) && c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return c.json({ code: 'INVALID_INPUT' }, 400);
    const rate = await databaseRateLimit(c.env.DB).consume(`loginflare:management:${c.req.method}:${principal.clientId}`, { window: 60, max: c.req.method === 'GET' ? 100 : 30 });
    if (!rate.allowed) { c.header('Retry-After', String(rate.retryAfter)); return c.json({ code: 'TOO_MANY_REQUESTS' }, 429); }
    await next();
    if (c.req.method === 'GET' || c.res.status >= 400) await writeAudit(c.env, {
        event: c.res.status >= 400 ? 'management.request_rejected' : 'management.read', outcome: c.res.status >= 400 ? 'failure' : 'success',
        actorClientId: principal.clientId, targetType: required.split(':')[1], reason: c.res.status >= 400 ? `HTTP_${c.res.status}` : null,
    }, c.req.raw.headers);
});
async function body(c: Context<ManagementEnv>) { return c.req.json().catch(() => null); }
async function mutation(c: Context<ManagementEnv>, statements: D1PreparedStatement[], event: Omit<AuditEvent, 'outcome' | 'actorUserId' | 'actorClientId'>) {
    return c.env.DB.batch([machineWriteGuard(c.env, c.var.machine!, c.var.managementScope!, event.targetUserId), ...statements,
        auditStatement(c.env, { ...event, actorClientId: c.var.machine!.clientId, outcome: 'success' }, c.req.raw.headers), finishMachineWrite(c.env)]);
}
interface ManagedUser { id: string; name: string; email: string; username: string | null; emailVerified: number; banned: number | null; createdAt: string; role: string }
const userColumns = '"id", "name", "email", "username", "emailVerified", "banned", "createdAt", "role"';
const presentUser = (row: ManagedUser) => ({ ...row, emailVerified: !!row.emailVerified, banned: !!row.banned });
managementApi.get('/users', async (c) => {
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'management-users', c.var.actorId, ['id', 'email', 'username']), boundary = pageBoundary(input, 'id');
    const rows = await c.env.DB.prepare(`SELECT ${userColumns} FROM "user" WHERE 1=1${input.lookupField ? ` AND "${input.lookupField}" = ?` : ''}${boundary.sql} ORDER BY "createdAt" ${boundary.order}, "id" ${boundary.order} LIMIT ?`)
        .bind(...(input.lookupValue ? [input.lookupValue] : []), ...boundary.values, input.limit + 1).all<ManagedUser>();
    return c.json(await pageResult(rows.results.map(presentUser), input, c.env.BETTER_AUTH_SECRET, (row) => ({ id: row.id, createdAt: row.createdAt })));
});
managementApi.get('/users/:userId', async (c) => {
    const row = await c.env.DB.prepare(`SELECT ${userColumns} FROM "user" WHERE "id" = ?`).bind(c.req.param('userId')).first<ManagedUser>();
    return row ? c.json(presentUser(row)) : c.json({ code: 'USER_NOT_FOUND' }, 404);
});
function revokeUserStatements(env: Env, userId: string) {
    return [
        env.DB.prepare('UPDATE "session" SET "oauthRevokedAt" = ? WHERE "userId" = ? AND "oauthRevokedAt" IS NULL').bind(new Date().toISOString(), userId),
        env.DB.prepare('UPDATE "oauthGrantPolicy" SET "revokedAt" = ? WHERE "userId" = ? AND "revokedAt" IS NULL').bind(new Date().toISOString(), userId),
        env.DB.prepare(`DELETE FROM "verification" WHERE "identifier" LIKE 'social-mfa:%' AND "value" IN (SELECT "id" FROM "socialFlow" WHERE "userId" = ?)`).bind(userId),
        env.DB.prepare(`DELETE FROM "verification" WHERE "value" = ? AND "identifier" LIKE '2fa-%'`).bind(userId),
        env.DB.prepare('DELETE FROM "socialFlow" WHERE "userId" = ?').bind(userId),
        env.DB.prepare('DELETE FROM "securityProof" WHERE "userId" = ?').bind(userId),
        env.DB.prepare('DELETE FROM "browserAuthFlow" WHERE "userId" = ? OR "targetUserId" = ? OR "originSessionId" IN (SELECT "id" FROM "session" WHERE "userId" = ?)').bind(userId, userId, userId),
        env.DB.prepare('DELETE FROM "session" WHERE "userId" = ?').bind(userId),
    ];
}
managementApi.patch('/users/:userId', async (c) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(100).optional(), banned: z.boolean().optional() }).strict().refine((value) => Object.keys(value).length > 0).safeParse(await body(c));
    if (!parsed.success) return c.json({ code: 'INVALID_INPUT', fieldErrors: Object.fromEntries(parsed.error.issues.filter((issue) => issue.path.length).map((issue) => [String(issue.path[0]), 'INVALID_INPUT'])) }, 400);
    const userId = c.req.param('userId'), row = await c.env.DB.prepare('SELECT "id", "role" FROM "user" WHERE "id" = ?').bind(userId).first<{ id: string; role: string }>();
    if (!row) return c.json({ code: 'USER_NOT_FOUND' }, 404);
    if (row.role === 'admin') return c.json({ code: 'FORBIDDEN' }, 403);
    const data = parsed.data;
    await mutation(c, [c.env.DB.prepare(`UPDATE "user" SET "name" = coalesce(?, "name"), "banned" = coalesce(?, "banned"),
        "banExpires" = CASE WHEN ? IS NULL THEN "banExpires" ELSE NULL END, "banReason" = CASE WHEN ? IS NULL THEN "banReason" ELSE NULL END,
        "updatedAt" = ? WHERE "id" = ? AND coalesce("role", 'user') <> 'admin'`)
        .bind(data.name ?? null, data.banned === undefined ? null : Number(data.banned), data.banned ?? null, data.banned ?? null, new Date().toISOString(), userId), ...(data.banned === true ? revokeUserStatements(c.env, userId) : [])], { event: 'management.user.updated', targetType: 'user', targetId: userId, targetUserId: userId });
    return c.json({ status: true });
});
managementApi.post('/users/:userId/revoke-sessions', async (c) => {
    z.object({}).strict().parse(await body(c));
    const userId = c.req.param('userId'), row = await c.env.DB.prepare('SELECT "role" FROM "user" WHERE "id" = ?').bind(userId).first<{ role: string }>();
    if (!row) return c.json({ code: 'USER_NOT_FOUND' }, 404);
    if (row.role === 'admin') return c.json({ code: 'FORBIDDEN' }, 403);
    await mutation(c, revokeUserStatements(c.env, userId), { event: 'management.user.sessions_revoked', targetType: 'user', targetId: userId, targetUserId: userId });
    return c.json({ status: true });
});
interface ClientRow { clientId: string; name: string; tokenEndpointAuthMethod: string; redirectUris: string; postLogoutRedirectUris: string; scopes: string; disabled: number; ownerDisabled: number; adminSuspended: number; ownerId: string | null; createdAt: string }
const clientColumns = '"clientId", "name", "tokenEndpointAuthMethod", "redirectUris", "postLogoutRedirectUris", "scopes", "disabled", "ownerDisabled", "adminSuspended", "ownerId", "createdAt"';
function presentClient(row: ClientRow) {
    const scopes = JSON.parse(row.scopes ?? '[]') as string[];
    return { clientId: row.clientId, name: row.name, type: row.tokenEndpointAuthMethod === 'none' ? 'spa' : 'web',
        redirectUris: JSON.parse(row.redirectUris) as string[], postLogoutRedirectUris: JSON.parse(row.postLogoutRedirectUris ?? '[]') as string[],
        scopes: scopes.filter((scope) => ['openid', 'profile', 'email', 'offline_access'].includes(scope)), apiScopes: scopes.filter((scope) => !['openid', 'profile', 'email', 'offline_access'].includes(scope)),
        disabled: !!row.disabled, ownerId: row.ownerId, ownerDisabled: !!row.ownerDisabled, adminSuspended: !!row.adminSuspended, createdAt: row.createdAt };
}
async function application(c: Context<ManagementEnv>) {
    return c.env.DB.prepare(`SELECT ${clientColumns} FROM "oauthClient" WHERE "clientId" = ? AND "referenceId" = 'loginflare' AND "clientId" NOT IN (SELECT "clientId" FROM "machineApp")`).bind(c.req.param('clientId')).first<ClientRow>();
}
managementApi.get('/applications', async (c) => {
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'management-applications', c.var.actorId, ['clientId', 'name']), boundary = pageBoundary(input, 'clientId');
    const rows = await c.env.DB.prepare(`SELECT ${clientColumns} FROM "oauthClient" WHERE "referenceId" = 'loginflare' AND "clientId" NOT IN (SELECT "clientId" FROM "machineApp")${input.lookupField ? ` AND "${input.lookupField}" = ?` : ''}${boundary.sql} ORDER BY "createdAt" ${boundary.order}, "clientId" ${boundary.order} LIMIT ?`)
        .bind(...(input.lookupValue ? [input.lookupValue] : []), ...boundary.values, input.limit + 1).all<ClientRow>();
    return c.json(await pageResult(rows.results.map(presentClient), input, c.env.BETTER_AUTH_SECRET, (item) => ({ id: item.clientId, createdAt: item.createdAt })));
});
managementApi.post('/applications', async (c) => {
    const input = applicationCreateSchema.safeParse(await body(c));
    if (!input.success) return c.json({ code: 'INVALID_INPUT', fieldErrors: applicationFieldErrors(input.error) }, 400);
    const client = await clientRegistration(c.env, input.data);
    await mutation(c, [client.statement], { event: 'management.application.created', clientId: client.clientId, targetType: 'application', targetId: client.clientId });
    return c.json({ ...input.data, clientId: client.clientId, clientSecret: client.clientSecret, disabled: false, createdAt: client.createdAt }, 201);
});
managementApi.get('/applications/:clientId', async (c) => {
    const row = await application(c); return row ? c.json(presentClient(row)) : c.json({ code: 'APPLICATION_NOT_FOUND' }, 404);
});
managementApi.patch('/applications/:clientId', async (c) => {
    const input = applicationUpdateSchema.safeParse(await body(c));
    if (!input.success) return c.json({ code: 'INVALID_INPUT', fieldErrors: applicationFieldErrors(input.error) }, 400);
    const row = await application(c); if (!row) return c.json({ code: 'APPLICATION_NOT_FOUND' }, 404);
    const data = input.data;
    const business = await c.env.DB.prepare(`SELECT DISTINCT p."scope" FROM "apiPermission" p JOIN "oauthResource" r ON r."id" = p."resourceId" JOIN "oauthClientResource" l ON l."resourceId" = r."identifier" WHERE l."clientId" = ?`).bind(row.clientId).all<{ scope: string }>();
    await mutation(c, [c.env.DB.prepare(`UPDATE "oauthClient" SET "name" = coalesce(?, "name"), "redirectUris" = coalesce(?, "redirectUris"), "postLogoutRedirectUris" = coalesce(?, "postLogoutRedirectUris"), "scopes" = coalesce(?, "scopes"),
        "adminSuspended" = coalesce(?, "adminSuspended"), "disabled" = ("ownerDisabled" OR coalesce(?, "adminSuspended")), "managementUserId" = NULL, "managementSessionId" = NULL, "managementAdministrator" = 1,
        "metadata" = CASE WHEN ? IS NULL THEN "metadata" ELSE json_set(coalesce("metadata", '{}'), '$.loginflareRedirectOrigins', json(?)) END, "updatedAt" = ? WHERE "clientId" = ?`)
        .bind(data.name ?? null, data.redirectUris ? JSON.stringify(data.redirectUris) : null, data.postLogoutRedirectUris ? JSON.stringify(data.postLogoutRedirectUris) : null,
            data.scopes ? JSON.stringify([...data.scopes, ...business.results.map((item) => item.scope)]) : null,
            data.disabled === undefined ? null : Number(data.disabled), data.disabled === undefined ? null : Number(data.disabled), data.redirectUris ? 1 : null,
            JSON.stringify([...new Set((data.redirectUris ?? []).map((uri) => new URL(uri).origin))]), new Date().toISOString(), row.clientId)], { event: 'management.application.updated', clientId: row.clientId, targetType: 'application', targetId: row.clientId });
    return c.json({ status: true });
});
managementApi.post('/applications/:clientId/rotate-secret', async (c) => {
    z.object({}).strict().parse(await body(c));
    const row = await application(c); if (!row) return c.json({ code: 'APPLICATION_NOT_FOUND' }, 404);
    if (row.tokenEndpointAuthMethod === 'none') return c.json({ code: 'APPLICATION_PUBLIC_CLIENT' }, 400);
    const credential = await newClientSecret();
    await mutation(c, [c.env.DB.prepare(`UPDATE "oauthClient" SET "clientSecret" = ?, "managementUserId" = NULL, "managementSessionId" = NULL, "managementAdministrator" = 1, "updatedAt" = ? WHERE "clientId" = ?`)
        .bind(credential.hash, new Date().toISOString(), row.clientId)], { event: 'management.application.secret_rotated', clientId: row.clientId, targetType: 'application', targetId: row.clientId });
    return c.json({ clientSecret: credential.secret });
});
managementApi.route('/audit-logs', createAuditLogs(true));
managementApi.route('/', createAccessManagement(true));
