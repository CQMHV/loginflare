import { betterAuth } from 'better-auth';
import { admin, captcha, username } from 'better-auth/plugins';
import { jwtVerify } from 'jose';
import { z } from 'zod';
import type { Env } from './config';
import { validateConfig } from './config';
import { sendAccountMail } from './mail';
import { acquireLease, beginEffect, ControlError, ensureControl, fencedBatch, finishEffect, issueSession,
    leaseDatabase, readControl, readSession, readValue, releaseLease, renewLease, valueStatement, writeValue } from './control';
import type { ControlRecord } from './control';
import { initialUpgradeProgress, advanceUpgrade, UpgradeError, type UpgradeProgress } from './upgrade';
import { openSetupValue, randomSetupToken, sealSetupValue, setupDigest, setupSecretEqual } from './setup-crypto';
import { SetupCloudflare, SetupProviderError, type SetupTarget, type SetupZone } from './setup-cloudflare';

type SetupEnv = Env & {
    CF_SETUP_TOKEN?: string; LOGINFLARE_WORKER_NAME?: string; LOGINFLARE_ACCOUNT_ID?: string;
    LOGINFLARE_BUILD_ID?: string; LOGINFLARE_CONFIG_REVISION?: string; CF_VERSION_METADATA?: { id: string };
};
type Lease = Awaited<ReturnType<typeof acquireLease>>;
type SetupSession = NonNullable<Awaited<ReturnType<typeof readSession>>>;
type Config = {
    authUrl: string; emailFrom: string; zoneId: string; siteZoneId?: string; revision: string;
    phase: 'domain' | 'sending' | 'widget' | 'secrets' | 'observed';
    widgetId?: string; sendingId?: string; effect?: { id: string; kind: string };
};
type Credentials = { authSecret: string; turnstileSecret?: string };
type Challenge = { id: string; name: string; taskId: string; digest: string; nonceDigest: string; expiresAt: number; used: boolean; effectId: string };
type StagedChallenge = Challenge & { replaces: string[] };
type CleanupIntent = { id: string; names: string[]; instanceId: string };
type CleanupEffect = { id: string; scopeId: string; kind: string; payload: string; status: 'pending' | 'done' | 'failed' };
const tokenSchema = z.string().min(20).max(4096).regex(/^\S+$/);
const candidateSchema = z.object({ name: z.string().trim().min(1).max(100),
    username: z.string().min(3).max(30).regex(/^[A-Za-z0-9_.]+$/), email: z.email().max(254),
    password: z.string().min(8).max(128), locale: z.enum(['en-US', 'zh-CN']).default('en-US'),
    captchaToken: z.string().min(1).max(4096) }).strict();
const configurationSchema = z.object({ token: tokenSchema.optional(), authUrl: z.string().max(2048),
    emailFrom: z.email().max(254), zoneId: z.string().regex(/^[0-9a-f]{32}$/),
    siteZoneId: z.string().regex(/^[0-9a-f]{32}$/).optional() }).strict();

class SetupError extends Error {
    constructor(readonly code: string, readonly status = 400) { super(code); }
}
function json(value: unknown, status = 200, headers?: HeadersInit) {
    return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers } });
}
function target(control: ControlRecord): SetupTarget {
    if (!control.accountId || !control.workerName) throw new SetupError('DEPLOYMENT_IDENTITY_REQUIRED', 409);
    return { accountId: control.accountId, workerName: control.workerName };
}
function credential(body: Record<string, unknown>, env: SetupEnv): string {
    const parsed = tokenSchema.safeParse(body.token ?? env.CF_SETUP_TOKEN);
    if (!parsed.success) throw new SetupError('CLOUDFLARE_TOKEN_REQUIRED', 401);
    return parsed.data;
}
function suppliedCredential(body: Record<string, unknown>): string {
    const parsed = tokenSchema.safeParse(body.token);
    if (!parsed.success) throw new SetupError('CLOUDFLARE_TOKEN_REQUIRED', 401);
    return parsed.data;
}
function callback(env: SetupEnv, locale: string) {
    return `${env.AUTH_URL}/${locale === 'zh-CN' ? 'zh-cn' : 'en-us'}/setup/verified`;
}
async function body(request: Request): Promise<Record<string, unknown>> {
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new SetupError('INVALID_INPUT');
    const reader = request.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        while (true) {
            const next = await reader.read(); if (next.done) break;
            size += next.value.byteLength;
            if (size > 16_384) { await reader.cancel(); throw new SetupError('PAYLOAD_TOO_LARGE', 413); }
            chunks.push(next.value);
        }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        return value as Record<string, unknown>;
    } catch { throw new SetupError('INVALID_INPUT'); }
}
async function limitAuthentication(db: D1Database, request: Request): Promise<void> {
    // A standalone, append-only control table: never depend on business rateLimit migrations.
    await db.batch([
        db.prepare('CREATE TABLE IF NOT EXISTS "lfSetupRate" ("key" TEXT PRIMARY KEY, "count" INTEGER NOT NULL, "expiresAt" INTEGER NOT NULL)'),
        db.prepare('CREATE INDEX IF NOT EXISTS "lfSetupRate_expiry" ON "lfSetupRate" ("expiresAt")'),
    ]);
    const now = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
    const path = new URL(request.url).pathname;
    const maximum = path === '/api/maintenance/verify' ? 60 : 5;
    const key = await setupDigest(`${request.headers.get('cf-connecting-ip') ?? 'unknown'}:${path}`);
    await db.prepare(`DELETE FROM "lfSetupRate" WHERE "key" IN
        (SELECT "key" FROM "lfSetupRate" WHERE "expiresAt" <= ${now} ORDER BY "expiresAt" LIMIT 100)`).run();
    const allowed = await db.prepare(`INSERT INTO "lfSetupRate" ("key", "count", "expiresAt") VALUES (?, 1, ${now}+60000)
        ON CONFLICT ("key") DO UPDATE SET "count" = CASE WHEN "expiresAt" <= ${now} THEN 1 ELSE "count" + 1 END,
        "expiresAt" = CASE WHEN "expiresAt" <= ${now} THEN ${now}+60000 ELSE "expiresAt" END
        WHERE "expiresAt" <= ${now} OR "count" < ${maximum} RETURNING "key"`).bind(key).first();
    if (!allowed) throw new SetupError('TOO_MANY_REQUESTS', 429);
}
async function leased<T>(env: SetupEnv, taskId: string, action: (lease: Lease) => Promise<T>,
    states: ControlRecord['installation'][] = ['installing']): Promise<T> {
    const lease = await acquireLease(env.DB, taskId);
    const timer = setInterval(() => { void renewLease(env.DB, lease).catch(() => { /* Every commit still verifies the lease. */ }); }, 15_000);
    try {
        // Re-read under the execution lease: a request authenticated before
        // completion must not resume configuration after another request finishes.
        const current = await readControl(env.DB);
        if (!states.includes(current.installation)) throw new SetupError('INSTALLATION_STATE_CHANGED', 409);
        return await action(lease);
    }
    finally { clearInterval(timer); await releaseLease(env.DB, lease).catch(() => undefined); }
}
async function requireSession(env: SetupEnv, request: Request, control: ControlRecord, cleanup = false): Promise<SetupSession> {
    const session = await readSession(env.DB, request);
    if (!session || session.taskId !== control.taskId) throw new SetupError('SETUP_SESSION_REQUIRED', 401);
    if (cleanup ? !['setup', 'cleanup', 'maintenance'].includes(session.purpose) : session.purpose !== 'setup') throw new SetupError('FORBIDDEN', 403);
    if (!cleanup && control.installation === 'complete') throw new SetupError('INSTALLATION_COMPLETE', 409);
    return session;
}
async function setSession(env: SetupEnv, purpose: 'setup' | 'maintenance' | 'cleanup', taskId: string, value: unknown): Promise<Response> {
    const raw = await issueSession(env.DB, purpose, taskId);
    return json(value, 200, { 'Set-Cookie': `loginflare.control=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800${env.APP_ENV === 'development' ? '' : '; Secure'}` });
}

