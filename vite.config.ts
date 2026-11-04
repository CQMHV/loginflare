import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { brandColors } from './src/shared/brand-colors.ts';
import { defaultBranding } from './src/shared/branding.ts';
import { randomUUID } from 'node:crypto';
import { validateDeploymentConfiguration } from './scripts/deployment.mjs';

const applicationBuild = process.env.WORKERS_CI_BUILD_UUID ?? randomUUID();
const applicationBuildTime = Date.now().toString();
export default defineConfig(({ mode }) => ({
    cacheDir: 'node_modules/.vite/loginflare',
    optimizeDeps: { include: ['@xmldom/xmldom'] },
    plugins: [{
        name: 'loginflare-local-read-delay',
        apply: 'serve',
        enforce: 'pre',
        configureServer(server) {
            const delayMs = Number(process.env.LOGINFLARE_API_DELAY_MS
                ?? loadEnv(server.config.mode, server.config.envDir, 'LOGINFLARE_').LOGINFLARE_API_DELAY_MS ?? '3000');
            if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30_000) {
                throw new Error('LOGINFLARE_API_DELAY_MS must be an integer from 0 to 30000.');
            }
            server.config.logger.info(`Local API GET requests have an additional ${delayMs} ms delay (except /api/health).`);
            server.middlewares.use((request, response, next) => {
                const path = request.url?.split('?', 1)[0] ?? '';
                if (delayMs > 0 && request.method === 'GET' && path.startsWith('/api/') && path !== '/api/health') {
                    const timer = setTimeout(next, delayMs);
                    response.once('close', () => clearTimeout(timer));
                    return;
                }
                next();
            });
        },
    }, react(), cloudflare({
        configPath: process.env.LOGINFLARE_CONFIG ?? (mode === 'deployment' || process.env.WORKERS_CI === '1' ? 'wrangler.jsonc' : 'wrangler.local.jsonc'),
        persistState: { path: '.cloudflare/state' },
        config: (configuration) => {
            if (!configuration.name) throw new Error('The selected Worker configuration must have a name.');
            if (mode === 'deployment' || process.env.WORKERS_CI === '1' || configuration.vars?.APP_ENV !== 'development') validateDeploymentConfiguration(configuration);
            const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? configuration.account_id;
            return { vars: {
                ...configuration.vars,
                LOGINFLARE_WORKER_NAME: configuration.name,
                LOGINFLARE_BUILD_ID: configuration.vars?.APP_ENV === 'development' ? 'development' : applicationBuild,
                LOGINFLARE_BUILD_TIME: configuration.vars?.APP_ENV === 'development' ? '0' : applicationBuildTime,
                ...(account ? { LOGINFLARE_ACCOUNT_ID: account } : {}),
            } };
        },
    })],
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
}));
