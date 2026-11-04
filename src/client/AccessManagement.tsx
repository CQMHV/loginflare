import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { localizedPath, type Locale } from '../shared/locales';
import { ApiError, fetchJson } from './api';
import { Button, ButtonLink, Checkbox, ConfirmationDialog, FormDialog, Select, TextField } from './material';
import { ErrorNotice, useFeedback } from './feedback';
import { ResourceFeedback, useDataActions, useResource } from './data';
import { CursorRecovery, listParameters, listPath, pageParameters, PageNavigation, type CursorPage } from './pagination';
import { useClearSecrets } from './page-state';

const base = '/api/admin/access';
interface ApiResource { id: string; name: string; identifier: string; description: string; disabled: boolean; accessTokenTtl: number | null; createdAt: string }
interface Permission { id: string; resourceId: string; name: string; scope: string; description: string }
interface Role { id: string; name: string; description: string; createdAt: string }
interface RoleDetail extends Role { permissionIds: string[]; permissions: Permission[] }
interface ResourceDetail extends ApiResource { permissions: Permission[] }
interface AllowedApplication { clientId: string; name: string; createdAt: string }
interface AuditEvent {
    id: string; event: string; outcome: string; actorUserId: string | null; targetUserId: string | null; clientId: string | null;
    targetType: string | null; targetId: string | null; reason: string | null; requestId: string; ipAddress: string | null; userAgent: string | null; createdAt: string;
}

function useAccessWrite() {
    const { t } = useTranslation(), actions = useDataActions(), feedback = useFeedback();
    const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [fields, setFields] = useState<Record<string, string>>({});
    const capture = useClearSecrets(() => { setBusy(false); setError(undefined); setFields({}); });
    function clear() { setError(undefined); setFields({}); }
    async function run(path: string, body: unknown, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', done: () => void) {
        if (busy) return;
        const current = capture(); setBusy(true); clear();
        try {
            await fetchJson(path, body, undefined, method);
            await actions.accessSaved();
            if (current()) { done(); feedback.success(t('saved')); }
        } catch (cause) {
            const code = actions.fail(cause);
            if (current()) {
                if (cause instanceof ApiError && cause.fieldErrors && Object.keys(cause.fieldErrors).length) setFields(cause.fieldErrors);
                else setError(code === 'INVALID_INPUT' ? 'ACCESS_INPUT_INVALID' : code);
            }
        } finally { if (current()) setBusy(false); }
    }
    function field(name: string) { const value = fields[name]; return value ? t(`errors.${value}`, { defaultValue: t('access.invalidField') }) : undefined; }
    return { busy, error, clear, run, field, fields, setFields };
}

function useListState(defaultField: string) {
    const location = useLocation(), [parameters, setParameters] = useSearchParams();
    const [field, setField] = useState(parameters.get('lookupField') ?? defaultField), [value, setValue] = useState(parameters.get('lookupValue') ?? '');
    const cursor = parameters.get('cursor'), query = pageParameters(location.search);
    useEffect(() => { const search = new URLSearchParams(location.search); setField(search.get('lookupField') ?? defaultField); setValue(search.get('lookupValue') ?? ''); }, [location.search, defaultField]);
    function navigatePage(nextCursor: string | null) { const next = listParameters(location.search); if (nextCursor) next.set('cursor', nextCursor); else next.delete('cursor'); setParameters(next); }
    function search() { setParameters(value.trim() ? { lookupField: field, lookupValue: value.trim() } : {}); }
    return { location, cursor, query, field, setField, value, setValue, navigatePage, search };
}

function SearchBar({ state, fields, label, nameLabel }: { state: ReturnType<typeof useListState>; fields: string[]; label: string; nameLabel?: string }) {
    const { t } = useTranslation();
    return <form className="search-bar" onSubmit={(event) => { event.preventDefault(); state.search(); }}>
        <div className="search-field"><Select label={t('lookupField')} value={state.field} options={fields.map((value) => ({ value, label: value === 'name' ? nameLabel ?? t('access.resourceName') : t(`access.${value}`) }))} onChange={state.setField} /></div>
        <div className="search-input"><TextField label={label} value={state.value} onValueChange={state.setValue} maxLength={254} /></div><Button className="secondary" type="submit">{t('search')}</Button>
    </form>;
}

