import type { AuthContext } from 'better-auth';
import { google, github } from 'better-auth/social-providers';
import { genericOAuth } from 'better-auth/plugins';
import { authorizationCodeRequest, getOAuth2Tokens, type OAuthProvider, type OAuth2Tokens } from 'better-auth/oauth2';
import { createLocalJWKSet, decodeJwt } from 'jose';
import { z } from 'zod';
import type { LoadedConnection } from './social-connections';
import { checkResolution, publicUrl, socialJson } from './social-network';

function mapped(profile: Record<string, unknown>, path: string): unknown {
    let value: unknown = profile;
    for (const key of path.split('.')) {
        if (!key || !value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
        value = (value as Record<string, unknown>)[key];
    }
    return value;
}
const text = (value: unknown) => typeof value === 'string' ? value : undefined;

export async function buildSocialProvider(selected: LoadedConnection, context: AuthContext): Promise<OAuthProvider> {
    const { config: c, type, secret, id } = selected;
    if (type === 'google' || type === 'github') {
        const provider: OAuthProvider = type === 'google'
            ? google({ clientId: c.clientId, clientSecret: secret, scope: c.scopes })
            : github({ clientId: c.clientId, clientSecret: secret, scope: c.scopes,
                mapProfileToUser: (profile) => ({ name: typeof profile.name === 'string' ? profile.name : '' }) });
        provider.id = id;
        return provider;
    }
    let authorizationUrl = c.authorizationUrl, tokenUrl = c.tokenUrl, userInfoUrl = c.userInfoUrl;
    let keys: ReturnType<typeof createLocalJWKSet> | undefined;
    if (type === 'oidc') {
        const metadata = await socialJson(c.discoveryUrl!);
        if (metadata.issuer !== c.issuer || typeof metadata.authorization_endpoint !== 'string' || typeof metadata.token_endpoint !== 'string'
            || typeof metadata.jwks_uri !== 'string') throw new Error('SOCIAL_PROVIDER_UNAVAILABLE');
        authorizationUrl = publicUrl(metadata.authorization_endpoint).href;
        tokenUrl = publicUrl(metadata.token_endpoint).href;
        userInfoUrl = typeof metadata.userinfo_endpoint === 'string' ? publicUrl(metadata.userinfo_endpoint).href : undefined;
        const jwks = await socialJson(publicUrl(metadata.jwks_uri).href);
        if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 50
            || jwks.keys.some((key) => !key || typeof key !== 'object' || typeof key.kty !== 'string')) throw new Error('SOCIAL_PROVIDER_UNAVAILABLE');
        keys = createLocalJWKSet(z.object({ keys: z.array(z.object({ kty: z.string() }).passthrough()) }).parse(jwks));
    }
    await Promise.all([authorizationUrl, tokenUrl, userInfoUrl].filter((value): value is string => !!value).map((value) => checkResolution(publicUrl(value))));
    const plugin = genericOAuth({ config: [{
        providerId: id, name: selected.name, clientId: c.clientId, clientSecret: secret,
        authorizationUrl, tokenUrl, userInfoUrl, pkce: true, scopes: type === 'oidc' ? [...new Set(['openid', ...c.scopes])] : c.scopes,
        disableProviderLogout: true,
        accountSubject: ({ profile }) => {
            const subject = type === 'oidc' ? profile.sub : mapped(profile, c.fields.subject);
            if ((typeof subject !== 'string' && typeof subject !== 'number') || !String(subject).trim() || String(subject).length > 512) throw new Error('SOCIAL_INVALID_IDENTITY');
            return subject;
        },
        getToken: async ({ code, codeVerifier, redirectURI }): Promise<OAuth2Tokens> => {
            const request = await authorizationCodeRequest({ code, codeVerifier, redirectURI,
                options: { clientId: c.clientId, clientSecret: secret }, tokenEndpointAuth: { method: c.tokenAuth } });
            const tokens = await socialJson(tokenUrl!, { method: 'POST', headers: request.headers, body: request.body.toString() });
            return getOAuth2Tokens(tokens);
        },
        getUserInfo: async (tokens) => {
            // The generic provider verifies OIDC tokens with the local key set below before this callback runs.
            let profile: Record<string, unknown>;
            if (type === 'oidc') {
                if (!tokens.idToken) throw new Error('SOCIAL_INVALID_IDENTITY');
                profile = decodeJwt(tokens.idToken);
                if (userInfoUrl && tokens.accessToken) {
                    const extra = await socialJson(userInfoUrl, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
                    if (extra.sub !== profile.sub) throw new Error('SOCIAL_INVALID_IDENTITY');
                    profile = { ...extra, ...profile };
                }
            } else {
                if (!tokens.accessToken) throw new Error('SOCIAL_INVALID_IDENTITY');
                profile = await socialJson(userInfoUrl!, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
            }
            return { ...profile,
                email: text(mapped(profile, c.fields.email)), name: text(mapped(profile, c.fields.name)),
                image: text(mapped(profile, c.fields.image)), emailVerified: mapped(profile, c.fields.emailVerified) === true,
            };
        },
    }] });
    const initialized = await plugin.init(context);
    const provider = initialized.context.socialProviders[0]!;
    if (type === 'oidc') {
        provider.issuer = c.issuer;
        provider.idToken = { jwks: keys!, issuer: c.issuer, audience: c.clientId, algorithms: ['RS256', 'ES256', 'PS256', 'EdDSA'] };
        provider.requiresIdTokenNonce = true;
    }
    return provider;
}
