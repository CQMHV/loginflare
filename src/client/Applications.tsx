import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { localizedPath, type Locale } from '../shared/locales';
import { errorCode, fetchJson } from './api';
import { Button, ButtonLink, Checkbox, ConfirmationDialog, Progress, Select, TextField } from './material';
import i18n from './i18n';
import { CursorRecovery, listParameters, listPath, pageParameters, PageNavigation, type CursorPage } from './pagination';

export interface Application {
    clientId: string;
    name: string;
    type: 'web' | 'spa';
    redirectUris: string[];
    postLogoutRedirectUris: string[];
    scopes: string[];
    disabled: boolean;
}

type ApplicationItem = Pick<Application, 'clientId' | 'name' | 'type' | 'disabled'> & { createdAt: string };

interface ApplicationResponse {
    application: Application;
    clientSecret?: string;
    issuer: string;
}

function ErrorNotice({ code }: { code?: string }) {
    const { t } = useTranslation();
    return code ? <div className="notice error" role="alert">{t(i18n.exists(`errors.${code}`) ? `errors.${code}` : 'errors.UNKNOWN_ERROR')}</div> : null;
}

function Status({ disabled }: { disabled: boolean }) {
    const { t } = useTranslation();
    return <span className={`badge ${disabled ? 'suspended' : 'active'}`}><span className="status-dot" />{t(disabled ? 'oauth.applicationDisabled' : 'oauth.applicationEnabled')}</span>;
}

function SecretNotice({ secret, onDismiss }: { secret?: string; onDismiss: () => void }) {
    const { t } = useTranslation();
    if (!secret) return null;
    return <section className="card secret-notice" aria-label={t('oauth.secretTitle')}>
        <div className="card-heading"><h2>{t('oauth.secretTitle')}</h2><p>{t('oauth.secretDescription')}</p></div>
        <div className="card-body stack-form"><TextField label={t('oauth.secretLabel')} value={secret} readOnly autoComplete="off" /><div><Button className="secondary" onClick={onDismiss}>{t('oauth.secretSaved')}</Button></div></div>
    </section>;
}

function ConnectionDetails({ application, issuer }: { application: Application; issuer: string }) {
    const { t } = useTranslation();
    return <section className="card"><div className="card-heading"><h2>{t('oauth.connectionDetails')}</h2><p>{t('oauth.connectionDescription')}</p></div>
        <div className="card-body stack-form">
            <TextField label={t('oauth.clientId')} value={application.clientId} readOnly />
            <TextField label={t('oauth.issuer')} value={issuer} readOnly />
            <TextField label={t('oauth.discovery')} value={`${issuer}/.well-known/openid-configuration`} readOnly />
            <p className="muted">{t(application.type === 'spa' ? 'oauth.spaStorageHint' : 'oauth.typeWebHint')}</p>
        </div>
    </section>;
}

