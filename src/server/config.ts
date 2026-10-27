export type Env = Cloudflare.Env;

export class ConfigurationError extends Error {}

export function validateConfig(env: Env): void {
    const required = ['AUTH_URL', 'EMAIL_FROM', 'TURNSTILE_SITE_KEY', 'BETTER_AUTH_SECRET', 'TURNSTILE_SECRET_KEY'] as const;
    for (const key of required) {
        if (typeof env[key] !== 'string' || !env[key].trim()) throw new ConfigurationError(`Missing ${key}`);
    }
    if (!['development', 'staging', 'production'].includes(env.APP_ENV)) throw new ConfigurationError('Invalid APP_ENV');
    if (env.BETTER_AUTH_SECRET.length < 32 || env.BETTER_AUTH_SECRET.startsWith('replace-')) throw new ConfigurationError('Invalid BETTER_AUTH_SECRET');
    let origin: URL;
    try {
        origin = new URL(env.AUTH_URL);
    } catch {
        throw new ConfigurationError('Invalid AUTH_URL');
    }
    if (origin.origin !== env.AUTH_URL || origin.username || origin.password) throw new ConfigurationError('AUTH_URL must be an origin');
    const local = env.APP_ENV === 'development';
    if (local && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new ConfigurationError('Development must use a loopback origin');
    if (!local && origin.protocol !== 'https:') throw new ConfigurationError('HTTPS is required');
    if (!local && (/^[123]x0/.test(env.TURNSTILE_SITE_KEY) || /^[123]x0/.test(env.TURNSTILE_SECRET_KEY))) throw new ConfigurationError('Turnstile test keys are not allowed');
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(env.EMAIL_FROM)) throw new ConfigurationError('Invalid EMAIL_FROM');
    if (!env.DB || !env.EMAIL) throw new ConfigurationError('Missing resource bindings');
}