function SelectionList({ kind, selected, onChange, disabled }: { kind: 'permissions' | 'roles'; selected: string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
    const { t } = useTranslation(), [cursor, setCursor] = useState<string | null>(null);
    const query = useResource<CursorPage<Permission | Role>>('access', `${base}/${kind}?${new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) })}`, `picker:${kind}:${cursor ?? ''}`);
    return <fieldset className="access-selection" disabled={disabled}><legend>{t(kind === 'permissions' ? 'access.choosePermissions' : 'access.chooseRoles')}</legend>
        <ResourceFeedback query={query} />
        {query.data && <><div className="access-selection-items">{query.data.items.map((item) => <Checkbox key={item.id} label={'scope' in item ? `${item.name} (${item.scope})` : item.name} checked={selected.includes(item.id)} disabled={disabled} onCheckedChange={(checked) => onChange(checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} />)}
            {!query.data.items.length && <p className="muted">{t('access.noChoices')}</p>}</div>
            <small className="muted">{t('access.selectedCount', { count: selected.length })}</small>
            <PageNavigation pageInfo={query.data.pageInfo} count={query.data.items.length} cursor={cursor} onNavigate={setCursor} />
        </>}
    </fieldset>;
}

function ResourceDialog({ value, onClose }: { value: ApiResource | null; onClose: () => void }) {
    const { t } = useTranslation(), mutation = useAccessWrite();
    const [name, setName] = useState(value?.name ?? ''), [identifier, setIdentifier] = useState(value?.identifier ?? ''), [description, setDescription] = useState(value?.description ?? '');
    const [ttl, setTtl] = useState(String(value?.accessTokenTtl ?? 300)), [disabled, setDisabled] = useState(value?.disabled ?? false);
    function submit() {
        const fields: Record<string, string> = {};
        if (!name.trim()) fields.name = 'ACCESS_NAME_REQUIRED';
        if (!value) { try { const uri = new URL(identifier); if (uri.protocol !== 'https:' || uri.search || uri.hash || uri.username || uri.password || identifier !== identifier.trim()) fields.identifier = 'ACCESS_IDENTIFIER_INVALID'; } catch { fields.identifier = 'ACCESS_IDENTIFIER_INVALID'; } }
        if (!/^\d+$/.test(ttl) || Number(ttl) < 60 || Number(ttl) > 3600) fields.accessTokenTtl = 'ACCESS_TTL_INVALID';
        mutation.clear(); mutation.setFields(fields); if (Object.keys(fields).length) return;
        void mutation.run(`${base}/resources${value ? `/${value.id}` : ''}`, { name: name.trim(), description: description.trim(), accessTokenTtl: Number(ttl), ...(value ? { disabled } : { identifier }) }, value ? 'PATCH' : 'POST', onClose);
    }
    return <FormDialog title={t(value ? 'access.editResource' : 'access.createResource')} cancelLabel={t('cancel')} confirmLabel={t('save')} onCancel={onClose} onSubmit={submit} busy={mutation.busy}>
        <ErrorNotice code={mutation.error} />
        <TextField label={t('access.resourceName')} value={name} onValueChange={setName} maxLength={100} required error={!!mutation.fields.name} errorText={mutation.field('name')} disabled={mutation.busy} />
        <TextField label={t('access.identifier')} value={identifier} onValueChange={setIdentifier} maxLength={2048} required readOnly={!!value} error={!!mutation.fields.identifier} errorText={mutation.fields.identifier === 'ACCESS_IDENTIFIER_INVALID' ? t('access.invalidIdentifier') : mutation.field('identifier')} disabled={mutation.busy} />
        <TextField label={t('access.description')} type="textarea" value={description} onValueChange={setDescription} maxLength={1000} error={!!mutation.fields.description} errorText={mutation.field('description')} disabled={mutation.busy} />
        <TextField label={t('access.tokenLifetime')} value={ttl} onValueChange={setTtl} inputMode="numeric" maxLength={4} required error={!!mutation.fields.accessTokenTtl} errorText={mutation.fields.accessTokenTtl ? t('access.invalidLifetime') : undefined} disabled={mutation.busy} />
        {value && <Checkbox label={t('access.enabled')} checked={!disabled} onCheckedChange={(checked) => setDisabled(!checked)} disabled={mutation.busy} />}
    </FormDialog>;
}

export function ApiResourcesPage({ locale }: { locale: Locale }) {
    const { t } = useTranslation(), state = useListState('name');
    const query = useResource<CursorPage<ApiResource>>('access', `${base}/resources?${state.query}`, `resources:${state.query}`);
    const [editing, setEditing] = useState(false);
    return <><div className="page-heading"><div><h1>{t('access.resources')}</h1><p>{t('access.resourcesDescription')}</p></div><Button onClick={() => setEditing(true)}>{t('access.createResource')}</Button></div>
        <section className="card user-table-card"><SearchBar state={state} fields={['name', 'identifier']} label={t('access.searchResources')} />
            {query.error && <CursorRecovery cursor={state.cursor} onReset={() => state.navigatePage(null)} />}<ResourceFeedback query={query} />
            {query.data && <><div className="table-scroll"><table><thead><tr><th>{t('access.resourceName')}</th><th>{t('access.identifier')}</th><th>{t('status')}</th><th><span className="sr-only">{t('access.details')}</span></th></tr></thead>
                <tbody>{query.data.items.map((item) => <tr key={item.id}><td><Link to={listPath(localizedPath(locale, 'admin/access/resources/detail'), state.location.search, { id: item.id })}>{item.name}</Link></td><td><code className="break-all">{item.identifier}</code></td><td>{t(item.disabled ? 'access.disabled' : 'access.enabled')}</td><td><ButtonLink variant="text" to={listPath(localizedPath(locale, 'admin/access/resources/detail'), state.location.search, { id: item.id })} aria-label={`${t('access.details')}: ${item.name}`}>{t('access.details')}</ButtonLink></td></tr>)}</tbody></table>
                {!query.data.items.length && <p className="empty-state">{t('access.emptyResources')}</p>}</div><PageNavigation pageInfo={query.data.pageInfo} count={query.data.items.length} cursor={state.cursor} onNavigate={state.navigatePage} /></>}
        </section>{editing && <ResourceDialog value={null} onClose={() => setEditing(false)} />}
    </>;
}

function PermissionDialog({ resourceId, value, onClose }: { resourceId: string; value: Permission | null; onClose: () => void }) {
    const { t } = useTranslation(), mutation = useAccessWrite();
    const [name, setName] = useState(value?.name ?? ''), [scope, setScope] = useState(value?.scope ?? ''), [description, setDescription] = useState(value?.description ?? '');
    function submit() {
        const fields: Record<string, string> = {};
        if (!name.trim()) fields.name = 'ACCESS_NAME_REQUIRED';
        if (!value && !/^[a-z][a-z0-9:_./-]{0,99}$/.test(scope)) fields.scope = 'ACCESS_SCOPE_INVALID';
        mutation.clear(); mutation.setFields(fields); if (Object.keys(fields).length) return;
        void mutation.run(value ? `${base}/permissions/${value.id}` : `${base}/resources/${resourceId}/permissions`, { name: name.trim(), description: description.trim(), ...(!value ? { scope } : {}) }, value ? 'PATCH' : 'POST', onClose);
    }
    return <FormDialog title={t(value ? 'access.editPermission' : 'access.createPermission')} cancelLabel={t('cancel')} confirmLabel={t('save')} onCancel={onClose} onSubmit={submit} busy={mutation.busy}>
        <ErrorNotice code={mutation.error} />
        <TextField label={t('access.permissionName')} value={name} onValueChange={setName} maxLength={100} required error={!!mutation.fields.name} errorText={mutation.field('name')} disabled={mutation.busy} />
        <TextField label={t('access.scope')} value={scope} onValueChange={setScope} maxLength={100} required readOnly={!!value} error={!!mutation.fields.scope} errorText={mutation.fields.scope === 'ACCESS_SCOPE_INVALID' ? t('access.invalidScope') : mutation.field('scope')} disabled={mutation.busy} />
        <TextField label={t('access.description')} type="textarea" value={description} onValueChange={setDescription} maxLength={1000} error={!!mutation.fields.description} errorText={mutation.field('description')} disabled={mutation.busy} />
    </FormDialog>;
}

function ResourceApplications({ resourceId }: { resourceId: string }) {
    const { t } = useTranslation(), [cursor, setCursor] = useState<string | null>(null), mutation = useAccessWrite();
    const query = useResource<CursorPage<AllowedApplication>>('access', `${base}/resources/${resourceId}/applications?${new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) })}`, `resource-applications:${resourceId}:${cursor ?? ''}`);
    const [adding, setAdding] = useState(false), [clientId, setClientId] = useState(''), [removing, setRemoving] = useState<AllowedApplication>();
    return <section className="card"><div className="card-heading access-heading"><div><h2>{t('access.applications')}</h2><p>{t('access.applicationsDescription')}</p></div><Button className="secondary" onClick={() => { mutation.clear(); setClientId(''); setAdding(true); }}>{t('access.linkApplication')}</Button></div>
        <div className="card-body"><ResourceFeedback query={query} />{query.data && <><div className="access-items">{query.data.items.map((item) => <div className="access-item" key={item.clientId}><div><strong>{item.name}</strong><code className="break-all">{item.clientId}</code></div><Button className="text-button danger" onClick={() => { mutation.clear(); setRemoving(item); }} aria-label={`${t('access.unlinkApplication')}: ${item.name}`}>{t('access.remove')}</Button></div>)}</div>
            {!query.data.items.length && <p className="empty-state">{t('access.noApplications')}</p>}<PageNavigation pageInfo={query.data.pageInfo} count={query.data.items.length} cursor={cursor} onNavigate={setCursor} /></>}</div>
        {adding && <FormDialog title={t('access.linkApplication')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} busy={mutation.busy} onCancel={() => setAdding(false)} onSubmit={() => { void mutation.run(`${base}/resources/${resourceId}/applications`, { clientId: clientId.trim() }, 'POST', () => setAdding(false)); }}><ErrorNotice code={mutation.error} /><TextField label={t('access.clientId')} value={clientId} onValueChange={setClientId} required maxLength={254} error={!!mutation.fields.clientId} errorText={mutation.field('clientId')} disabled={mutation.busy} /></FormDialog>}
        {removing && <ConfirmationDialog title={t('access.unlinkApplication')} description={t('access.unlinkApplicationConfirm')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} busy={mutation.busy} error={<ErrorNotice code={mutation.error} />} onCancel={() => setRemoving(undefined)} onConfirm={() => { void mutation.run(`${base}/resources/${resourceId}/applications/${encodeURIComponent(removing.clientId)}`, undefined, 'DELETE', () => setRemoving(undefined)); }} />}
    </section>;
}

export function ApiResourceDetailPage({ locale }: { locale: Locale }) {
    const { t } = useTranslation(), location = useLocation(), navigate = useNavigate(), id = new URLSearchParams(location.search).get('id') ?? '';
    const query = useResource<ResourceDetail>('access', `${base}/resources/${encodeURIComponent(id)}`, `resource:${id}`), mutation = useAccessWrite();
    const [editing, setEditing] = useState(false), [permission, setPermission] = useState<Permission | null>(), [removing, setRemoving] = useState<Permission | 'resource'>();
    const resource = query.data;
    return <><ButtonLink variant="text" className="detail-back" to={listPath(localizedPath(locale, 'admin/access/resources'), location.search)}>{t('access.backToResources')}</ButtonLink>
        <div className="page-heading"><div><h1>{resource?.name ?? t('access.resourceDetails')}</h1><p className="break-all">{resource?.identifier}</p></div>{resource && <div className="action-row"><Button className="secondary" onClick={() => setEditing(true)}>{t('access.edit')}</Button><Button className="text-button danger" onClick={() => { mutation.clear(); setRemoving('resource'); }}>{t('access.delete')}</Button></div>}</div><ResourceFeedback query={query} />
        {resource && <><section className="card"><div className="card-body access-resource-summary"><p>{resource.description}</p><span className="badge">{t(resource.disabled ? 'access.disabled' : 'access.enabled')}</span><span>{t('access.tokenLifetime')}: {resource.accessTokenTtl ?? 300}</span></div></section>
            <section className="card"><div className="card-heading access-heading"><div><h2>{t('access.permissions')}</h2><p>{t('access.permissionsDescription')}</p></div><Button className="secondary" onClick={() => setPermission(null)}>{t('access.createPermission')}</Button></div><div className="card-body"><div className="access-items">{resource.permissions.map((item) => <div className="access-item" key={item.id}><div><strong>{item.name}</strong><code className="break-all">{item.scope}</code>{item.description && <p className="muted">{item.description}</p>}</div><div className="action-row"><Button className="text-button" onClick={() => setPermission(item)} aria-label={`${t('access.editPermission')}: ${item.name}`}>{t('access.edit')}</Button><Button className="text-button danger" onClick={() => { mutation.clear(); setRemoving(item); }} aria-label={`${t('access.deletePermission')}: ${item.name}`}>{t('access.delete')}</Button></div></div>)}</div>{!resource.permissions.length && <p className="empty-state">{t('access.emptyPermissions')}</p>}</div></section>
            <ResourceApplications resourceId={id} />
        </>}
        {editing && resource && <ResourceDialog value={resource} onClose={() => setEditing(false)} />}
        {permission !== undefined && <PermissionDialog resourceId={id} value={permission} onClose={() => setPermission(undefined)} />}
        {removing && <ConfirmationDialog title={t(removing === 'resource' ? 'access.deleteResource' : 'access.deletePermission')} description={t(removing === 'resource' ? 'access.deleteResourceConfirm' : 'access.deletePermissionConfirm')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} busy={mutation.busy} error={<ErrorNotice code={mutation.error} />} onCancel={() => setRemoving(undefined)} onConfirm={() => { const target = removing; void mutation.run(target === 'resource' ? `${base}/resources/${id}` : `${base}/permissions/${target.id}`, undefined, 'DELETE', () => { setRemoving(undefined); if (target === 'resource') navigate(localizedPath(locale, 'admin/access/resources'), { replace: true }); }); }} />}
    </>;
}

function RoleDialog({ id, onClose }: { id?: string; onClose: () => void }) {
    const { t } = useTranslation(), mutation = useAccessWrite(), query = useResource<RoleDetail>('access', `${base}/roles/${id ?? ''}`, `role:${id ?? ''}`, !!id);
    const [name, setName] = useState(''), [description, setDescription] = useState(''), [permissionIds, setPermissionIds] = useState<string[]>([]), [initialized, setInitialized] = useState(!id);
    useEffect(() => { if (query.data && !initialized) { setName(query.data.name); setDescription(query.data.description); setPermissionIds(query.data.permissionIds); setInitialized(true); } }, [query.data, initialized]);
    return <FormDialog title={t(id ? 'access.editRole' : 'access.createRole')} cancelLabel={t('cancel')} confirmLabel={t('save')} onCancel={onClose} onSubmit={() => { void mutation.run(`${base}/roles${id ? `/${id}` : ''}`, { name: name.trim(), description: description.trim(), permissionIds }, id ? 'PATCH' : 'POST', onClose); }} busy={mutation.busy} confirmDisabled={!initialized}>
        {id && !initialized && <ResourceFeedback query={query} />}<ErrorNotice code={mutation.error} />
        {initialized && <><TextField label={t('access.roleName')} value={name} onValueChange={setName} maxLength={100} required error={!!mutation.fields.name} errorText={mutation.field('name')} disabled={mutation.busy} />
            <TextField label={t('access.description')} type="textarea" value={description} onValueChange={setDescription} maxLength={1000} error={!!mutation.fields.description} errorText={mutation.field('description')} disabled={mutation.busy} />
            <ErrorNotice message={mutation.field('permissionIds')} />
            <SelectionList kind="permissions" selected={permissionIds} onChange={setPermissionIds} disabled={mutation.busy} />
        </>}
    </FormDialog>;
}

export function BusinessRolesPage() {
    const { t } = useTranslation(), state = useListState('name'), query = useResource<CursorPage<Role>>('access', `${base}/roles?${state.query}`, `roles:${state.query}`), mutation = useAccessWrite();
    const [editing, setEditing] = useState<string | null>(), [removing, setRemoving] = useState<Role>();
    return <><div className="page-heading"><div><h1>{t('access.roles')}</h1><p>{t('access.rolesDescription')}</p></div><Button onClick={() => setEditing(null)}>{t('access.createRole')}</Button></div>
        <section className="card user-table-card"><SearchBar state={state} fields={['name']} label={t('access.searchRoles')} nameLabel={t('access.roleName')} />{query.error && <CursorRecovery cursor={state.cursor} onReset={() => state.navigatePage(null)} />}<ResourceFeedback query={query} />
            {query.data && <><div className="table-scroll"><table><thead><tr><th>{t('access.roleName')}</th><th>{t('access.description')}</th><th><span className="sr-only">{t('access.edit')}</span></th></tr></thead><tbody>{query.data.items.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.description}</td><td><div className="action-row"><Button className="text-button" aria-label={`${t('access.editRole')}: ${item.name}`} onClick={() => setEditing(item.id)}>{t('access.edit')}</Button><Button className="text-button danger" aria-label={`${t('access.deleteRole')}: ${item.name}`} onClick={() => { mutation.clear(); setRemoving(item); }}>{t('access.delete')}</Button></div></td></tr>)}</tbody></table>{!query.data.items.length && <p className="empty-state">{t('access.emptyRoles')}</p>}</div><PageNavigation pageInfo={query.data.pageInfo} count={query.data.items.length} cursor={state.cursor} onNavigate={state.navigatePage} /></>}
        </section>{editing !== undefined && <RoleDialog id={editing ?? undefined} onClose={() => setEditing(undefined)} />}
        {removing && <ConfirmationDialog title={t('access.deleteRole')} description={t('access.deleteRoleConfirm')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} busy={mutation.busy} error={<ErrorNotice code={mutation.error} />} onCancel={() => setRemoving(undefined)} onConfirm={() => { void mutation.run(`${base}/roles/${removing.id}`, undefined, 'DELETE', () => setRemoving(undefined)); }} />}
    </>;
}

