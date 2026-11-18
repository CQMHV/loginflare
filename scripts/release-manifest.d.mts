export function loadRelease(root: string): {
    manifest: { version: string };
    online: Record<string, string>;
    bundle: { hash: string; migrations: { name: string; hash: string; statements: string[] }[] };
};
export function sourceCommit(root: string): string;
export function sourceRepository(root: string): string | null;
