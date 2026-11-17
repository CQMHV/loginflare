import type { Branding } from '../shared/branding';
import { brandColors } from '../shared/brand-colors';
import type { Env } from './config';
import { mediaUrl } from './public-assets';

export type BrandingRow = Pick<Branding, 'name' | 'primaryColor' | 'colorScheme' | 'logoId' | 'revision'>;
export async function readBranding(db: D1Database): Promise<BrandingRow> {
    const row = await db.prepare('SELECT "name", "primaryColor", "colorScheme", "logoId", "revision" FROM "siteBranding" WHERE "id" = 1').first<BrandingRow>();
    if (!row) throw new Error('Branding settings are missing. Apply database migrations.');
    return row;
}
export function publicBranding(row: BrandingRow, env: Env): Branding {
    return { ...row, logoUrl: row.logoId ? mediaUrl(env, `branding/${row.logoId}`, `/branding/logos/${row.logoId}`) : '/assets/logo.svg', colors: brandColors(row.primaryColor, row.colorScheme) };
}