export function UserBusinessRoles({ userId }: { userId: string }) {
    const { t } = useTranslation(), query = useResource<{ roles: Role[] }>('access', `${base}/users/${encodeURIComponent(userId)}/roles`, `user-roles:${userId}`);
    const [editing, setEditing] = useState(false), [roleIds, setRoleIds] = useState<string[]>([]), mutation = useAccessWrite();
    return <section className="card"><div className="card-heading access-heading"><div><h2>{t('access.userRoles')}</h2><p>{t('access.userRolesDescription')}</p></div>{query.data && <Button className="secondary" onClick={() => { setRoleIds(query.data?.roles.map((item) => item.id) ?? []); mutation.clear(); setEditing(true); }}>{t('access.manageUserRoles')}</Button>}</div>
        <div className="card-body"><ResourceFeedback query={query} />{query.data && (query.data.roles.length ? <div className="access-role-badges">{query.data.roles.map((role) => <span className="badge" key={role.id}>{role.name}</span>)}</div> : <p className="muted">{t('access.noUserRoles')}</p>)}</div>
        {editing && <FormDialog title={t('access.manageUserRoles')} cancelLabel={t('cancel')} confirmLabel={t('save')} busy={mutation.busy} onCancel={() => setEditing(false)} onSubmit={() => { void mutation.run(`${base}/users/${encodeURIComponent(userId)}/roles`, { roleIds }, 'PUT', () => setEditing(false)); }}><ErrorNotice code={mutation.error} message={mutation.field('roleIds')} /><SelectionList kind="roles" selected={roleIds} onChange={setRoleIds} disabled={mutation.busy} /></FormDialog>}
    </section>;
}

