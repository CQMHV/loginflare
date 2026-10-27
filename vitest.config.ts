import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [
        cloudflareTest(async () => ({
            main: './src/server/index.ts',
            miniflare: {
                compatibilityDate: '2026-10-27',
                compatibilityFlags: ['nodejs_compat'],
                d1Databases: ['DB'],
                bindings: {
                    APP_ENV: 'development',
                    AUTH_URL: 'http://localhost:5173',
                    EMAIL_FROM: 'no-reply@loginflare.test',
                    TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
                    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
                    BETTER_AUTH_SECRET: 'integration-test-only-secret-with-more-than-32-characters',
                    TEST_MIGRATIONS: await readD1Migrations('./migrations'),
                },
                serviceBindings: {
                    ASSETS: () => new Response('<!doctype html><title>Loginflare</title>'),
                },
            },
        })),
    ],
    test: {
        include: ['tests/**/*.test.ts'],
        exclude: ['tests/e2e/**'],
        testTimeout: 30_000,
        hookTimeout: 30_000,
        fileParallelism: false,
    },
});
