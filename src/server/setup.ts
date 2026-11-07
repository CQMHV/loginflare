import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import { validateConfig, type Env } from './config';
import { sendInstallationMail } from './mail';
import { publicBranding, readBranding } from './branding-settings';
import { SetupCloudflare, SetupProviderError, type SetupDnsRecord, type SetupTarget } from './setup-cloudflare';

export const setupPage = /^\/(?:(?:en-us|zh-cn)\/)?setup\/?$/;
const bootstrapSecrets = ['CF_SETUP_TOKEN', 'SETUP_ORIGIN', 'SETUP_ADMIN_EMAIL'];
const materialKey = 'installation.json';
const cooldown = 60_000;
const linkLifetime = 20 * 60_000;
const leaseTime = 5 * 60_000;

type Step = 'target' | 'domain' | 'sending' | 'turnstile' | 'ready';
type Installation = {
    instanceId: string; origin: string; adminEmail: string; step: Step;
    accountId: string | null; workerName: string | null; zoneId: string | null; zoneName: string | null;
    fingerprint: string | null; error: string | null; errorDetail: string | null; completedAt: number | null;
    invitationHash: string | null; invitationExpiresAt: number | null;
};
const materialSchema = z.object({
    instanceId: z.uuid(), origin: z.string(), emailFrom: z.email(),
    authSecret: z.string().regex(/^[0-9a-f]{96}$/),
    siteKey: z.string().min(1), turnstileSecret: z.string().min(1),
}).strict();
type Material = z.infer<typeof materialSchema>;
const localeSchema = z.enum(['en-US', 'zh-CN']).default('en-US');
const inviteSchema = z.object({ locale: localeSchema }).strict();
const claimSchema = z.object({
    token: z.string().regex(/^[0-9a-f]{64}$/),
    username: z.string().regex(/^[a-zA-Z0-9_.]{3,30}$/).transform((value) => value.toLowerCase()),
    password: z.string().min(8).max(128), locale: localeSchema,
}).strict();

class SetupError extends Error {
    constructor(readonly code: string, readonly status = 409, readonly detail?: string) { super(code); }
}

function random(bytes: number) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function digest(value: string) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function json(value: unknown, status = 200, headers?: HeadersInit) {
    return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
function target(row: Installation): SetupTarget {
    if (!row.accountId || !row.workerName || !row.zoneId || !row.zoneName) throw new SetupError('DEPLOYMENT_IDENTITY_MISSING');
    return { accountId: row.accountId, workerName: row.workerName };
}
function sender(row: Installation) { return `noreply@notify.${row.zoneName}`; }

export function readInstallation(db: D1Database) {
    return db.prepare(`SELECT instanceId, origin, adminEmail, step, accountId, workerName, zoneId, zoneName, fingerprint,
        error, errorDetail, invitationHash, invitationExpiresAt, completedAt FROM lfInstallation WHERE id = 1`).first<Installation>();
}

function inputs(env: Env) {
    const domain = env.SETUP_ORIGIN?.trim().toLowerCase() ?? '';
    const host = domain.replace(/^https:\/\//, '').replace(/\/$/, '');
    if (host.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/.test(host)
        || host.endsWith('.workers.dev')) throw new SetupError('INVALID_LOGIN_DOMAIN');
    const adminEmail = z.email().max(254).safeParse(env.SETUP_ADMIN_EMAIL?.trim().toLowerCase());
    if (!adminEmail.success) throw new SetupError('INVALID_ADMIN_EMAIL');
    return { origin: `https://${host}`, adminEmail: adminEmail.data };
}

async function initialize(env: Env) {
    if (!env.CF_SETUP_TOKEN) throw new SetupError('DEPLOYMENT_INPUTS_REQUIRED');
    const { origin, adminEmail } = inputs(env);
    if (!env.PRIVATE) throw new SetupError('PRIVATE_STORAGE_REQUIRED');
    if (await env.PRIVATE.head(materialKey)) throw new SetupError('PRIVATE_STORAGE_ALREADY_INITIALIZED');
    await env.DB.prepare(`INSERT INTO lfInstallation (id, instanceId, origin, adminEmail, step)
        SELECT 1, ?, ?, ?, 'target' WHERE NOT EXISTS (SELECT 1 FROM "user") ON CONFLICT(id) DO NOTHING`)
        .bind(crypto.randomUUID(), origin, adminEmail).run();
    const row = await readInstallation(env.DB);
    if (!row) throw new SetupError('EMPTY_DATABASE_REQUIRED');
    return row;
}

// Preserve the logical DNS value when Cloudflare returns a trailing dot on MX
// or breaks a long DKIM TXT value into quoted character strings.
function dnsContent({ type, content }: SetupDnsRecord): string {
    if (type === 'MX') return content.replace(/\.$/, '').toLowerCase();
    if (type === 'TXT' && /^(?:"(?:[^"\\]|\\.)*"\s*)+$/.test(content)) {
        return Array.from(content.matchAll(/"((?:[^"\\]|\\.)*)"/g), (part) => part[1]).join('');
    }
    return content;
}

