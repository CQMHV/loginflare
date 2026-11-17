export { publicAssetsBase } from '../src/shared/public-assets.ts';
type Statement = { sql: string; params: (string | number)[] };
export function migrateAvatarUrls(query: (batch: Statement[]) => Promise<{ results: { id: string }[] }[]>, base: string, options?: { deadline?: number }): Promise<number>;
export function verifyMediaHeaders(base: string, fetcher?: typeof fetch): Promise<void>;
