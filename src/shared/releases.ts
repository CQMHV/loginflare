export const upstreamRepository = 'CQMHV/loginflare';
export const updateWorkflow = 'prepare-update.yml';

export function stableVersion(value: unknown): value is string {
    return typeof value === 'string' && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value);
}

export function newerVersion(target: string, current: string): boolean {
    if (!stableVersion(target) || !stableVersion(current)) return false;
    const parts = current.split('.').map(Number);
    for (const [index, part] of target.split('.').map(Number).entries()) {
        if (part !== parts[index]) return part > parts[index];
    }
    return false;
}

export function updateRepository(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    return /^[a-z\d][a-z\d-]{0,38}\/(?!\.{1,2}$)[a-z\d_.-]{1,100}$/i.test(value) && value.toLowerCase() !== upstreamRepository.toLowerCase() ? value : null;
}

export type UpdateStatus = {
    currentVersion: string;
    currentCommit: string | null;
    status: 'available' | 'current' | 'unpublished' | 'unavailable';
    availableVersion: string | null;
    releaseUrl: string | null;
    actionUrl: string | null;
};
