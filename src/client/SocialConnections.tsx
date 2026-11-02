import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { connectionTypes, defaultConnectionConfig, type ConnectionConfig, type ConnectionType, type SocialConnection } from '../shared/social';
import { fetchJson } from './api';
import { Button, Checkbox, ConfirmationDialog, FormDialog, Select, TextField } from './material';
import { ResourceFeedback, useDataActions, useResource } from './data';
import { useClearSecrets } from './page-state';
import { ErrorNotice, useFeedback } from './feedback';
import { resolveLocale } from './locale';

type Draft = Pick<SocialConnection, 'name' | 'type' | 'config' | 'enabled' | 'archived' | 'position' | 'revision'> & { id?: string; callbackURL?: string; linkedAccounts?: number; identityLocked?: boolean };
const guides = { google: 'https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred', github: 'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app', oidc: 'https://openid.net/specs/openid-connect-discovery-1_0.html', oauth2: 'https://www.rfc-editor.org/rfc/rfc6749' };
export function SocialConnectionsPage() {
    const { t } = useTranslation();
    const feedback = useFeedback();
    const query = useResource<{ connections: SocialConnection[] }>('social-connections', '/api/admin/social-connections');
    const actions = useDataActions();
    const [draft, setDraft] = useState<Draft>(), [secret, setSecret] = useState('');
    const [scopes, setScopes] = useState('');
    const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [archive, setArchive] = useState(false);
    useClearSecrets(() => setSecret(''));
    function edit(value: Partial<Draft>) { setDraft((current) => current && { ...current, ...value }); setError(undefined); }
    function config(value: Partial<ConnectionConfig>) { if (draft) edit({ config: { ...draft.config, ...value } }); }
    function open(value?: SocialConnection) {
        setDraft(value ?? { name: '', type: 'google', config: defaultConnectionConfig('google'), enabled: false, archived: false, position: 0, revision: 0 });
        setSecret(''); setError(undefined); setArchive(false);
        setScopes((value?.config ?? defaultConnectionConfig('google')).scopes.join(' '));
    }
    function closeEditor() { setDraft(undefined); setSecret(''); setError(undefined); setArchive(false); }
    async function save(archived = false) {
        if (!draft || busy) return;
        setBusy(true); setError(undefined);
        try {
            const { id, name, type, config, enabled, position, revision } = draft;
            const result = await fetchJson<SocialConnection>(`/api/admin/social-connections${id ? `/${id}` : ''}`, { name, type, config: { ...config, scopes: scopes.trim().split(/\s+/).filter(Boolean) }, enabled, position, revision, archived, ...(secret ? { clientSecret: secret } : {}) }, undefined, id ? 'PATCH' : 'POST');
            if (archived) closeEditor();
            else { setDraft(result); setSecret(''); }
            await actions.socialSaved(); feedback.success(t('saved'));
        } catch (cause) { setError(actions.fail(cause)); } finally { setBusy(false); }
    }
    function submit(event: FormEvent) { event.preventDefault(); void save(); }
    const locked = !!draft?.identityLocked, disabled = busy || !!draft?.archived;
    return <><div className="page-heading"><div><h1>{t('social.title')}</h1><p>{t('social.description')}</p></div><Button disabled={busy} onClick={() => open()}>{t('social.create')}</Button></div>
        <ResourceFeedback query={query} />
        {query.data && !query.data.connections.length && !draft && <p className="empty-state">{t('social.noConnections')}</p>}
        {query.data && <section className="social-connection-list">{query.data.connections.map((item) => <div className="card" key={item.id}><div className="card-body social-identity"><div><strong>{item.name}</strong><p className="muted">{item.type.toUpperCase()} · {t(item.archived ? 'social.archived' : item.enabled ? 'social.enabled' : 'social.unavailable')}</p></div><Button className="secondary" disabled={busy} onClick={() => open(item)}>{t('social.edit')}</Button></div></div>)}</section>}
        {draft && !archive && <FormDialog title={t(draft.id ? 'social.edit' : 'social.create')} cancelLabel={t('cancel')} confirmLabel={draft.archived ? undefined : t('save')} onCancel={closeEditor} onSubmit={submit} busy={busy} confirmDisabled={disabled}>
            {!draft.id && <p>{t('social.disabledDefault')}</p>}
            <ErrorNotice code={error} />
            {locked && <p>{t('social.identityLocked')}</p>}
            <TextField label={t('social.name')} value={draft.name} onValueChange={(name) => edit({ name })} maxLength={100} required disabled={disabled} />
            <Select label={t('social.type')} value={draft.type} options={connectionTypes.map((type) => ({ value: type, label: type === 'oauth2' ? 'OAuth 2.0' : type === 'oidc' ? 'OpenID Connect' : type === 'google' ? 'Google' : 'GitHub' }))} disabled={disabled || locked} onChange={(value) => { const type = value as ConnectionType; edit({ type, config: defaultConnectionConfig(type) }); setScopes(defaultConnectionConfig(type).scopes.join(' ')); }} />
            <a href={guides[draft.type]} target="_blank" rel="noreferrer">{t('social.guide')}</a>
            <TextField label={t('social.clientId')} value={draft.config.clientId} onValueChange={(clientId) => config({ clientId })} maxLength={512} required disabled={disabled || locked} />
            <TextField label={t('social.secret')} value={secret} onValueChange={setSecret} type="password" autoComplete="new-password" maxLength={4096} required={!draft.id} disabled={disabled} supportingText={t('social.secretHint')} />
            {draft.type === 'oidc' && <>{(['issuer', 'discoveryUrl'] as const).map((key) => <TextField key={key} label={t(`social.${key}`)} value={draft.config[key] ?? ''} onValueChange={(value) => config({ [key]: value })} maxLength={2048} required disabled={disabled || locked} />)}</>}
            {draft.type === 'oauth2' && <>{(['authorizationUrl', 'tokenUrl', 'userInfoUrl'] as const).map((key) => <TextField key={key} label={t(`social.${key}`)} value={draft.config[key] ?? ''} onValueChange={(value) => config({ [key]: value })} maxLength={2048} required disabled={disabled || locked} />)}<h3>{t('social.fields')}</h3>{(['subject', 'name', 'email', 'emailVerified', 'image'] as const).map((key) => <TextField key={key} label={t(`social.${key === 'name' ? 'profileName' : key}`)} value={draft.config.fields[key]} onValueChange={(value) => config({ fields: { ...draft.config.fields, [key]: value } })} maxLength={100} required={key === 'subject'} disabled={disabled || locked && key === 'subject'} />)}</>}
            <TextField label={t('social.scopes')} value={scopes} onValueChange={setScopes} maxLength={4000} disabled={disabled} />
            {['oidc', 'oauth2'].includes(draft.type) && <Select label={t('social.tokenAuth')} value={draft.config.tokenAuth} options={['client_secret_basic', 'client_secret_post'].map((value) => ({ value, label: value }))} onChange={(value) => config({ tokenAuth: value as ConnectionConfig['tokenAuth'] })} disabled={disabled} />}
            <TextField label={t('social.position')} value={String(draft.position)} onValueChange={(value) => edit({ position: Number(value) })} pattern="[0-9]{1,5}" required disabled={disabled} />
            {draft.id && <><TextField label={t('social.callback')} value={draft.callbackURL ?? ''} readOnly supportingText={t('social.callbackHint')} /><Checkbox label={t('social.enabled')} checked={draft.enabled} onCheckedChange={(enabled) => edit({ enabled })} disabled={disabled} /></>}
            {draft.id && !draft.archived && <div className="action-row"><Button className="secondary" disabled={disabled} onClick={() => { setBusy(true); setError(undefined); void fetchJson<{ url: string }>(`/api/admin/social-connections/${draft.id}/test`, { locale: resolveLocale(window.location.pathname) }).then((result) => window.location.assign(result.url)).catch((cause) => { setError(actions.fail(cause)); setBusy(false); }); }}>{t('social.test')}</Button><Button className="text-button danger" disabled={disabled} onClick={() => { setError(undefined); setArchive(true); }}>{t('social.archive')}</Button></div>}
        </FormDialog>}
        {archive && <ConfirmationDialog title={t('social.archive')} description={t('social.archiveConfirm')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} busy={busy} error={<ErrorNotice code={error} />} onCancel={() => { setArchive(false); setError(undefined); }} onConfirm={() => { void save(true); }} />}
    </>;
}