async function readCredentials(env: SetupEnv, control: ControlRecord, suppliedToken?: string): Promise<Credentials | null> {
    const encrypted = await readValue<string>(env.DB, 'setup:credentials');
    if (!encrypted) return null;
    const encryptionToken = env.CF_SETUP_TOKEN ?? suppliedToken;
    if (!encryptionToken) throw new SetupError('SETUP_RECOVERY_TOKEN_REQUIRED', 409);
    try { return JSON.parse(await openSetupValue(encrypted, encryptionToken, control.instanceId)) as Credentials; }
    catch { throw new SetupError('SETUP_RECOVERY_TOKEN_MISMATCH', 409); }
}
async function observedConfiguration(env: SetupEnv, control: ControlRecord, config: Config | null) {
    if (!config || !config.widgetId || env.LOGINFLARE_CONFIG_REVISION !== config.revision
        || env.AUTH_URL !== config.authUrl || env.EMAIL_FROM !== config.emailFrom || env.TURNSTILE_SITE_KEY !== config.widgetId) return false;
    const fingerprint = await readValue<string>(env.DB, 'setup:credentialDigest');
    if (!fingerprint || !env.BETTER_AUTH_SECRET || !env.TURNSTILE_SECRET_KEY) return false;
    return setupSecretEqual(await setupDigest(JSON.stringify([env.BETTER_AUTH_SECRET, env.TURNSTILE_SECRET_KEY, control.instanceId])), fingerprint);
}
async function status(request: Request, env: SetupEnv, control: ControlRecord) {
    const session = await readSession(env.DB, request);
    const authenticated = !!session && session.taskId === control.taskId;
    const basic = { mode: control.mode, installation: control.installation, installed: control.installation === 'complete', authenticated,
        cleanupPending: !!control.cleanupPending, buildId: env.LOGINFLARE_BUILD_ID ?? 'development',
        runtimeVersion: env.CF_VERSION_METADATA?.id ?? null, configRevision: env.LOGINFLARE_CONFIG_REVISION ?? null };
    if (!authenticated) return json(basic);
    const config = await readValue<Config>(env.DB, 'setup:configuration');
    const progress = await readValue<UpgradeProgress>(env.DB, `upgrade:${control.taskId}`);
    const candidateStage = control.installation === 'installing' && progress?.phase === 'complete';
    const candidate = candidateStage && control.candidateUserId ? await env.DB.prepare(`SELECT u."emailVerified", EXISTS (
        SELECT 1 FROM "account" a WHERE a."userId" = u."id" AND a."providerId" = 'credential' AND length(a."password") > 0
        ) AS "candidateCreated" FROM "user" u WHERE u."id" = ? AND u."email" = ?`)
        .bind(control.candidateUserId, control.candidateEmail).first<{ emailVerified: number; candidateCreated: number }>() : null;
    const observed = await observedConfiguration(env, control, config);
    return json({ ...basic, step: config?.phase ?? (progress ? 'database' : 'prepare'), configObserved: observed,
        configuration: config ? { authUrl: config.authUrl, emailFrom: config.emailFrom, zoneId: config.zoneId, siteZoneId: config.siteZoneId } : undefined,
        schemaReady: progress?.phase === 'complete', authUrl: observed ? env.AUTH_URL : undefined,
        turnstileSiteKey: observed ? env.TURNSTILE_SITE_KEY : undefined,
        ...(candidateStage ? { candidateCreated: !!candidate?.candidateCreated,
            candidateVerified: !!candidate?.candidateCreated && !!candidate.emailVerified, candidateEmail: control.candidateEmail } : {}), progress });
}

