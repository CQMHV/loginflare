import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { localizedPath, type Locale } from '../shared/locales';
import { applicationCreateSchema, applicationUpdateSchema, applicationFieldErrors, applicationFields, type ApplicationField, type ApplicationFieldErrors } from '../shared/application-validation';
import { ApiError, fetchJson } from './api';
import { Button, ButtonLink, Checkbox, FormDialog, Select, TextField } from './material';
import { ErrorNotice, useFeedback } from './feedback';
import { CursorRecovery, listParameters, listPath, pageParameters, PageNavigation, type CursorPage } from './pagination';
import { ResourceFeedback, useDataActions, useResource } from './data';
import { useClearSecrets, usePageDraft } from './page-state';
import { ToolbarIcon } from './ToolbarIcon';
import { useBranding } from './branding';

export interface Application {
    clientId: string;
    name: string;
    type: 'web' | 'spa';
    redirectUris: string[];
    postLogoutRedirectUris: string[];
    scopes: string[];
    apiScopes?: string[];
    disabled: boolean;
    ownerId: string | null;
    ownerDisabled: boolean;
    adminSuspended: boolean;
    owner?: { id: string; name: string; email: string } | null;
}

type ApplicationArea = 'admin' | 'developer';

type ApplicationItem = Pick<Application, 'clientId' | 'name' | 'type' | 'disabled' | 'ownerId' | 'adminSuspended' | 'owner'> & { createdAt: string };

interface ApplicationResponse {
    application: Application;
    clientSecret?: string;
    issuer: string;
}

function Status({ disabled, adminSuspended, ownerId }: Pick<Application, 'disabled' | 'adminSuspended' | 'ownerId'>) {
    const { t } = useTranslation();
    return <span className={`badge ${disabled ? 'suspended' : 'active'}`}><span className="status-dot" />{t(adminSuspended && ownerId ? 'oauth.adminSuspended' : disabled ? 'oauth.applicationDisabled' : 'oauth.applicationEnabled')}</span>;
}

function ApplicationActionDialog({ secret, confirmation, busy, error, onCancel, onConfirm, restrict = false }: {
    secret?: string; confirmation?: 'disable' | 'rotate'; busy: boolean; error?: string; onCancel: () => void; onConfirm: () => void; restrict?: boolean;
}) {
    const { t } = useTranslation();
    if (!secret && !confirmation) return null;
    const title = secret ? 'oauth.secretTitle' : confirmation === 'disable' ? restrict ? 'oauth.restrictApplication' : 'oauth.disableApplication' : 'oauth.rotateSecret';
    return <FormDialog title={t(title)} cancelLabel={t(secret ? 'oauth.secretSaved' : 'cancel')} confirmLabel={secret ? undefined : t('confirm')}
        onCancel={onCancel} onSubmit={onConfirm} busy={busy} danger={!secret}>
        {secret ? <><p>{t('oauth.secretDescription')}</p><TextField label={t('oauth.secretLabel')} value={secret} readOnly autoComplete="off" /></>
            : <><p>{t(confirmation === 'disable' ? restrict ? 'oauth.restrictApplicationConfirm' : 'oauth.disableApplicationConfirm' : 'oauth.rotateSecretConfirm')}</p><ErrorNotice code={error} /></>}
    </FormDialog>;
}

function ConnectionDetails({ application, issuer }: { application: Application; issuer: string }) {
    const { t } = useTranslation();
    const brand = useBranding();
    return <section className="card"><div className="card-heading"><h2>{t('oauth.connectionDetails')}</h2><p>{t('oauth.connectionDescription', { brand: brand.name })}</p></div>
        <div className="card-body stack-form">
            <TextField label={t('oauth.clientId')} value={application.clientId} readOnly />
            <TextField label={t('oauth.issuer')} value={issuer} readOnly />
            <TextField label={t('oauth.discovery')} value={`${issuer}/.well-known/openid-configuration`} readOnly />
            <p className="muted">{t(application.type === 'spa' ? 'oauth.spaStorageHint' : 'oauth.typeWebHint')}</p>
        </div>
    </section>;
}

