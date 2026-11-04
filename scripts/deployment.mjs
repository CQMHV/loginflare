import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const managedConfiguration = ['AUTH_URL', 'EMAIL_FROM', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'BETTER_AUTH_SECRET', 'LOGINFLARE_CONFIG_REVISION'];

export function validateDeploymentConfiguration(configuration) {
    if (!['production', 'staging'].includes(configuration.vars?.APP_ENV)) throw new Error('Deployment requires an explicitly built production or staging Worker. Run pnpm build:deploy.');
    for (const [name, environment] of [['default', configuration], ...Object.entries(configuration.env ?? {})]) {
        for (const key of managedConfiguration) {
            if (Object.hasOwn(environment.vars ?? {}, key)) throw new Error(`${name}: ${key} belongs to the installation wizard and must not be declared in vars, including as an empty string.`);
        }
        if (environment.secrets?.required?.includes('CF_SETUP_TOKEN')) throw new Error('CF_SETUP_TOKEN is only needed for first installation and must not be a required deployment secret.');
    }
    if (!configuration.d1_databases?.some((binding) => binding.binding === 'DB')) throw new Error('Missing DB binding.');
    if (!configuration.r2_buckets?.some((binding) => binding.binding === 'AVATARS')) throw new Error('Missing AVATARS binding.');
    if (!configuration.send_email?.some((binding) => binding.name === 'EMAIL')) throw new Error('Missing EMAIL binding.');
    return configuration;
}

export function deploy(input = process.argv.slice(2)) {
    input = input.filter((argument) => argument !== '--');
    if (input.some((argument) => argument !== '--dry-run')) throw new Error('Deployment accepts only --dry-run. Build the selected environment first; configuration, variable and secret-file overrides are not allowed.');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const pointer = resolve(root, '.wrangler/deploy/config.json');
    let build;
    try {
        const target = JSON.parse(readFileSync(pointer, 'utf8'));
        build = resolve(dirname(pointer), target.configPath);
    } catch {
        throw new Error('No built Worker configuration was found. Run pnpm build:deploy first.');
    }
    validateDeploymentConfiguration(JSON.parse(readFileSync(build, 'utf8')));
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve('wrangler/package.json');
    const wrangler = JSON.parse(readFileSync(packagePath, 'utf8'));
    const result = spawnSync(process.execPath, [resolve(dirname(packagePath), wrangler.bin.wrangler), 'deploy', ...input], {
        cwd: root, env: process.env, stdio: 'inherit', shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Worker deployment exited with ${result.status ?? 'unknown'}. Inspect the actual deployment before retrying.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { deploy(); }
    catch (error) { console.error(error instanceof Error ? error.message : 'Deployment failed.'); process.exitCode = 1; }
}
