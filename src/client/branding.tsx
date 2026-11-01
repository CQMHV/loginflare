import { useEffect, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from './api';
import { freshness } from './data';
import type { Branding } from '../shared/branding';

declare global {
    interface Window { loginflareBranding: { getSnapshot: () => Branding; apply: (value: Branding) => void } }
}
function subscribe(listener: () => void) {
    window.addEventListener('loginflare:branding-change', listener);
    return () => window.removeEventListener('loginflare:branding-change', listener);
}
export function useBranding() {
    return useSyncExternalStore(subscribe, window.loginflareBranding.getSnapshot);
}
export function BrandingUpdates() {
    const query = useQuery({ queryKey: ['branding'], queryFn: ({ signal }) => fetchJson<Branding>('/api/branding', undefined, undefined, undefined, signal), initialData: window.loginflareBranding.getSnapshot, staleTime: freshness.configuration, gcTime: Infinity });
    useEffect(() => { if (query.data) window.loginflareBranding.apply(query.data); }, [query.data]);
    return null;
}
