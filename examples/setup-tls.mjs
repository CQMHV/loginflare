import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve('work/example-tls');
const keyPath = resolve(directory, 'key.pem');
const certPath = resolve(directory, 'cert.pem');

function opensslBinary() {
    const candidates = [process.env.LOGINFLARE_OPENSSL, 'openssl'];
    if (process.platform === 'win32') {
        try {
            const gitExec = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim();
            candidates.push(resolve(gitExec, '../../../usr/bin/openssl.exe'));
        } catch { /* An explicit OpenSSL path can be supplied when Git is unavailable. */ }
    }
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            execFileSync(candidate, ['version'], { stdio: 'pipe', windowsHide: true, timeout: 5_000 });
            return candidate;
        } catch { /* Try the next installed executable. */ }
    }
    throw new Error('OpenSSL was not found. Install it or set LOGINFLARE_OPENSSL to its executable path.');
}

/** Generate only local example files. No certificate store or system DNS is changed. */
export function prepareExampleTls(force = false) {
    if (!force && existsSync(keyPath) && existsSync(certPath)) return { keyPath, certPath };
    if (!force && (existsSync(keyPath) || existsSync(certPath))) throw new Error('Incomplete example TLS files. Run pnpm example:tls --force to regenerate them.');
    mkdirSync(directory, { recursive: true });
    const openssl = opensslBinary();
    execFileSync(openssl, [
        'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '30', '-noenc',
        '-keyout', keyPath, '-out', certPath,
        '-subj', '/CN=Loginflare local examples',
        '-addext', 'subjectAltName=DNS:web.localhost,DNS:spa.localhost',
    ], { stdio: 'pipe', windowsHide: true, timeout: 30_000 });
    return { keyPath, certPath };
}

/** Read the configured example files without generating or installing certificates. */
export function readExampleTls() {
    const key = process.env.LOGINFLARE_TLS_KEY || keyPath;
    const cert = process.env.LOGINFLARE_TLS_CERT || certPath;
    if (!existsSync(key) || !existsSync(cert)) throw new Error('Example TLS files are missing. Run pnpm example:tls first.');
    return { key: readFileSync(key), cert: readFileSync(cert) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.slice(2).some((argument) => argument !== '--force')) throw new Error('Usage: node examples/setup-tls.mjs [--force]');
    const files = prepareExampleTls(process.argv.includes('--force'));
    console.log(`Local example certificate: ${files.certPath}`);
    console.log('Valid for web.localhost and spa.localhost. No system trust or DNS settings were changed.');
}
