/* The Worker supplies public branding as an escaped HTML attribute, before first paint. */
(() => {
    const root = document.documentElement;
    const initial = JSON.parse(root.dataset.branding);
    let snapshot;
    const style = document.createElement('style');
    style.id = 'brand-colors';
    document.head.append(style);
    function metadata() {
        const color = getComputedStyle(root).getPropertyValue('--md-sys-color-surface').trim();
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta && color) meta.content = color;
    }
    function apply(value) {
        if (snapshot && value.revision < snapshot.revision) return;
        snapshot = Object.freeze(value);
        style.textContent = Object.entries(value.colors).map(([theme, colors]) =>
            `html:root[data-theme="${theme}"]{${Object.entries(colors).map(([role, color]) => `--md-sys-color-${role}:${color};`).join('')}}`).join('\n');
        document.title = value.name;
        document.querySelector('meta[name="description"]').content = value.name;
        document.querySelector('link[rel="icon"]').href = value.logoUrl;
        metadata();
        window.dispatchEvent(new Event('loginflare:branding-change'));
    }
    window.loginflareBranding = Object.freeze({ getSnapshot: () => snapshot, apply });
    window.addEventListener('loginflare:theme-change', metadata);
    apply(initial);
})();
