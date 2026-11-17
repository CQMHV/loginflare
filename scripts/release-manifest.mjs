import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildMigrationBundle } from './migration-bundle.mjs';
import { spawnSync } from 'node:child_process';

export function sourceCommit(root) {
    const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const top = git(['rev-parse', '--show-toplevel']);
    if (top.status !== 0) return 'source-archive';
    // An archive unpacked inside another checkout must not inherit its commit.
    if (realpathSync(top.stdout.trim()) !== realpathSync(root)) return 'source-archive';
    const result = git(['rev-parse', 'HEAD']);
    return result.status === 0 && /^[0-9a-f]{40}$/.test(result.stdout.trim()) ? result.stdout.trim() : 'source-archive';
}

export function loadRelease(root, bundle = buildMigrationBundle(root)) {
    const manifest = JSON.parse(readFileSync(resolve(root, 'release.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const online = JSON.parse(readFileSync(resolve(root, 'migrations/online.json'), 'utf8'));
    if (manifest.format !== 1 || !/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.version !== pkg.version) throw new Error('Release and package versions must agree.');
    if (!manifest.upgradeFrom?.length || !manifest.migrations?.length) throw new Error('Release upgrade sources and migration checksums are required.');
    const files = new Map(bundle.migrations.map((migration) => [migration.name, migration]));
    const names = new Set();
    let previous = '';
    for (const { name, digest } of manifest.migrations) {
        if (names.has(name) || name <= previous || !/^[0-9a-f]{64}$/.test(digest) || files.get(name)?.hash !== digest) throw new Error(`Official migration checksum or order differs: ${name}.`);
        names.add(name); previous = name;
    }
    for (const [name, digest] of Object.entries(online)) {
        if (files.get(name)?.hash !== digest) throw new Error(`Online migration approval differs: ${name}.`);
    }
    return { manifest, online, bundle };
}
