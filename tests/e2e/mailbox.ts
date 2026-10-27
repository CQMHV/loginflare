import { expect } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const mailboxRoot = resolve('.wrangler/tmp/email');

export async function snapshotEmails(): Promise<Set<string>> {
    try {
        const files = await readdir(mailboxRoot, { recursive: true });
        return new Set(files.filter((file) => file.includes('email-text') && file.endsWith('.txt')));
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return new Set();
        throw error;
    }
}

/** Read only the local Cloudflare simulator's newly generated mail. Never send mail remotely. */
export async function waitForMail(before: Set<string>, kind: 'verify' | 'reset'): Promise<string> {
    let link = '';
    await expect.poll(async () => {
        for (const file of await snapshotEmails()) {
            if (before.has(file)) continue;
            const text = await readFile(join(mailboxRoot, file), 'utf8');
            const candidate = text.match(/https?:\/\/\S+/)?.[0];
            if (!candidate) continue;
            const url = new URL(candidate);
            if (url.origin !== 'http://localhost:5173') throw new Error('Local test email must point to the local server.');
            if (url.pathname.startsWith(kind === 'verify' ? '/api/auth/verify-email' : '/api/auth/reset-password/')) {
                link = candidate;
                return true;
            }
        }
        return false;
    }, { timeout: 10_000, message: 'Expected a new verification/reset email in the local simulator' }).toBe(true);
    return link;
}
