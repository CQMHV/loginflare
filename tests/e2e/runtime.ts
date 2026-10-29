import { resolve, sep } from 'node:path';

export const testOrigin = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5174';
const origin = new URL(testOrigin);
if (origin.origin !== testOrigin || origin.hostname !== 'localhost' || origin.protocol !== 'http:' || !origin.port || origin.port === '5173') throw new Error('Browser tests require an isolated local origin.');
export const testState = resolve(process.env.LOGINFLARE_LOCAL_STATE || '');
export const testMailbox = resolve(process.env.LOGINFLARE_MAILBOX || '');
if (![testState, testMailbox].every((value) => value.startsWith(resolve('work/e2e') + sep))) throw new Error('Browser tests require isolated state and mail.');
