/** Independent RFC 6238 generator, using the Base32 key shown to the user. */
export async function authenticatorCode(uri: string, now = Date.now()): Promise<string> {
    const secret = new URL(uri).searchParams.get('secret')!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const character of secret.toUpperCase().replace(/=+$/, '')) {
        const digit = alphabet.indexOf(character);
        if (digit < 0) throw new Error('Invalid Base32 key');
        value = (value << 5) | digit;
        bits += 5;
        if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
    }
    const counter = new ArrayBuffer(8);
    new DataView(counter).setBigUint64(0, BigInt(Math.floor(now / 30_000)));
    const key = await crypto.subtle.importKey('raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
    const offset = digest[digest.length - 1]! & 15;
    const binary = new DataView(digest.buffer).getUint32(offset) & 0x7fffffff;
    return String(binary % 1_000_000).padStart(6, '0');
}
