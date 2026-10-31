import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
    cacheDir: 'node_modules/.vite/loginflare',
    plugins: [{
        name: 'loginflare-local-read-delay',
        apply: 'serve',
        enforce: 'pre',
        configureServer(server) {
            server.config.logger.info('Local API GET requests have an additional 1000 ms delay (except /api/health).');
            server.middlewares.use((request, response, next) => {
                const path = request.url?.split('?', 1)[0] ?? '';
                if (request.method === 'GET' && path.startsWith('/api/') && path !== '/api/health') {
                    const timer = setTimeout(next, 1000);
                    response.once('close', () => clearTimeout(timer));
                    return;
                }
                next();
            });
        },
    }, react(), cloudflare({ persistState: { path: '.cloudflare/state' } })],
    server: { host: 'localhost', port: 5173, strictPort: true },
    build: { target: 'es2022' },
});
