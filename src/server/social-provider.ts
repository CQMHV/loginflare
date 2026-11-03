import type { AuthContext } from 'better-auth';
import { google, github, microsoft, discord, twitter } from 'better-auth/social-providers';
import { genericOAuth } from 'better-auth/plugins';
import { authorizationCodeRequest, createAuthorizationURL, getOAuth2Tokens, validateAuthorizationCode, verifyProviderIdToken, type OAuthProvider, type OAuth2Tokens } from 'better-auth/oauth2';
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
    if (type === 'x') {
        const provider: OAuthProvider = twitter({ clientId: c.clientId, clientSecret: secret, disableDefaultScope: true, scope: c.scopes });
        provider.id = id;
        // The built-in provider supplies PKCE and Basic token authentication.
        // Read only the authenticated profile, without its optional email lookup
        // or placeholder email: X verification badges do not verify an email.
        provider.getUserInfo = async (tokens) => {
            if (!tokens.accessToken) return null;
            const profile = await socialJson('https://api.x.com/2/users/me?user.fields=profile_image_url', { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
            const data = z.object({ id: z.string().trim().min(1).max(512), name: z.string().optional(), profile_image_url: z.string().optional() }).passthrough().parse(profile.data);
            return { user: { name: data.name, image: data.profile_image_url, email: undefined, emailVerified: false }, data: { ...profile, data } };
        };
        return provider;
    }
    if (type === 'microsoft' || type === 'discord') {
        const options = { clientId: c.clientId, clientSecret: secret, disableDefaultScope: true, scope: c.scopes };
        const tenant = c.tenantId ?? 'common';
        const authority = 'https://login.microsoftonline.com';
        const provider: OAuthProvider = type === 'microsoft'
            ? microsoft({ ...options, tenantId: tenant, disableProfilePhoto: true,
                mapProfileToUser: (profile) => ({ name: typeof profile.name === 'string' ? profile.name : '' }) })
            : discord(options);
        provider.id = id;
        // The preset profile implementations are reused; request construction is
        // shared so neither preset can omit the flow's PKCE or OIDC nonce.
        provider.createAuthorizationURL = ({ state, codeVerifier, redirectURI, idTokenNonce }) => createAuthorizationURL({
            id, options, state, codeVerifier, redirectURI,
            authorizationEndpoint: type === 'microsoft' ? `${authority}/${tenant}/oauth2/v2.0/authorize` : 'https://discord.com/oauth2/authorize',
            scopes: [...new Set([...(type === 'microsoft' ? ['openid'] : ['identify']), ...c.scopes])],
            nonce: type === 'microsoft' ? idTokenNonce : undefined,
        });
        provider.validateAuthorizationCode = ({ code, codeVerifier, redirectURI }) => validateAuthorizationCode({
            code, codeVerifier, redirectURI, options,
            tokenEndpoint: type === 'microsoft' ? `${authority}/${tenant}/oauth2/v2.0/token` : 'https://discord.com/api/oauth2/token',
        });
        if (type === 'microsoft') {
            provider.requiresIdTokenNonce = true;
            provider.accountSubject = ({ profile }) => {
                if (!('sub' in profile) || typeof profile.sub !== 'string' || !profile.sub.trim()) throw new Error('SOCIAL_INVALID_IDENTITY');
                return profile.sub;
            };
            const getUserInfo = provider.getUserInfo;
            provider.getUserInfo = async (tokens) => {
                if (!tokens.idToken || !tokens.expectedIdTokenNonce || !await verifyProviderIdToken(provider, tokens.idToken, tokens.expectedIdTokenNonce)) return null;
                return getUserInfo(tokens);
            };
        }
        return provider;
    }
    const oidc = type === 'oidc' || type === 'telegram';
    const issuer = type === 'telegram' ? 'https://oauth.telegram.org' : c.issuer;
    let authorizationUrl = c.authorizationUrl, tokenUrl = c.tokenUrl, userInfoUrl = c.userInfoUrl;
    let keys: ReturnType<typeof createLocalJWKSet> | undefined;
    let jwksUrl: string | undefined;
    if (type === 'telegram') {
        authorizationUrl = 'https://oauth.telegram.org/auth'; tokenUrl = 'https://oauth.telegram.org/token';
        userInfoUrl = undefined; jwksUrl = 'https://oauth.telegram.org/.well-known/jwks.json';
    } else if (type === 'oidc') {
        const metadata = await socialJson(c.discoveryUrl!);
        if (metadata.issuer !== c.issuer || typeof metadata.authorization_endpoint !== 'string' || typeof metadata.token_endpoint !== 'string'
            || typeof metadata.jwks_uri !== 'string') throw new Error('SOCIAL_PROVIDER_UNAVAILABLE');
        authorizationUrl = publicUrl(metadata.authorization_endpoint).href;
        tokenUrl = publicUrl(metadata.token_endpoint).href;
        userInfoUrl = typeof metadata.userinfo_endpoint === 'string' ? publicUrl(metadata.userinfo_endpoint).href : undefined;
        jwksUrl = publicUrl(metadata.jwks_uri).href;
    }
    if (jwksUrl) {
        const jwks = await socialJson(jwksUrl);
        if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 50
            || jwks.keys.some((key) => !key || typeof key !== 'object' || typeof key.kty !== 'string')) throw new Error('SOCIAL_PROVIDER_UNAVAILABLE');
        keys = createLocalJWKSet(z.object({ keys: z.array(z.object({ kty: z.string() }).passthrough()) }).parse(jwks));
    }
    await Promise.all([authorizationUrl, tokenUrl, userInfoUrl].filter((value): value is string => !!value).map((value) => checkResolution(publicUrl(value))));
    const plugin = genericOAuth({ config: [{
        providerId: id, name: selected.name, clientId: c.clientId, clientSecret: secret,
        authorizationUrl, tokenUrl, userInfoUrl, pkce: true, scopes: oidc ? [...new Set(['openid', ...c.scopes])] : c.scopes,
        disableProviderLogout: true,
        accountSubject: ({ profile }) => {
            const subject = oidc ? profile.sub : mapped(profile, c.fields.subject);
            if ((typeof subject !== 'string' && typeof subject !== 'number') || !String(subject).trim() || String(subject).length > 512) throw new Error('SOCIAL_INVALID_IDENTITY');
            return subject;
        },
        getToken: async ({ code, codeVerifier, redirectURI }): Promise<OAuth2Tokens> => {
            const request = await authorizationCodeRequest({ code, codeVerifier, redirectURI,
                options: { clientId: c.clientId, clientSecret: secret }, tokenEndpointAuth: { method: type === 'telegram' ? 'client_secret_basic' : c.tokenAuth } });
            const tokens = await socialJson(tokenUrl!, { method: 'POST', headers: request.headers, body: request.body.toString() });
            return getOAuth2Tokens(tokens);
        },
        getUserInfo: async (tokens) => {
            // The generic provider verifies OIDC tokens with the local key set below before this callback runs.
            let profile: Record<string, unknown>;
            if (oidc) {
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
                email: type === 'telegram' ? undefined : text(mapped(profile, c.fields.email)), name: text(type === 'telegram' ? profile.name : mapped(profile, c.fields.name)),
                image: text(type === 'telegram' ? profile.picture : mapped(profile, c.fields.image)), emailVerified: type !== 'telegram' && mapped(profile, c.fields.emailVerified) === true,
            };
        },
    }] });
    const initialized = await plugin.init(context);
    const provider = initialized.context.socialProviders[0]!;
    if (oidc) {
        provider.issuer = issuer;
        provider.idToken = { jwks: keys!, issuer, audience: c.clientId, algorithms: type === 'telegram' ? ['RS256', 'ES256', 'EdDSA'] : ['RS256', 'ES256', 'PS256', 'EdDSA'] };
        provider.requiresIdTokenNonce = true;
    }
    return provider;
}
