import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

export async function snapshotLocal(root, output, stateRoot) {
    const settings = JSON.parse(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
    const binding = settings.d1_databases?.find((value) => value.binding === 'DB');
    if (settings.vars?.APP_ENV !== 'development' || binding?.remote !== false || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(settings.vars.AUTH_URL).hostname)) throw new Error('Local snapshots require explicit development bindings.');
    const destination = resolve(output ?? join(root, 'work/backups', new Date().toISOString().replaceAll(':', '-')));
    await mkdir(destination, { recursive: true });
    const state = join(stateRoot ?? join(root, '.cloudflare/state'), 'v3/d1');
    const files = [];
    try {
        for (const file of await readdir(state, { recursive: true })) {
            if (!file.endsWith('.sqlite')) continue;
            const target = join(destination, 'd1', file);
            await mkdir(dirname(target), { recursive: true });
            const source = new DatabaseSync(join(state, file), { readOnly: true });
            try { await backup(source, target); } finally { source.close(); }
            const check = new DatabaseSync(target, { readOnly: true });
            try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Snapshot integrity failed.'); }
            finally { check.close(); }
            files.push(`d1/${file.replaceAll('\\', '/')}`);
        }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const file of ['.dev.vars', 'work/local-preview-accounts.json', 'work/local-expanded-preview-accounts.json']) {
        try {
            await mkdir(dirname(join(destination, file)), { recursive: true });
            await copyFile(join(root, file), join(destination, file));
            files.push(file);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await writeFile(join(destination, '.gitignore'), '*\n');
    await writeFile(join(destination, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), databaseId: binding.database_id, files }, null, 2));
    return { destination, files: files.length, integrity: 'ok' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    console.log(JSON.stringify(await snapshotLocal(root, process.argv[2])));
}
