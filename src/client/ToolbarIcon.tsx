import { createElement } from 'react';
import '@material/web/icon/icon.js';
import translate from '@material-symbols/svg-500/rounded/translate.svg?raw';
import contrast from '@material-symbols/svg-500/rounded/contrast.svg?raw';
import edit from '@material-symbols/svg-500/rounded/edit.svg?raw';
import person from '@material-symbols/svg-500/rounded/person.svg?raw';
import add from '@material-symbols/svg-500/rounded/add.svg?raw';
import remove from '@material-symbols/svg-500/rounded/remove.svg?raw';
import rotate_right from '@material-symbols/svg-500/rounded/rotate_right.svg?raw';
import restart_alt from '@material-symbols/svg-500/rounded/restart_alt.svg?raw';
import settings from '@material-symbols/svg-500/rounded/settings.svg?raw';
import check from '@material-symbols/svg-500/rounded/check.svg?raw';
import error from '@material-symbols/svg-500/rounded/error.svg?raw';
import close from '@material-symbols/svg-500/rounded/close.svg?raw';
import drag_indicator from '@material-symbols/svg-500/rounded/drag_indicator.svg?raw';
import apps from '@material-symbols/svg-500/rounded/apps.svg?raw';
import arrow_forward from '@material-symbols/svg-500/rounded/arrow_forward.svg?raw';

const symbols = { translate, contrast, edit, person, add, remove, rotate_right, restart_alt, settings, check, error, close, drag_indicator, apps, arrow_forward };

export function ToolbarIcon({ name, slot }: { name: keyof typeof symbols; slot?: string }) {
    // Only fixed Material Symbols assets from the pinned package enter this markup.
    const svg = symbols[name]
        .replace('<svg ', '<svg fill="currentColor" aria-hidden="true" focusable="false" ')
        .replace('width="48"', 'width="100%"')
        .replace('height="48"', 'height="100%"');
    return createElement('md-icon', { slot, 'aria-hidden': true, dangerouslySetInnerHTML: { __html: svg } });
}
