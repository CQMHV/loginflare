import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadRelease, sourceCommit } from './release-manifest.mjs';
import { buildMigrationBundle } from './migration-bundle.mjs';
import { checkRelease, packageSource, main as pack } from './pack-release.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('release versions and every official migration checksum agree with the checkout', () => {
    const { manifest, bundle } = loadRelease(process.cwd());
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.ok(manifest.migrations.every(({ name }) => bundle.migrations.some((migration) => migration.name === name)));
    assert.equal(sourceCommit(resolve(process.cwd(), 'scripts')), 'source-archive', 'a nested source archive must not inherit its parent checkout commit');
});

test('a fork may add migrations but cannot silently alter official history or reuse an approval', (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'loginflare-release-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(resolve(root, 'migrations'));
    for (const file of ['release.json', 'package.json', 'migrations/online.json']) writeFileSync(resolve(root, file), readFileSync(file));
    const bundle = buildMigrationBundle();
    const fork = { ...bundle, migrations: [...bundle.migrations, { name: '0028_fork.sql', hash: 'fork' }] };
    assert.doesNotThrow(() => loadRelease(root, fork));
    const changed = { ...bundle, migrations: bundle.migrations.map((migration, index) => index ? migration : { ...migration, hash: 'changed' }) };
    assert.throws(() => loadRelease(root, changed), /Official migration/);
    writeFileSync(resolve(root, 'package.json'), '{"version":"0.0.0"}');
    assert.throws(() => loadRelease(root, fork), /versions must agree/);
    writeFileSync(resolve(root, 'package.json'), readFileSync('package.json'));
    writeFileSync(resolve(root, 'migrations/online.json'), JSON.stringify({ '0028_fork.sql': 'wrong' }));
    assert.throws(() => loadRelease(root, fork), /approval differs/);
});

test('release gate validates upgrade approvals and packages exact version notes without secrets', (t) => {
    assert.doesNotThrow(() => checkRelease(process.cwd()));
    assert.throws(() => pack(['--check', '--tag', 'v9.9.9']), /tag and manifest version differ/);
    const root = mkdtempSync(resolve(tmpdir(), 'loginflare-package-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(resolve(root, 'CHANGELOG.md'), '## Unreleased\n\n## 0.2.0\n\nTarget changes.\n\n## 0.1.0\n\nOld changes.\n');
    writeFileSync(resolve(root, 'package.json'), '{"version":"0.2.0"}\n');
    const output = resolve(root, 'output');
    const artifact = packageSource(root, ['CHANGELOG.md', 'package.json'], output, '0.2.0', '1'.repeat(40));
    const provenance = JSON.parse(readFileSync(resolve(output, 'provenance.json'), 'utf8'));
    assert.equal(provenance.sha256, createHash('sha256').update(readFileSync(artifact)).digest('hex'));
    assert.equal(readFileSync(resolve(output, 'release-notes.md'), 'utf8'), 'Target changes.\n');
    const extracted = resolve(root, 'unpacked'); mkdirSync(extracted);
    assert.equal(spawnSync('tar', ['-xf', artifact, '-C', extracted]).status, 0);
    assert.equal(JSON.parse(readFileSync(resolve(extracted, 'package.json'), 'utf8')).version, '0.2.0');
    for (const file of ['.env', 'examples/.dev.vars', 'work/private', '../outside', '-C']) {
        assert.throws(() => packageSource(root, [file], output, '0.2.0', '1'.repeat(40)), /Unsafe source/);
    }
});
