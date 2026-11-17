import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRelease, sourceCommit } from './release-manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function git(args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(`Git ${args[0]} could not be verified.`);
    return result.stdout.trim();
}

export function checkRelease(directory = root) {
    const { manifest, bundle, online } = loadRelease(directory);
    const notes = readFileSync(resolve(directory, 'CHANGELOG.md'), 'utf8');
    if (!notes.includes(`## ${manifest.version}\n`) && !notes.includes(`## ${manifest.version}\r\n`)) throw new Error('The target version needs release notes.');
    for (const doc of ['docs/upgrading.md', 'docs/upgrading.zh-CN.md']) {
        if (!readFileSync(resolve(directory, doc), 'utf8').includes(manifest.version)) throw new Error(`${doc} must document the target version.`);
    }
    for (const baseline of manifest.upgradeFrom) {
        const index = bundle.migrations.findIndex(({ name }) => name === baseline.through);
        if (!/^[0-9a-f]{40}$/.test(baseline.commit) || index < 0) throw new Error('Upgrade baselines need an immutable source commit and migration boundary.');
        for (const migration of bundle.migrations.slice(index + 1)) {
            if (online[migration.name] !== migration.hash) throw new Error(`${migration.name} requires reviewed online compatibility evidence before this release.`);
        }
    }
    return manifest;
}

export function packageSource(directory, files, output, version, commit) {
    for (const file of files) {
        if (!file || file.startsWith('/') || file.startsWith('-') || file.includes('\\') || file.split('/').some((part) => part === '..')
            || /^(?:work|node_modules|dist|\.git|\.wrangler|\.cloudflare)\//.test(file) || /(?:^|\/)(?:\.env|\.dev\.vars)(?:$|\.(?!.*example$))/.test(file)
            || file === 'wrangler.private.jsonc' || /[\r\n]/.test(file) || lstatSync(resolve(directory, file)).isSymbolicLink()) throw new Error(`Unsafe source archive entry: ${file}.`);
    }
    mkdirSync(output, { recursive: true });
    const list = resolve(output, 'files.txt');
    writeFileSync(list, files.join('\n') + '\n');
    const name = `loginflare-${version}.tar.gz`, artifact = resolve(output, name);
    const packed = spawnSync('tar', ['-czf', artifact, '-T', list], { cwd: directory, encoding: 'utf8', timeout: 60_000 });
    if (packed.status !== 0) throw new Error(`Source packaging failed: ${packed.stderr}`);
    const digest = createHash('sha256').update(readFileSync(artifact)).digest('hex');
    writeFileSync(resolve(output, 'SHA256SUMS'), `${digest}  ${name}\n`);
    writeFileSync(resolve(output, 'provenance.json'), JSON.stringify({ format: 1, version, commit, artifact: name, sha256: digest }, null, 4) + '\n');
    const changelog = readFileSync(resolve(directory, 'CHANGELOG.md'), 'utf8').replaceAll('\r\n', '\n');
    const notes = changelog.split(`## ${version}\n`)[1]?.split('\n## ')[0]?.trim();
    if (!notes) throw new Error('The target version needs nonempty release notes.');
    writeFileSync(resolve(output, 'release-notes.md'), notes + '\n');
    return artifact;
}

export function main(input) {
    const args = input.filter((value) => value !== '--');
    const check = args.includes('--check');
    if (check) args.splice(args.indexOf('--check'), 1);
    let tag;
    if (args.length) {
        if (args.length !== 2 || args[0] !== '--tag') throw new Error('Usage: release:pack [--check] [--tag vVERSION]');
        tag = args[1];
    }
    const manifest = checkRelease();
    if (tag && tag !== `v${manifest.version}`) throw new Error('Release tag and manifest version differ.');
    if (tag) {
        const { bundle } = loadRelease(root);
        const declared = new Set(manifest.migrations.map(({ name }) => name));
        if (bundle.migrations.some(({ name }) => !declared.has(name))) throw new Error('A tagged source release must declare every migration in release.json.');
    }
    if (check && !tag) { console.log(`Validated Loginflare ${manifest.version}.`); return; }
    const commit = sourceCommit(root);
    if (commit === 'source-archive') throw new Error('Source packaging and tag verification require a Git checkout of this source directory.');
    if (tag && (git(['rev-parse', `refs/tags/${tag}^{commit}`]) !== commit || git(['branch', '--show-current']) !== 'main')) throw new Error('Dispatch from main at the exact version tag commit.');
    if (check) { console.log(`Validated Loginflare ${manifest.version}.`); return; }
    if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Release packaging requires a clean tracked checkout.');
    const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
    const output = resolve(root, 'work/releases', manifest.version);
    const artifact = packageSource(root, files, output, manifest.version, commit);
    console.log(`Packaged ${artifact}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { main(process.argv.slice(2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
