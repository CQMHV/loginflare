export const connectionTypes = ['google', 'microsoft', 'github', 'discord', 'x', 'telegram', 'oidc', 'oauth2'] as const;
export type ConnectionType = typeof connectionTypes[number];
export const socialIconSize = 256;
export interface ConnectionConfig {
    clientId: string;
    tenantId?: string;
    issuer?: string;
    discoveryUrl?: string;
    authorizationUrl?: string;
    tokenUrl?: string;
    userInfoUrl?: string;
    tokenAuth: 'client_secret_basic' | 'client_secret_post';
    scopes: string[];
    fields: { subject: string; name: string; email: string; emailVerified: string; image: string };
}
export interface SocialConnection {
    id: string; name: string; type: ConnectionType; config: ConnectionConfig;
    hasSecret: boolean; enabled: boolean; archived: boolean; position: number; revision: number;
    identityLocked: boolean;
    callbackURL: string; linkedAccounts: number;
    iconId?: string | null; iconUrl?: string | null;
}
export interface PublicProvider { id: string; name: string; type: ConnectionType; iconUrl?: string | null }
export interface LinkedIdentity { id: string; providerId: string; accountId: string; name: string; type: ConnectionType; enabled: boolean; iconUrl?: string | null }
export interface SecurityCapabilities { hasPassword: boolean; identities: LinkedIdentity[]; providers: PublicProvider[]; proofPurpose?: SecurityPurpose; proofExpiresAt?: number }
export const securityPurposes = ['link', 'unlink', 'set-password', 'emails/add', 'emails/resend', 'emails/set-primary', 'emails/remove', 'two-factor/enable', 'two-factor/disable', 'two-factor/generate-backup-codes'] as const;
export type SecurityPurpose = typeof securityPurposes[number];
export function defaultConnectionConfig(type: ConnectionType): ConnectionConfig {
    return {
        clientId: '', ...(type === 'microsoft' ? { tenantId: 'common' } : {}),
        tokenAuth: ['github', 'microsoft', 'discord'].includes(type) ? 'client_secret_post' : 'client_secret_basic',
        scopes: type === 'github' ? ['read:user', 'user:email'] : type === 'discord' ? ['identify', 'email'] : type === 'x' ? ['users.read', 'tweet.read'] : type === 'telegram' ? ['openid', 'profile'] : type === 'oauth2' ? [] : ['openid', 'profile', 'email'],
        fields: { subject: ['oauth2', 'discord', 'x'].includes(type) ? 'id' : 'sub', name: 'name', email: 'email', emailVerified: 'email_verified', image: 'picture' },
    };
}
