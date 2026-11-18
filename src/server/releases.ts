import manifest from '../../release.json';
import { newerVersion, stableVersion, updateRepository, updateWorkflow, upstreamRepository, type UpdateStatus } from '../shared/releases';
import type { Env } from './config';

const releasesPage = `https://github.com/${upstreamRepository}/releases`;
const latestReleaseUrl = `${releasesPage}/latest`;
const releaseTagPrefix = `${releasesPage}/tag/v`;
type Latest = { status: 'unpublished' | 'unavailable' } | { status: 'published'; version: string };

export function releaseFeed(request: typeof fetch = (...args) => fetch(...args), now = Date.now) {
    let cached: { latest: Latest; expiresAt: number } | undefined;
    return async (): Promise<Latest> => {
        if (cached && now() < cached.expiresAt) return cached.latest;
        let latest: Latest = { status: 'unavailable' };
        try {
            const response = await request(latestReleaseUrl, {
                method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(3000),
            });
            const redirect = response.headers.get('Location');
            if (response.status === 302 && redirect) {
                const destination = new URL(redirect, latestReleaseUrl).href;
                const version = destination.startsWith(releaseTagPrefix) ? destination.slice(releaseTagPrefix.length) : null;
                if (destination === releasesPage) latest = { status: 'unpublished' };
                else if (stableVersion(version)) latest = { status: 'published', version };
            }
        } catch { /* A release check must not make the console unavailable. */ }
        cached = { latest, expiresAt: now() + (latest.status === 'unavailable' ? 60_000 : 3_600_000) };
        return latest;
    };
}

const latestRelease = releaseFeed();

export async function readUpdateStatus(env: Env, check = latestRelease): Promise<UpdateStatus> {
    const currentVersion = stableVersion(env.LOGINFLARE_RELEASE_VERSION) ? env.LOGINFLARE_RELEASE_VERSION : manifest.version;
    const currentCommit = /^[a-f0-9]{40}$/.test(env.LOGINFLARE_SOURCE_COMMIT ?? '') ? env.LOGINFLARE_SOURCE_COMMIT! : null;
    const repository = updateRepository(env.LOGINFLARE_UPDATE_REPOSITORY);
    const latest: Latest = env.APP_ENV === 'development' ? { status: 'unpublished' } : await check();
    const available = latest.status === 'published' && newerVersion(latest.version, currentVersion);
    const availableVersion = available && latest.status === 'published' ? latest.version : null;
    return {
        currentVersion, currentCommit, availableVersion,
        status: available ? 'available' : latest.status === 'published' ? 'current' : latest.status,
        releaseUrl: availableVersion ? `${releasesPage}/tag/v${availableVersion}` : releasesPage,
        actionUrl: available && repository ? `https://github.com/${repository}/actions/workflows/${updateWorkflow}` : null,
    };
}
