import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const runId = process.env.LOGINFLARE_E2E_RUN_ID || randomUUID();
process.env.LOGINFLARE_E2E_RUN_ID = runId;
process.env.PLAYWRIGHT_BASE_URL ||= 'http://localhost:5174';
process.env.LOGINFLARE_LOCAL_STATE ||= resolve('work/e2e', runId, 'state');
process.env.LOGINFLARE_MAILBOX ||= resolve('work/e2e', runId, 'mail');

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: false,
    workers: 1,
    timeout: 30_000,
    expect: { timeout: 10_000 },
    reporter: [['list'], ['html', { open: 'never' }]],
    outputDir: 'test-results',
    use: {
        baseURL: process.env.PLAYWRIGHT_BASE_URL,
        locale: 'zh-CN',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        actionTimeout: 15_000,
        navigationTimeout: 20_000,
        serviceWorkers: 'block',
    },
    projects: [{
        name: 'chromium',
        use: {
            ...devices['Desktop Chrome'],
            channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined),
        },
    }],
    webServer: {
        command: 'pnpm build && node scripts/e2e-local.mjs',
        url: `${process.env.PLAYWRIGHT_BASE_URL}/api/health`,
        reuseExistingServer: false,
        timeout: 90_000,
        env: {
            WRANGLER_LOG_PATH: resolve('work/wrangler-logs'),
            WRANGLER_REGISTRY_PATH: resolve('work/wrangler-registry'),
            MINIFLARE_REGISTRY_PATH: resolve('work/miniflare-registry'),
        },
    },
});
