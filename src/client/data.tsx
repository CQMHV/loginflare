import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PropsWithChildren } from 'react';
import { onlineManager, QueryCache, QueryClient, QueryClientProvider, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError, errorCode, fetchJson, request, type Identity } from './api';
import { Button, Progress } from './material';
import i18n from './i18n';
import type { Branding } from '../shared/branding';

export const identityKey = ['identity'] as const;
export const freshness = { identity: 15_000, sessions: 15_000, ordinary: 60_000, configuration: 300_000 };
export type Resource = 'emails' | 'sessions' | 'users' | 'user' | 'applications' | 'application' | 'consent' | 'branding' | 'security' | 'social-connections';
type Group = Resource | 'profile';
type SyncMessage = { type: 'identity' | 'signout' | 'invalidate' | 'branding' | 'social'; owner?: string; groups?: Group[] };
const SyncContext = createContext<(message: SyncMessage) => void>(() => {});
const ScopeContext = createContext({ scope: '', owner: '' });

export function identityScope(identity: Identity | null | undefined): string {
    return identity ? JSON.stringify([identity.user.id, identity.session.id, identity.user.role ?? 'user']) : '';
}

function isAccessError(error: unknown): boolean {
    return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

function mayAutomaticallyRefresh(query: { state: { error: Error | null; errorUpdatedAt: number } }): boolean {
    const { error, errorUpdatedAt } = query.state;
    if (!error) return true;
    return error instanceof ApiError && (error.code === 'NETWORK_ERROR' || error.status >= 500 || error.status === 429)
        && Date.now() - errorUpdatedAt >= Math.max(5000, error.retryAfterMs);
}

function clearPrivate(client: QueryClient, keepScope?: string) {
    const predicate = (query: { queryKey: readonly unknown[] }) => query.queryKey[0] === 'private' && query.queryKey[1] !== keepScope;
    void client.cancelQueries({ predicate });
    client.removeQueries({ predicate });
}

export function endIdentity(client: QueryClient) {
    void client.cancelQueries({ queryKey: identityKey });
    clearPrivate(client);
    client.setQueryData(identityKey, null);
}

export function handlePrivateError(client: QueryClient, scope: string, error: unknown): string {
    if (scope !== identityScope(client.getQueryData<Identity | null>(identityKey))) return errorCode(error);
    if (error instanceof ApiError) {
        if ((error.status === 401 && ['UNAUTHORIZED', 'SESSION_EXPIRED'].includes(error.code)) || ['USER_BANNED', 'BANNED_USER'].includes(error.code)) endIdentity(client);
        else if (error.status === 403) void client.invalidateQueries({ queryKey: identityKey });
    }
    return errorCode(error);
}

export function createDataClient() {
    const client = new QueryClient({
        queryCache: new QueryCache({ onError(error, query) {
            if (query.queryKey[0] === 'private' && typeof query.queryKey[1] === 'string') handlePrivateError(client, query.queryKey[1], error);
            else if (query.queryKey[0] === 'identity' && isAccessError(error)) endIdentity(client);
        } }),
        defaultOptions: {
            queries: {
                staleTime: freshness.ordinary, gcTime: 300_000,
                retry: (failures, error) => failures < 1 && error instanceof ApiError && (error.code === 'NETWORK_ERROR' || error.status >= 500),
                retryDelay: 1000,
                refetchOnMount: mayAutomaticallyRefresh, refetchOnWindowFocus: mayAutomaticallyRefresh, refetchOnReconnect: mayAutomaticallyRefresh,
            },
            mutations: { retry: false },
        },
    });
    // Bound inactive results as well as their lifetime, including cursor pages.
    client.getQueryCache().subscribe(() => {
        const inactive = client.getQueryCache().findAll({ queryKey: ['private'], type: 'inactive' })
            .filter((query) => query.state.fetchStatus !== 'fetching' && query.state.status !== 'pending').sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt);
        for (const query of inactive.slice(0, Math.max(0, inactive.length - 50))) client.getQueryCache().remove(query);
    });
    return client;
}

