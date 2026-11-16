import type { Env } from './config';

/** Request-local work flag; scheduled maintenance still recovers interrupted delivery. */
export function markWebhookWork(env: Env) {
    if (env.requestWork) env.requestWork.webhooks = true;
}