function ApplicationOwner({ owner, locale }: { owner: Application['owner']; locale: Locale }) {
    const { t } = useTranslation();
    return owner ? <Link to={`${localizedPath(locale, 'admin/users/detail')}?${new URLSearchParams({ id: owner.id })}`}>{owner.email}</Link> : <span>{t('oauth.instanceApplication')}</span>;
}

function ApplicationDetails({ application, locale }: { application: Application; locale: Locale }) {
    const { t } = useTranslation();
    return <section className="card"><div className="card-body user-detail-grid application-details">
        <div><small>{t('oauth.applicationName')}</small><strong>{application.name}</strong></div>
        <div><small>{t('oauth.applicationType')}</small><strong>{t(application.type === 'spa' ? 'oauth.typeSpa' : 'oauth.typeWeb')}</strong></div>
        <div><small>{t('oauth.developer')}</small><ApplicationOwner owner={application.owner} locale={locale} />{application.owner?.name && <strong>{application.owner.name}</strong>}</div>
        <div><small>{t('oauth.clientId')}</small><code className="break-all">{application.clientId}</code></div>
        <div className="full-width"><small>{t('oauth.redirectUris')}</small>{application.redirectUris.map((uri, index) => <code className="break-all" key={`${index}:${uri}`}>{uri}</code>)}</div>
        <div className="full-width"><small>{t('oauth.postLogoutRedirectUris')}</small>{application.postLogoutRedirectUris.map((uri, index) => <code className="break-all" key={`${index}:${uri}`}>{uri}</code>)}</div>
        <div className="full-width"><small>{t('oauth.allowedScopes')}</small>{application.scopes.map((scope) => <span key={scope}>{t(`oauth.scope_${scope}`, { defaultValue: scope })}</span>)}</div>
    </div></section>;
}

function DeveloperApplicationsPage({ locale }: { locale: Locale }) {
    const { t } = useTranslation();
    const brand = useBranding();
    const applicationQuery = useResource<CursorPage<ApplicationItem> & { issuer: string }>('applications', '/api/developer/applications?limit=100', 'developer:workspace');
    const applications = applicationQuery.data?.items;
    const createPath = localizedPath(locale, 'developer/applications/new');
    return <>
        <div className="page-heading"><div><h1>{t('oauth.myApplications')}</h1><p>{t('oauth.developerApplicationsDescription', { brand: brand.name })}</p></div>{!!applications?.length && <ButtonLink to={createPath}>{t('oauth.createApplication')}</ButtonLink>}</div>
        <ResourceFeedback query={applicationQuery} />
        {applications?.length === 0 && <section className="card developer-applications-empty" aria-labelledby="developer-applications-empty-title">
            <span className="developer-application-icon"><ToolbarIcon name="apps" /></span>
            <h2 id="developer-applications-empty-title">{t('oauth.firstApplication')}</h2>
            <p>{t('oauth.applicationsEmpty', { brand: brand.name })}</p>
            <ButtonLink to={createPath}>{t('oauth.createApplication')}</ButtonLink>
        </section>}
        {!!applications?.length && <div className="developer-applications-grid">{applications.map((application) => {
            const titleId = `developer-application-${encodeURIComponent(application.clientId)}`;
            return <Link key={application.clientId} className="card developer-application-card" aria-labelledby={titleId} to={`${localizedPath(locale, 'developer/applications/detail')}?${new URLSearchParams({ clientId: application.clientId })}`}>
                <div className="developer-application-top"><span className="developer-application-icon"><ToolbarIcon name="apps" /></span><Status disabled={application.disabled} adminSuspended={application.adminSuspended} ownerId={application.ownerId} /></div>
                <div className="developer-application-title"><h2 id={titleId}>{application.name}</h2><ToolbarIcon name="arrow_forward" /></div>
                <p className="developer-application-type">{t(application.type === 'spa' ? 'oauth.typeSpa' : 'oauth.typeWeb')}</p>
                <div className="developer-application-client"><span>{t('oauth.clientId')}</span><code>{application.clientId}</code></div>
            </Link>;
        })}</div>}
    </>;
}

