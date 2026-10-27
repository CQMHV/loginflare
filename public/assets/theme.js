/* Initialize before styles and React so a saved theme is applied on first paint. */
(() => {
    const key = 'loginflare.theme';
    const eventName = 'loginflare:theme-change';
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const normalize = (value) => value === 'light' || value === 'dark' ? value : 'system';
    let preference = 'system';
    try {
        preference = normalize(localStorage.getItem(key));
    } catch {
        // An unavailable browser store does not prevent in-memory theme selection.
    }
    let snapshot;
    function apply() {
        const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
        if (snapshot?.preference === preference && snapshot.theme === theme) return;
        snapshot = Object.freeze({ preference, theme });
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.themePreference = preference;
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.content = theme === 'dark' ? '#191511' : '#fffbf7';
        window.dispatchEvent(new Event(eventName));
    }
    window.loginflareTheme = Object.freeze({
        getSnapshot: () => snapshot,
        setPreference: (value) => {
            preference = normalize(value);
            try {
                localStorage.setItem(key, preference);
            } catch {
                // The active theme still updates when persistence is unavailable.
            }
            apply();
        },
    });
    system.addEventListener('change', () => {
        if (preference === 'system') apply();
    });
    window.addEventListener('storage', (event) => {
        if (event.key !== key && event.key !== null) return;
        try {
            if (event.storageArea !== localStorage) return;
        } catch {
            return;
        }
        preference = normalize(event.newValue);
        apply();
    });
    apply();
})();
