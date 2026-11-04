import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { createAuth } from './auth';
import type { Env } from './config';
import { auditStatement, writeAudit, type AuditEvent } from './audit';
import { databaseRateLimit } from './rate-limit';
import { PaginationError, pageBoundary, pageResult, readPageInput } from './pagination';
import { managementResource, managementScopes } from '../shared/machines';
import { clientRegistration, newClientSecret } from './client-registration';

type Identity = NonNullable<Awaited<ReturnType<ReturnType<typeof createAuth>['api']['getSession']>>>;
type MachineEnv = { Bindings: Env; Variables: { identity: Identity } };
const name = z.string().trim().min(1).max(100), description = z.string().trim().max(1000);
const ids = z.array(z.string().uuid()).max(100).refine((values) => new Set(values).size === values.length);
const scopes = z.array(z.enum(managementScopes)).max(managementScopes.length).refine((values) => new Set(values).size === values.length);
const roleCreate = z.object({ name, description: description.default(''), permissionIds: ids.default([]), managementScopes: scopes.default([]) }).strict();
const roleUpdate = z.object({ name: name.optional(), description: description.optional(), permissionIds: ids.optional(), managementScopes: scopes.optional() }).strict().refine((value) => Object.keys(value).length > 0);
interface Machine { clientId: string; name: string; disabled: number; createdAt: string }
interface Role { id: string; name: string; description: string; createdAt: string }
export const machines = new Hono<MachineEnv>();
export function machineError(error: Error): { code: string; status: 400 | 403 | 409; fieldErrors?: Record<string, string> } | null {
    if (error instanceof z.ZodError) return { code: 'MACHINE_INPUT_INVALID', status: 400, fieldErrors: Object.fromEntries(error.issues.filter((issue) => typeof issue.path[0] === 'string').map((issue) => [String(issue.path[0]), 'MACHINE_INPUT_INVALID'])) };
    let cause: unknown = error;
    for (let i = 0; i < 6 && cause; i++) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (message.includes('ACCESS_MANAGEMENT_FORBIDDEN') || message.includes('MACHINE_ACCESS_REVOKED') || message.includes('APPLICATION_ACCESS_REVOKED')) return { code: 'FORBIDDEN', status: 403 };
        if (message.includes('MACHINE_LIMIT')) return { code: 'MACHINE_LIMIT', status: 400 };
        if (message.includes('MACHINE_SYSTEM_RESOURCE')) return { code: 'MACHINE_SYSTEM_RESOURCE', status: 403 };
        if (message.includes('UNIQUE constraint failed: machineRole.name')) return { code: 'MACHINE_NAME_EXISTS', status: 409, fieldErrors: { name: 'MACHINE_NAME_EXISTS' } };
        if (message.includes('FOREIGN KEY constraint failed')) return { code: 'MACHINE_CONFLICT', status: 409 };
        cause = typeof cause === 'object' && cause && 'cause' in cause ? cause.cause : undefined;
    }
    return null;
}
machines.onError((error, c) => {
    if (error instanceof PaginationError) return c.json({ code: error.code }, 400);
    const known = machineError(error); if (known) return c.json({ code: known.code, fieldErrors: known.fieldErrors }, known.status);
    throw error;
});
machines.use('*', async (c, next) => {
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(c.req.method)) return c.json({ code: 'METHOD_NOT_ALLOWED' }, 405);
    if (c.req.method !== 'GET' && c.req.header('origin') !== c.env.AUTH_URL) return c.json({ code: 'INVALID_ORIGIN' }, 403);
    if (['POST', 'PATCH', 'PUT'].includes(c.req.method) && c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json') return c.json({ code: 'INVALID_INPUT' }, 400);
    const identity = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } });
    if (!identity) return c.json({ code: 'UNAUTHORIZED' }, 401);
    if (identity.user.role !== 'admin' || identity.user.banned || !identity.user.emailVerified) return c.json({ code: 'FORBIDDEN' }, 403);
    c.set('identity', identity);
    const rate = await databaseRateLimit(c.env.DB).consume(`loginflare:machine-admin:${c.req.method}:${identity.user.id}`, { window: 60, max: c.req.method === 'GET' ? 100 : 30 });
    if (!rate.allowed) { c.header('Retry-After', String(rate.retryAfter)); return c.json({ code: 'TOO_MANY_REQUESTS' }, 429); }
    await next();
    if (c.req.method !== 'GET' && c.res.status >= 400) await writeAudit(c.env, { event: 'machine.management_rejected', outcome: 'failure', actorUserId: identity.user.id, reason: `HTTP_${c.res.status}` }, c.req.raw.headers);
});
async function mutate(c: Context<MachineEnv>, statements: D1PreparedStatement[], event: Omit<AuditEvent, 'outcome' | 'actorUserId'>) {
    return c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO "apiAccessWrite" ("id", "userId", "sessionId") VALUES ('access', ?, ?)`).bind(c.var.identity.user.id, c.var.identity.session.id),
        ...statements, auditStatement(c.env, { ...event, actorUserId: c.var.identity.user.id, outcome: 'success' }, c.req.raw.headers),
        c.env.DB.prepare(`DELETE FROM "apiAccessWrite" WHERE "id" = 'access'`),
    ]);
}
async function body(c: Context<MachineEnv>) { return c.req.json().catch(() => null); }
async function machine(c: Context<MachineEnv>) {
    return c.env.DB.prepare(`SELECT c."clientId", c."name", coalesce(c."disabled", 0) AS "disabled", c."createdAt" FROM "oauthClient" c JOIN "machineApp" m ON m."clientId" = c."clientId" WHERE c."clientId" = ? AND c."referenceId" = 'loginflare'`).bind(c.req.param('clientId')).first<Machine>();
}
async function rolesFor(c: Context<MachineEnv>, clientId: string) {
    return (await c.env.DB.prepare(`SELECT r."id", r."name" FROM "machineRole" r JOIN "machineAppRole" a ON a."roleId" = r."id" WHERE a."clientId" = ? ORDER BY r."name" LIMIT 100`).bind(clientId).all<{ id: string; name: string }>()).results;
}
machines.get('/permissions', async (c) => c.json({
    permissions: (await c.env.DB.prepare(`SELECT p.*, r."name" AS "resourceName" FROM "apiPermission" p JOIN "oauthResource" r ON r."id" = p."resourceId" ORDER BY r."name", p."scope" LIMIT 1000`).all()).results,
    managementScopes, managementResource,
}));
machines.get('/applications', async (c) => {
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'machine-apps', c.var.identity.user.id, ['name', 'clientId']), boundary = pageBoundary(input, 'clientId');
    const rows = await c.env.DB.prepare(`SELECT "clientId", "name", coalesce("disabled", 0) AS "disabled", "createdAt",
        (SELECT json_group_array("roleId") FROM "machineAppRole" a WHERE a."clientId" = "oauthClient"."clientId") AS "roleIds"
        FROM "oauthClient" WHERE "clientId" IN (SELECT "clientId" FROM "machineApp")${input.lookupField ? ` AND "${input.lookupField}" = ?` : ''}${boundary.sql}
        ORDER BY "createdAt" ${boundary.order}, "clientId" ${boundary.order} LIMIT ?`)
        .bind(...(input.lookupValue ? [input.lookupValue] : []), ...boundary.values, input.limit + 1).all<Machine & { roleIds: string }>();
    const items = rows.results.map((row) => ({ ...row, disabled: !!row.disabled, roleIds: JSON.parse(row.roleIds) as string[] }));
    return c.json({ ...await pageResult(items, input, c.env.BETTER_AUTH_SECRET, (item) => ({ id: item.clientId, createdAt: item.createdAt })), issuer: `${c.env.AUTH_URL}/api/auth`, managementResource });
});
machines.post('/applications', async (c) => {
    const data = z.object({ name }).strict().parse(await body(c));
    const client = await clientRegistration(c.env, { ...data, type: 'machine' }, { userId: c.var.identity.user.id, sessionId: c.var.identity.session.id, administrator: true });
    await mutate(c, [client.statement, c.env.DB.prepare('INSERT INTO "machineApp" ("clientId") VALUES (?)').bind(client.clientId)], { event: 'machine.application.created', clientId: client.clientId, targetType: 'machine', targetId: client.clientId });
    return c.json({ clientId: client.clientId, clientSecret: client.clientSecret, name: data.name, createdAt: client.createdAt, disabled: false, roleIds: [] }, 201);
});
machines.get('/applications/:clientId', async (c) => {
    const row = await machine(c); if (!row) return c.json({ code: 'MACHINE_NOT_FOUND' }, 404);
    const roles = await rolesFor(c, row.clientId);
    const granted = await c.env.DB.prepare('SELECT DISTINCT "scope" FROM "machineScope" WHERE "clientId" = ? ORDER BY "scope" LIMIT ?').bind(row.clientId, 1000 + managementScopes.length).all<{ scope: string }>();
    return c.json({ ...row, disabled: !!row.disabled, roles, roleIds: roles.map((role) => role.id), scopes: granted.results.map((row) => row.scope), issuer: `${c.env.AUTH_URL}/api/auth`, managementResource });
});
machines.patch('/applications/:clientId', async (c) => {
    const data = z.object({ name: name.optional(), disabled: z.boolean().optional() }).strict().refine((value) => Object.keys(value).length > 0).parse(await body(c));
    const row = await machine(c); if (!row) return c.json({ code: 'MACHINE_NOT_FOUND' }, 404);
    await mutate(c, [c.env.DB.prepare(`UPDATE "oauthClient" SET "name" = coalesce(?, "name"), "disabled" = coalesce(?, "disabled"), "adminSuspended" = coalesce(?, "adminSuspended"), "managementUserId" = ?, "managementSessionId" = ?, "managementAdministrator" = 1, "updatedAt" = ? WHERE "clientId" = ?`)
        .bind(data.name ?? null, data.disabled === undefined ? null : Number(data.disabled), data.disabled === undefined ? null : Number(data.disabled), c.var.identity.user.id, c.var.identity.session.id, new Date().toISOString(), row.clientId)], { event: 'machine.application.updated', clientId: row.clientId, targetType: 'machine', targetId: row.clientId });
    return c.json({ status: true });
});
machines.post('/applications/:clientId/rotate-secret', async (c) => {
    z.object({}).strict().parse(await body(c));
    const row = await machine(c); if (!row) return c.json({ code: 'MACHINE_NOT_FOUND' }, 404);
    const credential = await newClientSecret();
    await mutate(c, [c.env.DB.prepare(`UPDATE "oauthClient" SET "clientSecret" = ?, "managementUserId" = ?, "managementSessionId" = ?, "managementAdministrator" = 1, "updatedAt" = ? WHERE "clientId" = ?`)
        .bind(credential.hash, c.var.identity.user.id, c.var.identity.session.id, new Date().toISOString(), row.clientId)], { event: 'machine.secret.rotated', clientId: row.clientId, targetType: 'machine', targetId: row.clientId });
    return c.json({ clientSecret: credential.secret });
});
machines.post('/applications/:clientId/revoke-tokens', async (c) => {
    z.object({}).strict().parse(await body(c));
    const row = await machine(c); if (!row) return c.json({ code: 'MACHINE_NOT_FOUND' }, 404);
    await mutate(c, [c.env.DB.prepare('UPDATE "machineApp" SET "version" = "version" + 1 WHERE "clientId" = ?').bind(row.clientId)], { event: 'machine.tokens.revoked', clientId: row.clientId, targetType: 'machine', targetId: row.clientId });
    return c.json({ status: true });
});
machines.put('/applications/:clientId/roles', async (c) => {
    const data = z.object({ roleIds: ids }).strict().parse(await body(c)), row = await machine(c);
    if (!row) return c.json({ code: 'MACHINE_NOT_FOUND' }, 404);
    if ((await c.env.DB.prepare('SELECT COUNT(*) AS n FROM "machineRole" WHERE "id" IN (SELECT value FROM json_each(?))').bind(JSON.stringify(data.roleIds)).first<number>('n')) !== data.roleIds.length) return c.json({ code: 'MACHINE_ROLE_NOT_FOUND' }, 400);
    await mutate(c, [c.env.DB.prepare('DELETE FROM "machineAppRole" WHERE "clientId" = ? AND "roleId" NOT IN (SELECT value FROM json_each(?))').bind(row.clientId, JSON.stringify(data.roleIds)), c.env.DB.prepare('INSERT OR IGNORE INTO "machineAppRole" ("clientId", "roleId") SELECT ?, value FROM json_each(?)').bind(row.clientId, JSON.stringify(data.roleIds))], { event: 'machine.application.roles.updated', clientId: row.clientId, targetType: 'machine', targetId: row.clientId });
    return c.json({ status: true });
});
machines.get('/roles', async (c) => {
    const input = await readPageInput(new URL(c.req.url), c.env.BETTER_AUTH_SECRET, 'machine-roles', c.var.identity.user.id, ['name']), boundary = pageBoundary(input, 'id');
    const rows = await c.env.DB.prepare(`SELECT * FROM "machineRole" WHERE 1=1${input.lookupField ? ' AND "name" = ?' : ''}${boundary.sql} ORDER BY "createdAt" ${boundary.order}, "id" ${boundary.order} LIMIT ?`).bind(...(input.lookupValue ? [input.lookupValue] : []), ...boundary.values, input.limit + 1).all<Role>();
    return c.json(await pageResult(rows.results, input, c.env.BETTER_AUTH_SECRET, (item) => ({ id: item.id, createdAt: item.createdAt })));
});
async function validPermissions(c: Context<MachineEnv>, values: string[]) {
    return (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM "apiPermission" WHERE "id" IN (SELECT value FROM json_each(?))').bind(JSON.stringify(values)).first<number>('n')) === values.length;
}
function roleStatements(c: Context<MachineEnv>, roleId: string, data: { permissionIds?: string[]; managementScopes?: string[] }) {
    return [
        ...(data.permissionIds ? [c.env.DB.prepare('DELETE FROM "machineRolePermission" WHERE "roleId" = ? AND "permissionId" NOT IN (SELECT value FROM json_each(?))').bind(roleId, JSON.stringify(data.permissionIds)), c.env.DB.prepare('INSERT OR IGNORE INTO "machineRolePermission" ("roleId", "permissionId") SELECT ?, value FROM json_each(?)').bind(roleId, JSON.stringify(data.permissionIds))] : []),
        ...(data.managementScopes ? [c.env.DB.prepare('DELETE FROM "machineRoleManagementScope" WHERE "roleId" = ? AND "scope" NOT IN (SELECT value FROM json_each(?))').bind(roleId, JSON.stringify(data.managementScopes)), c.env.DB.prepare('INSERT OR IGNORE INTO "machineRoleManagementScope" ("roleId", "scope") SELECT ?, value FROM json_each(?)').bind(roleId, JSON.stringify(data.managementScopes))] : []),
    ];
}
machines.post('/roles', async (c) => {
    const data = roleCreate.parse(await body(c));
    if (!await validPermissions(c, data.permissionIds)) return c.json({ code: 'MACHINE_PERMISSION_NOT_FOUND' }, 400);
    const id = crypto.randomUUID(), now = new Date().toISOString();
    await mutate(c, [c.env.DB.prepare('INSERT INTO "machineRole" ("id", "name", "description", "createdAt") VALUES (?, ?, ?, ?)').bind(id, data.name, data.description, now), ...roleStatements(c, id, data)], { event: 'machine.role.created', targetType: 'machineRole', targetId: id });
    return c.json({ ...data, id, createdAt: now }, 201);
});
machines.get('/roles/:id', async (c) => {
    const row = await c.env.DB.prepare('SELECT * FROM "machineRole" WHERE "id" = ?').bind(c.req.param('id')).first<Role>();
    if (!row) return c.json({ code: 'MACHINE_ROLE_NOT_FOUND' }, 404);
    const permissions = await c.env.DB.prepare('SELECT "permissionId" FROM "machineRolePermission" WHERE "roleId" = ? ORDER BY "permissionId" LIMIT 100').bind(row.id).all<{ permissionId: string }>();
    const granted = await c.env.DB.prepare('SELECT "scope" FROM "machineRoleManagementScope" WHERE "roleId" = ? ORDER BY "scope"').bind(row.id).all<{ scope: string }>();
    return c.json({ ...row, permissionIds: permissions.results.map((row) => row.permissionId), managementScopes: granted.results.map((row) => row.scope) });
});
machines.patch('/roles/:id', async (c) => {
    const data = roleUpdate.parse(await body(c)), id = c.req.param('id');
    if (!await c.env.DB.prepare('SELECT "id" FROM "machineRole" WHERE "id" = ?').bind(id).first()) return c.json({ code: 'MACHINE_ROLE_NOT_FOUND' }, 404);
    if (data.permissionIds && !await validPermissions(c, data.permissionIds)) return c.json({ code: 'MACHINE_PERMISSION_NOT_FOUND' }, 400);
    await mutate(c, [c.env.DB.prepare('UPDATE "machineRole" SET "name" = coalesce(?, "name"), "description" = coalesce(?, "description") WHERE "id" = ?').bind(data.name ?? null, data.description ?? null, id), ...roleStatements(c, id, data)], { event: 'machine.role.updated', targetType: 'machineRole', targetId: id });
    return c.json({ status: true });
});
machines.delete('/roles/:id', async (c) => {
    const id = c.req.param('id');
    if (!await c.env.DB.prepare('SELECT "id" FROM "machineRole" WHERE "id" = ?').bind(id).first()) return c.json({ code: 'MACHINE_ROLE_NOT_FOUND' }, 404);
    await mutate(c, [c.env.DB.prepare('DELETE FROM "machineRole" WHERE "id" = ?').bind(id)], { event: 'machine.role.deleted', targetType: 'machineRole', targetId: id });
    return c.json({ status: true });
});
