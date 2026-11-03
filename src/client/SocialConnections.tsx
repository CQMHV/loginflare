import { useMemo, useRef, useState, type FormEvent } from 'react';
import { DragDropProvider, type DragEndEvent, type DragOverEvent, type DragStartEvent } from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import { Accessibility, defaultPreset } from '@dnd-kit/dom';
import { useTranslation } from 'react-i18next';
import { connectionTypes, defaultConnectionConfig, type ConnectionConfig, type ConnectionType, type SocialConnection } from '../shared/social';
import { fetchJson } from './api';
import { Button, Checkbox, ConfirmationDialog, FormDialog, Select, TextField } from './material';
import { ResourceFeedback, useDataActions, useResource } from './data';
import { useClearSecrets } from './page-state';
import { ErrorNotice, useFeedback } from './feedback';
import { resolveLocale } from './locale';
import { ToolbarIcon } from './ToolbarIcon';

type Draft = Pick<SocialConnection, 'name' | 'type' | 'config' | 'enabled' | 'archived' | 'revision'> & { id?: string; callbackURL?: string; linkedAccounts?: number; identityLocked?: boolean };
const guides = { google: 'https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred', github: 'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app', oidc: 'https://openid.net/specs/openid-connect-discovery-1_0.html', oauth2: 'https://www.rfc-editor.org/rfc/rfc6749' };

