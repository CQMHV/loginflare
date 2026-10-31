import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './i18n';
import App from './App';
import { DataProvider } from './data';

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <DataProvider><BrowserRouter>
            <App />
        </BrowserRouter></DataProvider>
    </React.StrictMode>,
);