async function invalidate(client: QueryClient, scope: string, groups: Group[]) {
    await client.invalidateQueries({
        predicate: (query) => (groups.includes('profile') && query.queryKey[0] === 'identity')
            || (query.queryKey[0] === 'private' && query.queryKey[1] === scope && groups.includes(query.queryKey[2] as Resource)),
        refetchType: document.visibilityState === 'visible' ? 'active' : 'none',
    });
}

export function DataProvider({ children }: PropsWithChildren) {
    const [client] = useState(createDataClient);
    const channel = useRef<BroadcastChannel | null>(null);
    const publish = useCallback((message: SyncMessage) => channel.current?.postMessage(message), []);
    useEffect(() => {
        const bus = new BroadcastChannel('loginflare-account-data');
        channel.current = bus;
        bus.onmessage = (event: MessageEvent<SyncMessage>) => {
            const message = event.data;
            if (message?.type === 'signout') endIdentity(client);
            else if (message?.type === 'social') {
                void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'social-providers' || (query.queryKey[0] === 'private' && ['security', 'social-connections'].includes(String(query.queryKey[2]))), refetchType: document.visibilityState === 'visible' ? 'active' : 'none' });
            }
            else if (message?.type === 'branding') {
                void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'branding' || (query.queryKey[0] === 'private' && query.queryKey[2] === 'branding'), refetchType: document.visibilityState === 'visible' ? 'active' : 'none' });
            }
            else if (message?.type === 'identity') {
                clearPrivate(client);
                void client.resetQueries({ queryKey: identityKey, exact: true });
            } else if (message?.type === 'invalidate' && message.owner === client.getQueryData<Identity | null>(identityKey)?.user.id && Array.isArray(message.groups)) {
                void invalidate(client, identityScope(client.getQueryData(identityKey)), message.groups);
            }
        };
        let previous: string | undefined;
        const unsubscribe = client.getQueryCache().subscribe((event) => {
            if (event.type !== 'updated' || event.query.queryKey[0] !== 'identity' || event.action.type !== 'success') return;
            const identity = event.query.state.data as Identity | null;
            const scope = identityScope(identity);
            if (scope !== previous) {
                clearPrivate(client, scope);
                if (previous !== undefined) publish({ type: identity ? 'identity' : 'signout', owner: identity?.user.id });
                previous = scope;
            }
        });
        const restore = (event: PageTransitionEvent) => {
            if (event.persisted) void client.refetchQueries({ queryKey: identityKey, exact: true }).then(() =>
                client.invalidateQueries({ queryKey: ['private'], refetchType: document.visibilityState === 'visible' ? 'active' : 'none' }));
        };
        window.addEventListener('pageshow', restore);
        return () => { unsubscribe(); bus.close(); channel.current = null; window.removeEventListener('pageshow', restore); };
    }, [client, publish]);
    return <QueryClientProvider client={client}><SyncContext.Provider value={publish}>{children}</SyncContext.Provider></QueryClientProvider>;
}

export function useIdentity() {
    const client = useQueryClient();
    const query = useQuery({ queryKey: identityKey, queryFn: ({ signal }) => request<Identity | null>('/get-session', undefined, signal), staleTime: freshness.identity, gcTime: Infinity });
    const refresh = useCallback(async () => { await client.refetchQueries({ queryKey: identityKey, exact: true }, { throwOnError: true }); }, [client]);
    return { ...query, refresh };
}