export function ApplicationsPage({ locale }: { locale: Locale }) {
    const { t } = useTranslation();
    const location = useLocation();
    const [parameters, setParameters] = useSearchParams();
    const cursor = parameters.get('cursor');
    const lookupField = parameters.get('lookupField') ?? 'clientId';
    const lookupValue = parameters.get('lookupValue') ?? '';
    const [field, setField] = useState(lookupField);
    const [query, setQuery] = useState(lookupValue);
    const [data, setData] = useState<CursorPage<ApplicationItem> & { issuer: string }>();
    const [error, setError] = useState<string>();
    const requestQuery = pageParameters(location.search);
    useEffect(() => { setField(lookupField); setQuery(lookupValue); }, [lookupField, lookupValue]);
    useEffect(() => {
        let current = true;
        setData(undefined); setError(undefined);
        void fetchJson<CursorPage<ApplicationItem> & { issuer: string }>(`/api/admin/applications?${requestQuery}`).then((result) => {
            if (current) setData(result);
        }).catch((cause) => { if (current) setError(errorCode(cause)); });
        return () => { current = false; };
    }, [requestQuery]);
    function navigatePage(nextCursor: string | null) {
        const next = listParameters(location.search);
        if (nextCursor) next.set('cursor', nextCursor); else next.delete('cursor');
        setParameters(next);
    }
    return <>
        <div className="page-heading"><div><h1>{t('oauth.applicationsTitle')}</h1><p>{t('oauth.applicationsDescription')}</p></div><ButtonLink to={listPath(localizedPath(locale, 'admin/applications/new'), location.search)}>{t('oauth.createApplication')}</ButtonLink></div>
        <ErrorNotice code={error} />
        {error && <CursorRecovery cursor={cursor} onReset={() => navigatePage(null)} />}
        <section className="card"><form className="search-bar" onSubmit={(event) => { event.preventDefault(); const value = query.trim(); setParameters(value ? { lookupField: field, lookupValue: value } : {}); }}><div className="search-field"><Select label={t('lookupField')} value={field} options={[{ value: 'clientId', label: t('oauth.clientId') }, { value: 'name', label: t('oauth.applicationName') }]} onChange={setField} /></div><div className="search-input"><TextField label={t('oauth.searchApplications')} value={query} onValueChange={setQuery} maxLength={254} supportingText={t('exactLookupHint')} /></div><Button className="secondary" type="submit">{t('search')}</Button></form>
        {!data && !error && <div className="loading-state" role="status"><Progress />{t('loading')}</div>}
        {data && <><div className="table-scroll"><table>
            <thead><tr><th>{t('oauth.applicationName')}</th><th>{t('oauth.applicationType')}</th><th>{t('status')}</th><th>{t('created')}</th></tr></thead>
            <tbody>{data.items.map((application) => <tr key={application.clientId}>
                <td><Link className="application-name" to={listPath(localizedPath(locale, 'admin/applications/detail'), location.search, { clientId: application.clientId })}>{application.name}</Link><small className="application-id">{application.clientId}</small></td>
                <td>{t(application.type === 'spa' ? 'oauth.typeSpa' : 'oauth.typeWeb')}</td><td><Status disabled={application.disabled} /></td><td className="muted">{application.createdAt && !Number.isNaN(Date.parse(application.createdAt)) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(application.createdAt)) : '—'}</td>
            </tr>)}</tbody>
        </table></div>{data.items.length === 0 && <p className="empty-state">{t('oauth.applicationsEmpty')}</p>}<PageNavigation pageInfo={data.pageInfo} count={data.items.length} cursor={cursor} onNavigate={navigatePage} /></>}
        </section>
    </>;
}

