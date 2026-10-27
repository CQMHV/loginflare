import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const visited = new Set();
const notices = [];
// Reviewed supplements apply only to these exact published package versions.
// An upgrade with omitted license text must be reviewed before distribution.
const licenseSupplements = new Map([
    ['@lit-labs/ssr-dom-shim@1.6.0', {
        directory: 'third-party/ssr-dom-shim-1.6.0',
        license: 'BSD-3-Clause',
        sourceFile: 'index.js',
        sourceSha256: '339ea611ea0872ab4237c2cf9d7360d4aa80eea8f6f4f5f1f2084f4a29d91791',
    }],
]);

async function findPackage(name, from) {
    for (const directory of createRequire(from).resolve.paths(name) ?? []) {
        try {
            return await realpath(join(directory, name, 'package.json'));
        } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        }
    }
    return undefined;
}

async function collect(packagePath) {
    const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
    const identity = `${metadata.name}@${metadata.version}`;
    if (visited.has(identity)) return;
    visited.add(identity);
    const directory = dirname(packagePath);
    const names = (await readdir(directory)).filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name)).sort();
    const texts = await Promise.all(names.map(async (name) => `${name}\n${await readFile(join(directory, name), 'utf8')}`));
    if (!names.length) {
        const supplement = licenseSupplements.get(identity);
        if (!supplement || metadata.license !== supplement.license) {
            throw new Error(`Missing license text for ${identity}; review before distributing.`);
        }
        const sourceHash = createHash('sha256').update(await readFile(join(directory, supplement.sourceFile))).digest('hex');
        if (sourceHash !== supplement.sourceSha256) throw new Error(`Published artifact changed for ${identity}; review its license supplement.`);
        for (const name of ['NOTICE', 'LICENSE']) {
            texts.push(`${name}\n${await readFile(join(root, supplement.directory, name), 'utf8')}`);
        }
    }
    notices.push(`${identity}\nLicense: ${metadata.license ?? 'See the following license text'}\n${texts.join('\n\n')}`);
    for (const [name] of Object.entries({ ...metadata.dependencies, ...metadata.optionalDependencies })) {
        const dependency = await findPackage(name, packagePath);
        if (dependency) await collect(dependency);
        else if (metadata.dependencies?.[name] && !metadata.optionalDependencies?.[name]) throw new Error(`Missing dependency ${name} of ${identity}`);
    }
}

const manifest = join(root, 'package.json');
const metadata = JSON.parse(await readFile(manifest, 'utf8'));
for (const name of Object.keys(metadata.dependencies)) {
    const packagePath = await findPackage(name, manifest);
    if (!packagePath) throw new Error(`Install dependencies before generating notices: ${name}`);
    await collect(packagePath);
}
await mkdir(join(root, 'public/assets'), { recursive: true });
await writeFile(join(root, 'public/assets/third-party-notices.txt'), [
    'Loginflare — Third-party notices',
    'These dependencies retain their own licenses. Loginflare’s MIT OR Apache-2.0 choice does not replace them.',
    ...notices.sort().map((notice) => `${'='.repeat(72)}\n${notice}`),
    '',
].join('\n\n').trimEnd() + '\n');
console.log(`Generated third-party notices for ${visited.size} runtime packages.`);
