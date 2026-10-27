import type { Locator } from '@playwright/test';

export async function renderedTextContrast(locator: Locator, filledButton = false): Promise<number> {
    return locator.evaluate((element, isFilled) => {
        const channels = (color: string) => color.match(/[\d.]+/g)!.map(Number);
        const composite = (front: number[], back: number[], opacity = 1) => {
            const alpha = (front[3] ?? 1) * opacity;
            return back.slice(0, 3).map((value, index) => front[index] * alpha + value * (1 - alpha));
        };
        let background = [255, 255, 255];
        const ancestors: Element[] = [];
        for (let current: Element | null = element; current;) {
            ancestors.unshift(current);
            const root = current.getRootNode();
            current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        }
        for (const ancestor of ancestors) background = composite(channels(getComputedStyle(ancestor).backgroundColor), background);
        let foreground = channels(getComputedStyle(element).color);
        if (isFilled) {
            const root = element.getRootNode() as ShadowRoot;
            background = channels(getComputedStyle(root.querySelector('.background')!).backgroundColor);
            foreground = channels(getComputedStyle(root.querySelector('.label')!).color);
            const surface = root.querySelector('md-ripple')?.shadowRoot?.querySelector('.surface');
            if (surface) {
                for (const pseudo of ['::before', '::after']) {
                    const style = getComputedStyle(surface, pseudo);
                    background = composite(channels(style.backgroundColor), background, Number(style.opacity));
                }
            }
        }
        const luminance = (rgb: number[]) => rgb.slice(0, 3).map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
        const values = [luminance(composite(foreground, background)), luminance(background)].sort((a, b) => b - a);
        return (values[0] + 0.05) / (values[1] + 0.05);
    }, filledButton);
}