export function ApplicationEditor({ locale, create = false }: { locale: Locale; create?: boolean }) {
    const { t } = useTranslation();
    const location = useLocation();
    const clientId = new URLSearchParams(location.search).get('clientId') ?? '';
    const [application, setApplication] = useState<Application>();
    const [issuer, setIssuer] = useState('');
    const [name, setName] = useState('');
    const [type, setType] = useState<'web' | 'spa'>('web');
    const [redirectUris, setRedirectUris] = useState('');
    const [postLogoutRedirectUris, setPostLogoutRedirectUris] = useState('');
    const [scopes, setScopes] = useState<string[]>(['openid', 'profile', 'email', 'offline_access']);
    const [secret, setSecret] = useState<string>();
    const [error, setError] = useState<string>();
    const [saved, setSaved] = useState(false);
    const [busy, setBusy] = useState(false);
    const [confirmation, setConfirmation] = useState<'disable' | 'rotate'>();
    const created = create && !!application;

    function applyResult(data: ApplicationResponse) {
        setApplication(data.application);
        setIssuer(data.issuer);
        setName(data.application.name);
        setType(data.application.type);
        setRedirectUris(data.application.redirectUris.join('\n'));
        setPostLogoutRedirectUris(data.application.postLogoutRedirectUris.join('\n'));
        setScopes(data.application.scopes);
    }

    useEffect(() => {
        if (create) return;
        let current = true;
        setApplication(undefined); setError(undefined); setSaved(false); setSecret(undefined);
        void fetchJson<ApplicationResponse>(`/api/admin/applications/${encodeURIComponent(clientId)}`).then((data) => {
            if (current) applyResult(data);
        }).catch((cause) => { if (current) setError(errorCode(cause)); });
        return () => { current = false; };
    }, [clientId, create]);

    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy(true); setError(undefined); setSaved(false);
        const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        try {
            const data = await fetchJson<ApplicationResponse>(create ? '/api/admin/applications' : `/api/admin/applications/${encodeURIComponent(clientId)}`, {
                name: name.trim(), ...(create ? { type } : {}),
                redirectUris: lines(redirectUris), postLogoutRedirectUris: lines(postLogoutRedirectUris), scopes,
            }, undefined, create ? 'POST' : 'PATCH');
            applyResult(data); setSecret(data.clientSecret); setSaved(true);
        } catch (cause) { setError(errorCode(cause)); }
        finally { setBusy(false); }
    }

    async function control(kind: 'disable' | 'enable' | 'rotate') {
        if (!application) return;
        setBusy(true); setError(undefined); setSaved(false);
        const path = `/api/admin/applications/${encodeURIComponent(application.clientId)}`;
        try {
            if (kind === 'rotate') {
                const data = await fetchJson<{ clientSecret: string }>(`${path}/rotate-secret`, {});
                setSecret(data.clientSecret);
            } else {
                applyResult(await fetchJson<ApplicationResponse>(path, { disabled: kind === 'disable' }, undefined, 'PATCH'));
            }
            setSaved(true);
        } catch (cause) { setError(errorCode(cause)); }
        finally { setBusy(false); }
    }

    return <>
        {confirmation && <ConfirmationDialog title={t(confirmation === 'disable' ? 'oauth.disableApplication' : 'oauth.rotateSecret')} description={t(confirmation === 'disable' ? 'oauth.disableApplicationConfirm' : 'oauth.rotateSecretConfirm')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} onCancel={() => setConfirmation(undefined)} onConfirm={() => { const kind = confirmation; setConfirmation(undefined); void control(kind); }} />}
        <ButtonLink variant="text" className="detail-back" to={listPath(localizedPath(locale, 'admin/applications'), location.search)}>{t('oauth.backToApplications')}</ButtonLink>
        <div className="page-heading"><div><h1>{t(create ? 'oauth.createApplication' : 'oauth.applicationDetails')}</h1><p>{application?.name ?? t('oauth.applicationsDescription')}</p></div>{application && <Status disabled={application.disabled} />}</div>
        <ErrorNotice code={error} />
        {saved && <div className="notice success" role="status">{t(created ? 'oauth.applicationCreated' : 'oauth.applicationSaved')}</div>}
        <SecretNotice secret={secret} onDismiss={() => setSecret(undefined)} />
        {!create && !application && !error && <div className="loading-state" role="status"><Progress />{t('loading')}</div>}
        {created ? <ButtonLink to={listPath(localizedPath(locale, 'admin/applications/detail'), location.search, { clientId: application.clientId })}>{t('oauth.applicationDetails')}</ButtonLink> : (create || application) && <section className="card"><form className="card-body stack-form" onSubmit={(event) => { void save(event); }}>
            <TextField label={t('oauth.applicationName')} value={name} onValueChange={setName} maxLength={100} required supportingText={t('oauth.applicationNameHint')} />
            {create ? <Select label={t('oauth.applicationType')} value={type} options={[{ value: 'web', label: t('oauth.typeWeb') }, { value: 'spa', label: t('oauth.typeSpa') }]} onChange={(value) => setType(value === 'spa' ? 'spa' : 'web')} /> : <TextField label={t('oauth.applicationType')} value={t(type === 'spa' ? 'oauth.typeSpa' : 'oauth.typeWeb')} readOnly supportingText={t('oauth.typeFixed')} />}
            {create && <p className="muted">{t(type === 'spa' ? 'oauth.typeSpaHint' : 'oauth.typeWebHint')}</p>}
            <TextField label={t('oauth.redirectUris')} type="textarea" value={redirectUris} onValueChange={setRedirectUris} required maxLength={8192} supportingText={t('oauth.redirectUrisHint')} />
            <TextField label={t('oauth.postLogoutRedirectUris')} type="textarea" value={postLogoutRedirectUris} onValueChange={setPostLogoutRedirectUris} required maxLength={8192} supportingText={t('oauth.postLogoutRedirectUrisHint')} />
            <fieldset className="scope-options"><legend>{t('oauth.allowedScopes')}</legend><p className="muted">{t('oauth.scopesHint')}</p><p className="muted">{t('oauth.openidRequired')}</p>{['profile', 'email', 'offline_access'].map((scope) => <Checkbox key={scope} label={t(`oauth.scope_${scope}`)} checked={scopes.includes(scope)} onCheckedChange={(checked) => setScopes((current) => checked ? [...current, scope] : current.filter((value) => value !== scope))} />)}</fieldset>
            <div className="form-footer"><Button type="submit" busy={busy}>{t(create ? 'oauth.createApplication' : 'save')}</Button></div>
        </form></section>}
        {application && <ConnectionDetails application={application} issuer={issuer} />}
        {application && !create && <section className="card"><div className="card-heading"><h2>{t('oauth.applicationControls')}</h2><p>{t('oauth.controlsDescription')}</p></div><div className="card-body action-row">
            <Button className={application.disabled ? 'primary' : 'danger-button'} busy={busy} onClick={() => { if (application.disabled) void control('enable'); else setConfirmation('disable'); }}>{t(application.disabled ? 'oauth.restoreApplication' : 'oauth.disableApplication')}</Button>
            {application.type === 'web' && <Button className="secondary" busy={busy} onClick={() => setConfirmation('rotate')}>{t('oauth.rotateSecret')}</Button>}
        </div></section>}
    </>;
}
