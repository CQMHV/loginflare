import type { BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';
import type { Env } from './config';

/** This context is constructed by the authenticated application API, never from request fields. */
export interface ApplicationManagement {
    userId: string;
    sessionId: string;
    administrator: boolean;
    ownerDisabled?: boolean;
    adminSuspended?: boolean;
}

export interface ApplicationOwnership {
    ownerId: string | null;
    ownerDisabled: number;
    adminSuspended: number;
}

export function applicationPolicy(management?: ApplicationManagement) {
    const actor = (key: 'userId' | 'sessionId') => management?.[key] ?? null;
    return {
        id: 'loginflare-application-management',
        schema: { oauthClient: { fields: {
            ownerId: { type: 'string', required: false, input: false, returned: false, defaultValue: () => management && !management.administrator ? management.userId : null },
            ownerDisabled: { type: 'boolean', required: false, input: false, returned: false, defaultValue: false,
                ...(management?.ownerDisabled !== undefined ? { onUpdate: () => management.ownerDisabled } : {}) },
            adminSuspended: { type: 'boolean', required: false, input: false, returned: false, defaultValue: false,
                ...(management?.adminSuspended !== undefined ? { onUpdate: () => management.adminSuspended } : {}) },
            managementUserId: { type: 'string', required: false, input: false, returned: false, defaultValue: () => actor('userId'), ...(management ? { onUpdate: () => actor('userId') } : {}) },
            managementSessionId: { type: 'string', required: false, input: false, returned: false, defaultValue: () => actor('sessionId'), ...(management ? { onUpdate: () => actor('sessionId') } : {}) },
            managementAdministrator: { type: 'boolean', required: false, input: false, returned: false, defaultValue: () => management?.administrator ?? false,
                ...(management ? { onUpdate: () => management.administrator } : {}) },
        } } },
    } satisfies BetterAuthPlugin;
}

export async function applicationPrivileges(env: Env, management: ApplicationManagement, clientId?: string, writing = false): Promise<boolean> {
    const eligible = await env.DB.prepare(`SELECT 1 FROM "user" u JOIN "session" s ON s."userId" = u."id"
        WHERE u."id" = ? AND s."id" = ? AND u."emailVerified" = 1 AND COALESCE(u."banned", 0) = 0
        AND s."expiresAt" > ? AND s."oauthRevokedAt" IS NULL AND (? = 0 OR u."role" = 'admin')`)
        .bind(management.userId, management.sessionId, new Date().toISOString(), Number(management.administrator)).first();
    if (!eligible) return false;
    if (!clientId) return true;
    const client = await env.DB.prepare(`SELECT "ownerId", "adminSuspended" FROM "oauthClient" WHERE "clientId" = ? AND "referenceId" = 'loginflare'`)
        .bind(clientId).first<Pick<ApplicationOwnership, 'ownerId' | 'adminSuspended'>>();
    if (!client || (!management.administrator && client.ownerId !== management.userId)) return false;
    if (!management.administrator && writing && client.adminSuspended) {
        throw new APIError('FORBIDDEN', { code: 'APPLICATION_SUSPENDED', message: 'APPLICATION_SUSPENDED' });
    }
    return true;
}