function ManagedApplicationsPage({ locale }: { locale: Locale }) {
    const { t } = useTranslation();
    const location = useLocation();
    const [parameters, setParameters] = useSearchParams();
    const cursor = parameters.get('cursor');
    const lookupField = parameters.get('lookupField') ?? 'clientId';
    const lookupValue = parameters.get('lookupValue') ?? '';
    const requestQuery = pageParameters(location.search);
    const [searchDraft, setSearchDraft] = usePageDraft<{ field?: string; query?: string }>(`admin:applications-search:${requestQuery}`);
    const field = searchDraft?.field ?? lookupField;
    const query = searchDraft?.query ?? lookupValue;
    const setField = (field: string) => setSearchDraft({ ...searchDraft, field });
    const setQuery = (query: string) => setSearchDraft({ ...searchDraft, query });
    const applicationQuery = useResource<CursorPage<ApplicationItem> & { issuer: string }>('applications', `/api/admin/applications?${requestQuery}`, `admin:${requestQuery}`);
    const data = applicationQuery.data;
    function navigatePage(nextCursor: string | null) {
        const next = listParameters(location.search);
        if (nextCursor) next.set('cursor', nextCursor); else next.delete('cursor');
        setParameters(next);
    }
    return <>
        <div className="page-heading"><div><h1>{t('oauth.applicationsTitle')}</h1><p>{t('oauth.applicationsDescription')}</p></div></div>
        {applicationQuery.error && <CursorRecovery cursor={cursor} onReset={() => navigatePage(null)} />}
        <section className="card"><form className="search-bar" onSubmit={(event) => { event.preventDefault(); const value = query.trim(); setSearchDraft(undefined); setParameters(value ? { lookupField: field, lookupValue: value } : {}); }}><div className="search-field"><Select label={t('lookupField')} value={field} options={[{ value: 'clientId', label: t('oauth.clientId') }, { value: 'name', label: t('oauth.applicationName') }]} onChange={setField} /></div><div className="search-input"><TextField label={t('oauth.searchApplications')} value={query} onValueChange={setQuery} maxLength={254} supportingText={t('exactLookupHint')} /></div><Button className="secondary" type="submit">{t('search')}</Button></form>
        <ResourceFeedback query={applicationQuery} />
        {data && <><div className="table-scroll"><table>
            <thead><tr><th>{t('oauth.applicationName')}</th><th>{t('oauth.applicationType')}</th><th>{t('oauth.developer')}</th><th>{t('status')}</th><th>{t('created')}</th></tr></thead>
            <tbody>{data.items.map((application) => <tr key={application.clientId}>
                <td><Link className="application-name" to={listPath(localizedPath(locale, 'admin/applications/detail'), location.search, { clientId: application.clientId })}>{application.name}</Link><small className="application-id">{application.clientId}</small></td>
                <td>{t(application.type === 'spa' ? 'oauth.typeSpa' : 'oauth.typeWeb')}</td><td><ApplicationOwner owner={application.owner} locale={locale} /></td><td><Status disabled={application.disabled} adminSuspended={application.adminSuspended} ownerId={application.ownerId} /></td><td className="muted">{application.createdAt && !Number.isNaN(Date.parse(application.createdAt)) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(application.createdAt)) : '—'}</td>
            </tr>)}</tbody>
        </table></div>{data.items.length === 0 && <p className="empty-state">{t('oauth.managedApplicationsEmpty')}</p>}<PageNavigation pageInfo={data.pageInfo} count={data.items.length} cursor={cursor} onNavigate={navigatePage} /></>}
        </section>
    </>;
}

export function ApplicationsPage({ locale, area = 'admin' }: { locale: Locale; area?: ApplicationArea }) {
    return area === 'developer' ? <DeveloperApplicationsPage locale={locale} /> : <ManagedApplicationsPage locale={locale} />;
}

