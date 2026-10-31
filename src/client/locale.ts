import { defaultLocale, isLocale, locales, pathToLocale, type Locale } from '../shared/locales';

const preferenceKey = 'loginflare.locale';

export function savePreference(locale: Locale) {
    try {
        localStorage.setItem(preferenceKey, locale);
    } catch {
        // The URL still controls language when browser storage is unavailable.
    }
}

export function resolveLocale(pathname: string, accountLocale?: unknown): Locale {
    const explicit = pathToLocale[pathname.split('/')[1] ?? ''];
    if (explicit) return explicit;
    try {
        const saved = localStorage.getItem(preferenceKey);
        if (isLocale(saved)) return saved;
    } catch {
        // Browser and account preferences remain usable without local storage.
    }
    if (isLocale(accountLocale)) return accountLocale;
    for (const tag of navigator.languages.length ? navigator.languages : [navigator.language]) {
        try {
            const language = new Intl.Locale(tag).language;
            const matched = locales.find((locale) => locale.split('-')[0] === language);
            if (matched) return matched;
        } catch {
            // Ignore invalid language tags and try the next browser preference.
        }
    }
    return defaultLocale;
}
