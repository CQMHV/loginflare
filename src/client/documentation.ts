import type { Locale } from '../shared/locales';

export function documentationUrl(locale: Locale, document: 'docs/oauth' | 'docs/access-control' | 'docs/management-api' | 'examples/server-web/README') {
    return `https://github.com/CQMHV/loginflare/blob/main/${document}${locale === 'zh-CN' ? '.zh-CN' : ''}.md`;
}
