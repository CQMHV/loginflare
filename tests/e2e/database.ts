import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/** Clean up only the UUID-addressed users created by this browser test. */
export function removeLocalFixtures(emails: readonly string[]): void {
    if (!emails.length) return;
    if (emails.some((email) => !/^ui-(?:target-)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@loginflare\.test$/.test(email))) {
        throw new Error('Refusing to remove an account that is not an exact browser-test fixture.');
    }
    const values = emails.map((email) => `'${email}'`).join(', ');
    const sql = `DELETE FROM "verification" WHERE "value" IN (SELECT "id" FROM "user" WHERE "email" IN (${values})); DELETE FROM "user" WHERE "email" IN (${values});`;
    executeLocal(sql);
}

/** Remove only explicitly tracked generated clients with browser-test names. */
export function removeLocalApplications(clientIds: readonly string[]): void {
    if (!clientIds.length) return;
    if (clientIds.some((clientId) => !/^[A-Za-z]{32}$/.test(clientId))) {
        throw new Error('Refusing to remove an application with an unexpected fixture client ID.');
    }
    const values = clientIds.map((clientId) => `'${clientId}'`).join(', ');
    executeLocal(`DELETE FROM "oauthClient" WHERE "clientId" IN (${values}) AND "name" GLOB 'ui-oauth-*';`);
}

function executeLocal(sql: string): void {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve('wrangler/package.json');
    const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
    const executable = resolve(dirname(packagePath), metadata.bin.wrangler);
    execFileSync(process.execPath, [executable, 'd1', 'execute', 'DB', '--local', '--persist-to', resolve('.cloudflare/state'), '--command', sql, '--json'], {
        cwd: process.cwd(),
        timeout: 30_000,
        stdio: 'pipe',
        env: {
            ...process.env,
            XDG_CONFIG_HOME: resolve('.cloudflare/tool-config'),
            WRANGLER_LOG_PATH: resolve('.cloudflare/tool-config/wrangler.log'),
            WRANGLER_REGISTRY_PATH: resolve('.cloudflare/tool-config/registry'),
            MINIFLARE_REGISTRY_PATH: resolve('.cloudflare/tool-config/registry'),
        },
    });
}