export function ApplicationEditor({ locale, create = false, area = 'admin' }: { locale: Locale; create?: boolean; area?: ApplicationArea }) {
    const { t, i18n } = useTranslation();
    const brand = useBranding();
    const feedback = useFeedback();
    const location = useLocation();
    const clientId = new URLSearchParams(location.search).get('clientId') ?? '';
    const apiPath = `/api/${area}/applications`;
    const applicationQuery = useResource<ApplicationResponse>('application', `${apiPath}/${encodeURIComponent(clientId)}`, `${area}:${clientId}`, !create);
    const [createdData, setCreatedData] = useState<Pick<ApplicationResponse, 'application' | 'issuer'>>();
    const application = createdData?.application ?? applicationQuery.data?.application;
    const issuer = createdData?.issuer ?? applicationQuery.data?.issuer ?? '';
    type FormValues = { name: string; type: 'web' | 'spa'; redirectUris: string; postLogoutRedirectUris: string; scopes: string[] };
    const [draft, setDraft, clearDraft] = usePageDraft<FormValues>(`${area}:application:${create ? 'new' : clientId}`);
    const editor = useRef<HTMLFormElement>(null);
    const focusError = useRef<ApplicationField | undefined>(undefined);
    const [fieldErrors, setFieldErrors] = useState<ApplicationFieldErrors>({});
    const form: FormValues = draft ?? {
        name: application?.name ?? '', type: application?.type ?? 'web', redirectUris: application?.redirectUris.join('\n') ?? '',
        postLogoutRedirectUris: application?.postLogoutRedirectUris.join('\n') ?? '', scopes: application?.scopes ?? ['openid', 'profile', 'email', 'offline_access'],
    };
    const { name, type, redirectUris, postLogoutRedirectUris, scopes } = form;
    function clearFieldError(field: ApplicationField) {
        setFieldErrors((current) => { const next = { ...current }; delete next[field]; return next; });
        setError(undefined);
    }
    const setName = (name: string) => { clearFieldError('name'); setDraft({ ...form, name }); };
    const setType = (type: 'web' | 'spa') => { clearFieldError('type'); setDraft({ ...form, type }); };
    const setRedirectUris = (redirectUris: string) => { clearFieldError('redirectUris'); setDraft({ ...form, redirectUris }); };
    const setPostLogoutRedirectUris = (postLogoutRedirectUris: string) => { clearFieldError('postLogoutRedirectUris'); setDraft({ ...form, postLogoutRedirectUris }); };
    const setScopes = (update: (current: string[]) => string[]) => { clearFieldError('scopes'); setDraft({ ...form, scopes: update(scopes) }); };
    const dataActions = useDataActions();
    const [secret, setSecret] = useState<string>();
    const captureSecrets = useClearSecrets(() => { setSecret(undefined); setConfirmation(undefined); setControlError(undefined); }, `${area}:${create ? 'new' : clientId}`);
    const [error, setError] = useState<string>();
    const [controlError, setControlError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [confirmation, setConfirmation] = useState<'disable' | 'rotate'>();
    const created = create && !!application;
    const restricted = area === 'developer' && !!application?.adminSuspended;
    const disabled = busy || restricted;
    const controlDisabled = !!application && (area === 'developer' ? application.ownerDisabled : application.adminSuspended);
    const adminRestriction = area === 'admin' && !!application?.ownerId;
    const controlLabel = adminRestriction ? controlDisabled ? 'oauth.removeRestriction' : 'oauth.restrictApplication' : controlDisabled ? 'oauth.restoreApplication' : 'oauth.disableApplication';
    useEffect(() => {
        if (restricted) { setSecret(undefined); setConfirmation(undefined); setControlError(undefined); }
    }, [restricted]);
    useEffect(() => {
        const field = focusError.current;
        if (!field) return;
        focusError.current = undefined;
        const element = editor.current?.querySelector<HTMLElement>(`[name="${field}"]`);
        element?.focus({ preventScroll: true });
        element?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }, [fieldErrors]);
    function showFieldErrors(errors: ApplicationFieldErrors) {
        focusError.current = applicationFields.find((field) => errors[field]);
        setFieldErrors(errors);
    }
    function fieldFeedback(field: ApplicationField) {
        return { error: !!fieldErrors[field], errorText: fieldErrors[field] ? t(`oauth.validation.${fieldErrors[field]}`) : '' };
    }

    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault(); if (disabled || area !== 'developer') return;
        setError(undefined);
        const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const input = (create ? applicationCreateSchema : applicationUpdateSchema).safeParse({
            name: name.trim(), ...(create ? { type } : {}),
            redirectUris: lines(redirectUris), postLogoutRedirectUris: lines(postLogoutRedirectUris), scopes,
        });
        if (!input.success) { showFieldErrors(applicationFieldErrors(input.error)); return; }
        setFieldErrors({});
        const secretsCurrent = captureSecrets();
        setBusy(true);
        try {
            const data = await fetchJson<ApplicationResponse>(create ? apiPath : `${apiPath}/${encodeURIComponent(clientId)}`, input.data, undefined, create ? 'POST' : 'PATCH');
            if (create && secretsCurrent()) setCreatedData({ application: data.application, issuer: data.issuer });
            if (secretsCurrent()) setSecret(data.clientSecret);
            await dataActions.applicationsSaved(); clearDraft(draft);
            feedback.success(t(create ? 'oauth.applicationCreated' : 'oauth.applicationSaved'));
        } catch (cause) {
            const code = dataActions.fail(cause);
            const fields = cause instanceof ApiError && cause.fieldErrors ? Object.fromEntries(applicationFields
                .filter((field) => cause.fieldErrors?.[field] && i18n.exists(`oauth.validation.${cause.fieldErrors[field]}`))
                .map((field) => [field, cause.fieldErrors![field]])) as ApplicationFieldErrors : {};
            if (code === 'INVALID_INPUT' && Object.keys(fields).length) showFieldErrors(fields);
            else setError(code);
            if (code === 'APPLICATION_SUSPENDED' || code === 'APPLICATION_CONFLICT') await dataActions.invalidate('application', 'applications');
        }
        finally { setBusy(false); }
    }

    async function control(kind: 'disable' | 'enable' | 'rotate') {
        if (!application || disabled || (kind === 'rotate' && area !== 'developer')) return;
        const secretsCurrent = captureSecrets();
        setBusy(true); setControlError(undefined);
        const path = `${apiPath}/${encodeURIComponent(application.clientId)}`;
        try {
            if (kind === 'rotate') {
                const data = await fetchJson<{ clientSecret: string }>(`${path}/rotate-secret`, {});
                setConfirmation(undefined);
                if (secretsCurrent()) setSecret(data.clientSecret);
            } else {
                await fetchJson<ApplicationResponse>(path, { disabled: kind === 'disable' }, undefined, 'PATCH');
            }
            await dataActions.applicationsSaved(); setConfirmation(undefined);
            feedback.success(t('oauth.applicationSaved'));
        } catch (cause) {
            const code = dataActions.fail(cause); setControlError(code);
            if (code === 'APPLICATION_SUSPENDED' || code === 'APPLICATION_CONFLICT') await dataActions.invalidate('application', 'applications');
        }
        finally { setBusy(false); }
    }

    return <>
        {!restricted && <ApplicationActionDialog secret={secret} confirmation={confirmation} busy={busy} error={controlError}
            restrict={adminRestriction} onCancel={() => { setSecret(undefined); setConfirmation(undefined); setControlError(undefined); }} onConfirm={() => { if (confirmation) void control(confirmation); }} />}
        <ButtonLink variant="text" className="detail-back" to={listPath(localizedPath(locale, `${area}/applications`), location.search)}>{t('oauth.backToApplications')}</ButtonLink>
        <div className="page-heading"><div><h1>{t(create ? 'oauth.createApplication' : 'oauth.applicationDetails')}</h1><p>{application?.name ?? t(area === 'developer' ? 'oauth.developerApplicationsDescription' : 'oauth.applicationsDescription', { brand: brand.name })}</p></div>{application && <Status disabled={application.disabled} adminSuspended={application.adminSuspended} ownerId={application.ownerId} />}</div>
        {!create && <ResourceFeedback query={applicationQuery} />}
        {area === 'developer' && (created ? <ButtonLink to={listPath(localizedPath(locale, 'developer/applications/detail'), location.search, { clientId: application.clientId })}>{t('oauth.applicationDetails')}</ButtonLink> : (create || application) && <section className="card"><form ref={editor} className="card-body stack-form" onSubmit={(event) => { void save(event); }}>
            <ErrorNotice code={error} />
            <TextField name="name" label={t('oauth.applicationName')} value={name} onValueChange={setName} maxLength={100} required disabled={disabled} supportingText={t('oauth.applicationNameHint')} {...fieldFeedback('name')} />
            {create ? <Select name="type" label={t('oauth.applicationType')} value={type} options={[{ value: 'web', label: t('oauth.typeWeb') }, { value: 'spa', label: t('oauth.typeSpa') }]} onChange={(value) => setType(value === 'spa' ? 'spa' : 'web')} disabled={disabled} {...fieldFeedback('type')} /> : <TextField label={t('oauth.applicationType')} value={t(type === 'spa' ? 'oauth.typeSpa' : 'oauth.typeWeb')} readOnly supportingText={t('oauth.typeFixed')} />}
            {create && <p className="muted">{t(type === 'spa' ? 'oauth.typeSpaHint' : 'oauth.typeWebHint')}</p>}
            <TextField name="redirectUris" label={t('oauth.redirectUris')} type="textarea" value={redirectUris} onValueChange={setRedirectUris} required maxLength={8192} disabled={disabled} supportingText={t('oauth.redirectUrisHint')} {...fieldFeedback('redirectUris')} />
            <TextField name="postLogoutRedirectUris" label={t('oauth.postLogoutRedirectUris')} type="textarea" value={postLogoutRedirectUris} onValueChange={setPostLogoutRedirectUris} required maxLength={8192} disabled={disabled} supportingText={t('oauth.postLogoutRedirectUrisHint', { brand: brand.name })} {...fieldFeedback('postLogoutRedirectUris')} />
            <fieldset className="scope-options" name="scopes" tabIndex={-1} aria-describedby={fieldErrors.scopes ? 'application-scopes-error' : undefined}><legend>{t('oauth.allowedScopes')}</legend><p className="muted">{t('oauth.scopesHint')}</p><p className="muted">{t('oauth.openidRequired')}</p>{['profile', 'email', 'offline_access'].map((scope) => <Checkbox key={scope} label={t(`oauth.scope_${scope}`)} checked={scopes.includes(scope)} disabled={disabled} onCheckedChange={(checked) => setScopes((current) => checked ? [...current, scope] : current.filter((value) => value !== scope))} />)}{fieldErrors.scopes && <p className="field-error" role="alert" id="application-scopes-error">{t(`oauth.validation.${fieldErrors.scopes}`)}</p>}</fieldset>
            <div className="form-footer">{draft && <Button className="text-button" disabled={disabled} onClick={() => { setDraft(undefined); setFieldErrors({}); setError(undefined); }}>{t('discardDraft')}</Button>}<Button type="submit" busy={busy} disabled={restricted}>{t(create ? 'oauth.createApplication' : 'save')}</Button></div>
        </form></section>)}
        {application && area === 'admin' && <ApplicationDetails application={application} locale={locale} />}
        {application && area === 'developer' && <ConnectionDetails application={application} issuer={issuer} />}
        {!!application?.apiScopes?.length && <section className="card"><div className="card-heading"><h2>{t('access.applicationPermissions')}</h2><p>{t('access.applicationPermissionsDescription')}</p></div><div className="card-body access-items">{application.apiScopes.map((scope) => <code className="break-all" key={scope}>{scope}</code>)}</div></section>}
        {application && !create && <section className="card"><div className="card-heading"><h2>{t(area === 'admin' ? 'oauth.manageApplication' : 'oauth.applicationControls')}</h2><p>{t(area === 'admin' ? 'oauth.manageApplicationDescription' : restricted ? 'oauth.adminSuspendedDescription' : 'oauth.controlsDescription')}</p></div><div className="card-body stack-form">
            {!confirmation && <ErrorNotice code={controlError} />}
            <div className="action-row"><Button className={controlDisabled ? 'primary' : 'danger-button'} busy={busy} disabled={restricted} onClick={() => { setControlError(undefined); if (controlDisabled) void control('enable'); else setConfirmation('disable'); }}>{t(controlLabel)}</Button>
            {area === 'developer' && application.type === 'web' && <Button className="secondary" busy={busy} disabled={restricted} onClick={() => { setControlError(undefined); setConfirmation('rotate'); }}>{t('oauth.rotateSecret')}</Button>}</div>
        </div></section>}
    </>;
}
