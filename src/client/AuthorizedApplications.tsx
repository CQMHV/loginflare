import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import type { Locale } from '../shared/locales';
import { fetchJson } from './api';
import { ResourceFeedback, useDataActions, useResource } from './data';
import { ErrorNotice, useFeedback } from './feedback';
import { Button, ConfirmationDialog } from './material';
import { useClearSecrets } from './page-state';
import { CursorRecovery, PageNavigation, type CursorPage } from './pagination';

export interface AuthorizedApplication {
    clientId: string;
    name: string;
    scopes: string[];
    authorizedAt: string;
    disabled: boolean;
}

export function AuthorizedApplicationsPage({ locale }: { locale: Locale }) {
    const { t } = useTranslation();
    const feedback = useFeedback();
    const actions = useDataActions();
    const [parameters, setParameters] = useSearchParams();
    const cursor = parameters.get('cursor');
    const requestQuery = new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) }).toString();
    const query = useResource<CursorPage<AuthorizedApplication>>('authorized-applications', `/api/account/applications?${requestQuery}`, requestQuery);
    const [selected, setSelected] = useState<AuthorizedApplication>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const capture = useClearSecrets(() => { setSelected(undefined); setError(undefined); setBusy(false); }, requestQuery);
    useEffect(() => { setSelected(undefined); setError(undefined); setBusy(false); }, [requestQuery]);
    useEffect(() => {
        if (!selected || busy || !query.isSuccess || query.isFetching || query.error || !query.data) return;
        if (!query.data.items.some((application) => application.clientId === selected.clientId)) {
            setSelected(undefined); setError(undefined);
        }
    }, [selected, busy, query.isSuccess, query.isFetching, query.error, query.data]);

    function navigatePage(nextCursor: string | null) {
        setParameters(nextCursor ? { cursor: nextCursor } : {});
    }
    async function revoke() {
        if (!selected || busy) return;
        const active = capture();
        setBusy(true); setError(undefined);
        try {
            await fetchJson<{ status: true }>(`/api/account/applications/${encodeURIComponent(selected.clientId)}/revoke`, {});
            await actions.invalidate('authorized-applications');
            if (active()) {
                setSelected(undefined);
                feedback.success(t('oauth.authorizationRevoked'));
                if (cursor && query.data?.items.length === 1) navigatePage(null);
            }
        } catch (cause) { if (active()) setError(actions.fail(cause)); }
        finally { if (active()) setBusy(false); }
    }

    return <>
        <div className="page-heading"><div><h1>{t('oauth.authorizedApplicationsTitle')}</h1><p>{t('oauth.authorizedApplicationsDescription')}</p></div></div>
        <ResourceFeedback query={query} />
        {query.error && <CursorRecovery cursor={cursor} onReset={() => navigatePage(null)} />}
        {query.data && <>
            {query.data.items.length ? <ul className="authorized-application-list" aria-label={t('oauth.authorizedApplicationsTitle')}>
                {query.data.items.map((application) => {
                    const date = new Date(application.authorizedAt);
                    return <li className="card authorized-application-card" key={application.clientId}>
                        <div className="authorized-application-heading"><h2>{application.name}</h2>{application.disabled && <span className="badge suspended">{t('oauth.applicationDisabled')}</span>}</div>
                        <div className="authorized-application-permissions"><h3>{t('oauth.authorizedPermissions')}</h3><ul>{application.scopes.map((scope) => <li key={scope}>{t(`oauth.scope_${scope}`, { defaultValue: scope })}</li>)}</ul></div>
                        <div className="authorized-application-footer">
                            <dl><dt>{t('oauth.authorizedAt')}</dt><dd>{Number.isNaN(date.getTime()) ? '—' : <time dateTime={application.authorizedAt}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)}</time>}</dd></dl>
                            <Button className="secondary" disabled={busy} onClick={() => { setError(undefined); setSelected(application); }}>{t('oauth.revokeAuthorization')}</Button>
                        </div>
                    </li>;
                })}
            </ul> : <section className="card"><p className="empty-state">{t('oauth.authorizedApplicationsEmpty')}</p></section>}
            {(query.data.items.length > 0 || cursor) && <PageNavigation pageInfo={query.data.pageInfo} count={query.data.items.length} cursor={cursor} onNavigate={navigatePage} />}
        </>}
        {selected && <ConfirmationDialog title={t('oauth.revokeAuthorization')} description={t('oauth.revokeAuthorizationConfirm', { name: selected.name })}
            cancelLabel={t('cancel')} confirmLabel={t('oauth.revokeAuthorization')} busy={busy} error={<ErrorNotice code={error} />}
            onCancel={() => { setSelected(undefined); setError(undefined); }} onConfirm={() => { void revoke(); }} />}
    </>;
}
