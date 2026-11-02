import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './i18n';
import App from './App';
import { DataProvider } from './data';
import { FeedbackProvider } from './feedback';

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <DataProvider><BrowserRouter>
            <FeedbackProvider><App /></FeedbackProvider>
        </BrowserRouter></DataProvider>
    </React.StrictMode>,
);