type NamedDnsRecord = SetupDnsRecord & { id: string };
function dnsConflict(record: NamedDnsRecord): never {
    throw new SetupError('DNS_CONFLICT', 409, `${record.type} ${record.name} (${record.id})`);
}

async function loadMaterial(env: Env, row: Installation) {
    const object = await env.PRIVATE?.get(materialKey);
    if (!object) throw new SetupError('INSTANCE_KEYS_MISSING', 503);
    const source = await object.text();
    const fingerprint = await digest(source);
    if (row.fingerprint && row.fingerprint !== fingerprint) throw new SetupError('INSTANCE_KEYS_MISMATCH', 503);
    const value = materialSchema.parse(JSON.parse(source));
    if (value.instanceId !== row.instanceId || value.origin !== row.origin || value.emailFrom !== sender(row)) {
        throw new SetupError('INSTANCE_KEYS_MISMATCH', 503);
    }
    return { value, fingerprint };
}

const materialCache = new WeakMap<R2Bucket, { fingerprint: string; until: number; value: Promise<Material> }>();
export async function instanceEnv(env: Env, row: Installation): Promise<Env> {
    if (!row.fingerprint || !env.PRIVATE) throw new SetupError('INSTANCE_KEYS_MISSING', 503);
    const current = materialCache.get(env.PRIVATE);
    const value = current?.fingerprint === row.fingerprint && current.until > Date.now() ? current.value
        : loadMaterial(env, row).then(({ value }) => value);
    if (value !== current?.value) {
        materialCache.set(env.PRIVATE, { fingerprint: row.fingerprint, until: Date.now() + 30_000, value });
        void value.catch(() => {
            if (materialCache.get(env.PRIVATE!)?.value === value) materialCache.delete(env.PRIVATE!);
        });
    }
    const keys = await value;
    const configured = { ...env, AUTH_URL: row.origin, EMAIL_FROM: keys.emailFrom, BETTER_AUTH_SECRET: keys.authSecret,
        TURNSTILE_SITE_KEY: keys.siteKey, TURNSTILE_SECRET_KEY: keys.turnstileSecret };
    validateConfig(configured);
    return configured;
}