/** Only the native password/username/captcha/mail core is initialized during installation. */
function setupAuth(env: SetupEnv, candidateId?: string) {
    validateConfig(env);
    return betterAuth({
        appName: 'Loginflare', baseURL: env.AUTH_URL, basePath: '/api/auth', secret: env.BETTER_AUTH_SECRET,
        database: env.DB, trustedOrigins: [env.AUTH_URL], telemetry: { enabled: false }, logger: { disabled: true },
        emailAndPassword: { enabled: true, requireEmailVerification: true, minPasswordLength: 8, maxPasswordLength: 128 },
        emailVerification: { sendOnSignUp: true, sendOnSignIn: false, autoSignInAfterVerification: false,
            sendVerificationEmail: ({ user, url }) => sendAccountMail(env, user, url) },
        user: { additionalFields: { locale: { type: 'string', required: false, defaultValue: 'en-US', input: true } } },
        advanced: { database: { validateSchema: false, generateId: ({ model }) => model === 'user' && candidateId ? candidateId : crypto.randomUUID() },
            useSecureCookies: env.APP_ENV !== 'development', ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
        plugins: [admin({ defaultRole: 'user', adminRoles: ['admin'] }), username({ displayUsername: false }),
            captcha({ provider: 'cloudflare-turnstile', secretKey: env.TURNSTILE_SECRET_KEY,
                endpoints: ['/sign-up/email', '/send-verification-email'] })],
    });
}

async function discoverTarget(api: SetupCloudflare, env: SetupEnv, control: ControlRecord): Promise<SetupTarget> {
    const workerName = control.workerName || env.LOGINFLARE_WORKER_NAME;
    const runtimeVersion = env.CF_VERSION_METADATA?.id;
    if (!workerName || !runtimeVersion) throw new SetupError('DEPLOYMENT_METADATA_REQUIRED', 409);
    let accountId = control.accountId || env.LOGINFLARE_ACCOUNT_ID;
    if (accountId) {
        const version = await api.workerVersion({ accountId, workerName }, runtimeVersion);
        if (version.id !== runtimeVersion) throw new SetupError('DEPLOYMENT_IDENTITY_MISMATCH', 403);
    } else {
        const accounts = await api.accounts();
        const matches: string[] = [];
        for (const account of accounts) {
            try {
                const version = await api.workerVersion({ accountId: account.id, workerName }, runtimeVersion);
                if (version.id === runtimeVersion) matches.push(account.id);
            } catch (error) { if (!(error instanceof SetupProviderError) || error.uncertain) throw error; }
        }
        if (matches.length !== 1) throw new SetupError('DEPLOYMENT_IDENTITY_MISMATCH', 403);
        accountId = matches[0]!;
    }
    return { accountId, workerName };
}
async function authenticate(_request: Request, env: SetupEnv, control: ControlRecord, input: Record<string, unknown>) {
    if (control.installation !== 'new' && control.installation !== 'installing') throw new SetupError('INITIAL_SETUP_CLOSED', 409);
    const token = suppliedCredential(input);
    if (!env.CF_SETUP_TOKEN || !await setupSecretEqual(token, env.CF_SETUP_TOKEN)) throw new SetupError('INVALID_SETUP_TOKEN', 401);
    const api = new SetupCloudflare(token);
    await api.verifyUserToken();
    const { accountId, workerName } = await discoverTarget(api, env, control);
    await leased(env, control.taskId!, async (lease) => {
        await fencedBatch(env.DB, lease, [env.DB.prepare(`UPDATE "lfControl" SET "installation" = 'installing', "accountId" = ?, "workerName" = ?, "revision" = "revision" + 1
            WHERE "id" = 1 AND "installation" IN ('new', 'installing')`).bind(accountId, workerName)]);
    }, ['new', 'installing']);
    return setSession(env, 'setup', control.taskId!, { authenticated: true });
}

async function prepare(env: SetupEnv, control: ControlRecord) {
    return leased(env, control.taskId!, async (lease) => {
        const key = `upgrade:${control.taskId}`;
        const progress = await readValue<UpgradeProgress>(env.DB, key) ?? initialUpgradeProgress();
        const result = await advanceUpgrade({ db: env.DB, progress, commit: async (statements, next) => {
            return fencedBatch(env.DB, lease, [...statements, env.DB.prepare(`INSERT INTO "lfControlValue" ("key", "value") VALUES (?, ?)
                ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"`).bind(key, JSON.stringify(next))]);
        } }, env.BETTER_AUTH_SECRET ?? '');
        return json(result);
    });
}

async function checkZone(api: SetupCloudflare, control: ControlRecord, id: string, hostname: string): Promise<SetupZone> {
    const zone = await api.zone(id);
    if (zone.account.id !== control.accountId || (hostname !== zone.name && !hostname.endsWith(`.${zone.name}`))) throw new SetupError('ZONE_IDENTITY_MISMATCH', 403);
    if (zone.status && zone.status !== 'active') throw new SetupError('ZONE_NOT_ACTIVE', 409);
    return zone;
}

async function configure(env: SetupEnv, control: ControlRecord, input: Record<string, unknown>) {
    const progress = await readValue<UpgradeProgress>(env.DB, `upgrade:${control.taskId}`);
    if (progress?.phase !== 'complete') throw new SetupError('DATABASE_PREPARATION_REQUIRED', 409);
    const parsed = configurationSchema.safeParse(input);
    if (!parsed.success) throw new SetupError('INVALID_INPUT');
    const value = parsed.data;
    const url = new URL(value.authUrl);
    if (url.origin !== value.authUrl || url.protocol !== 'https:' || url.username || url.password) throw new SetupError('INVALID_AUTH_URL');
    const token = credential(input, env), api = new SetupCloudflare(token), deployment = target(control);
    await api.verifyUserToken();
    const mailHost = value.emailFrom.slice(value.emailFrom.indexOf('@') + 1).toLowerCase();
    await checkZone(api, control, value.zoneId, mailHost);
    if (value.siteZoneId) await checkZone(api, control, value.siteZoneId, url.hostname);
    else {
        const account = await api.workersSubdomain(deployment.accountId);
        if (!account || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(account.subdomain)) throw new SetupError('WORKERS_SUBDOMAIN_UNAVAILABLE', 409);
        if (url.hostname !== `${deployment.workerName}.${account.subdomain}.workers.dev`) throw new SetupError('WORKERS_SUBDOMAIN_MISMATCH', 403);
    }
    return leased(env, control.taskId!, async (lease) => {
        let config = await readValue<Config>(env.DB, 'setup:configuration');
        if (config && (config.authUrl !== value.authUrl || config.emailFrom !== value.emailFrom || config.zoneId !== value.zoneId
            || config.siteZoneId !== value.siteZoneId)) throw new SetupError('SETUP_CONFIGURATION_ALREADY_SELECTED', 409);
        if (!config) {
            config = { authUrl: value.authUrl, emailFrom: value.emailFrom, zoneId: value.zoneId,
                siteZoneId: value.siteZoneId, revision: crypto.randomUUID(), phase: 'domain' };
            await writeValue(env.DB, lease, 'setup:configuration', config);
        }
        let credentials = await readCredentials(env, control, token);
        if (!credentials) {
            if (env.BETTER_AUTH_SECRET) throw new SetupError('EXISTING_AUTH_SECRET_REQUIRES_ADOPTION', 409);
            credentials = { authSecret: randomSetupToken(48) };
            await writeValue(env.DB, lease, 'setup:credentials', await sealSetupValue(JSON.stringify(credentials), env.CF_SETUP_TOKEN ?? token, control.instanceId));
        }
        const save = () => writeValue(env.DB, lease, 'setup:configuration', config);
        const effect = async <T>(kind: string, reconcile: () => Promise<T | null>, perform: () => Promise<T>) => {
            if (config!.effect) {
                const recorded = await env.DB.prepare('SELECT "status" FROM "lfControlEffect" WHERE "id" = ? AND "scopeId" = ?')
                    .bind(config!.effect.id, control.taskId).first<{ status: string }>();
                if (!recorded || recorded.status === 'failed') { config!.effect = undefined; await save(); }
                else {
                    if (config!.effect.kind !== kind) throw new SetupError('EXTERNAL_RESULT_UNCERTAIN', 409);
                    const found = await reconcile();
                    if (found === null) throw new SetupError('EXTERNAL_RESULT_UNCERTAIN', 409);
                    await finishEffect(env.DB, lease, config!.effect.id, 'done'); config!.effect = undefined; await save();
                    return found;
                }
            }
            const prior = await reconcile();
            if (prior !== null) return prior;
            const id = crypto.randomUUID();
            config!.effect = { id, kind }; await save();
            await beginEffect(env.DB, lease, kind, { revision: config!.revision }, id);
            try {
                const result = await perform();
                await finishEffect(env.DB, lease, id, 'done'); config!.effect = undefined; await save();
                return result;
            } catch (error) {
                if (error instanceof SetupProviderError && !error.uncertain) {
                    await finishEffect(env.DB, lease, id, 'failed'); config!.effect = undefined; await save();
                }
                throw error;
            }
        };
        if (config.phase === 'domain') {
            if (config.siteZoneId) await effect('setup-domain', async () => {
                const existing = (await api.workerDomains(deployment.accountId)).filter((item) => item.hostname === url.hostname);
                if (existing.some((item) => item.service !== deployment.workerName)) throw new SetupError('DOMAIN_CONFLICT', 409);
                return existing[0] ?? null;
            }, () => api.attachDomain(deployment, config!.siteZoneId!, url.hostname));
            config.phase = 'sending'; await save();
        } else if (config.phase === 'sending') {
            const domain = config.sendingId ? (await api.sendingDomains(config.zoneId)).find((item) => item.tag === config!.sendingId && item.name === mailHost)
                : await effect('setup-sending', async () => (await api.sendingDomains(config!.zoneId)).find((item) => item.name === mailHost) ?? null,
                    () => api.createSendingDomain(config!.zoneId, mailHost));
            if (!domain) throw new SetupError('SENDING_RESOURCE_MISSING', 409);
            config.sendingId = domain.tag; await save();
            const desired = await api.sendingDns(config.zoneId, domain.tag);
            for (const record of desired) {
                const kind = `setup-dns:${record.type}:${record.name}`;
                const existing = await api.dns(config.zoneId, record.name, record.type);
                const exact = existing.find((item) => item.content === record.content && (item.priority ?? null) === (record.priority ?? null));
                if (exact) {
                    if (config.effect?.kind === kind) { await finishEffect(env.DB, lease, config.effect.id, 'done'); config.effect = undefined; await save(); }
                    continue;
                }
                if (existing.length) throw new SetupError('DNS_CONFLICT', 409);
                await effect(kind, async () => (await api.dns(config!.zoneId, record.name, record.type))
                    .find((item) => item.content === record.content && (item.priority ?? null) === (record.priority ?? null)) ?? null,
                () => api.createDns(config!.zoneId, record));
                return json({ step: 'sending', pending: true }, 202);
            }
            if (!domain.enabled) return json({ step: 'sending', pending: true, code: 'EMAIL_SERVICE_NOT_READY',
                actionUrl: `https://dash.cloudflare.com/${deployment.accountId}/email/sending` }, 202);
            config.phase = 'widget'; await save();
        } else if (config.phase === 'widget') {
            const name = `Loginflare ${control.instanceId} ${config.revision}`;
            const widget = await effect('setup-turnstile', async () => {
                const matches = (await api.widgets(deployment.accountId)).filter((item) => item.name === name && item.domains.length === 1 && item.domains[0] === url.hostname);
                if (matches.length > 1) throw new SetupError('TURNSTILE_RESOURCE_AMBIGUOUS', 409);
                return matches[0] ? api.widget(deployment.accountId, matches[0].sitekey) : null;
            }, () => api.createWidget(deployment.accountId, name, url.hostname));
            if (!widget.secret) throw new SetupError('TURNSTILE_SECRET_UNAVAILABLE', 409);
            config.widgetId = widget.sitekey; credentials.turnstileSecret = widget.secret;
            await writeValue(env.DB, lease, 'setup:credentials', await sealSetupValue(JSON.stringify(credentials), env.CF_SETUP_TOKEN ?? token, control.instanceId));
            await writeValue(env.DB, lease, 'setup:credentialDigest', await setupDigest(JSON.stringify([credentials.authSecret, credentials.turnstileSecret, control.instanceId])));
            config.phase = 'secrets'; await save();
        } else if (config.phase === 'secrets') {
            if (!config.widgetId || !credentials.turnstileSecret) throw new SetupError('SETUP_CREDENTIALS_INCOMPLETE', 409);
            await effect('setup-secrets', async () => await observedConfiguration(env, control, config) ? true : null, async () => {
                await api.patchSecrets(deployment, { AUTH_URL: config!.authUrl, EMAIL_FROM: config!.emailFrom,
                    TURNSTILE_SITE_KEY: config!.widgetId!, TURNSTILE_SECRET_KEY: credentials!.turnstileSecret!,
                    BETTER_AUTH_SECRET: credentials!.authSecret, LOGINFLARE_CONFIG_REVISION: config!.revision });
                return true;
            });
            config.phase = 'observed'; await save();
        } else if (!await observedConfiguration(env, control, config)) {
            return json({ step: 'observed', pending: true }, 202);
        } else {
            await fencedBatch(env.DB, lease, [env.DB.prepare('UPDATE "lfControl" SET "configRevision" = ?, "revision" = "revision" + 1 WHERE "id" = 1').bind(config.revision)]);
        }
        return json({ step: config.phase, configObserved: await observedConfiguration(env, control, config) }, 202);
    });
}

/** Standalone control routes are called before the business browser/auth/branding boundary. */
export async function handleSetup(request: Request, env: SetupEnv, _ctx?: ExecutionContext): Promise<Response | null> {
    const url = new URL(request.url);
    const verify = url.pathname === '/api/auth/verify-email';
    const maintenance = ['/api/maintenance/challenge', '/api/maintenance/verify'].includes(url.pathname);
    if (!url.pathname.startsWith('/api/setup/') && !maintenance && !verify) return null;
    try {
        const control = await ensureControl(env);
        if (verify && control.installation !== 'installing') return null;
        if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) throw new SetupError('INVALID_ORIGIN', 403);
        if (request.method === 'GET' && url.pathname === '/api/setup/status') return status(request, env, control);
        if (verify) return await verifyCandidate(request, env, control);
        if (request.method === 'GET' && url.pathname === '/api/setup/recovery') {
            await requireSession(env, request, control);
            const config = await readValue<Config>(env.DB, 'setup:configuration');
            if (!await observedConfiguration(env, control, config)) throw new SetupError('CONFIGURATION_NOT_OBSERVED', 409);
            return json({ instanceId: control.instanceId, accountId: control.accountId, workerName: control.workerName,
                authUrl: env.AUTH_URL, emailFrom: env.EMAIL_FROM, turnstileSiteKey: env.TURNSTILE_SITE_KEY,
                betterAuthSecret: env.BETTER_AUTH_SECRET, configRevision: env.LOGINFLARE_CONFIG_REVISION }, 200,
            { 'Content-Disposition': 'attachment; filename="loginflare-recovery.json"' });
        }
        if (request.method !== 'POST') throw new SetupError('METHOD_NOT_ALLOWED', 405);
        if (url.pathname === '/api/setup/authenticate' || maintenance) await limitAuthentication(env.DB, request);
        const input = await body(request);
        if (url.pathname === '/api/setup/authenticate') return await authenticate(request, env, control, input);
        if (url.pathname === '/api/maintenance/challenge') return await startChallenge(env, control, input);
        if (url.pathname === '/api/maintenance/verify') return await verifyChallenge(env, control, input);
        const cleanup = url.pathname === '/api/setup/cleanup';
        const session = await requireSession(env, request, control, cleanup);
        if (cleanup) return await cleanupSetup(env, control, input);
        if (url.pathname === '/api/setup/options') {
            const api = new SetupCloudflare(credential(input, env)); await api.verifyUserToken();
            return json({ zones: (await api.zones()).filter((zone) => zone.account.id === control.accountId) });
        }
        if (url.pathname === '/api/setup/prepare') return await prepare(env, control);
        if (url.pathname === '/api/setup/configure') return await configure(env, control, input);
        if (url.pathname === '/api/setup/candidate') return await candidate(request, env, control, input);
        if (url.pathname === '/api/setup/resend') return await resendCandidate(request, env, control, input);
        if (url.pathname === '/api/setup/finish') return await finishSetup(env, control, session);
        throw new SetupError('NOT_FOUND', 404);
    } catch (error) {
        if (error instanceof SetupError || error instanceof SetupProviderError || error instanceof ControlError) return json({ code: error.code,
            ...(error instanceof SetupProviderError && error.uncertain ? { uncertain: true } : {}) }, error.status);
        if (error instanceof UpgradeError) return json({ code: error.code }, 409);
        return json({ code: 'SETUP_REQUEST_FAILED' }, 503);
    }
}

