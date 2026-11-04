import { oauthClientMetadataSchema } from '@better-auth/oauth-provider';
import { generateRandomString } from 'better-auth/crypto';
import type { Env } from './config';
import type { ApplicationManagement } from './application-policy';

// The native provider's default secret format is SHA-256, base64url without padding.
// Reuse it for atomic service registrations, which have no browser session and
// therefore cannot call its session-only administrative endpoints.
export async function newClientSecret() {
    const secret = generateRandomString(48, 'a-z', 'A-Z', '0-9');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
    return { secret, hash: btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') };
}

export async function clientRegistration(env: Env, data: {
    name: string; type: 'web' | 'spa' | 'machine'; redirectUris?: string[]; postLogoutRedirectUris?: string[]; scopes?: string[];
}, actor?: ApplicationManagement) {
    const machine = data.type === 'machine', confidential = data.type !== 'spa';
    const clientId = generateRandomString(32, 'a-z', 'A-Z', '0-9'), now = new Date().toISOString();
    const metadata = oauthClientMetadataSchema.parse({
        client_id: clientId,
        client_name: data.name, token_endpoint_auth_method: confidential ? 'client_secret_basic' : 'none',
        ...(!machine ? { redirect_uris: data.redirectUris, post_logout_redirect_uris: data.postLogoutRedirectUris } : {}),
        grant_types: machine ? ['client_credentials'] : ['authorization_code', 'refresh_token'], response_types: machine ? [] : ['code'],
        scope: (data.scopes ?? []).join(' '), application_type: 'web', require_pkce: !machine,
    });
    const credential = confidential ? await newClientSecret() : undefined;
    const statement = env.DB.prepare(`INSERT INTO "oauthClient" ("id", "clientId", "name", "clientSecret", "tokenEndpointAuthMethod", "applicationType", "redirectUris", "postLogoutRedirectUris",
        "scopes", "clientCredentialsScopes", "grantTypes", "responseTypes", "requirePKCE", "skipConsent", "enableEndSession", "disabled", "ownerDisabled", "adminSuspended", "referenceId", "createdAt", "updatedAt", "metadata", "managementUserId", "managementSessionId", "managementAdministrator")
        VALUES (?, ?, ?, ?, ?, 'web', ?, ?, ?, '[]', ?, ?, ?, 0, ?, 0, 0, 0, 'loginflare', ?, ?, ?, ?, ?, 1)`)
        .bind(crypto.randomUUID(), clientId, metadata.client_name ?? data.name, credential?.hash ?? null, metadata.token_endpoint_auth_method,
            JSON.stringify(data.redirectUris ?? []), JSON.stringify(data.postLogoutRedirectUris ?? []), JSON.stringify(data.scopes ?? []),
            JSON.stringify(metadata.grant_types), JSON.stringify(metadata.response_types), Number(!machine), Number(!machine), now, now,
            JSON.stringify({ loginflareRedirectOrigins: [...new Set((data.redirectUris ?? []).map((uri) => new URL(uri).origin))] }), actor?.userId ?? null, actor?.sessionId ?? null);
    return { clientId, clientSecret: credential?.secret, createdAt: now, statement };
}