export function DataScope({ identity, children }: PropsWithChildren<{ identity: Identity | null | undefined }>) {
    const client = useQueryClient();
    const scope = identityScope(identity);
    const owner = identity?.user.id ?? '';
    const value = useMemo(() => ({ scope, owner }), [scope, owner]);
    const previous = useRef(scope);
    useLayoutEffect(() => {
        if (previous.current !== scope) window.dispatchEvent(new Event('loginflare:clear-sensitive'));
        previous.current = scope;
    }, [scope]);
    useEffect(() => {
        if (!identity) return;
        const remaining = Date.parse(identity.session.expiresAt) - Date.now();
        const timer = setTimeout(() => endIdentity(client), Math.max(0, remaining));
        return () => clearTimeout(timer);
    }, [client, identity]);
    return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useResource<T>(resource: Resource, path: string, position = '', enabled = true) {
    const { scope } = useContext(ScopeContext);
    const client = useQueryClient();
    const queryKey = ['private', scope, resource, position];
    const state = client.getQueryState(queryKey);
    const query = useQuery({
        queryKey, enabled: !!scope && enabled,
        queryFn: ({ signal }) => fetchJson<T>(path, undefined, undefined, undefined, signal),
        retryOnMount: !state || mayAutomaticallyRefresh({ state }),
        staleTime: resource === 'sessions' ? freshness.sessions : freshness.ordinary,
        ...(resource === 'consent' ? { staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false } : {}),
    });
    return { ...query, data: isAccessError(query.error) ? undefined : query.data };
}

export function useDataActions() {
    const client = useQueryClient();
    const { scope, owner } = useContext(ScopeContext);
    const publish = useContext(SyncContext);
    return {
        async invalidate(...groups: Group[]) {
            if (scope !== identityScope(client.getQueryData(identityKey))) return;
            publish({ type: 'invalidate', owner, groups });
            await invalidate(client, scope, groups);
        },
        fail: (error: unknown) => handlePrivateError(client, scope, error),
        async socialSaved() {
            publish({ type: 'social' });
            await client.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'social-providers' || (query.queryKey[0] === 'private' && ['security', 'social-connections'].includes(String(query.queryKey[2]))) });
        },
        async brandingSaved(value: Branding) {
            await client.cancelQueries({ predicate: (query) => query.queryKey[0] === 'branding' || (query.queryKey[0] === 'private' && query.queryKey[1] === scope && query.queryKey[2] === 'branding') });
            const newer = (previous: Branding | undefined) => previous && previous.revision > value.revision ? previous : value;
            client.setQueryData<Branding>(['branding'], newer);
            if (scope === identityScope(client.getQueryData(identityKey))) client.setQueryData<Branding>(['private', scope, 'branding', ''], newer);
            publish({ type: 'branding' });
        },
        signOut() { endIdentity(client); publish({ type: 'signout' }); },
    };
}

export function useConfiguration() {
    const client = useQueryClient();
    return useCallback(() => client.fetchQuery({
        queryKey: ['configuration'], staleTime: freshness.configuration,
        queryFn: ({ signal }) => fetchJson<{ turnstileSiteKey: string }>('/api/config', undefined, undefined, undefined, signal),
    }), [client]);
}

export function ResourceFeedback({ query }: { query: Pick<UseQueryResult<unknown>, 'data' | 'error' | 'isFetching' | 'refetch'> }) {
    const { t } = useTranslation();
    return <>
        {query.error && <div className="notice error"><div role="alert">{t(i18n.exists(`errors.${errorCode(query.error)}`) ? `errors.${errorCode(query.error)}` : 'errors.UNKNOWN_ERROR')}{query.data !== undefined && <> {t('cachedDataNotice')}</>}</div><Button className="text-button small" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{t('tryAgain')}</Button></div>}
        {query.data === undefined && !query.error && <div className="loading-state" role="status"><Progress />{t('loading')}</div>}
        {query.data !== undefined && query.isFetching && <span className="sr-only" role="status">{t('updatingData')}</span>}
    </>;
}

export function ConnectionNotice() {
    const { t } = useTranslation();
    const online = useSyncExternalStore((listener) => onlineManager.subscribe(listener), () => onlineManager.isOnline());
    return online ? null : <div className="notice" role="status">{t('offlineDataNotice')}</div>;
}
