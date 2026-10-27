import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';
export type ThemePreference = Theme | 'system';

declare global {
    interface Window {
        loginflareTheme: {
            getSnapshot: () => Readonly<{ preference: ThemePreference; theme: Theme }>;
            setPreference: (preference: ThemePreference) => void;
        };
    }
}

function subscribe(listener: () => void) {
    window.addEventListener('loginflare:theme-change', listener);
    return () => window.removeEventListener('loginflare:theme-change', listener);
}

export function useTheme() {
    return useSyncExternalStore(subscribe, window.loginflareTheme.getSnapshot);
}

export function setThemePreference(preference: ThemePreference) {
    window.loginflareTheme.setPreference(preference);
}
