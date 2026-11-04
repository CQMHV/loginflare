const encoder = new TextEncoder();

export function randomSetupToken(bytes = 32): string {
    return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
        .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function setupDigest(value: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Compare fixed-size digests so neither string length nor early exits reveal a credential. */
export async function setupSecretEqual(left: string, right: string): Promise<boolean> {
    const [a, b] = await Promise.all([setupDigest(left), setupDigest(right)]);
    let difference = 0;
    for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
    return difference === 0;
}

async function recoveryKey(token: string, instanceId: string): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey('raw', encoder.encode(token), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(instanceId),
        info: encoder.encode('loginflare:installation:recovery:v1') }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function encode(value: ArrayBuffer | Uint8Array): string {
    return btoa(String.fromCharCode(...new Uint8Array(value)));
}

function decode(value: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** Pending credentials are recoverable across lost responses without plaintext database storage. */
export async function sealSetupValue(value: string, token: string, instanceId: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(instanceId) },
        await recoveryKey(token, instanceId), encoder.encode(value));
    return JSON.stringify({ version: 1, iv: encode(iv), ciphertext: encode(encrypted) });
}

export async function openSetupValue(envelope: string, token: string, instanceId: string): Promise<string> {
    const parsed: unknown = JSON.parse(envelope);
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1
        || !('iv' in parsed) || typeof parsed.iv !== 'string' || !('ciphertext' in parsed) || typeof parsed.ciphertext !== 'string') {
        throw new Error('INVALID_SETUP_ENVELOPE');
    }
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(parsed.iv), additionalData: encoder.encode(instanceId) },
        await recoveryKey(token, instanceId), decode(parsed.ciphertext));
    return new TextDecoder().decode(decrypted);
}