async function candidate(request: Request, env: SetupEnv, control: ControlRecord, input: Record<string, unknown>): Promise<Response> {
    const parsed = candidateSchema.safeParse(input);
    if (!parsed.success) throw new SetupError('INVALID_INPUT');
    const value = parsed.data, email = value.email.toLowerCase();
    const config = await readValue<Config>(env.DB, 'setup:configuration');
    if (!await observedConfiguration(env, control, config)) throw new SetupError('CONFIGURATION_NOT_OBSERVED', 409);
    return leased(env, control.taskId!, async (lease) => {
        const current = await readControl(env.DB);
        if (current.candidateEmail && current.candidateEmail !== email) throw new SetupError('CANDIDATE_ALREADY_SELECTED', 409);
        let userId = current.candidateUserId;
        if (!userId) {
            const existing = await env.DB.prepare('SELECT "id" FROM "user" WHERE lower("email") = ?').bind(email).first();
            if (existing) throw new SetupError('CANDIDATE_EMAIL_ALREADY_EXISTS', 409);
            userId = crypto.randomUUID();
            await fencedBatch(env.DB, lease, [env.DB.prepare(`UPDATE "lfControl" SET "candidateUserId" = ?, "candidateEmail" = ?, "revision" = "revision" + 1
                WHERE "id" = 1 AND "candidateUserId" IS NULL AND "installation" = 'installing'`).bind(userId, email)]);
        }
        const existing = await env.DB.prepare('SELECT "id" FROM "user" WHERE "id" = ? AND lower("email") = ?').bind(userId, email).first();
        if (existing) {
            const credential = await env.DB.prepare(`SELECT 1 FROM "account" WHERE "userId" = ? AND "providerId" = 'credential' AND length("password") > 0`)
                .bind(userId).first();
            if (credential) return json({ candidateCreated: true });
            // Native registration may have committed the user before linking
            // its credential account. Only the reserved, unverified, unused
            // candidate can be removed and retried with the same fixed ID.
            const [removed] = await fencedBatch(env.DB, lease, [env.DB.prepare(`DELETE FROM "user"
                WHERE "id" = ? AND lower("email") = ? AND "emailVerified" = 0
                AND COALESCE("role", 'user') = 'user' AND COALESCE("banned", 0) = 0 AND "twoFactorEnabled" = 0
                AND NOT EXISTS (SELECT 1 FROM "account" WHERE "userId" = "user"."id")
                AND NOT EXISTS (SELECT 1 FROM "session" WHERE "userId" = "user"."id")
                AND EXISTS (SELECT 1 FROM "lfControl" WHERE "id" = 1 AND "installation" = 'installing'
                    AND "candidateUserId" = "user"."id" AND "candidateEmail" = lower("user"."email")) RETURNING "id"`).bind(userId, email)]);
            if (removed?.results.length !== 1 || removed.results[0]?.id !== userId) throw new SetupError('CANDIDATE_ACCOUNT_INCOMPLETE', 409);
        }
        const headers = new Headers({ Origin: env.AUTH_URL, 'Content-Type': 'application/json', 'x-captcha-response': value.captchaToken,
            'CF-Connecting-IP': request.headers.get('cf-connecting-ip') ?? '' });
        const response = await setupAuth({ ...env, DB: leaseDatabase(env.DB, lease) }, userId).handler(new Request(`${env.AUTH_URL}/api/auth/sign-up/email`, { method: 'POST', headers,
            body: JSON.stringify({ name: value.name, username: value.username.toLowerCase(), email, password: value.password,
                locale: value.locale, callbackURL: callback(env, value.locale) }) }));
        if (!response.ok) return json({ code: 'CANDIDATE_REGISTRATION_FAILED' }, response.status);
        return json({ candidateCreated: true });
    });
}
async function resendCandidate(request: Request, env: SetupEnv, control: ControlRecord, input: Record<string, unknown>): Promise<Response> {
    if (!control.candidateUserId || !control.candidateEmail || typeof input.captchaToken !== 'string') throw new SetupError('CANDIDATE_REQUIRED', 409);
    const captchaToken = input.captchaToken;
    return leased(env, control.taskId!, async (lease) => {
        const user = await env.DB.prepare('SELECT "locale" FROM "user" WHERE "id" = ? AND "email" = ?').bind(control.candidateUserId, control.candidateEmail).first<{ locale: string }>();
        if (!user) throw new SetupError('CANDIDATE_REQUIRED', 409);
        const response = await setupAuth({ ...env, DB: leaseDatabase(env.DB, lease) }).handler(new Request(`${env.AUTH_URL}/api/auth/send-verification-email`, { method: 'POST',
            headers: { Origin: env.AUTH_URL, 'Content-Type': 'application/json', 'x-captcha-response': captchaToken,
                'CF-Connecting-IP': request.headers.get('cf-connecting-ip') ?? '' },
            body: JSON.stringify({ email: control.candidateEmail, callbackURL: callback(env, user.locale) }) }));
        return response.ok ? json({ sent: true }) : json({ code: 'EMAIL_DELIVERY_FAILED' }, response.status);
    });
}
async function verifyCandidate(request: Request, env: SetupEnv, control: ControlRecord): Promise<Response> {
    const url = new URL(request.url), token = url.searchParams.get('token');
    if (request.method !== 'GET' || !token || token.length > 4096 || !control.candidateEmail || !control.candidateUserId) throw new SetupError('INVALID_VERIFICATION_LINK', 400);
    let payload;
    try { payload = (await jwtVerify(token, new TextEncoder().encode(env.BETTER_AUTH_SECRET), { algorithms: ['HS256'] })).payload; }
    catch { throw new SetupError('INVALID_VERIFICATION_LINK', 400); }
    if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== control.candidateEmail || payload.updateTo || payload.requestType) throw new SetupError('INVALID_VERIFICATION_LINK', 400);
    const user = await env.DB.prepare('SELECT "locale" FROM "user" WHERE "id" = ? AND "email" = ?').bind(control.candidateUserId, control.candidateEmail).first<{ locale: string }>();
    if (!user) throw new SetupError('INVALID_VERIFICATION_LINK', 400);
    return leased(env, control.taskId!, async (lease) => {
        const safe = new URL(`${env.AUTH_URL}/api/auth/verify-email`);
        safe.searchParams.set('token', token); safe.searchParams.set('callbackURL', callback(env, user.locale));
        return setupAuth({ ...env, DB: leaseDatabase(env.DB, lease) }).handler(new Request(safe, { method: 'GET' }));
    });
}
async function finishSetup(env: SetupEnv, control: ControlRecord, session: SetupSession): Promise<Response> {
    const config = await readValue<Config>(env.DB, 'setup:configuration');
    if (!await observedConfiguration(env, control, config)) throw new SetupError('CONFIGURATION_NOT_OBSERVED', 409);
    return leased(env, control.taskId!, async (lease) => {
        if (config!.effect) {
            if (config!.effect.kind !== 'setup-secrets') throw new SetupError('EXTERNAL_RESULT_UNCERTAIN', 409);
            await finishEffect(env.DB, lease, config!.effect.id, 'done');
            config!.effect = undefined; await writeValue(env.DB, lease, 'setup:configuration', config);
        }
        const eligible = await env.DB.prepare('SELECT 1 FROM "user" WHERE "id" = ? AND "email" = ? AND "emailVerified" = 1 AND COALESCE("banned", 0) = 0')
            .bind(control.candidateUserId, control.candidateEmail).first();
        if (!eligible) throw new SetupError('CANDIDATE_NOT_VERIFIED', 409);
        const assertion = crypto.randomUUID();
        await fencedBatch(env.DB, lease, [
            env.DB.prepare(`INSERT INTO "lfControlFence" ("id", "valid") SELECT ?, CASE WHEN EXISTS (
                SELECT 1 FROM "lfControl" c JOIN "user" u ON u."id" = c."candidateUserId" AND u."email" = c."candidateEmail"
                JOIN "lfControlSession" s ON s."taskId" = c."taskId"
                WHERE c."id" = 1 AND c."installation" = 'installing' AND c."candidateUserId" = ? AND c."candidateEmail" = ?
                AND u."emailVerified" = 1 AND COALESCE(u."banned", 0) = 0
                AND EXISTS (SELECT 1 FROM "account" a WHERE a."userId" = u."id" AND a."providerId" = 'credential' AND length(a."password") > 0)
                AND s."hash" = ? AND s."purpose" = 'setup' AND s."expiresAt" > CAST(unixepoch('subsec') * 1000 AS INTEGER)
                AND NOT EXISTS (SELECT 1 FROM "lfControlEffect" WHERE "status" = 'pending')
                ) THEN 1 ELSE 0 END`).bind(assertion, control.candidateUserId, control.candidateEmail, session.hash),
            env.DB.prepare(`UPDATE "user" SET "role" = 'admin' WHERE "id" = ? AND "email" = ? AND "emailVerified" = 1 AND COALESCE("banned", 0) = 0
                AND EXISTS (SELECT 1 FROM "lfControl" WHERE "id" = 1 AND "installation" = 'installing' AND "candidateUserId" = ? AND "candidateEmail" = ?)`)
                .bind(control.candidateUserId, control.candidateEmail, control.candidateUserId, control.candidateEmail),
            env.DB.prepare(`UPDATE "lfControl" SET "installation" = 'complete', "mode" = 'ready', "cleanupPending" = 1, "configRevision" = ?, "revision" = "revision" + 1
                WHERE "id" = 1 AND "installation" = 'installing' AND EXISTS (SELECT 1 FROM "user" WHERE "id" = "lfControl"."candidateUserId" AND "email" = "lfControl"."candidateEmail"
                AND "emailVerified" = 1 AND "role" = 'admin' AND COALESCE("banned", 0) = 0)`).bind(config!.revision),
            env.DB.prepare('UPDATE "lfControlSession" SET "purpose" = ? WHERE "purpose" = ? AND "taskId" = ?').bind('cleanup', 'setup', control.taskId),
            env.DB.prepare('DELETE FROM "lfControlFence" WHERE "id" = ?').bind(assertion),
        ]);
        const completed = await readControl(env.DB);
        if (completed.installation !== 'complete') throw new SetupError('CANDIDATE_NOT_VERIFIED', 409);
        return json({ installed: true, cleanupPending: true });
    });
}

