import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: false,
    workers: 1,
    timeout: 30_000,
    expect: { timeout: 10_000 },
    reporter: [['list'], ['html', { open: 'never' }]],
    outputDir: 'test-results',
    use: {
        baseURL: 'http://localhost:5173',
        locale: 'zh-CN',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        actionTimeout: 15_000,
        navigationTimeout: 20_000,
    },
    projects: [{
        name: 'chromium',
        use: {
            ...devices['Desktop Chrome'],
            channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined),
        },
    }],
    webServer: {
        command: 'pnpm dev',
        url: 'http://localhost:5173/api/health',
        reuseExistingServer: !process.env.CI,
        timeout: 90_000,
        env: {
            WRANGLER_LOG_PATH: resolve('work/wrangler-logs'),
            WRANGLER_REGISTRY_PATH: resolve('work/wrangler-registry'),
            MINIFLARE_REGISTRY_PATH: resolve('work/miniflare-registry'),
        },
    },
});
