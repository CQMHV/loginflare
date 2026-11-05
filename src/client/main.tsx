import React from 'react';
import ReactDOM from 'react-dom/client';

const root = ReactDOM.createRoot(document.getElementById('root')!);
const controlPage = /^\/(?:(?:en-us|zh-cn)\/)?(?:setup|maintenance)(?:\/verified)?\/?$/.test(location.pathname);

if (controlPage) {
    // Recovery must not initialize account, branding or application queries.
    const { default: Setup } = await import('./Setup');
    root.render(<React.StrictMode><Setup /></React.StrictMode>);
} else {
    await import('./i18n');
    const [{ BrowserRouter }, { default: App }, { DataProvider }, { FeedbackProvider }] = await Promise.all([
        import('react-router-dom'), import('./App'), import('./data'), import('./feedback'),
    ]);
    root.render(
        <React.StrictMode>
            <DataProvider><BrowserRouter>
                <FeedbackProvider><App /></FeedbackProvider>
            </BrowserRouter></DataProvider>
        </React.StrictMode>,
    );
}
