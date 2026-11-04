import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createAuth } from './auth';
import type { Env } from './config';
import { auditStatement, writeAudit, type AuditEvent } from './audit';
import { PaginationError, pageBoundary, pageResult, readPageInput } from './pagination';
import { databaseRateLimit } from './rate-limit';

type Identity = NonNullable<Awaited<ReturnType<ReturnType<typeof createAuth>['api']['getSession']>>>;
type AccessEnv = { Bindings: Env; Variables: { identity: Identity } };
const id = z.string().uuid();
const name = z.string().trim().min(1).max(100);
const description = z.string().trim().max(1000).default('');
const identifier = z.string().max(2048).refine((value) => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search && value === value.trim(); }
    catch { return false; }
});
const resourceCreate = z.object({ name, identifier, description, accessTokenTtl: z.number().int().min(60).max(3600).default(300) }).strict();
const resourceUpdate = z.object({ name: name.optional(), description: z.string().trim().max(1000).optional(), accessTokenTtl: z.number().int().min(60).max(3600).optional(), disabled: z.boolean().optional() }).strict().refine((value) => Object.keys(value).length > 0);
const permissionCreate = z.object({ name, description, scope: z.string().regex(/^[a-z][a-z0-9:_./-]{0,99}$/).refine((value) => !['openid', 'profile', 'email', 'offline_access'].includes(value)) }).strict();
const permissionUpdate = z.object({ name: name.optional(), description: z.string().trim().max(1000).optional() }).strict().refine((value) => Object.keys(value).length > 0);
const roleCreate = z.object({ name, description, permissionIds: z.array(id).max(100).refine((value) => new Set(value).size === value.length).default([]) }).strict();
const roleUpdate = z.object({ name: name.optional(), description: z.string().trim().max(1000).optional(), permissionIds: z.array(id).max(100).refine((value) => new Set(value).size === value.length).optional() }).strict().refine((value) => Object.keys(value).length > 0);
interface Resource { id: string; identifier: string; name: string; description: string; accessTokenTtl: number; disabled: number; createdAt: string }
const resourceColumns = '"id", "identifier", "name", coalesce(json_extract("metadata", \'$.description\'), \'\') AS "description", coalesce("accessTokenTtl", 300) AS "accessTokenTtl", coalesce("disabled", 0) AS "disabled", "createdAt"';
interface Permission { id: string; resourceId: string; name: string; description: string; scope: string; createdAt: string }
interface Role { id: string; name: string; description: string; createdAt: string }
export const accessManagement = new Hono<AccessEnv>();
accessManagement.onError((error, c) => {
    if (error instanceof PaginationError) return c.json({ code: error.code }, 400);
    if (error instanceof z.ZodError) {
        const codes: Record<string, string> = { name: 'ACCESS_NAME_REQUIRED', identifier: 'ACCESS_IDENTIFIER_INVALID', accessTokenTtl: 'ACCESS_TTL_INVALID', scope: 'ACCESS_SCOPE_INVALID', permissionIds: 'ACCESS_INVALID_PERMISSION', roleIds: 'ACCESS_INVALID_ROLE' };
        const fieldErrors = Object.fromEntries(error.issues.filter((issue) => typeof issue.path[0] === 'string').map((issue) => [String(issue.path[0]), codes[String(issue.path[0])] ?? 'ACCESS_INPUT_INVALID']));
        return c.json({ code: 'ACCESS_INPUT_INVALID', fieldErrors }, 400);
    }
    let cause: unknown = error;
    for (let depth = 0; depth < 6 && cause; depth++) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (message.includes('ACCESS_MANAGEMENT_FORBIDDEN')) return c.json({ code: 'FORBIDDEN' }, 403);
        if (message.includes('ACCESS_LIMIT')) return c.json({ code: 'ACCESS_LIMIT' }, 400);
        if (message.includes('UNIQUE constraint failed')) {
            const field = message.includes('oauthResource.identifier') ? 'identifier' : message.includes('apiPermission.scope') ? 'scope' : message.includes('apiRole.name') ? 'name' : null;
            const code = field === 'identifier' ? 'ACCESS_IDENTIFIER_EXISTS' : field === 'scope' ? 'ACCESS_SCOPE_EXISTS' : field === 'name' ? 'ACCESS_NAME_EXISTS' : 'ACCESS_CONFLICT';
            return c.json({ code, ...(field ? { fieldErrors: { [field]: code } } : {}) }, 409);
        }
        if (message.includes('FOREIGN KEY constraint failed')) return c.json({ code: 'ACCESS_CONFLICT' }, 409);
        cause = typeof cause === 'object' && cause && 'cause' in cause ? cause.cause : undefined;
    }
    throw error;
});
accessManagement.use('*', async (c, next) => {
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method)) return c.json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    if (c.req.method !== 'GET' && c.req.header('origin') !== c.env.AUTH_URL) return c.json({ code: 'INVALID_ORIGIN' }, 403);
    if (['POST', 'PATCH', 'PUT'].includes(c.req.method) && c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') return c.json({ code: 'INVALID_INPUT' }, 400);
    const identity = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
    if (!identity) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (identity.user.role !== 'admin' || identity.user.banned || !identity.user.emailVerified) return c.json({ code: 'FORBIDDEN' }, 403);
    c.set('identity', identity);
    const limit = await databaseRateLimit(c.env.DB).consume(`loginflare:access:${c.req.method}:${identity.user.id}`, { window: 60, max: c.req.method === 'GET' ? 100 : 30 });
    if (!limit.allowed) { c.header('Retry-After', String(limit.retryAfter)); return c.json({ code: 'TOO_MANY_REQUESTS' }, 429); }
    await next();
    if (c.req.method !== 'GET' && c.res.status >= 400) await writeAudit(c.env, { event: 'access.management_rejected', outcome: 'failure', actorUserId: identity.user.id, reason: `HTTP_${c.res.status}` }, c.req.raw.headers);
});
async function body(c: Context<AccessEnv>) { return c.req.json().catch(() => null); }
async function mutation(c: Context<AccessEnv>, statements: D1PreparedStatement[], event: Omit<AuditEvent, 'outcome' | 'actorUserId'>) {
    // D1 batches are transactions. Recheck authority inside the write transaction,
    // and commit its durable audit event together with the actual change.
    return c.env.DB.batch([
        c.env.DB.prepare('INSERT INTO "apiAccessWrite" ("id", "userId", "sessionId") VALUES (\'access\', ?, ?)').bind(c.var.identity.user.id, c.var.identity.session.id),
        ...statements,
        auditStatement(c.env, { ...event, actorUserId: c.var.identity.user.id, outcome: 'success' }, c.req.raw.headers),
        c.env.DB.prepare('DELETE FROM "apiAccessWrite" WHERE "id" = \'access\''),
    ]);
}
async function resource(c: Context<AccessEnv>) { return c.env.DB.prepare(`SELECT ${resourceColumns} FROM "oauthResource" WHERE "id" = ?`).bind(c.req.param('id')).first<Resource>(); }
function present(row: Resource) { return { ...row, disabled: !!row.disabled }; }
async function validPermissions(c: Context<AccessEnv>, ids: string[]) {
    return (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM "apiPermission" WHERE "id" IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).first<number>('n')) === ids.length;
}
accessManagement.get('/resources', async (c) => {
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'api-resources', c.var.identity.user.id, ['name', 'identifier']);
    const boundary = pageBoundary(input, 'id');
    const rows = await c.env.DB.prepare(`SELECT ${resourceColumns} FROM "oauthResource" WHERE 1=1${input.lookupField ? ` AND "${input.lookupField}" = ?` : ''}${boundary.sql} ORDER BY "createdAt" ${boundary.order}, "id" ${boundary.order} LIMIT ?`)
        .bind(...(input.lookupValue ? [input.lookupValue] : []), ...boundary.values, input.limit + 1).all<Resource>();
    return c.json(await pageResult(rows.results.map(present), input, c.env.BETTER_AUTH_SECRET, (item) => ({ id: item.id, createdAt: item.createdAt })));
});
accessManagement.post('/resources', async (c) => {
    const data = resourceCreate.parse(await body(c)), resourceId = crypto.randomUUID(), now = new Date().toISOString();
    await mutation(c, [c.env.DB.prepare(`INSERT INTO "oauthResource" ("id", "identifier", "name", "accessTokenTtl", "allowedScopes", "disabled", "createdAt", "updatedAt", "policyVersion", "metadata") VALUES (?, ?, ?, ?, ?, 0, ?, ?, 1, ?)`)
        .bind(resourceId, data.identifier, data.name, data.accessTokenTtl, JSON.stringify(['openid', 'profile', 'email', 'offline_access']), now, now, JSON.stringify({ description: data.description }))], { event: 'access.resource.created', targetType: 'resource', targetId: resourceId });
    return c.json({ ...data, id: resourceId, disabled: false, createdAt: now }, 201);
});
accessManagement.get('/resources/:id', async (c) => {
    const row = await resource(c); if (!row) return c.json({ code: 'ACCESS_RESOURCE_NOT_FOUND' }, 404);
    const permissions = await c.env.DB.prepare('SELECT * FROM "apiPermission" WHERE "resourceId" = ? ORDER BY "createdAt", "id" LIMIT 100').bind(row.id).all<Permission>();
    return c.json({ ...present(row), permissions: permissions.results });
});
accessManagement.patch('/resources/:id', async (c) => {
    const data = resourceUpdate.parse(await body(c)), row = await resource(c);
    if (!row) return c.json({ code: 'ACCESS_RESOURCE_NOT_FOUND' }, 404);
    await mutation(c, [c.env.DB.prepare(`UPDATE "oauthResource" SET "name" = coalesce(?, "name"), "accessTokenTtl" = coalesce(?, "accessTokenTtl"), "disabled" = coalesce(?, "disabled"), "metadata" = CASE WHEN ? IS NULL THEN "metadata" ELSE json_set(coalesce("metadata", '{}'), '$.description', ?) END, "updatedAt" = ? WHERE "id" = ?`)
        .bind(data.name ?? null, data.accessTokenTtl ?? null, data.disabled === undefined ? null : Number(data.disabled), data.description ?? null, data.description ?? null, new Date().toISOString(), row.id)], { event: 'access.resource.updated', targetType: 'resource', targetId: row.id });
    return c.json({ status: true });
});
accessManagement.delete('/resources/:id', async (c) => {
    const row = await resource(c); if (!row) return c.json({ code: 'ACCESS_RESOURCE_NOT_FOUND' }, 404);
    await mutation(c, [c.env.DB.prepare('DELETE FROM "apiPermission" WHERE "resourceId" = ?').bind(row.id), c.env.DB.prepare('DELETE FROM "oauthClientResource" WHERE "resourceId" = ?').bind(row.identifier), c.env.DB.prepare('DELETE FROM "oauthResource" WHERE "id" = ?').bind(row.id)], { event: 'access.resource.deleted', targetType: 'resource', targetId: row.id });
    return c.json({ status: true });
});
accessManagement.get('/permissions', async (c) => {
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'api-permissions', c.var.identity.user.id, ['scope', 'name']);
    const boundary = pageBoundary(input, 'id');
    const rows = await c.env.DB.prepare(`SELECT * FROM "apiPermission" WHERE 1=1${input.lookupField ? ` AND "${input.lookupField}" = ?` : ''}${boundary.sql} ORDER BY "createdAt" ${boundary.order}, "id" ${boundary.order} LIMIT ?`)
        .bind(...(input.lookupValue ? [input.lookupValue] : []), ...boundary.values, input.limit + 1).all<Permission>();
    return c.json(await pageResult(rows.results, input, c.env.BETTER_AUTH_SECRET, (item) => ({ id: item.id, createdAt: item.createdAt })));
});
accessManagement.post('/resources/:id/permissions', async (c) => {
    const data = permissionCreate.parse(await body(c)), row = await resource(c);
    if (!row) return c.json({ code: 'ACCESS_RESOURCE_NOT_FOUND' }, 404);
    const permissionId = crypto.randomUUID(), now = new Date().toISOString();
    await mutation(c, [c.env.DB.prepare('INSERT INTO "apiPermission" ("id", "resourceId", "name", "description", "scope", "createdAt") VALUES (?, ?, ?, ?, ?, ?)').bind(permissionId, row.id, data.name, data.description, data.scope, now)], { event: 'access.permission.created', targetType: 'permission', targetId: permissionId });
    return c.json({ ...data, id: permissionId, resourceId: row.id, createdAt: now }, 201);
});
accessManagement.patch('/permissions/:id', async (c) => {
    const data = permissionUpdate.parse(await body(c));
    const row = await c.env.DB.prepare('SELECT "id" FROM "apiPermission" WHERE "id" = ?').bind(c.req.param('id')).first();
    if (!row) return c.json({ code: 'ACCESS_PERMISSION_NOT_FOUND' }, 404);
    await mutation(c, [c.env.DB.prepare('UPDATE "apiPermission" SET "name" = coalesce(?, "name"), "description" = coalesce(?, "description") WHERE "id" = ?').bind(data.name ?? null, data.description ?? null, c.req.param('id'))], { event: 'access.permission.updated', targetType: 'permission', targetId: c.req.param('id') });
    return c.json({ status: true });
});
accessManagement.delete('/permissions/:id', async (c) => {
    const row = await c.env.DB.prepare('SELECT "id" FROM "apiPermission" WHERE "id" = ?').bind(c.req.param('id')).first();
    if (!row) return c.json({ code: 'ACCESS_PERMISSION_NOT_FOUND' }, 404);
    await mutation(c, [c.env.DB.prepare('DELETE FROM "apiPermission" WHERE "id" = ?').bind(c.req.param('id'))], { event: 'access.permission.deleted', targetType: 'permission', targetId: c.req.param('id') });
    return c.json({ status: true });
});
accessManagement.get('/resources/:id/applications', async (c) => {
    const row = await resource(c); if (!row) return c.json({ code: 'ACCESS_RESOURCE_NOT_FOUND' }, 404);
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, `resource-applications:${row.id}`, c.var.identity.user.id, []);
    const boundary = pageBoundary(input, 'clientId');
    const rows = await c.env.DB.prepare(`SELECT "clientId", "name", "createdAt" FROM "oauthClient" WHERE "clientId" IN (SELECT "clientId" FROM "oauthClientResource" WHERE "resourceId" = ?)${boundary.sql} ORDER BY "createdAt" ${boundary.order}, "clientId" ${boundary.order} LIMIT ?`)
        .bind(row.identifier, ...boundary.values, input.limit + 1).all<{ clientId: string; name: string; createdAt: string }>();
    return c.json(await pageResult(rows.results, input, c.env.BETTER_AUTH_SECRET, (item) => ({ id: item.clientId, createdAt: item.createdAt })));
});
accessManagement.post('/resources/:id/applications', async (c) => {
    const data = z.object({ clientId: z.string().min(1).max(255) }).strict().parse(await body(c)), row = await resource(c);
    if (!row) return c.json({ code: 'ACCESS_RESOURCE_NOT_FOUND' }, 404);
    if (!await c.env.DB.prepare('SELECT "id" FROM "oauthClient" WHERE "clientId" = ? AND "referenceId" = \'loginflare\'').bind(data.clientId).first()) return c.json({ code: 'APPLICATION_NOT_FOUND' }, 404);
    await mutation(c, [c.env.DB.prepare('INSERT INTO "oauthClientResource" ("id", "clientId", "resourceId", "createdAt") VALUES (?, ?, ?, ?)').bind(crypto.randomUUID(), data.clientId, row.identifier, new Date().toISOString())], { event: 'access.application.linked', targetType: 'resource', targetId: row.id, clientId: data.clientId });
    return c.json({ status: true }, 201);
});
accessManagement.delete('/resources/:id/applications/:clientId', async (c) => {
    const row = await resource(c); if (!row) return c.json({ code: 'ACCESS_RESOURCE_NOT_FOUND' }, 404);
    await mutation(c, [c.env.DB.prepare('DELETE FROM "oauthClientResource" WHERE "resourceId" = ? AND "clientId" = ?').bind(row.identifier, c.req.param('clientId'))], { event: 'access.application.unlinked', targetType: 'resource', targetId: row.id, clientId: c.req.param('clientId') });
    return c.json({ status: true });
});
accessManagement.get('/roles', async (c) => {
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'api-roles', c.var.identity.user.id, ['name']);
    const boundary = pageBoundary(input, 'id');
    const rows = await c.env.DB.prepare(`SELECT * FROM "apiRole" WHERE 1=1${input.lookupField ? ' AND "name" = ?' : ''}${boundary.sql} ORDER BY "createdAt" ${boundary.order}, "id" ${boundary.order} LIMIT ?`)
        .bind(...(input.lookupValue ? [input.lookupValue] : []), ...boundary.values, input.limit + 1).all<Role>();
    return c.json(await pageResult(rows.results, input, c.env.BETTER_AUTH_SECRET, (item) => ({ id: item.id, createdAt: item.createdAt })));
});
accessManagement.post('/roles', async (c) => {
    const data = roleCreate.parse(await body(c));
    if (!await validPermissions(c, data.permissionIds)) return c.json({ code: 'ACCESS_PERMISSION_NOT_FOUND' }, 400);
    const roleId = crypto.randomUUID(), now = new Date().toISOString();
    await mutation(c, [c.env.DB.prepare('INSERT INTO "apiRole" ("id", "name", "description", "createdAt") VALUES (?, ?, ?, ?)').bind(roleId, data.name, data.description, now), c.env.DB.prepare('INSERT INTO "apiRolePermission" ("roleId", "permissionId") SELECT ?, value FROM json_each(?)').bind(roleId, JSON.stringify(data.permissionIds))], { event: 'access.role.created', targetType: 'role', targetId: roleId });
    return c.json({ ...data, id: roleId, createdAt: now }, 201);
});
accessManagement.get('/roles/:id', async (c) => {
    const row = await c.env.DB.prepare('SELECT * FROM "apiRole" WHERE "id" = ?').bind(c.req.param('id')).first<Role>();
    if (!row) return c.json({ code: 'ACCESS_ROLE_NOT_FOUND' }, 404);
    const permissions = await c.env.DB.prepare('SELECT p.* FROM "apiPermission" p JOIN "apiRolePermission" r ON r."permissionId" = p."id" WHERE r."roleId" = ? ORDER BY p."scope" LIMIT 100').bind(row.id).all<Permission>();
    return c.json({ ...row, permissions: permissions.results, permissionIds: permissions.results.map((permission) => permission.id) });
});
accessManagement.patch('/roles/:id', async (c) => {
    const data = roleUpdate.parse(await body(c)), roleId = c.req.param('id');
    if (!await c.env.DB.prepare('SELECT "id" FROM "apiRole" WHERE "id" = ?').bind(roleId).first()) return c.json({ code: 'ACCESS_ROLE_NOT_FOUND' }, 404);
    if (data.permissionIds && !await validPermissions(c, data.permissionIds)) return c.json({ code: 'ACCESS_PERMISSION_NOT_FOUND' }, 400);
    await mutation(c, [c.env.DB.prepare('UPDATE "apiRole" SET "name" = coalesce(?, "name"), "description" = coalesce(?, "description") WHERE "id" = ?').bind(data.name ?? null, data.description ?? null, roleId), ...(data.permissionIds ? [c.env.DB.prepare('DELETE FROM "apiRolePermission" WHERE "roleId" = ? AND "permissionId" NOT IN (SELECT value FROM json_each(?))').bind(roleId, JSON.stringify(data.permissionIds)), c.env.DB.prepare('INSERT OR IGNORE INTO "apiRolePermission" ("roleId", "permissionId") SELECT ?, value FROM json_each(?)').bind(roleId, JSON.stringify(data.permissionIds))] : [])], { event: 'access.role.updated', targetType: 'role', targetId: roleId });
    return c.json({ status: true });
});
accessManagement.delete('/roles/:id', async (c) => {
    if (!await c.env.DB.prepare('SELECT "id" FROM "apiRole" WHERE "id" = ?').bind(c.req.param('id')).first()) return c.json({ code: 'ACCESS_ROLE_NOT_FOUND' }, 404);
    await mutation(c, [c.env.DB.prepare('DELETE FROM "apiRole" WHERE "id" = ?').bind(c.req.param('id'))], { event: 'access.role.deleted', targetType: 'role', targetId: c.req.param('id') });
    return c.json({ status: true });
});
accessManagement.get('/users/:userId/roles', async (c) => {
    if (!await c.env.DB.prepare('SELECT "id" FROM "user" WHERE "id" = ?').bind(c.req.param('userId')).first()) return c.json({ code: 'USER_NOT_FOUND' }, 404);
    const rows = await c.env.DB.prepare('SELECT r.* FROM "apiRole" r JOIN "apiUserRole" u ON u."roleId" = r."id" WHERE u."userId" = ? ORDER BY r."name" LIMIT 100').bind(c.req.param('userId')).all<Role>();
    return c.json({ roles: rows.results });
});
accessManagement.put('/users/:userId/roles', async (c) => {
    const { roleIds } = z.object({ roleIds: z.array(id).max(100).refine((value) => new Set(value).size === value.length) }).strict().parse(await body(c));
    const userId = c.req.param('userId');
    if (!await c.env.DB.prepare('SELECT "id" FROM "user" WHERE "id" = ?').bind(userId).first()) return c.json({ code: 'USER_NOT_FOUND' }, 404);
    if ((await c.env.DB.prepare('SELECT COUNT(*) AS n FROM "apiRole" WHERE "id" IN (SELECT value FROM json_each(?))').bind(JSON.stringify(roleIds)).first<number>('n')) !== roleIds.length) return c.json({ code: 'ACCESS_ROLE_NOT_FOUND' }, 400);
    await mutation(c, [c.env.DB.prepare('DELETE FROM "apiUserRole" WHERE "userId" = ? AND "roleId" NOT IN (SELECT value FROM json_each(?))').bind(userId, JSON.stringify(roleIds)), c.env.DB.prepare('INSERT OR IGNORE INTO "apiUserRole" ("userId", "roleId") SELECT ?, value FROM json_each(?)').bind(userId, JSON.stringify(roleIds))], { event: 'access.user.roles.updated', targetType: 'user', targetId: userId, targetUserId: userId });
    return c.json({ status: true });
});
