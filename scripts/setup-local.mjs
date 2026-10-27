import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

try {
    await writeFile(new URL('../.dev.vars', import.meta.url), [
        '# Local development secrets. Never commit this file.',
        `BETTER_AUTH_SECRET=${randomBytes(48).toString('base64url')}`,
        'TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA',
        '',
    ].join('\n'), { flag: 'wx', mode: 0o600 });
    console.log('Created .dev.vars with a random local secret and Turnstile test key.');
} catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log('.dev.vars already exists; left unchanged.');
}