export async function advanceInstallation(env: Env, cloudflare?: SetupCloudflare) {
    const row = await readInstallation(env.DB) ?? await initialize(env);
    if (!env.CF_SETUP_TOKEN) {
        if (row.step === 'ready') return;
        throw new SetupError('DEPLOYMENT_TOKEN_REQUIRED');
    }
    const db = env.DB, lease = crypto.randomUUID(), now = Date.now();
    const acquired = await db.prepare(`UPDATE lfInstallation SET lease = ?, leaseUntil = ?
        WHERE id = 1 AND leaseUntil <= ? AND retryAt <= ? AND step = ? RETURNING id`)
        .bind(lease, now + leaseTime, now, now, row.step).first();
    if (!acquired) return;
    try {
        const api = cloudflare ?? new SetupCloudflare(env.CF_SETUP_TOKEN);
        const host = new URL(row.origin).hostname;
        if (row.step === 'target') {
            await api.verifyUserToken();
            const accountId = env.LOGINFLARE_ACCOUNT_ID, workerName = env.LOGINFLARE_WORKER_NAME;
            const versionId = env.CF_VERSION_METADATA?.id;
            if (!accountId || !workerName || !versionId) throw new SetupError('DEPLOYMENT_IDENTITY_MISSING');
            const version = await api.workerVersion({ accountId, workerName }, versionId);
            if (version.id !== versionId) throw new SetupError('DEPLOYMENT_IDENTITY_MISMATCH');
            const labels = host.split('.');
            let zone;
            for (let offset = 0; offset < labels.length - 1; offset++) {
                const name = labels.slice(offset).join('.');
                zone = (await api.zones(accountId, name)).find((item) => item.name === name && item.account.id === accountId && item.status === 'active');
                if (zone) break;
            }
            if (!zone) throw new SetupError('ACTIVE_ZONE_NOT_FOUND', 409, host);
            if (host === `notify.${zone.name}`) throw new SetupError('LOGIN_DOMAIN_RESERVED', 409, host);
            await db.prepare(`UPDATE lfInstallation SET accountId = ?, workerName = ?, zoneId = ?, zoneName = ?, step = 'domain'
                WHERE id = 1 AND lease = ?`).bind(accountId, workerName, zone.id, zone.name, lease).run();
        } else if (row.step === 'domain') {
            const deployment = target(row);
            const existing = (await api.workerDomains(deployment.accountId, host)).find((item) => item.hostname === host);
            if (existing && existing.service !== deployment.workerName) throw new SetupError('DOMAIN_CONFLICT', 409, host);
            if (!existing) {
                const records = await api.dns(row.zoneId!, host);
                const conflict = records.find((record) => ['A', 'AAAA', 'CNAME', 'NS'].includes(record.type));
                if (conflict) dnsConflict(conflict);
                await api.attachDomain(deployment, row.zoneId!, host);
            }
            await db.prepare("UPDATE lfInstallation SET step = 'sending' WHERE id = 1 AND lease = ?").bind(lease).run();
        } else if (row.step === 'sending') {
            const zoneId = row.zoneId!, mailHost = sender(row).split('@')[1]!;
            const sending = (await api.sendingDomains(zoneId)).find((item) => item.name === mailHost)
                ?? await api.createSendingDomain(zoneId, mailHost);
            const desired = await api.sendingDns(zoneId, sending.tag);
            if (!desired.length) throw new SetupError('EMAIL_DNS_NOT_READY', 503);
            // Inspect all records before writing any, so an unrelated MX, SPF,
            // DKIM or DMARC record is never silently adopted or overwritten.
            const missing: SetupDnsRecord[] = [];
            const byName = new Map<string, SetupDnsRecord[]>();
            for (const record of desired) {
                const records = byName.get(record.name) ?? [];
                records.push(record);
                byName.set(record.name, records);
            }
            const matches = (item: SetupDnsRecord, record: SetupDnsRecord) => item.type === record.type
                    && dnsContent(item) === dnsContent(record) && (item.priority ?? null) === (record.priority ?? null);
            for (const [name, records] of byName) {
                const existing = await api.dns(zoneId, name);
                for (const item of existing) {
                    if (records.some((record) => matches(item, record))) continue;
                    if (item.type === 'CNAME' || records.some((record) => item.type === record.type
                        && (record.type !== 'TXT' || !/^v=spf1\b/i.test(dnsContent(record)) || /^v=spf1\b/i.test(dnsContent(item))))) {
                        dnsConflict(item);
                    }
                }
                for (const record of records) {
                    if (!existing.some((item) => matches(item, record))) missing.push(record);
                }
            }
            for (const record of missing) await api.createDns(zoneId, record);
            if (missing.length || !sending.enabled) throw new SetupError('EMAIL_DNS_PENDING', 503);
            await db.prepare("UPDATE lfInstallation SET step = 'turnstile' WHERE id = 1 AND lease = ?").bind(lease).run();
        } else if (row.step === 'turnstile') {
            if (!env.PRIVATE) throw new SetupError('PRIVATE_STORAGE_REQUIRED');
            if (!await env.PRIVATE.head(materialKey)) {
                const { accountId } = target(row), name = `Loginflare ${row.instanceId}`;
                const widgets = (await api.widgets(accountId)).filter((item) => item.name === name);
                if (widgets.length > 1 || widgets.some((item) => item.domains.length !== 1 || item.domains[0] !== host)) {
                    throw new SetupError('TURNSTILE_RESOURCE_CONFLICT');
                }
                const widget = widgets[0] ? await api.widget(accountId, widgets[0].sitekey) : await api.createWidget(accountId, name, host);
                if (!widget.secret) throw new SetupError('TURNSTILE_SECRET_UNAVAILABLE');
                const material: Material = { instanceId: row.instanceId, origin: row.origin, emailFrom: sender(row),
                    authSecret: random(48), siteKey: widget.sitekey, turnstileSecret: widget.secret };
                await env.PRIVATE.put(materialKey, JSON.stringify(material), { onlyIf: new Headers({ 'If-None-Match': '*' }) });
            }
            const { fingerprint } = await loadMaterial(env, row);
            await db.prepare("UPDATE lfInstallation SET step = 'ready', fingerprint = ? WHERE id = 1 AND lease = ?")
                .bind(fingerprint, lease).run();
        } else {
            await instanceEnv(env, row);
            await removeBootstrapSecrets(db, api, target(row));
        }
        await db.prepare('UPDATE lfInstallation SET error = NULL, errorDetail = NULL, retryAt = 0 WHERE id = 1 AND lease = ?')
            .bind(lease).run();
    } catch (error) {
        const failure = error instanceof SetupError || error instanceof SetupProviderError ? error.code : 'DEPLOYMENT_STEP_FAILED';
        const detail = error instanceof SetupError ? error.detail ?? null : null;
        await db.prepare('UPDATE lfInstallation SET error = ?, errorDetail = ?, retryAt = ? WHERE id = 1 AND lease = ?')
            .bind(failure, detail, Date.now() + (failure === 'EMAIL_DNS_PENDING' ? 15_000 : 30_000), lease).run();
    } finally {
        await db.prepare('UPDATE lfInstallation SET lease = NULL, leaseUntil = 0 WHERE id = 1 AND lease = ?').bind(lease).run();
    }
}

