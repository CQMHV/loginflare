import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { readExampleTls } from '../setup-tls.mjs';

export default defineConfig(({ command }) => ({
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: {
        host: '127.0.0.1', port: 5182, strictPort: true,
        allowedHosts: ['spa.localhost'],
        ...(command === 'serve' ? { https: readExampleTls() } : {}),
    },
    build: { outDir: '../../work/example-spa-dist', emptyOutDir: true },
}));
