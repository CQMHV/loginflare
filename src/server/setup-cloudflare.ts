export class SetupProviderError extends Error {
    constructor(public readonly code: string, public readonly status: number, public readonly uncertain = false, cause?: unknown) {
        super(code, { cause });
    }
}

export interface SetupTarget { accountId: string; workerName: string }
export interface SetupZone { id: string; name: string; account: { id: string }; status?: string }
export interface SetupWidget { sitekey: string; secret?: string; domains: string[]; name: string; mode: string }
export interface SetupSendingDomain { tag: string; name: string; enabled: boolean }
export interface SetupDnsRecord { type: string; name: string; content: string; priority?: number; ttl?: number }

type Envelope<T> = { success?: boolean; result?: T; errors?: { code?: number }[] };

async function readBoundedJson(response: Response): Promise<unknown> {
    if (!response.body) throw new SetupProviderError('CLOUDFLARE_INVALID_RESPONSE', 502, true);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 1_048_576) {
                await reader.cancel();
                throw new SetupProviderError('CLOUDFLARE_RESPONSE_TOO_LARGE', 502, true);
            }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
}

/** The API origin is fixed; credentials never accompany user-provided URLs or redirects. */
export class SetupCloudflare {
    constructor(private readonly token: string, private readonly transport: typeof fetch = fetch) {
        if (!token || token.trim() !== token || /\s/.test(token) || token.length > 4096) throw new SetupProviderError('INVALID_CLOUDFLARE_TOKEN', 400);
    }

    async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
        if (!path.startsWith('/') || path.includes('://') || path.includes('..')) throw new SetupProviderError('INVALID_CLOUDFLARE_PATH', 400);
        const mutation = method !== 'GET';
        let response: Response;
        try {
            const transport = this.transport;
            response = await transport(`https://api.cloudflare.com/client/v4${path}`, {
                method, redirect: 'manual', signal: AbortSignal.timeout(25_000),
                headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch (error) { throw new SetupProviderError('CLOUDFLARE_RESULT_UNCERTAIN', 503, mutation, error); }
        if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            throw new SetupProviderError('CLOUDFLARE_REDIRECT_REJECTED', 503, mutation);
        }
        if (response.status === 401 || response.status === 403) {
            await response.body?.cancel();
            throw new SetupProviderError('CLOUDFLARE_PERMISSION_DENIED', 403);
        }
        let value: unknown;
        try { value = await readBoundedJson(response); }
        catch (error) {
            if (error instanceof SetupProviderError) throw error;
            throw new SetupProviderError('CLOUDFLARE_RESULT_UNCERTAIN', 503, mutation);
        }
        const result = value as Envelope<T>;
        if (!response.ok || !result || result.success !== true) {
            throw new SetupProviderError(response.status === 429 ? 'CLOUDFLARE_RATE_LIMITED' : 'CLOUDFLARE_REQUEST_FAILED',
                response.status === 429 ? 429 : 503,
                mutation && (response.status >= 500 || (response.ok && result?.success !== false)));
        }
        return result.result as T;
    }

    async verifyUserToken(): Promise<void> {
        const token = await this.request<{ status: string }>('/user/tokens/verify');
        if (token?.status !== 'active') throw new SetupProviderError('USER_API_TOKEN_REQUIRED', 403);
    }

    zones(accountId: string, name: string) {
        return this.request<SetupZone[]>(`/zones?${new URLSearchParams({ 'account.id': accountId, name, status: 'active' })}`);
    }
    workerVersion(target: SetupTarget, versionId: string) {
        return this.request<{ id: string; resources?: { bindings?: { name: string; type: string; id?: string }[] } }>(
            `${this.workerPath(target)}/versions/${encodeURIComponent(versionId)}`);
    }
    secrets(target: SetupTarget) { return this.request<{ name: string; type: string }[]>(`${this.workerPath(target)}/secrets`); }
    patchSecrets(target: SetupTarget, values: Record<string, string | null>) {
        const secrets = Object.fromEntries(Object.entries(values).map(([name, text]) => [name,
            text === null ? null : { name, text, type: 'secret_text' }]));
        return this.request<Record<string, { name: string; type: string }>>(`${this.workerPath(target)}/secrets-bulk`, 'PATCH', { secrets });
    }
    widgets(accountId: string) {
        return this.request<SetupWidget[]>(`/accounts/${encodeURIComponent(accountId)}/challenges/widgets?per_page=50`);
    }
    widget(accountId: string, sitekey: string) {
        return this.request<SetupWidget>(`/accounts/${encodeURIComponent(accountId)}/challenges/widgets/${encodeURIComponent(sitekey)}`);
    }
    createWidget(accountId: string, name: string, hostname: string) {
        return this.request<SetupWidget>(`/accounts/${encodeURIComponent(accountId)}/challenges/widgets`, 'POST',
            { name, domains: [hostname], mode: 'managed', clearance_level: 'no_clearance' });
    }
    workerDomains(accountId: string, hostname: string) {
        return this.request<{ hostname: string; service: string; id: string }[]>(`/accounts/${encodeURIComponent(accountId)}/workers/domains?hostname=${encodeURIComponent(hostname)}`);
    }
    attachDomain(target: SetupTarget, zoneId: string, hostname: string) {
        return this.request<{ hostname: string; service: string }>(`/accounts/${encodeURIComponent(target.accountId)}/workers/domains`, 'PUT',
            { hostname, service: target.workerName, zone_id: zoneId, enabled: true });
    }
    sendingDomains(zoneId: string) {
        return this.request<SetupSendingDomain[]>(`/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains`);
    }
    createSendingDomain(zoneId: string, hostname: string) {
        return this.request<SetupSendingDomain>(`/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains`, 'POST', { name: hostname });
    }
    sendingDns(zoneId: string, domainId: string) {
        return this.request<SetupDnsRecord[]>(`/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains/${encodeURIComponent(domainId)}/dns`);
    }
    dns(zoneId: string, name: string, type?: string) {
        const query = new URLSearchParams({ name, per_page: '100' });
        if (type) query.set('type', type);
        return this.request<(SetupDnsRecord & { id: string })[]>(`/zones/${encodeURIComponent(zoneId)}/dns_records?${query}`);
    }
    createDns(zoneId: string, record: SetupDnsRecord) {
        return this.request<SetupDnsRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records`, 'POST', { ...record, ttl: record.ttl ?? 1 });
    }
    private workerPath(target: SetupTarget) {
        return `/accounts/${encodeURIComponent(target.accountId)}/workers/scripts/${encodeURIComponent(target.workerName)}`;
    }
}
