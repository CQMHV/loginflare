import type { Env } from './config';
import { managementResource, type ManagementScope } from '../shared/machines';

export interface MachinePrincipal {
    clientId: string;
    version: number;
    scopes: string[];
    expiresAt: number;
}

export async function machineAccess(env: Env, clientId: string, resources: string[], scopes: string[], version?: number): Promise<number | null> {
    if (resources.length !== 1 || !scopes.length || scopes.length > 100 || new Set(scopes).size !== scopes.length) return null;
    const machine = await env.DB.prepare(`SELECT m."version" FROM "machineApp" m JOIN "oauthClient" c ON c."clientId" = m."clientId"
        JOIN "oauthClientResource" link ON link."clientId" = c."clientId" JOIN "oauthResource" r ON r."identifier" = link."resourceId"
        WHERE c."clientId" = ? AND c."referenceId" = 'loginflare' AND coalesce(c."disabled", 0) = 0 AND coalesce(r."disabled", 0) = 0
        AND r."identifier" = ? AND (? IS NULL OR m."version" = ?)
        AND NOT EXISTS (SELECT 1 FROM json_each(?) requested WHERE requested.value NOT IN (SELECT value FROM json_each(c."clientCredentialsScopes")))`)
        .bind(clientId, resources[0], version ?? null, version ?? null, JSON.stringify(scopes)).first<{ version: number }>();
    if (!machine) return null;
    const count = await env.DB.prepare(`SELECT COUNT(DISTINCT "scope") AS n FROM "machineScope" WHERE "clientId" = ? AND "resource" = ? AND "scope" IN (SELECT value FROM json_each(?))`)
        .bind(clientId, resources[0], JSON.stringify(scopes)).first<number>('n');
    return count === scopes.length ? machine.version : null;
}

/** Consumes only payloads verified by native introspection or JOSE with our signing keys. */
export async function activeMachineToken(env: Env, payload: Record<string, unknown>): Promise<boolean> {
    const resources = typeof payload.aud === 'string' ? [payload.aud] : Array.isArray(payload.aud) && payload.aud.every((value) => typeof value === 'string') ? payload.aud as string[] : [];
    return payload.lf_principal === 'machine' && typeof payload.sub === 'string' && payload.sub === payload.client_id
        && Number.isSafeInteger(payload.lf_machine_version) && typeof payload.scope === 'string'
        && await machineAccess(env, payload.sub, resources, payload.scope.split(' ').filter(Boolean), payload.lf_machine_version as number) !== null;
}

/** First statement of a D1 transaction; authority cannot be revoked between check and write. */
export function machineWriteGuard(env: Env, principal: MachinePrincipal, scope: ManagementScope, targetUserId?: string | null) {
    return env.DB.prepare(`INSERT INTO "machineWrite" ("id", "clientId", "version", "scope", "expiresAt", "targetUserId") VALUES ('machine', ?, ?, ?, ?, ?)`)
        .bind(principal.clientId, principal.version, scope, principal.expiresAt, targetUserId ?? null);
}
export function finishMachineWrite(env: Env) { return env.DB.prepare(`DELETE FROM "machineWrite" WHERE "id" = 'machine'`); }
export { managementResource };
