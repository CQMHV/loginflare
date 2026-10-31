export const avatarSize = 256;
export const avatarMimeType = 'image/webp';
export const maximumAvatarBytes = 300 * 1024;
export const maximumSourceBytes = 20 * 1024 * 1024;
export const maximumSourceDimension = 16_384;
export const maximumSourcePixels = 100_000_000;
export const avatarIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class AvatarImageError extends Error {
    constructor(public code = 'AVATAR_INVALID_IMAGE') { super(code); }
}

/** Bounded structural inspection and metadata removal; never trusts a filename or MIME header. */
export function inspectImage(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
    const invalid = () => { throw new AvatarImageError(); };
    const parts: Uint8Array[] = [];
    let width = 0, height = 0, mime = '';
    if (bytes.length >= 45 && bytes[0] === 137 && text(1, 7) === 'PNG\r\n\x1a\n') {
        mime = 'image/png'; parts.push(bytes.subarray(0, 8));
        let offset = 8, data = false, ended = false;
        while (offset + 12 <= bytes.length) {
            const length = view.getUint32(offset);
            const type = text(offset + 4, 4);
            if (length > bytes.length - offset - 12 || type === 'acTL') invalid();
            if (offset === 8) {
                if (type !== 'IHDR' || length !== 13) invalid();
                width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
            } else if (type === 'IHDR') invalid();
            if (type === 'IDAT') data ||= length > 0;
            if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) parts.push(bytes.subarray(offset, offset + length + 12));
            else if (type.charCodeAt(0) < 97) invalid();
            offset += length + 12;
            if (type === 'IEND') { if (length !== 0 || offset !== bytes.length) invalid(); ended = true; break; }
        }
        if (!data || !ended) invalid();
    } else if (bytes.length >= 20 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
        mime = 'image/webp';
        if (view.getUint32(4, true) !== bytes.length - 8) invalid();
        parts.push(bytes.slice(0, 12));
        let offset = 12, frames = 0;
        const uint24 = (at: number) => bytes[at]! | bytes[at + 1]! << 8 | bytes[at + 2]! << 16;
        while (offset + 8 <= bytes.length) {
            const type = text(offset, 4), length = view.getUint32(offset + 4, true);
            const end = offset + 8 + length + (length % 2), at = offset + 8;
            if (end > bytes.length || type === 'ANIM' || type === 'ANMF') invalid();
            if (type === 'VP8X') {
                if (length !== 10 || offset !== 12 || (bytes[at]! & 2)) invalid();
                width = uint24(at + 4) + 1; height = uint24(at + 7) + 1;
                const chunk = bytes.slice(offset, end);
                chunk[8] = chunk[8]! & ~(0x20 | 0x08 | 0x04);
                parts.push(chunk);
            } else if (type === 'VP8 ' || type === 'VP8L') {
                let frameWidth: number, frameHeight: number;
                if (type === 'VP8 ') {
                    if (length < 10 || text(at + 3, 3) !== '\x9d\x01\x2a') invalid();
                    frameWidth = view.getUint16(at + 6, true) & 0x3fff; frameHeight = view.getUint16(at + 8, true) & 0x3fff;
                } else {
                    if (length < 5 || bytes[at] !== 0x2f) invalid();
                    const bits = view.getUint32(at + 1, true);
                    frameWidth = (bits & 0x3fff) + 1; frameHeight = ((bits >>> 14) & 0x3fff) + 1;
                }
                if (width && (width !== frameWidth || height !== frameHeight)) invalid();
                width = frameWidth; height = frameHeight; frames++;
                parts.push(bytes.subarray(offset, end));
            } else if (type === 'ALPH') parts.push(bytes.subarray(offset, end));
            else if (!['EXIF', 'XMP ', 'ICCP'].includes(type)) invalid();
            offset = end;
        }
        if (offset !== bytes.length || frames !== 1) invalid();
    } else if (bytes.length >= 8 && bytes[0] === 255 && bytes[1] === 216) {
        mime = 'image/jpeg'; parts.push(bytes.subarray(0, 2));
        let offset = 2, scanned = false, ended = false;
        while (offset + 2 <= bytes.length) {
            if (bytes[offset] !== 255) invalid();
            while (bytes[offset + 1] === 255) offset++;
            const marker = bytes[offset + 1]!;
            if (marker === 0xd9) {
                if (offset + 2 !== bytes.length) invalid();
                parts.push(bytes.subarray(offset)); ended = true; break;
            }
            if (offset + 4 > bytes.length) invalid();
            const length = view.getUint16(offset + 2);
            if (length < 2 || offset + length + 2 > bytes.length) invalid();
            if ([0xc0, 0xc1, 0xc2].includes(marker)) {
                if (length < 8 || width) invalid();
                height = view.getUint16(offset + 5); width = view.getUint16(offset + 7);
            }
            if (marker === 0xda) {
                parts.push(bytes.subarray(offset, offset + length + 2));
                offset += length + 2;
                const start = offset;
                while (offset + 1 < bytes.length) {
                    if (bytes[offset] === 255 && bytes[offset + 1] !== 0 && !(bytes[offset + 1]! >= 0xd0 && bytes[offset + 1]! <= 0xd7)) break;
                    offset++;
                }
                parts.push(bytes.subarray(start, offset)); scanned = true; continue;
            }
            if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) parts.push(bytes.subarray(offset, offset + length + 2));
            offset += length + 2;
        }
        if (!scanned || !ended) invalid();
    } else invalid();
    if (!width || !height || width > maximumSourceDimension || height > maximumSourceDimension || width * height > maximumSourcePixels) invalid();
    return { width, height, mime, sanitized() {
        const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
        let offset = 0;
        for (const part of parts) { result.set(part, offset); offset += part.length; }
        if (mime === 'image/webp') new DataView(result.buffer).setUint32(4, result.length - 8, true);
        return result;
    } };
}
