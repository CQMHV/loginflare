import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { brandColors } from './src/shared/brand-colors.ts';
import { defaultBranding } from './src/shared/branding.ts';

export default defineConfig({
    cacheDir: 'node_modules/.vite/loginflare',
    optimizeDeps: { include: ['@xmldom/xmldom'] },
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
    css: {
        postcss: {
            plugins: [{
                postcssPlugin: 'loginflare-font-display',
                AtRule: {
                    'loginflare-default-colors'(rule, { Rule, Declaration }) {
                        const schemes = brandColors(defaultBranding.primaryColor, defaultBranding.colorScheme);
                        rule.replaceWith(...Object.entries(schemes).map(([theme, colors]) => {
                            const block = new Rule({ selector: theme === 'light' ? ':root' : ":root[data-theme='dark']" });
                            block.source = rule.source;
                            for (const [role, color] of Object.entries(colors)) {
                                const declaration = new Declaration({ prop: `--md-sys-color-${role}`, value: color });
                                declaration.source = rule.source; block.append(declaration);
                            }
                            return block;
                        }));
                    },
                    'font-face'(rule) {
                        // Keep Fontsource's subsets and URLs while applying one
                        // loading policy in both development and production.
                        rule.walkDecls('font-display', (declaration) => { declaration.value = 'optional'; });
                    },
                },
            }],
        },
    },
    server: { host: 'localhost', port: 5173, strictPort: true },
    build: { target: 'es2022' },
});