async function startChallenge(env: SetupEnv, control: ControlRecord, input: Record<string, unknown>): Promise<Response> {
    const token = suppliedCredential(input);
    const nonce = z.string().min(43).max(200).regex(/^[A-Za-z0-9_-]+$/).safeParse(input.nonce);
    if (!nonce.success) throw new SetupError('CHALLENGE_NONCE_REQUIRED');
    const api = new SetupCloudflare(token);
    await api.verifyUserToken();
    const deployment = await discoverTarget(api, env, control);
    return leased(env, control.taskId!, async (lease) => {
        if (!control.accountId || !control.workerName) await fencedBatch(env.DB, lease, [env.DB.prepare('UPDATE "lfControl" SET "accountId" = ?, "workerName" = ?, "revision" = "revision" + 1 WHERE "id" = 1')
            .bind(deployment.accountId, deployment.workerName)]);
        // Recovery must not require the expired installation session. An
        // immutable deletion intent can be replayed using this explicitly
        // supplied token, before proving control with a fresh nonce write.
        const cleanup = await replayCleanupIntent(env, control, lease, api, deployment);
        if (cleanup && !cleanup.complete) throw new SetupError('CLEANUP_RETRY_PENDING', 409);
        const staged = await readValue<StagedChallenge>(env.DB, 'setup:challengeStaged');
        if (staged) {
            if (staged.taskId !== control.taskId) throw new SetupError('CHALLENGE_TASK_MISMATCH', 409);
            const effect = await challengeEffect(env, control, staged);
            if (effect === 'pending') {
                if (await challengeObserved(env, staged)) await activateChallenge(env, lease, staged);
                else {
                    if (staged.expiresAt > Date.now() && await setupSecretEqual(staged.nonceDigest, await setupDigest(nonce.data))) {
                        return json({ challengeId: staged.id, pending: true }, 202);
                    }
                    throw new SetupError('EXTERNAL_RESULT_UNCERTAIN', 409);
                }
            } else if (effect === 'done') await activateChallenge(env, lease, staged);
            else await fencedBatch(env.DB, lease, [env.DB.prepare('DELETE FROM "lfControlValue" WHERE "key" = ?').bind('setup:challengeStaged')]);
        }
        const previous = await readValue<Challenge>(env.DB, 'setup:challenge');
        if (previous && previous.taskId === control.taskId && !previous.used && previous.expiresAt > Date.now()
            && !cleanup?.names.includes(previous.name)
            && await setupSecretEqual(previous.nonceDigest, await setupDigest(nonce.data))) {
            return json({ challengeId: previous.id, pending: true }, 202);
        }
        if (previous && await challengeEffect(env, control, previous) === 'pending') {
            if (!await challengeObserved(env, previous)) throw new SetupError('EXTERNAL_RESULT_UNCERTAIN', 409);
            await finishEffect(env.DB, lease, previous.effectId, 'done');
        }
        const names = await readValue<string[]>(env.DB, 'setup:challengeNames') ?? [];
        const remove = [...new Set([...names, ...(previous ? [previous.name] : [])])];
        for (const name of remove) {
            if (!/^LF_CONTROL_CHALLENGE_[0-9a-f]{32}$/.test(name)) throw new SetupError('INVALID_CHALLENGE_STATE', 503);
            const effect = await env.DB.prepare(`SELECT "status" FROM "lfControlEffect" WHERE "kind" = 'maintenance-challenge'
                AND json_extract("payload", '$.name') = ? ORDER BY "createdAt" DESC LIMIT 1`).bind(name).first<{ status: string }>();
            if (effect?.status !== 'done') throw new SetupError('EXTERNAL_RESULT_UNCERTAIN', 409);
        }
        const id = crypto.randomUUID(), raw = randomSetupToken(), name = `LF_CONTROL_CHALLENGE_${id.replaceAll('-', '')}`;
        const challenge: StagedChallenge = { id, name, taskId: control.taskId, digest: await setupDigest(raw), nonceDigest: await setupDigest(nonce.data),
            expiresAt: Date.now() + 600_000, used: false, effectId: crypto.randomUUID(), replaces: remove };
        // Preserve the old owner's proof until the new caller has actually
        // performed a write. A read-only token must not replace that proof.
        await writeValue(env.DB, lease, 'setup:challengeStaged', challenge);
        await beginEffect(env.DB, lease, 'maintenance-challenge', { name, challengeId: id, replaces: remove }, challenge.effectId);
        try {
            await api.patchSecrets(deployment, { ...Object.fromEntries(remove.map((old) => [old, null])), [name]: raw });
            await activateChallenge(env, lease, challenge);
        } catch (error) {
            if (error instanceof SetupProviderError && !error.uncertain) {
                await finishEffect(env.DB, lease, challenge.effectId, 'failed');
                await fencedBatch(env.DB, lease, [env.DB.prepare('DELETE FROM "lfControlValue" WHERE "key" = ?').bind('setup:challengeStaged')]);
            } else if (error instanceof SetupProviderError && error.uncertain) {
                await registerChallengeCleanup(env, lease, challenge);
            }
            throw error;
        }
        return json({ challengeId: id, pending: true }, 202);
    }, ['new', 'installing', 'complete', 'legacy']);
}
async function challengeEffect(env: SetupEnv, _control: ControlRecord, challenge: Challenge): Promise<string | null> {
    return env.DB.prepare(`SELECT "status" FROM "lfControlEffect" WHERE "id" = ? AND "kind" = 'maintenance-challenge'
        AND json_extract("payload", '$.name') = ?`).bind(challenge.effectId, challenge.name).first<string>('status');
}
async function challengeObserved(env: SetupEnv, challenge: Challenge): Promise<boolean> {
    const observed: unknown = Reflect.get(env, challenge.name);
    return typeof observed === 'string' && await setupSecretEqual(await setupDigest(observed), challenge.digest);
}
async function activateChallenge(env: SetupEnv, lease: Lease, challenge: StagedChallenge): Promise<void> {
    await fencedBatch(env.DB, lease, [
        valueStatement(env.DB, 'setup:challenge', challenge),
        valueStatement(env.DB, 'setup:challengeNames', [challenge.name]),
        env.DB.prepare('DELETE FROM "lfControlValue" WHERE "key" = ?').bind('setup:challengeStaged'),
        env.DB.prepare('UPDATE "lfControlEffect" SET "status" = ? WHERE "id" = ? AND "scopeId" = ?').bind('done', challenge.effectId, lease.taskId),
        env.DB.prepare(`UPDATE "lfControl" SET "cleanupPending" = 1, "revision" = "revision" + 1 WHERE "id" = 1 AND "installation" = 'complete'`),
    ]);
}
async function registerChallengeCleanup(env: SetupEnv, lease: Lease, challenge: Challenge) {
    const names = await readValue<string[]>(env.DB, 'setup:challengeNames') ?? [];
    await writeValue(env.DB, lease, 'setup:challengeNames', [...new Set([...names, challenge.name])]);
    await fencedBatch(env.DB, lease, [env.DB.prepare(`UPDATE "lfControl" SET "cleanupPending" = 1, "revision" = "revision" + 1
        WHERE "id" = 1 AND "installation" = 'complete'`)]);
}
async function verifyChallenge(env: SetupEnv, control: ControlRecord, input: Record<string, unknown>): Promise<Response> {
    if (typeof input.challengeId !== 'string' || typeof input.nonce !== 'string' || input.nonce.length > 200) throw new SetupError('INVALID_INPUT');
    const active = await readValue<Challenge>(env.DB, 'setup:challenge');
    const staged = await readValue<StagedChallenge>(env.DB, 'setup:challengeStaged');
    const challenge = active?.id === input.challengeId ? active : staged?.id === input.challengeId ? staged : null;
    if (!challenge || challenge.taskId !== control.taskId || challenge.id !== input.challengeId || challenge.used || challenge.expiresAt <= Date.now()) throw new SetupError('CHALLENGE_EXPIRED', 401);
    if (!await setupSecretEqual(challenge.nonceDigest, await setupDigest(input.nonce))) throw new SetupError('INVALID_CHALLENGE_PROOF', 401);
    if (!await challengeObserved(env, challenge)) return json({ pending: true }, 202);
    return leased(env, control.taskId!, async (lease) => {
        const pending = await readValue<StagedChallenge>(env.DB, 'setup:challengeStaged');
        if (pending?.id === challenge.id) await activateChallenge(env, lease, pending);
        const latest = await readValue<Challenge>(env.DB, 'setup:challenge');
        if (!latest || latest.id !== challenge.id || latest.used) throw new SetupError('CHALLENGE_EXPIRED', 401);
        await registerChallengeCleanup(env, lease, challenge);
        await writeValue(env.DB, lease, 'setup:challenge', { ...challenge, used: true });
        await finishEffect(env.DB, lease, challenge.effectId, 'done');
        return setSession(env, control.installation === 'installing' || control.installation === 'new' ? 'setup' : 'maintenance', control.taskId!, { authenticated: true });
    }, ['new', 'installing', 'complete', 'legacy']);
}

