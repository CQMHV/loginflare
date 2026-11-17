import { createRequire } from 'node:module';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, lstatSync } from 'node:fs';

export function validateLocalState(root, state) {
    const directory = resolve(root, state), allowed = resolve(root, 'work');
    const child = relative(allowed, directory);
    if (!child || child === '..' || child.startsWith('..' + sep) || resolve(allowed, child) !== directory) throw new Error('Local upgrade state must be an isolated child of work/.');
    let current = root;
    for (const part of relative(root, directory).split(sep)) {
        current = resolve(current, part);
        if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Local upgrade state must not traverse symbolic links or junctions.');
    }
    return directory;
}

export async function localUpgrade(root, state) {
    const directory = validateLocalState(root, state);
    const require = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'));
    const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(require.resolve('miniflare')).href);
    const options = convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response("Isolated upgrade database"); } }',
        compatibilityDate: '2026-10-26', d1Databases: { DB: '00000000-0000-4000-8000-000000000002' } });
    options.resourcePersistencePath = resolve(directory, 'v3');
    options.telemetry = { enabled: false };
    const runtime = new Miniflare(options);
    try {
        const db = await runtime.getD1Database('DB');
        return { query: (batch) => db.batch(batch.map(({ sql, params }) => db.prepare(sql).bind(...params))),
            target: { account: 'local', name: 'loginflare-local', database: '00000000-0000-4000-8000-000000000002', avatars: 'local-avatars', privateBucket: 'local-private' },
            dispose: () => runtime.dispose() };
    } catch (error) { await runtime.dispose(); throw error; }
}