async function removeBootstrapSecrets(db: D1Database, api: SetupCloudflare, deployment: SetupTarget) {
    const owner = `setup:${crypto.randomUUID()}`;
    const now = Date.now();
    const lock = await db.prepare(`INSERT INTO lfReleaseLock (id, owner, expiresAt) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expiresAt = excluded.expiresAt
        WHERE lfReleaseLock.expiresAt <= ? RETURNING id`).bind(owner, now + 5 * 60_000, now).first();
    if (!lock) return;
    let ambiguous = false;
    try {
        const names = (await api.secrets(deployment)).map(({ name }) => name);
        const found = bootstrapSecrets.filter((name) => names.includes(name));
        if (found.length) {
            ambiguous = true;
            await api.patchSecrets(deployment, Object.fromEntries(found.map((name) => [name, null])));
            ambiguous = false;
        }
    } catch (error) {
        if (error instanceof SetupProviderError && !error.uncertain) ambiguous = false;
        throw error;
    } finally {
        if (!ambiguous) await db.prepare('DELETE FROM lfReleaseLock WHERE id = 1 AND owner = ?').bind(owner).run();
    }
}

async function readBody(request: Request) {
    if (request.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json' || !request.body) throw new SetupError('INVALID_INPUT', 400);
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let length = 0, body = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 4096) { await reader.cancel(); throw new SetupError('INVALID_INPUT', 400); }
            body += decoder.decode(value, { stream: true });
        }
        return JSON.parse(body + decoder.decode()) as unknown;
    } catch { throw new SetupError('INVALID_INPUT', 400); }
    finally { reader.releaseLock(); }
}