function SortableConnection({ item, index, disabled, editDisabled, onEdit }: { item: SocialConnection; index: number; disabled: boolean; editDisabled: boolean; onEdit: () => void }) {
    const { t } = useTranslation();
    const { ref, handleRef, isDragSource } = useSortable({ id: item.id, index, disabled, data: { name: item.name } });
    return <div ref={ref} role="listitem" data-connection-id={item.id} className={`card social-sortable-connection${isDragSource ? ' is-dragging' : ''}`}>
        <div className="card-body social-sortable-row">
            <button ref={handleRef} type="button" className="social-drag-handle" aria-label={t('social.reorder', { name: item.name })} aria-roledescription={t('social.sortable')} aria-disabled={disabled} tabIndex={disabled ? -1 : 0}><ToolbarIcon name="drag_indicator" /></button>
            <div className="social-provider-details"><div><strong>{item.name}</strong><p className="muted">{item.type.toUpperCase()} · {t(item.archived ? 'social.archived' : item.enabled ? 'social.enabled' : 'social.unavailable')}</p></div></div>
            <Button className="secondary" disabled={editDisabled} onClick={onEdit}>{t('social.edit')}</Button>
        </div>
    </div>;
}
export function SocialConnectionsPage() {
    const { t } = useTranslation();
    const feedback = useFeedback();
    const query = useResource<{ connections: SocialConnection[] }>('social-connections', '/api/admin/social-connections');
    const actions = useDataActions();
    const [draft, setDraft] = useState<Draft>(), [secret, setSecret] = useState('');
    const [scopes, setScopes] = useState('');
    const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [archive, setArchive] = useState(false);
    const [localOrder, setLocalOrder] = useState<SocialConnection[]>();
    const [dragging, setDragging] = useState(false);
    const dragSnapshot = useRef<SocialConnection[]>([]);
    const connections = localOrder ?? query.data?.connections ?? [];
    const dragPlugins = useMemo(() => [...defaultPreset.plugins.filter((plugin) => plugin !== Accessibility), Accessibility.configure({
        screenReaderInstructions: { draggable: t('social.sortInstructions') },
        announcements: {
            dragstart: ({ operation: { source } }: DragStartEvent) => source ? t('social.sortStarted', { name: source.data.name }) : undefined,
            dragover: ({ operation: { source } }: DragOverEvent) => isSortable(source) ? t('social.sortMoved', { name: source.data.name, position: source.index + 1 }) : undefined,
            dragend: ({ canceled, operation: { source } }: DragEndEvent) => source ? t(canceled ? 'social.sortCancelled' : 'social.sortDropped', { name: source.data.name }) : undefined,
        },
    })], [t]);
    const capture = useClearSecrets(() => setSecret(''));
    function edit(value: Partial<Draft>) { setDraft((current) => current && { ...current, ...value }); setError(undefined); }
    function config(value: Partial<ConnectionConfig>) { if (draft) edit({ config: { ...draft.config, ...value } }); }
    function open(value?: SocialConnection) {
        setDraft(value ?? { name: '', type: 'google', config: defaultConnectionConfig('google'), enabled: false, archived: false, revision: 0 });
        setSecret(''); setError(undefined); setArchive(false);
        setScopes((value?.config ?? defaultConnectionConfig('google')).scopes.join(' '));
    }
    function closeEditor() { setDraft(undefined); setSecret(''); setError(undefined); setArchive(false); }
    async function save(archived = false) {
        if (!draft || busy) return;
        setBusy(true); setError(undefined);
        try {
            const { id, name, type, config, enabled, revision } = draft;
            const result = await fetchJson<SocialConnection>(`/api/admin/social-connections${id ? `/${id}` : ''}`, { name, type, config: { ...config, scopes: scopes.trim().split(/\s+/).filter(Boolean) }, enabled, revision, archived, ...(secret ? { clientSecret: secret } : {}) }, undefined, id ? 'PATCH' : 'POST');
            if (archived) closeEditor();
            else { setDraft(result); setSecret(''); }
            await actions.socialSaved(); feedback.success(t('saved'));
        } catch (cause) { setError(actions.fail(cause)); } finally { setBusy(false); }
    }
    async function reorder(event: DragEndEvent) {
        setDragging(false);
        const source = event.operation.source;
        if (event.canceled || !isSortable(source) || source.initialIndex === source.index) { setLocalOrder(undefined); return; }
        const previous = dragSnapshot.current, next = [...previous];
        const [moved] = next.splice(source.initialIndex, 1);
        if (!moved) { setLocalOrder(undefined); return; }
        next.splice(source.index, 0, moved);
        const active = capture();
        setLocalOrder(next); setBusy(true);
        try {
            await fetchJson('/api/admin/social-connections/reorder', { order: next.map((item) => item.id), previousOrder: previous.map((item) => item.id) });
            await actions.socialSaved();
            if (active()) feedback.success(t('saved'));
        } catch (cause) {
            if (active()) feedback.error(t(`errors.${actions.fail(cause)}`, { defaultValue: t('errors.UNKNOWN_ERROR') }));
            await actions.socialSaved();
        } finally { if (active()) { setLocalOrder(undefined); setBusy(false); } }
    }
    function submit(event: FormEvent) { event.preventDefault(); void save(); }
    const locked = !!draft?.identityLocked, disabled = busy || !!draft?.archived;
    return <><div className="page-heading"><div><h1>{t('social.title')}</h1><p>{t('social.description')}</p></div><Button disabled={busy || dragging} onClick={() => open()}>{t('social.create')}</Button></div>
        <ResourceFeedback query={query} />
        {query.data && !query.data.connections.length && !draft && <p className="empty-state">{t('social.noConnections')}</p>}
        {query.data && <DragDropProvider plugins={dragPlugins} onBeforeDragStart={(event) => { if (busy || draft) event.preventDefault(); }} onDragStart={() => { dragSnapshot.current = connections; setLocalOrder(connections); setDragging(true); }} onDragEnd={(event) => { void reorder(event); }}>
            <section className="social-connection-list" role="list" aria-label={t('social.title')} aria-busy={busy}>{connections.map((item, index) => <SortableConnection key={item.id} item={item} index={index} disabled={busy || !!draft || connections.length < 2} editDisabled={busy || dragging} onEdit={() => open(item)} />)}</section>
        </DragDropProvider>}
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
            {draft.id && <><TextField label={t('social.callback')} value={draft.callbackURL ?? ''} readOnly supportingText={t('social.callbackHint')} /><Checkbox label={t('social.enabled')} checked={draft.enabled} onCheckedChange={(enabled) => edit({ enabled })} disabled={disabled} /></>}
            {draft.id && !draft.archived && <div className="action-row"><Button className="secondary" disabled={disabled} onClick={() => { setBusy(true); setError(undefined); void fetchJson<{ url: string }>(`/api/admin/social-connections/${draft.id}/test`, { locale: resolveLocale(window.location.pathname) }).then((result) => window.location.assign(result.url)).catch((cause) => { setError(actions.fail(cause)); setBusy(false); }); }}>{t('social.test')}</Button><Button className="text-button danger" disabled={disabled} onClick={() => { setError(undefined); setArchive(true); }}>{t('social.archive')}</Button></div>}
        </FormDialog>}
        {archive && <ConfirmationDialog title={t('social.archive')} description={t('social.archiveConfirm')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} busy={busy} error={<ErrorNotice code={error} />} onCancel={() => { setArchive(false); setError(undefined); }} onConfirm={() => { void save(true); }} />}
    </>;
}