function deletionNames(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 100
        || value.some((name) => typeof name !== 'string'
            || (name !== 'CF_SETUP_TOKEN' && !/^LF_CONTROL_CHALLENGE_[0-9a-f]{32}$/.test(name)))) {
        throw new SetupError('INVALID_CLEANUP_INTENT', 409);
    }
    return [...new Set(value as string[])].sort();
}

async function cleanupIntent(env: SetupEnv, control: ControlRecord): Promise<{ intent: CleanupIntent; effect: CleanupEffect | null } | null> {
    const stored = await readValue<{ id?: unknown; names?: unknown; instanceId?: unknown }>(env.DB, 'setup:cleanupEffect');
    const pending = await env.DB.prepare(`SELECT "id", "scopeId", "kind", "payload", "status" FROM "lfControlEffect"
        WHERE "scopeId" = ? AND "kind" = 'setup-cleanup' AND "status" = 'pending' ORDER BY "createdAt" LIMIT 2`)
        .bind(control.taskId).all<CleanupEffect>();
    if (pending.results.length > 1) throw new SetupError('CLEANUP_INTENT_CONFLICT', 409);
    if (!stored && !pending.results.length) return null;
    if (stored && typeof stored.id !== 'string') throw new SetupError('INVALID_CLEANUP_INTENT', 409);
    if (stored?.instanceId !== undefined && stored.instanceId !== control.instanceId) throw new SetupError('INVALID_CLEANUP_INTENT', 409);
    const id = stored?.id as string | undefined ?? pending.results[0]!.id;
    if (pending.results[0] && pending.results[0].id !== id) throw new SetupError('CLEANUP_INTENT_CONFLICT', 409);
    const effect = pending.results[0] ?? await env.DB.prepare('SELECT "id", "scopeId", "kind", "payload", "status" FROM "lfControlEffect" WHERE "id" = ?')
        .bind(id).first<CleanupEffect>();
    if (effect && (effect.kind !== 'setup-cleanup' || effect.scopeId !== control.taskId)) throw new SetupError('INVALID_CLEANUP_INTENT', 409);
    let payload: { names?: unknown; instanceId?: unknown } | null = null;
    if (effect) {
        try { payload = JSON.parse(effect.payload) as { names?: unknown; instanceId?: unknown }; }
        catch { throw new SetupError('INVALID_CLEANUP_INTENT', 409); }
        if (!payload || (payload.instanceId !== undefined && payload.instanceId !== control.instanceId)) throw new SetupError('INVALID_CLEANUP_INTENT', 409);
    }
    // Legacy {id} checkpoints are recoverable only when their durable effect
    // still proves the original name set. Never infer it from newer challenges.
    if (stored?.names === undefined && !payload?.names) throw new SetupError('CLEANUP_INTENT_NAMES_REQUIRED', 409);
    const names = deletionNames(stored?.names ?? payload?.names);
    if (payload?.names && JSON.stringify(deletionNames(payload.names)) !== JSON.stringify(names)) throw new SetupError('CLEANUP_INTENT_CONFLICT', 409);
    return { intent: { id, names, instanceId: control.instanceId }, effect };
}

