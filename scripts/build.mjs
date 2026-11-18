import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const deploy = process.argv.includes('--deployment') || process.env.WORKERS_CI === '1';
const vite = new URL('bin/vite.js', import.meta.resolve('vite/package.json'));
const steps = [[new URL('scripts/licenses.mjs', root)], [vite, 'build', ...(deploy ? ['--mode', 'deployment'] : [])]];
for (const [script, ...args] of steps) {
    const result = spawnSync(process.execPath, [fileURLToPath(script), ...args], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