function AuditDetailDialog({ id, locale, onClose }: { id: string; locale: Locale; onClose: () => void }) {
    const { t } = useTranslation(), query = useResource<AuditEvent>('audit', `/api/admin/audit-logs/${encodeURIComponent(id)}`, `event:${id}`);
    const fields = ['event', 'outcome', 'actorUserId', 'targetUserId', 'clientId', 'targetType', 'targetId', 'reason', 'requestId', 'ipAddress', 'userAgent'] as const;
    return <FormDialog title={t('access.auditDetails')} cancelLabel={t('access.close')} onCancel={onClose}>
        <ResourceFeedback query={query} />{query.data && <dl className="access-event-details"><div><dt>{t('access.timestamp')}</dt><dd>{new Date(query.data.createdAt).toLocaleString(locale)}</dd></div>{fields.map((field) => <div key={field}><dt>{t(`access.${field}`)}</dt><dd>{field === 'event' ? <>{t(`access.events.${query.data!.event.replaceAll('.', '_')}`, { defaultValue: query.data!.event })}<code>{query.data!.event}</code></> : field === 'outcome' ? t(`access.${query.data!.outcome}`, { defaultValue: query.data!.outcome }) : query.data![field] || '—'}</dd></div>)}</dl>}
    </FormDialog>;
}

