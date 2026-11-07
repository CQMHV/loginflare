import React from 'react';
import ReactDOM from 'react-dom/client';

const root = ReactDOM.createRoot(document.getElementById('root')!);
const setupPage = /^\/(?:(?:en-us|zh-cn)\/)?setup\/?$/.test(location.pathname);

if (setupPage) {
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