async function saveCleanupIntent(env: SetupEnv, lease: Lease, intent: CleanupIntent, effect: CleanupEffect | null): Promise<void> {
    const pending = await env.DB.prepare(`SELECT 1 FROM "lfControlEffect" WHERE "status" = 'pending'
        AND "kind" NOT LIKE 'r2:%' AND "id" <> ? LIMIT 1`).bind(intent.id).first();
    if (pending) throw new SetupError('EXTERNAL_RESULT_UNCERTAIN', 409);
    const assertion = crypto.randomUUID();
    const guard = env.DB.prepare(`INSERT INTO "lfControlFence" ("id", "valid") SELECT ?, CASE WHEN NOT EXISTS (
        SELECT 1 FROM "lfControlEffect" WHERE "status" = 'pending' AND "kind" NOT LIKE 'r2:%' AND "id" <> ?
        ) THEN 1 ELSE 0 END`).bind(assertion, intent.id);
    const record = effect ? env.DB.prepare(`UPDATE "lfControlEffect" SET "status" = 'pending', "generation" = ?
        WHERE "id" = ? AND "scopeId" = ? AND "kind" = 'setup-cleanup'`).bind(lease.generation, intent.id, lease.taskId)
        : env.DB.prepare(`INSERT INTO "lfControlEffect" ("id", "scopeId", "generation", "kind", "payload", "status", "createdAt")
            VALUES (?, ?, ?, 'setup-cleanup', ?, 'pending', CAST(unixepoch('subsec') * 1000 AS INTEGER))`)
            .bind(intent.id, lease.taskId, lease.generation, JSON.stringify({ names: intent.names, instanceId: intent.instanceId }));
    await fencedBatch(env.DB, lease, [guard, record, valueStatement(env.DB, 'setup:cleanupEffect', intent),
        env.DB.prepare('DELETE FROM "lfControlFence" WHERE "id" = ?').bind(assertion)]);
}

