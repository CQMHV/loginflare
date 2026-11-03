import { z } from 'zod';

export const applicationFields = ['name', 'type', 'redirectUris', 'postLogoutRedirectUris', 'scopes'] as const;
export type ApplicationField = typeof applicationFields[number];
export type ApplicationFieldErrors = Partial<Record<ApplicationField, string>>;

const fieldCodes = {
    name: 'APPLICATION_NAME_INVALID', type: 'APPLICATION_TYPE_INVALID', redirectUris: 'APPLICATION_REDIRECT_REQUIRED',
    postLogoutRedirectUris: 'APPLICATION_LOGOUT_REDIRECT_REQUIRED', scopes: 'APPLICATION_SCOPES_INVALID',
} satisfies Record<ApplicationField, string>;
const validationCodes = new Set([...Object.values(fieldCodes), 'APPLICATION_URI_INVALID', 'APPLICATION_REDIRECT_LIMIT', 'APPLICATION_LOGOUT_REDIRECT_LIMIT', 'APPLICATION_URI_HTTPS_REQUIRED', 'APPLICATION_URI_LOOPBACK']);

function redirectError(value: string): string | undefined {
    if (value.length > 2048 || value !== value.trim() || /[\\\u0000-\u0020\u007f]/.test(value) || value.includes('*') || value.includes('#')) return 'APPLICATION_URI_INVALID';
    let uri: URL;
    try { uri = new URL(value); } catch { return 'APPLICATION_URI_INVALID'; }
    if (uri.username || uri.password) return 'APPLICATION_URI_INVALID';
    if (uri.protocol !== 'https:') return 'APPLICATION_URI_HTTPS_REQUIRED';
    const host = uri.hostname.toLowerCase().replace(/\.+$/, '');
    // WHATWG URL normalizes numeric, hexadecimal and expanded IP forms first.
    if (host === 'localhost' || /^127\./.test(host) || host === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host)) return 'APPLICATION_URI_LOOPBACK';
}
const redirectUri = z.string().superRefine((value, context) => {
    const message = redirectError(value);
    if (message) context.addIssue({ code: 'custom', message });
});
const logoutRedirects = z.array(redirectUri).min(1, { message: 'APPLICATION_LOGOUT_REDIRECT_REQUIRED' }).max(10, { message: 'APPLICATION_LOGOUT_REDIRECT_LIMIT' });
const editable = z.object({
    name: z.string().trim().min(1, { message: 'APPLICATION_NAME_INVALID' }).max(100, { message: 'APPLICATION_NAME_INVALID' }),
    redirectUris: z.array(redirectUri).min(1, { message: 'APPLICATION_REDIRECT_REQUIRED' }).max(10, { message: 'APPLICATION_REDIRECT_LIMIT' }),
    postLogoutRedirectUris: logoutRedirects,
    scopes: z.array(z.enum(['openid', 'profile', 'email', 'offline_access'])).min(1).max(4)
        .refine((values) => values.includes('openid') && new Set(values).size === values.length, { message: 'APPLICATION_SCOPES_INVALID' }),
});
export const applicationCreateSchema = editable.extend({ type: z.enum(['web', 'spa']) }).strict();
export const applicationUpdateSchema = editable.partial().extend({ disabled: z.boolean().optional() }).strict().refine((value) => Object.keys(value).length > 0);

export function applicationFieldErrors(error: z.ZodError): ApplicationFieldErrors {
    const fields: ApplicationFieldErrors = {};
    for (const issue of error.issues) {
        const key = issue.path[0];
        if (typeof key !== 'string' || !applicationFields.includes(key as ApplicationField)) continue;
        const field = key as ApplicationField;
        if (fields[field]) continue;
        fields[field] = validationCodes.has(issue.message) ? issue.message
            : issue.path.length > 1 && ['redirectUris', 'postLogoutRedirectUris'].includes(field) ? 'APPLICATION_URI_INVALID' : fieldCodes[field];
    }
    return fields;
}
