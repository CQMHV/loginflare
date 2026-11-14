// A deterministic-format software authenticator for native server verification.
// Browser acceptance tests separately use Chromium's virtual authenticator.
const bytes = (value: string) => new TextEncoder().encode(value);
export const encoded = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decoded = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (x) => x.charCodeAt(0));
const join = (...values: Uint8Array[]) => { const result = new Uint8Array(values.reduce((n, v) => n + v.length, 0)); let offset = 0; for (const v of values) { result.set(v, offset); offset += v.length; } return result; };
const sha = async (value: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(value).buffer));
function cbor(value: string | Uint8Array | Map<string, unknown>): Uint8Array {
    if (value instanceof Map) return join(new Uint8Array([0xa0 + value.size]), ...[...value].flatMap(([key, v]) => [cbor(key), cbor(v as Parameters<typeof cbor>[0])]));
    const data = typeof value === 'string' ? bytes(value) : value, tag = typeof value === 'string' ? 0x60 : 0x40;
    return join(new Uint8Array(data.length < 24 ? [tag + data.length] : [tag + 24, data.length]), data);
}
export async function authenticator() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey), id = crypto.getRandomValues(new Uint8Array(32));
    const cose = join(new Uint8Array([0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21, 0x58, 0x20]), decoded(jwk.x!), new Uint8Array([0x22, 0x58, 0x20]), decoded(jwk.y!));
    let counter = 0;
    return {
        id: encoded(id),
        async registration(challenge: string, origin = 'http://localhost:5173', rp = 'localhost', uv = true) {
            const client = bytes(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
            const auth = join(await sha(bytes(rp)), new Uint8Array([uv ? 0x45 : 0x41]), new Uint8Array(4 + 16), new Uint8Array([0, id.length]), id, cose);
            return { id: encoded(id), rawId: encoded(id), type: 'public-key', response: { clientDataJSON: encoded(client), attestationObject: encoded(cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', auth]]))), transports: ['internal'] }, clientExtensionResults: {} };
        },
        async assertion(challenge: string, origin = 'http://localhost:5173', rp = 'localhost', uv = true) {
            const client = bytes(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }));
            const count = new Uint8Array(4); new DataView(count.buffer).setUint32(0, ++counter);
            const auth = join(await sha(bytes(rp)), new Uint8Array([uv ? 5 : 1]), count);
            const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, join(auth, await sha(client))));
            function integer(v: Uint8Array) { let start = 0; while (start < v.length - 1 && v[start] === 0) start++; v = v.slice(start); if (v[0]! & 0x80) v = join(new Uint8Array([0]), v); return join(new Uint8Array([2, v.length]), v); }
            const components = join(integer(signature.slice(0, 32)), integer(signature.slice(32)));
            return { id: encoded(id), rawId: encoded(id), type: 'public-key', response: { clientDataJSON: encoded(client), authenticatorData: encoded(auth), signature: encoded(join(new Uint8Array([0x30, components.length]), components)) }, clientExtensionResults: {} };
        },
    };
}