async function invite(env: Env, row: Installation, locale: z.infer<typeof localeSchema>) {
    const now = Date.now(), token = random(32), proof = await digest(token);
    const reserved = await env.DB.prepare(`UPDATE lfInstallation SET invitationHash = ?, invitationExpiresAt = ?, lastInvitationAt = ?
        WHERE id = 1 AND step = 'ready' AND completedAt IS NULL AND lastInvitationAt <= ?
        AND (invitationExpiresAt IS NULL OR invitationExpiresAt <= ?) RETURNING id`)
        .bind(proof, now + linkLifetime, now, now - cooldown, now).first();
    if (!reserved) return; // A live invitation remains valid when other visitors request another.
    try {
        await sendInstallationMail(env, row.adminEmail, token, locale);
    } catch {
        await env.DB.prepare(`UPDATE lfInstallation SET invitationHash = NULL, invitationExpiresAt = NULL
            WHERE id = 1 AND invitationHash = ? AND completedAt IS NULL`).bind(proof).run();
        throw new SetupError('EMAIL_DELIVERY_FAILED', 503);
    }
}

async function claim(env: Env, row: Installation, value: z.infer<typeof claimSchema>) {
    const proof = await digest(value.token);
    if (row.invitationHash !== proof || (row.invitationExpiresAt ?? 0) <= Date.now()) throw new SetupError('INVALID_OR_EXPIRED_LINK', 400);
    const password = await hashPassword(value.password);
    const id = crypto.randomUUID(), now = Date.now(), date = new Date(now).toISOString();
    const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role, banned, locale, username)
            SELECT ?, ?, adminEmail, 1, ?, ?, 'admin', 0, ?, ? FROM lfInstallation
            WHERE id = 1 AND step = 'ready' AND completedAt IS NULL AND invitationHash = ? AND invitationExpiresAt > ?
            AND NOT EXISTS (SELECT 1 FROM "user") RETURNING id`).bind(id, value.username, date, date, value.locale, value.username, proof, now),
        env.DB.prepare(`INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
            SELECT ?, id, 'credential', id, ?, ?, ? FROM "user" WHERE id = ?`).bind(crypto.randomUUID(), password, date, date, id),
        env.DB.prepare(`UPDATE lfInstallation SET completedAt = ?, invitationHash = NULL, invitationExpiresAt = NULL
            WHERE id = 1 AND EXISTS (SELECT 1 FROM account WHERE userId = ? AND providerId = 'credential')`).bind(now, id),
    ]);
    if (!results[0]?.results.length) throw new SetupError('INVALID_OR_EXPIRED_LINK', 400);
}

export async function handleSetup(request: Request, env: Env, row: Installation | null): Promise<Response> {
    const url = new URL(request.url), path = url.pathname;
    try {
        if (path === '/api/setup/status' && request.method === 'GET') {
            const canonical = url.origin === row?.origin;
            const { name, logoUrl } = publicBranding(await readBranding(env.DB));
            return json({ step: row?.step ?? 'target', canonical, branding: { name, logoUrl },
                publicUrl: row?.step === 'ready' ? row.origin : undefined, completed: Boolean(row?.completedAt),
                error: row?.error ?? undefined, detail: row?.errorDetail ?? undefined,
                canStart: Boolean(env.CF_SETUP_TOKEN && (!row || row.step !== 'ready')) });
        }
        if (request.method !== 'POST' || request.headers.get('Origin') !== url.origin) return json({ code: 'NOT_FOUND' }, 404);
        if (path === '/api/setup/start' && (!row || row.step !== 'ready')) {
            await advanceInstallation(env);
            return json({}, 202);
        }
        if (!row || row.step !== 'ready' || row.completedAt || url.origin !== row.origin) return json({ code: 'NOT_FOUND' }, 404);
        if (path === '/api/setup/invite') {
            const input = inviteSchema.safeParse(await readBody(request));
            if (!input.success) throw new SetupError('INVALID_INPUT', 400);
            await invite(await instanceEnv(env, row), row, input.data.locale);
            return json({}, 202);
        }
        if (path === '/api/setup/claim') {
            const input = claimSchema.safeParse(await readBody(request));
            if (!input.success) throw new SetupError('INVALID_INPUT', 400);
            await claim(await instanceEnv(env, row), row, input.data);
            return json({});
        }
        return json({ code: 'NOT_FOUND' }, 404);
    } catch (error) {
        if (error instanceof SetupError) return json({ code: error.code, detail: error.detail }, error.status);
        return json({ code: 'INSTALLATION_UNAVAILABLE' }, 503);
    }
}
