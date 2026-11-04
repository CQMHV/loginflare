import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const target = fileURLToPath(new URL('worker-configuration.d.ts', import.meta.url));
const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
    'types', target, '--config', 'examples/worker-api/wrangler.jsonc',
    '--env-interface', 'WorkerApiBindings', '--include-runtime', 'false', '--strict-vars', 'false',
], { cwd: root, stdio: 'inherit', env: process.env });
if (result.status !== 0) process.exit(result.status ?? 1);
// Keep this independent example's generated namespace separate from the main
// Worker's global binding declarations when its tests run in the root project.
const source = readFileSync(target, 'utf8').replace(/^interface WorkerApiBindings/m, 'export interface WorkerApiBindings');
writeFileSync(target, `${source}\nexport {};\n`);
