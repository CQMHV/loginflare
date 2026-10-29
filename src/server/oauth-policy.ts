import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, createAuthMiddleware, isAPIError, sensitiveSessionMiddleware } from 'better-auth/api';
import type { OAuthProviderExtension } from '@better-auth/oauth-provider';
import type { Env } from './config';

/** Loginflare account policy, composed through Better Auth's supported lifecycle hooks. */
export function createOAuthPolicy(env: Env) {
    const marked = new WeakSet<object>();
    async function revokeUser(userId: string, exceptSessionId?: string) {
        // The migration's trigger revokes native token rows in the same D1 statement.
        await env.DB.prepare(`UPDATE "oauthGrantPolicy" SET "revokedAt" = ?
            WHERE "userId" = ? AND "revokedAt" IS NULL
            ${exceptSessionId ? 'AND ("originalSessionId" IS NULL OR "originalSessionId" <> ?)' : ''}`)
            .bind(new Date().toISOString(), userId, ...(exceptSessionId ? [exceptSessionId] : [])).run();
    }

    async function revokeSession(sessionId: string) {
        // Mark the session before native deletion so first-time grants cannot enter
        // between this hook and DELETE. The trigger also revokes its existing grants.
        await env.DB.prepare(`UPDATE "session" SET "oauthRevokedAt" = ?
            WHERE "id" = ? AND "oauthRevokedAt" IS NULL`)
            .bind(new Date().toISOString(), sessionId).run();
    }

    async function revokeAll(userId: string, exceptSessionId?: string, remove = false) {
        const now = new Date().toISOString();
        const sessions = `"userId" = ?${exceptSessionId ? ' AND "id" <> ?' : ''}`;
        const grants = `"userId" = ?${exceptSessionId ? ' AND "originalSessionId" <> ?' : ''}`;
        await env.DB.batch([
            env.DB.prepare(`UPDATE "session" SET "oauthRevokedAt" = ? WHERE ${sessions} AND "oauthRevokedAt" IS NULL`)
                .bind(now, userId, ...(exceptSessionId ? [exceptSessionId] : [])),
            env.DB.prepare(`UPDATE "oauthGrantPolicy" SET "revokedAt" = ? WHERE ${grants} AND "revokedAt" IS NULL`)
                .bind(now, userId, ...(exceptSessionId ? [exceptSessionId] : [])),
            ...(remove ? [env.DB.prepare(`DELETE FROM "session" WHERE ${sessions}`)
                .bind(userId, ...(exceptSessionId ? [exceptSessionId] : []))] : []),
        ]);
    }

    async function requireEligibleUser(userId: string | undefined, usingToken = false) {
        const user = userId ? await env.DB.prepare('SELECT "banned", "emailVerified" FROM "user" WHERE "id" = ?')
            .bind(userId).first<{ banned: number | null; emailVerified: number }>() : null;
        if (!user || user.banned || !user.emailVerified) {
            throw new APIError(usingToken ? 'UNAUTHORIZED' : 'BAD_REQUEST', {
                error: usingToken ? 'invalid_token' : 'invalid_grant',
                error_description: 'The account is unavailable.',
            });
        }
    }

    const extension: OAuthProviderExtension = {
        claims: {
            async idToken({ user }) {
                // Runs before native token issuance; the D1 constraint is the concurrent-write backstop.
                await requireEligibleUser(user?.id);
                return {};
            },
            async accessToken({ user, grantType }) {
                await requireEligibleUser(user?.id, grantType === undefined);
                return {};
            },
            async userInfo({ user }) {
                await requireEligibleUser(user.id, true);
                return {};
            },
        },
    };

    const plugin = {
        id: 'loginflare-oauth-policy',
        init() {
            return { options: { databaseHooks: {
                session: { delete: {
                    async before(session, ctx) {
                        if (!ctx) return;
                        const path = ctx.path;
                        if (['/admin/revoke-user-sessions', '/admin/ban-user', '/reset-password', '/change-password'].includes(path ?? '')) {
                            // Native deleteMany enumerates only one adapter page for hooks.
                            // Mark the complete set before its first deletion, once per call.
                            if (!marked.has(ctx)) {
                                const except = path === '/change-password' ? ctx.context.session?.session.id : undefined;
                                await revokeAll(session.userId, except);
                                marked.add(ctx);
                            }
                        } else if (path === '/revoke-session') {
                            // Ordinary /sign-out and RP-initiated logout deliberately leave offline grants intact.
                            await revokeSession(session.id);
                        }
                    },
                } },
            } } };
        },
        endpoints: {
            revokeOtherSessions: createAuthEndpoint('/revoke-other-sessions', {
                method: 'POST', requireHeaders: true, use: [sensitiveSessionMiddleware],
            }, async (ctx) => {
                const identity = ctx.context.session;
                if (identity.user.banned || !identity.user.emailVerified) throw new APIError('FORBIDDEN', { code: 'FORBIDDEN' });
                await revokeAll(identity.user.id, identity.session.id, true);
                return ctx.json({ status: true });
            }),
        },
        hooks: { after: [{
            matcher: (ctx) => ['/admin/revoke-user-sessions', '/change-password'].includes(ctx.path ?? ''),
            handler: createAuthMiddleware(async (ctx) => {
                const result = ctx.context.returned;
                if (isAPIError(result) || (result instanceof Response && !result.ok)) return;
                if (ctx.path === '/admin/revoke-user-sessions') {
                    if (typeof ctx.body?.userId === 'string') await revokeAll(ctx.body.userId, undefined, true);
                    return;
                }
                const identity = ctx.context.session;
                if (identity && (ctx.path !== '/change-password' || ctx.body?.revokeOtherSessions === true)) {
                    // Includes offline grants whose browser session had already ended normally.
                    await revokeUser(identity.user.id, identity.session.id);
                }
            }),
        }] },
    } satisfies BetterAuthPlugin;

    return {
        plugin,
        extension,
        async onPasswordReset({ user }: { user: { id: string } }) {
            // Reset must also revoke offline grants when the user has no remaining browser sessions.
            await revokeAll(user.id, undefined, true);
        },
    };
}
