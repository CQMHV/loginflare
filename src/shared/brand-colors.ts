import { argbFromHex, hexFromArgb, Hct, SchemeContent, SchemeExpressive, SchemeFidelity, SchemeFruitSalad, SchemeMonochrome, SchemeNeutral, SchemeRainbow, SchemeTonalSpot, SchemeVibrant } from '@material/material-color-utilities';
import type { Branding, ColorScheme } from './branding.ts';

const roles = ['primary', 'surfaceTint', 'onPrimary', 'primaryContainer', 'onPrimaryContainer', 'inversePrimary', 'primaryFixed', 'primaryFixedDim', 'onPrimaryFixed', 'onPrimaryFixedVariant', 'secondary', 'onSecondary', 'secondaryContainer', 'onSecondaryContainer', 'secondaryFixed', 'secondaryFixedDim', 'onSecondaryFixed', 'onSecondaryFixedVariant', 'tertiary', 'onTertiary', 'tertiaryContainer', 'onTertiaryContainer', 'tertiaryFixed', 'tertiaryFixedDim', 'onTertiaryFixed', 'onTertiaryFixedVariant', 'error', 'onError', 'errorContainer', 'onErrorContainer', 'background', 'onBackground', 'surface', 'onSurface', 'surfaceVariant', 'onSurfaceVariant', 'surfaceDim', 'surfaceBright', 'surfaceContainerLowest', 'surfaceContainerLow', 'surfaceContainer', 'surfaceContainerHigh', 'surfaceContainerHighest', 'outline', 'outlineVariant', 'inverseSurface', 'inverseOnSurface', 'shadow', 'scrim'] as const;
const schemes = {
    'tonal-spot': SchemeTonalSpot, fidelity: SchemeFidelity, monochrome: SchemeMonochrome,
    neutral: SchemeNeutral, vibrant: SchemeVibrant, expressive: SchemeExpressive,
    content: SchemeContent, rainbow: SchemeRainbow, 'fruit-salad': SchemeFruitSalad,
} satisfies Record<ColorScheme, typeof SchemeTonalSpot>;

export function brandColors(seed: string, variant: ColorScheme): Branding['colors'] {
    const source = Hct.fromInt(argbFromHex(seed));
    const scheme = (dark: boolean) => {
        const colors = new schemes[variant](source, dark, 0);
        return Object.fromEntries(roles.map((role) => [role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), hexFromArgb(colors[role])]));
    };
    return { light: scheme(false), dark: scheme(true) };
}
