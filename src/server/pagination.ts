export class PaginationError extends Error {
    constructor(public code: 'INVALID_INPUT' | 'INVALID_CURSOR') { super(code); }
}

export interface PagePosition { createdAt: string; id: string }
interface Cursor { version: 1; scope: string; direction: 'next' | 'previous'; position: PagePosition }
export interface PageInput { limit: number; cursor?: Cursor; lookupField?: string; lookupValue?: string; scope: string }
const encoder = new TextEncoder();

function encode(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new PaginationError('INVALID_CURSOR');
    const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
    if (encode(bytes) !== value) throw new PaginationError('INVALID_CURSOR');
    return bytes;
}
async function signingKey(secret: string): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', encoder.encode(`loginflare:pagination:v1:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signCursor(secret: string, cursor: Cursor): Promise<string> {
    const payload = encode(encoder.encode(JSON.stringify(cursor)));
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload)));
    return `${payload}.${encode(signature)}`;
}

export async function readPageInput(url: URL, secret: string, entity: string, owner: string, fields: readonly string[]): Promise<PageInput> {
    const parameters = url.searchParams;
    const allowed = ['limit', 'cursor', ...(fields.length ? ['lookupField', 'lookupValue'] : [])];
    if ([...parameters.keys()].some((key) => !allowed.includes(key) || parameters.getAll(key).length !== 1)) throw new PaginationError('INVALID_INPUT');
    const limitValue = parameters.get('limit');
    if (limitValue !== null && !/^[1-9][0-9]*$/.test(limitValue)) throw new PaginationError('INVALID_INPUT');
    const limit = limitValue === null ? 20 : Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PaginationError('INVALID_INPUT');
    const lookupField = parameters.get('lookupField') ?? undefined;
    let lookupValue = parameters.get('lookupValue')?.trim();
    if ((lookupField === undefined) !== (lookupValue === undefined) || (lookupField !== undefined && (!fields.includes(lookupField) || !lookupValue || lookupValue.length > 254))) throw new PaginationError('INVALID_INPUT');
    if (lookupField === 'email' || lookupField === 'username') lookupValue = lookupValue?.toLowerCase();
    const scope = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify({ entity, owner, lookupField, lookupValue })))));
    const input: PageInput = { limit, lookupField, lookupValue, scope };
    const token = parameters.get('cursor');
    if (token === null) return input;
    try {
        if (!token || token.length > 2048) throw new PaginationError('INVALID_CURSOR');
        const parts = token.split('.');
        if (parts.length !== 2) throw new PaginationError('INVALID_CURSOR');
        if (!await crypto.subtle.verify('HMAC', await signingKey(secret), decode(parts[1]!), encoder.encode(parts[0]!))) throw new PaginationError('INVALID_CURSOR');
        const cursor = JSON.parse(new TextDecoder().decode(decode(parts[0]!))) as Cursor;
        if (cursor.version !== 1 || cursor.scope !== scope || !['next', 'previous'].includes(cursor.direction)
            || typeof cursor.position?.id !== 'string' || !cursor.position.id || cursor.position.id.length > 255
            || typeof cursor.position.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.position.createdAt)
            || !Number.isFinite(Date.parse(cursor.position.createdAt))) throw new PaginationError('INVALID_CURSOR');
        input.cursor = cursor;
        return input;
    } catch { throw new PaginationError('INVALID_CURSOR'); }
}

export function pageBoundary(input: PageInput, idColumn: string): { sql: string; values: string[]; order: 'ASC' | 'DESC' } {
    const previous = input.cursor?.direction === 'previous';
    if (!input.cursor) return { sql: '', values: [], order: 'DESC' };
    const operator = previous ? '>' : '<';
    return {
        sql: ` AND ("createdAt", "${idColumn}") ${operator} (?, ?)`,
        values: [input.cursor.position.createdAt, input.cursor.position.id],
        order: previous ? 'ASC' : 'DESC',
    };
}

export async function pageResult<T>(rows: T[], input: PageInput, secret: string, position: (item: T) => PagePosition) {
    const extra = rows.length > input.limit;
    let items = rows.slice(0, input.limit);
    const previous = input.cursor?.direction === 'previous';
    if (previous) items = items.reverse();
    const hasNext = previous ? !!input.cursor : extra;
    const hasPrevious = previous ? extra : !!input.cursor;
    const make = (item: T, direction: Cursor['direction']) => signCursor(secret, { version: 1, scope: input.scope, direction, position: position(item) });
    return {
        items,
        pageInfo: {
            nextCursor: items.length && hasNext ? await make(items.at(-1)!, 'next') : null,
            previousCursor: items.length && hasPrevious ? await make(items[0]!, 'previous') : null,
        },
    };
}
