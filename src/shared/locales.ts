export const locales = ['en-US', 'zh-CN'] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en-US';

export const localeToPath: Record<Locale, string> = {
    'en-US': 'en-us',
    'zh-CN': 'zh-cn',
};

export const pathToLocale: Record<string, Locale | undefined> = {
    'en-us': 'en-US',
    'zh-cn': 'zh-CN',
};

export function isLocale(value: unknown): value is Locale {
    return value === 'en-US' || value === 'zh-CN';
}

export function localizedPath(locale: Locale, path = ''): string {
    return `/${localeToPath[locale]}/${path.replace(/^\/+/, '')}`;
}
