import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
    plugins: [react(), cloudflare({ persistState: { path: '.cloudflare/state' } })],
    server: { host: 'localhost', port: 5173, strictPort: true },
    build: { target: 'es2022' },
});
