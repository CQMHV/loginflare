export const colorSchemes = ['tonal-spot', 'fidelity', 'monochrome', 'neutral', 'vibrant', 'expressive', 'content', 'rainbow', 'fruit-salad'] as const;
export type ColorScheme = typeof colorSchemes[number];
export const defaultBranding = { name: 'Loginflare', primaryColor: '#f38020', colorScheme: 'tonal-spot', logoId: null, revision: 0 } as const;
export interface Branding {
    name: string;
    primaryColor: string;
    colorScheme: ColorScheme;
    logoId: string | null;
    logoUrl: string;
    revision: number;
    colors: { light: Record<string, string>; dark: Record<string, string> };
}
