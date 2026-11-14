import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { realpath } from 'node:fs/promises';

async function checksum(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

/** Verify before copying a stopped instance into an isolated restore directory. */
export async function verifyLocalSnapshot(destination) {
    const root = await realpath(destination);
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    if (manifest.format !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Unsupported or empty snapshot.');
    for (const file of manifest.files) {
        if (typeof file !== 'string' || isAbsolute(file) || file.includes('\\') || file.split('/').some((part) => part === '..' || !part)) throw new Error('Invalid snapshot path.');
        const target = await realpath(join(root, file));
        const position = relative(root, target);
        if (isAbsolute(position) || position.startsWith('..')) throw new Error('Snapshot path escapes its directory.');
        if (await checksum(target) !== manifest.sha256?.[file]) throw new Error(`Snapshot checksum mismatch: ${file}`);
        if (file.endsWith('.sqlite')) {
            const database = new DatabaseSync(target, { readOnly: true });
            try {
                if (database.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
                    || database.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`Snapshot database integrity failed: ${file}`);
            } finally { database.close(); }
        }
    }
    return { files: manifest.files.length, integrity: 'ok' };
}

export async function snapshotLocal(root, output, stateRoot, allowEmpty = false) {
    const settings = JSON.parse(await readFile(join(root, 'wrangler.local.jsonc'), 'utf8'));
    const binding = settings.d1_databases?.find((value) => value.binding === 'DB');
    if (settings.vars?.APP_ENV !== 'development' || binding?.remote !== false || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(settings.vars.AUTH_URL).hostname)) throw new Error('Local snapshots require explicit development bindings.');
    if (settings.r2_buckets?.some((bucket) => bucket.remote !== false)) throw new Error('Local snapshots require explicit local R2 bindings.');
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
    // Pause avatar writes before taking a combined snapshot. R2 includes SQLite
    // metadata and blob files; copying live WAL files is not a database backup.
    const objects = join(stateRoot ?? join(root, '.cloudflare/state'), 'v3/r2');
    try {
        for (const file of await readdir(objects, { recursive: true })) {
            const sourceFile = join(objects, file);
            if (!(await stat(sourceFile)).isFile() || /-(wal|shm)$/.test(file)) continue;
            const target = join(destination, 'r2', file);
            await mkdir(dirname(target), { recursive: true });
            if (file.endsWith('.sqlite')) {
                const source = new DatabaseSync(sourceFile, { readOnly: true });
                try { await backup(source, target); } finally { source.close(); }
                const check = new DatabaseSync(target, { readOnly: true });
                try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('R2 snapshot integrity failed.'); }
                finally { check.close(); }
            } else await copyFile(sourceFile, target);
            files.push(`r2/${file.replaceAll('\\', '/')}`);
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
    if (!files.some((file) => file.startsWith('d1/'))) {
        if (allowEmpty) return { destination, files: 0, integrity: 'empty' };
        throw new Error('No local database to snapshot.');
    }
    const sha256 = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await checksum(join(destination, file))])));
    await writeFile(join(destination, 'manifest.json'), JSON.stringify({ format: 1, createdAt: new Date().toISOString(), databaseId: binding.database_id, files, sha256 }, null, 2));
    await verifyLocalSnapshot(destination);
    return { destination, files: files.length, integrity: 'ok' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    console.log(JSON.stringify(await snapshotLocal(root, process.argv[2])));
}