async function replayCleanupIntent(env: SetupEnv, control: ControlRecord, lease: Lease, api: SetupCloudflare, deployment: SetupTarget)
    : Promise<{ complete: boolean; names: string[] } | null> {
    const saved = await cleanupIntent(env, control);
    if (!saved) return null;
    if (control.installation !== 'complete') throw new SetupError('INVALID_CLEANUP_INTENT', 409);
    const { intent, effect } = saved;
    const bound = await api.secrets(deployment);
    if (intent.names.some((name) => bound.some((item) => item.name === name))) {
        await saveCleanupIntent(env, lease, intent, effect);
        // Every attempt, including a delayed executor, sends this exact set of
        // null values. These names are never reused; replay cannot overwrite
        // authentication/configuration or a newer random challenge Secret.
        // Even a rejected retry cannot settle an earlier timed-out attempt.
        // Keep the logical deletion pending until its fixed names are absent.
        await api.patchSecrets(deployment, Object.fromEntries(intent.names.map((name) => [name, null])));
        const after = await api.secrets(deployment);
        if (intent.names.some((name) => after.some((item) => item.name === name))) return { complete: false, names: intent.names };
    }
    await fencedBatch(env.DB, lease, [
        env.DB.prepare(`UPDATE "lfControlEffect" SET "status" = 'done' WHERE "id" = ? AND "scopeId" = ? AND "kind" = 'setup-cleanup'`)
            .bind(intent.id, lease.taskId),
        env.DB.prepare(`DELETE FROM "lfControlValue" WHERE "key" = 'setup:cleanupEffect' AND json_extract("value", '$.id') = ?`).bind(intent.id),
    ]);
    return { complete: true, names: intent.names };
}

async function cleanupSetup(env: SetupEnv, control: ControlRecord, input: Record<string, unknown>): Promise<Response> {
    if (control.installation !== 'complete') throw new SetupError('INSTALLATION_NOT_COMPLETE', 409);
    if (!control.cleanupPending) return json({ cleanupPending: false });
    const api = new SetupCloudflare(credential(input, env)), deployment = target(control);
    return leased(env, control.taskId!, async (lease) => {
        const replay = await replayCleanupIntent(env, control, lease, api, deployment);
        if (replay && !replay.complete) return json({ cleanupPending: true }, 202);
        const staged = await readValue<StagedChallenge>(env.DB, 'setup:challengeStaged');
        if (staged) {
            const effect = await challengeEffect(env, control, staged);
            if (effect === 'pending') {
                if (!await challengeObserved(env, staged)) throw new SetupError('EXTERNAL_RESULT_UNCERTAIN', 409);
                await activateChallenge(env, lease, staged);
            } else if (effect === 'done') await activateChallenge(env, lease, staged);
        }
        const challenge = await readValue<Challenge>(env.DB, 'setup:challenge');
        if (challenge && await challengeEffect(env, control, challenge) === 'pending') {
            if (!await challengeObserved(env, challenge)) throw new SetupError('EXTERNAL_RESULT_UNCERTAIN', 409);
            await finishEffect(env.DB, lease, challenge.effectId, 'done');
        }
        const names = await readValue<string[]>(env.DB, 'setup:challengeNames') ?? [];
        const remove = [...new Set(['CF_SETUP_TOKEN', ...names, ...(challenge ? [challenge.name] : []),
            ...(staged ? [staged.name, ...staged.replaces] : [])])];
        if (remove.some((name) => name !== 'CF_SETUP_TOKEN' && !/^LF_CONTROL_CHALLENGE_[0-9a-f]{32}$/.test(name))) throw new SetupError('INVALID_CHALLENGE_STATE', 503);
        const bound = await api.secrets(deployment);
        const present = remove.filter((name) => bound.some((item) => item.name === name));
        if (present.length) {
            // A newer challenge is a separate cleanup wave. It is never folded
            // into an earlier deletion request whose executor could still run.
            if (replay) return json({ cleanupPending: true }, 202);
            const intent: CleanupIntent = { id: crypto.randomUUID(), names: deletionNames(present), instanceId: control.instanceId };
            await saveCleanupIntent(env, lease, intent, null);
            const result = await replayCleanupIntent(env, control, lease, api, deployment);
            if (!result?.complete) return json({ cleanupPending: true }, 202);
        }
        await fencedBatch(env.DB, lease, [env.DB.prepare('DELETE FROM "lfControlValue" WHERE "key" IN (?, ?, ?, ?, ?)')
            .bind('setup:credentials', 'setup:challenge', 'setup:cleanupEffect', 'setup:challengeNames', 'setup:challengeStaged'),
        env.DB.prepare('UPDATE "lfControl" SET "cleanupPending" = 0, "revision" = "revision" + 1 WHERE "id" = 1 AND "installation" = ?').bind('complete')]);
        return json({ cleanupPending: false, revokeToken: true });
    }, ['complete']);
}
