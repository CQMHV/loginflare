import type { Env } from './config';
import { publicAssetsBase } from '../shared/public-assets';

export function publicMediaBase(env: Pick<Env, 'PUBLIC_ASSETS_URL' | 'APP_ENV' | 'AUTH_URL'>): string | null {
    return publicAssetsBase(env.PUBLIC_ASSETS_URL, env.APP_ENV === 'development', env.AUTH_URL);
}

export function mediaUrl(env: Pick<Env, 'PUBLIC_ASSETS_URL' | 'APP_ENV' | 'AUTH_URL'>, key: string, workerPath: string): string {
    const base = publicMediaBase(env);
    return base ? `${base}/${key}` : workerPath;
}

/** Old bookmarks may still use the issuer; new API responses use R2 directly. */
export function mediaRedirect(env: Env, key: string): Response | null {
    const base = publicMediaBase(env);
    return base ? new Response(null, { status: 302, headers: {
        Location: `${base}/${key}`,
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
    } }) : null;
}

export function mediaImageSources(env: Pick<Env, 'PUBLIC_ASSETS_URL' | 'APP_ENV' | 'AUTH_URL'>): string[] {
    const base = publicMediaBase(env);
    return base ? [new URL(base).origin] : [];
}
