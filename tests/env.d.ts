/// <reference types="@cloudflare/vitest-plugin/types" />

export {};

declare global {
    namespace Cloudflare {
        interface Env {
            TEST_MIGRATIONS: { name: string; queries: string[] }[];
        }
    }
}
