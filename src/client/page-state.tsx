import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type PropsWithChildren } from 'react';
import { flushSync } from 'react-dom';
import { useLocation } from 'react-router-dom';

function createPageStore() {
    const drafts = new Map<string, unknown>();
    const positions = new Map<string, { x: number; y: number }>();
    const listeners = new Set<() => void>();
    return {
        positions,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        read<T>(key: string) { return drafts.get(key) as T | undefined; },
        write<T>(key: string, value: T | undefined) {
            drafts.delete(key);
            if (value !== undefined) drafts.set(key, value);
            while (drafts.size > 30) drafts.delete(drafts.keys().next().value!);
            for (const listener of listeners) listener();
        },
    };
}
const PageContext = createContext<ReturnType<typeof createPageStore> | null>(null);

export function PageStateProvider({ children }: PropsWithChildren) {
    const store = useMemo(createPageStore, []);
    return <PageContext.Provider value={store}>{children}<ScrollRestoration /></PageContext.Provider>;
}

export function usePageDraft<T>(key: string) {
    const store = useContext(PageContext);
    if (!store) throw new Error('Page state provider is required');
    const value = useSyncExternalStore(store.subscribe, () => store.read<T>(key));
    return [value, (next: T | undefined) => store.write(key, next), (expected: T | undefined) => {
        if (store.read<T>(key) === expected) store.write(key, undefined);
    }] as const;
}

export function useClearSecrets(reset: () => void, boundary?: string) {
    const latest = useRef(reset);
    const generation = useRef(0);
    latest.current = reset;
    useEffect(() => {
        const clear = () => { generation.current++; latest.current(); };
        const hide = () => flushSync(clear);
        window.addEventListener('pagehide', hide);
        window.addEventListener('loginflare:clear-sensitive', clear);
        return () => { generation.current++; window.removeEventListener('pagehide', hide); window.removeEventListener('loginflare:clear-sensitive', clear); };
    }, [boundary]);
    return useCallback(() => {
        const started = generation.current;
        return () => started === generation.current;
    }, []);
}

function ScrollRestoration() {
    const store = useContext(PageContext)!;
    const { pathname, search } = useLocation();
    const parameters = new URLSearchParams(search);
    const key = pathname.split('/').slice(2).join('/') + '?' + new URLSearchParams(
        [...parameters].filter(([name]) => ['cursor', 'lookupField', 'lookupValue', 'id', 'clientId'].includes(name)).sort(([a], [b]) => a.localeCompare(b))
    );
    useLayoutEffect(() => {
        if (!/^(account|admin)(?:\/|\?)/.test(key)) return;
        const position = store.positions.get(key) ?? { x: 0, y: 0 };
        const previous = history.scrollRestoration;
        history.scrollRestoration = 'manual';
        let restoring = true;
        const restore = () => {
            if (!restoring) return;
            window.scrollTo(position.x, position.y);
            if (document.documentElement.scrollHeight >= position.y + window.innerHeight) restoring = false;
        };
        const observer = new ResizeObserver(restore);
        observer.observe(document.body);
        restore();
        const record = () => {
            if (restoring) return;
            store.positions.delete(key);
            store.positions.set(key, { x: window.scrollX, y: window.scrollY });
            while (store.positions.size > 50) store.positions.delete(store.positions.keys().next().value!);
        };
        const stop = () => { restoring = false; };
        window.addEventListener('scroll', record, { passive: true });
        window.addEventListener('click', record, true);
        window.addEventListener('wheel', stop, { passive: true });
        window.addEventListener('touchstart', stop, { passive: true });
        window.addEventListener('keydown', stop);
        return () => {
            observer.disconnect();
            history.scrollRestoration = previous;
            window.removeEventListener('wheel', stop); window.removeEventListener('touchstart', stop); window.removeEventListener('keydown', stop);
            window.removeEventListener('scroll', record); window.removeEventListener('click', record, true);
        };
    }, [store, key]);
    return null;
}