export function AuditLogsPage({ locale }: { locale: Locale }) {
    const { t } = useTranslation(), state = useListState('event'), [detail, setDetail] = useState<string>();
    const query = useResource<CursorPage<AuditEvent>>('audit', `/api/admin/audit-logs?${state.query}`, `events:${state.query}`);
    return <><div className="page-heading"><div><h1>{t('access.audit')}</h1><p>{t('access.auditDescription')}</p></div></div>
        <section className="card user-table-card"><SearchBar state={state} fields={['event', 'outcome', 'actorUserId', 'targetUserId', 'clientId']} label={t('access.searchAudit')} />{query.error && <CursorRecovery cursor={state.cursor} onReset={() => state.navigatePage(null)} />}<ResourceFeedback query={query} />
            {query.data && <><div className="table-scroll"><table><thead><tr><th>{t('access.timestamp')}</th><th>{t('access.event')}</th><th>{t('access.outcome')}</th><th>{t('access.actorUserId')}</th><th><span className="sr-only">{t('access.details')}</span></th></tr></thead><tbody>{query.data.items.map((item) => <tr key={item.id}><td>{new Date(item.createdAt).toLocaleString(locale)}</td><td>{t(`access.events.${item.event.replaceAll('.', '_')}`, { defaultValue: item.event })}</td><td>{t(`access.${item.outcome}`, { defaultValue: item.outcome })}</td><td><code className="break-all">{item.actorUserId || '—'}</code></td><td><Button className="text-button" aria-label={`${t('access.details')}: ${item.event}`} onClick={() => setDetail(item.id)}>{t('access.details')}</Button></td></tr>)}</tbody></table>{!query.data.items.length && <p className="empty-state">{t('access.noEvents')}</p>}</div><PageNavigation pageInfo={query.data.pageInfo} count={query.data.items.length} cursor={state.cursor} onNavigate={state.navigatePage} /></>}
        </section>{detail && <AuditDetailDialog id={detail} locale={locale} onClose={() => setDetail(undefined)} />}
    </>;
}
