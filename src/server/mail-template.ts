import type { Locale } from '../shared/locales.ts';
import type { BrandingRow } from './branding-settings';
import { brandColors } from '../shared/brand-colors.ts';

type MailContent = {
    brand: BrandingRow; origin: string; locale: Locale;
    title: string; introduction: string; note?: string;
} & ({ action: { label: string; url: string }; code?: never } | { code: string; action?: never });

const copy = {
    'en-US': {
        category: 'ACCOUNT SECURITY', tagline: 'Your identity. Your cloud.',
        ignore: 'If you did not request this email, you can safely ignore it.',
        fallback: 'If the button does not work, copy and open this link:',
    },
    'zh-CN': {
        category: '账号安全', tagline: '你的身份，你的云。',
        ignore: '如果你没有发起此请求，可以忽略这封邮件。',
        fallback: '如果按钮无法打开，请复制下方链接到浏览器：',
    },
};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** The website's Material palette, rendered without scripts, web fonts or CSS variables. */
export function renderMail(content: MailContent): { html: string; text: string } {
    const { brand, locale, title, introduction, note, action, code } = content;
    const { light: colors, dark } = brandColors(brand.primaryColor, brand.colorScheme);
    const text = copy[locale], origin = new URL(content.origin);
    const logo = brand.logoId ? `<td width="46" style="width:46px;vertical-align:middle"><img src="${escapeHtml(new URL(`/branding/logos/${encodeURIComponent(brand.logoId)}`, origin).href)}" width="34" height="38" alt="" style="display:block;width:34px;height:38px;object-fit:contain;border:0" /></td>` : '';
    const darkStyles = [
        `.mail-surface{background:${dark.surface}!important}`,
        `.mail-card{background:${dark['surface-container-lowest']}!important;border-color:${dark['outline-variant']}!important}`,
        `.mail-hero{background:${dark['primary-container']}!important;color:${dark['on-primary-container']}!important}`,
        `.mail-brand{color:${dark['on-surface']}!important}`,
        `.mail-muted{color:${dark['on-surface-variant']}!important}`,
        `.mail-code-box{background:${dark['secondary-container']}!important;color:${dark['on-secondary-container']}!important}`,
        `.mail-button{background:${dark.primary}!important;color:${dark['on-primary']}!important}`,
        `.mail-link{color:${dark.primary}!important}`,
        `.mail-divider{border-color:${dark['outline-variant']}!important}`,
    ].join('');
    const actionHtml = action ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 0"><tr><td class="mail-button" bgcolor="${colors.primary}" style="background:${colors.primary};border-radius:28px;text-align:center;mso-padding-alt:14px 28px"><a class="mail-button" href="${escapeHtml(action.url)}" style="display:inline-block;background:${colors.primary};color:${colors['on-primary']};border-radius:28px;padding:14px 28px;font-size:15px;font-weight:500;line-height:20px;text-decoration:none;mso-padding-alt:0">${escapeHtml(action.label)}</a></td></tr></table>`
        : `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:28px 0 0"><tr><td class="mail-code-box" bgcolor="${colors['secondary-container']}" style="background:${colors['secondary-container']};color:${colors['on-secondary-container']};border-radius:16px;padding:24px 12px;text-align:center"><p class="mail-code" style="margin:0;font-family:'Roboto','Segoe UI',Arial,sans-serif;font-size:36px;font-weight:500;line-height:48px;letter-spacing:10px;font-variant-numeric:tabular-nums">${escapeHtml(code!)}</p></td></tr></table>`;
    const html = `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" /><meta name="supported-color-schemes" content="light dark" /><title>${escapeHtml(title)} · ${escapeHtml(brand.name)}</title>
<style>body{margin:0;padding:0}table{border-collapse:separate}a:focus{outline:2px solid ${colors.primary};outline-offset:4px}
@media(prefers-color-scheme:dark){${darkStyles}}
@media(max-width:480px){.mail-page{padding:24px 12px!important}.mail-header{padding:0 12px 24px!important}.mail-body,.mail-hero{padding:28px 24px!important}.mail-title{font-size:28px!important;line-height:36px!important}.mail-code{font-size:32px!important;letter-spacing:8px!important}}
</style></head>
<body class="mail-surface" style="margin:0;padding:0;background:${colors.surface};color:${colors['on-surface']};font-family:'Roboto','Noto Sans SC','Segoe UI','Microsoft YaHei',Arial,sans-serif;-webkit-text-size-adjust:100%;word-wrap:break-word;overflow-wrap:anywhere">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escapeHtml(introduction)}</div>
<table role="presentation" class="mail-surface" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${colors.surface}" style="width:100%;background:${colors.surface}"><tr><td class="mail-page" align="center" style="padding:40px 16px">
<!--[if mso]><table role="presentation" width="600" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;margin:0 auto">
<tr><td class="mail-header" style="padding:0 24px 28px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${logo}<td class="mail-brand" style="color:${colors['on-surface']};font-size:22px;font-weight:500;line-height:30px;word-break:break-word">${escapeHtml(brand.name)}</td></tr></table></td></tr>
<tr><td class="mail-card" bgcolor="${colors['surface-container-lowest']}" style="background:${colors['surface-container-lowest']};border:1px solid ${colors['outline-variant']};border-radius:28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%">
<tr><td class="mail-hero" bgcolor="${colors['primary-container']}" style="padding:32px 36px;background:${colors['primary-container']};color:${colors['on-primary-container']};border-radius:27px 27px 0 0"><p style="margin:0 0 14px;font-size:12px;font-weight:500;line-height:18px;letter-spacing:.5px">${text.category}</p><h1 class="mail-title" style="margin:0;font-size:32px;font-weight:400;line-height:40px;letter-spacing:-.5px;word-break:break-word">${escapeHtml(title)}</h1></td></tr>
<tr><td class="mail-body" style="padding:32px 36px 36px"><p class="mail-muted" style="margin:0;font-size:16px;line-height:27px;color:${colors['on-surface-variant']}">${escapeHtml(introduction)}</p>
${actionHtml}
${note ? `<p class="mail-muted" style="margin:20px 0 0;font-size:14px;line-height:23px;color:${colors['on-surface-variant']}">${escapeHtml(note)}</p>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:28px"><tr><td class="mail-divider" style="border-top:1px solid ${colors['outline-variant']};padding-top:24px"><p class="mail-muted" style="margin:0;font-size:13px;line-height:22px;color:${colors['on-surface-variant']}">${text.ignore}</p>
${action ? `<p class="mail-muted" style="margin:18px 0 6px;font-size:12px;line-height:20px;color:${colors['on-surface-variant']}">${text.fallback}</p><a class="mail-link" href="${escapeHtml(action.url)}" style="font-size:12px;line-height:20px;color:${colors.primary};text-decoration:underline;word-break:break-all;overflow-wrap:anywhere">${escapeHtml(action.url)}</a>` : ''}
</td></tr></table></td></tr></table></td></tr>
<tr><td class="mail-muted" align="center" style="padding:24px 16px 0;color:${colors['on-surface-variant']};font-size:12px;line-height:21px">${escapeHtml(brand.name)} · ${text.tagline}<br />${escapeHtml(origin.hostname)}</td></tr>
</table><!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
    return { html, text: [introduction, action?.url ?? code, note, text.ignore].filter(Boolean).join('\n\n') };
}
