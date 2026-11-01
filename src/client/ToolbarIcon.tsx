import { createElement } from 'react';
import '@material/web/icon/icon.js';
import translate from '@material-symbols/svg-500/rounded/translate.svg?raw';
import contrast from '@material-symbols/svg-500/rounded/contrast.svg?raw';
import edit from '@material-symbols/svg-500/rounded/edit.svg?raw';
import person from '@material-symbols/svg-500/rounded/person.svg?raw';

const symbols = { translate, contrast, edit, person };

export function ToolbarIcon({ name }: { name: keyof typeof symbols }) {
    // Only fixed Material Symbols assets from the pinned package enter this markup.
    const svg = symbols[name]
        .replace('<svg ', '<svg fill="currentColor" aria-hidden="true" focusable="false" ')
        .replace('width="48"', 'width="100%"')
        .replace('height="48"', 'height="100%"');
    return createElement('md-icon', { 'aria-hidden': true, dangerouslySetInnerHTML: { __html: svg } });
}
