import { DOMParser, onErrorStopParsing } from '@xmldom/xmldom';

export const maximumSvgBytes = 256 * 1024;

function safeStyle(value: string): boolean {
    return !/\\|@import|@font-face|@(?:-webkit-)?keyframes|animation(?:-[a-z-]+)?\s*:/i.test(value)
        && [...value.matchAll(/url\(([^)]*)\)/gi)].every((match) => match[1]!.trim().replace(/^["']|["']$/g, '').startsWith('#'));
}
export function parseSvg(bytes: Uint8Array) {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (bytes.length > maximumSvgBytes || (source.match(/<[a-z]/gi)?.length ?? 0) > 5000 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('Invalid SVG image');
    const document = new DOMParser({ onError: onErrorStopParsing }).parseFromString(source, 'image/svg+xml');
    if (document.documentElement?.localName !== 'svg' || document.documentElement.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error('Invalid SVG image');
    const nodes = [document.documentElement];
    while (nodes.length) {
        const element = nodes.pop()!;
        const tag = (element.localName ?? element.tagName).toLowerCase();
        if (tag.startsWith('animate') || ['script', 'foreignobject', 'iframe', 'object', 'embed', 'set', 'discard'].includes(tag)) throw new Error('Invalid SVG image');
        if (tag === 'style' && !safeStyle(element.textContent ?? '')) throw new Error('Invalid SVG image');
        for (let index = 0; index < element.attributes.length; index++) {
            const attribute = element.attributes.item(index)!;
            const name = attribute.localName ?? attribute.name;
            if (/^on/i.test(name) || (['href', 'src'].includes(name) && !attribute.value.startsWith('#'))) throw new Error('Invalid SVG image');
            if (!safeStyle(attribute.value)) throw new Error('Invalid SVG image');
        }
        for (let child = element.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === 1) nodes.push(child as typeof element);
            if (child.nodeType === 7 && child.nodeName !== 'xml') throw new Error('Invalid SVG image');
        }
    }
    for (let child = document.firstChild; child; child = child.nextSibling) if (child.nodeType === 7 && child.nodeName !== 'xml') throw new Error('Invalid SVG image');
    return { source, document };
}
