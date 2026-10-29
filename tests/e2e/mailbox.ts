import { expect } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testMailbox, testOrigin } from './runtime';

const mailboxRoot = testMailbox;

export async function snapshotEmails(): Promise<Set<string>> {
    try {
        const files = await readdir(mailboxRoot, { recursive: true });
        return new Set(files.filter((file) => file.includes('email-text') && file.endsWith('.txt')));
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return new Set();
        throw error;
    }
}

/** Read only new messages captured by the isolated local browser-test harness. */
export async function waitForMail(before: Set<string>, kind: 'verify'): Promise<string> {
    let link = '';
    await expect.poll(async () => {
        for (const file of await snapshotEmails()) {
            if (before.has(file)) continue;
            const text = await readFile(join(mailboxRoot, file), 'utf8');
            const candidate = text.match(/https?:\/\/\S+/)?.[0];
            if (!candidate) continue;
            const url = new URL(candidate);
            if (url.origin !== testOrigin) throw new Error('Local test email must point to the local server.');
            if (kind === 'verify' && url.pathname.startsWith('/api/auth/verify-email')) {
                link = candidate;
                return true;
            }
        }
        return false;
    }, { timeout: 10_000, message: 'Expected a new verification email in the local simulator' }).toBe(true);
    return link;
}

export async function waitForCode(before: Set<string>): Promise<string> {
    let code = '';
    await expect.poll(async () => {
        for (const file of await snapshotEmails()) {
            if (before.has(file)) continue;
            const text = await readFile(join(mailboxRoot, file), 'utf8');
            const match = text.match(/\b\d{6}\b/);
            if (match) {
                code = match[0];
                return true;
            }
        }
        return false;
    }, { timeout: 10_000, message: 'Expected a new code email in the local simulator' }).toBe(true);
    return code;
}
