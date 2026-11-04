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

const base = '/api/admin/machines';
interface MachineApplication { clientId: string; name: string; disabled: boolean; createdAt: string; roleIds: string[]; roles?: { id: string; name: string }[]; scopes?: string[]; issuer?: string; managementResource?: string }
interface MachineRole { id: string; name: string; description: string; createdAt: string }
interface MachineRoleDetail extends MachineRole { permissionIds: string[]; managementScopes: string[] }
interface MachinePermission { id: string; resourceId: string; scope: string; name: string; description: string; resourceName: string }
interface PermissionCatalog { permissions: MachinePermission[]; managementScopes: string[]; managementResource: string }
interface ApplicationList extends CursorPage<MachineApplication> { issuer: string; managementResource: string }
interface Secret { clientId: string; value: string }

function useMachineWrite() {
    const { t } = useTranslation(), actions = useDataActions(), feedback = useFeedback();
    const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [fields, setFields] = useState<Record<string, string>>({});
    const capture = useClearSecrets(() => { setBusy(false); setError(undefined); setFields({}); });
    function clear() { setError(undefined); setFields({}); }
    async function run<T>(path: string, body: unknown, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', done: (result: T) => void) {
        if (busy) return;
        const current = capture(); setBusy(true); clear();
        try {
            const result = await fetchJson<T>(path, body, undefined, method);
            await actions.machinesSaved();
            if (current()) { done(result); feedback.success(t('saved')); }
        } catch (cause) {
            const code = actions.fail(cause);
            if (current()) {
                if (cause instanceof ApiError && cause.fieldErrors && Object.keys(cause.fieldErrors).length) setFields(cause.fieldErrors);
                else setError(code === 'INVALID_INPUT' ? 'MACHINE_INPUT_INVALID' : code);
            }
        } finally { if (current()) setBusy(false); }
    }
    function field(name: string) { return fields[name] ? t(`errors.${fields[name]}`, { defaultValue: t('machines.invalidField') }) : undefined; }
    return { busy, error, fields, clear, run, field };
}

function useMachineList(defaultField: string) {
    const location = useLocation(), [parameters, setParameters] = useSearchParams();
    const [field, setField] = useState(parameters.get('lookupField') ?? defaultField), [value, setValue] = useState(parameters.get('lookupValue') ?? '');
    useEffect(() => { const search = new URLSearchParams(location.search); setField(search.get('lookupField') ?? defaultField); setValue(search.get('lookupValue') ?? ''); }, [location.search, defaultField]);
    const cursor = parameters.get('cursor'), query = pageParameters(location.search);
    function navigatePage(nextCursor: string | null) { const next = listParameters(location.search); if (nextCursor) next.set('cursor', nextCursor); else next.delete('cursor'); setParameters(next); }
    function search() { setParameters(value.trim() ? { lookupField: field, lookupValue: value.trim() } : {}); }
    return { location, cursor, query, field, setField, value, setValue, navigatePage, search };
}

function MachineSearch({ state, applications = false }: { state: ReturnType<typeof useMachineList>; applications?: boolean }) {
    const { t } = useTranslation();
    return <form className="search-bar" onSubmit={(event) => { event.preventDefault(); state.search(); }}>
        <div className="search-field"><Select label={t('lookupField')} value={state.field} options={[{ value: 'name', label: t(applications ? 'machines.applicationName' : 'machines.roleName') }, ...(applications ? [{ value: 'clientId', label: t('machines.clientId') }] : [])]} onChange={state.setField} /></div>
        <div className="search-input"><TextField label={t(applications ? 'machines.searchApplications' : 'machines.searchRoles')} value={state.value} onValueChange={state.setValue} maxLength={254} /></div><Button className="secondary" type="submit">{t('search')}</Button>
    </form>;
}

function SecretDialog({ secret, onClose }: { secret: Secret; onClose: () => void }) {
    const { t } = useTranslation();
    return <FormDialog title={t('machines.secretTitle')} cancelLabel={t('machines.secretSaved')} onCancel={onClose}>
        <p>{t('machines.secretDescription')}</p><TextField label={t('machines.clientId')} value={secret.clientId} readOnly /><TextField label={t('machines.clientSecret')} value={secret.value} autoComplete="off" readOnly />
    </FormDialog>;
}

function ApplicationDialog({ application, onClose, onCreated }: { application?: MachineApplication; onClose: () => void; onCreated?: (secret: Secret) => void }) {
    const { t } = useTranslation(), mutation = useMachineWrite(), [name, setName] = useState(application?.name ?? '');
    return <FormDialog title={t(application ? 'machines.editApplication' : 'machines.createApplication')} cancelLabel={t('cancel')} confirmLabel={t('save')} onCancel={onClose} busy={mutation.busy} onSubmit={() => {
        void mutation.run<MachineApplication & { clientSecret?: string }>(`${base}/applications${application ? `/${encodeURIComponent(application.clientId)}` : ''}`, { name: name.trim() }, application ? 'PATCH' : 'POST', (result) => { onClose(); if (result.clientSecret) onCreated?.({ clientId: result.clientId, value: result.clientSecret }); });
    }}>
        <ErrorNotice code={mutation.error} /><TextField label={t('machines.applicationName')} value={name} onValueChange={setName} required maxLength={100} disabled={mutation.busy} error={!!mutation.fields.name} errorText={mutation.field('name')} />
    </FormDialog>;
}

export function MachineApplicationsPage({ locale }: { locale: Locale }) {
    const { t } = useTranslation(), state = useMachineList('name'), navigate = useNavigate();
    const query = useResource<ApplicationList>('machines', `${base}/applications?${state.query}`, `applications:${state.query}`);
    const [creating, setCreating] = useState(false), [secret, setSecret] = useState<Secret>();
    useClearSecrets(() => { setSecret(undefined); setCreating(false); });
    const path = (clientId: string) => listPath(localizedPath(locale, 'admin/machines/applications/detail'), state.location.search, { clientId });
    return <><div className="page-heading"><div><h1>{t('machines.applications')}</h1><p>{t('machines.applicationsDescription')}</p></div><Button onClick={() => setCreating(true)}>{t('machines.createApplication')}</Button></div>
        <section className="card user-table-card"><MachineSearch state={state} applications />{query.error && <CursorRecovery cursor={state.cursor} onReset={() => state.navigatePage(null)} />}<ResourceFeedback query={query} />
            {query.data && <><div className="table-scroll"><table><thead><tr><th>{t('machines.applicationName')}</th><th>{t('machines.clientId')}</th><th>{t('status')}</th><th>{t('machines.roles')}</th><th><span className="sr-only">{t('machines.details')}</span></th></tr></thead><tbody>{query.data.items.map((item) => <tr key={item.clientId}><td><Link to={path(item.clientId)}>{item.name}</Link></td><td><code>{item.clientId}</code></td><td>{t(item.disabled ? 'machines.disabled' : 'machines.enabled')}</td><td>{t('machines.roleCount', { count: item.roleIds.length })}</td><td><ButtonLink variant="text" to={path(item.clientId)} aria-label={`${t('machines.details')}: ${item.name}`}>{t('machines.details')}</ButtonLink></td></tr>)}</tbody></table>{!query.data.items.length && <p className="empty-state">{t('machines.emptyApplications')}</p>}</div><PageNavigation pageInfo={query.data.pageInfo} count={query.data.items.length} cursor={state.cursor} onNavigate={state.navigatePage} /></>}
        </section>{creating && <ApplicationDialog onClose={() => setCreating(false)} onCreated={setSecret} />}
        {secret && <SecretDialog secret={secret} onClose={() => { const clientId = secret.clientId; setSecret(undefined); navigate(path(clientId)); }} />}
    </>;
}

function MachineRolePicker({ selected, onChange, disabled }: { selected: string[]; onChange: (ids: string[]) => void; disabled: boolean }) {
    const { t } = useTranslation(), [cursor, setCursor] = useState<string | null>(null);
    const query = useResource<CursorPage<MachineRole>>('machines', `${base}/roles?${new URLSearchParams({ limit: '20', ...(cursor ? { cursor } : {}) })}`, `role-picker:${cursor ?? ''}`);
    return <fieldset className="access-selection" disabled={disabled}><legend>{t('machines.roles')}</legend><ResourceFeedback query={query} />
        {query.data && <><div className="access-selection-items">{query.data.items.map((item) => <Checkbox key={item.id} label={item.name} checked={selected.includes(item.id)} disabled={disabled} onCheckedChange={(checked) => onChange(checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} />)}{!query.data.items.length && <p className="muted">{t('machines.emptyRoles')}</p>}</div><small className="muted">{t('machines.selectedCount', { count: selected.length })}</small><PageNavigation pageInfo={query.data.pageInfo} count={query.data.items.length} cursor={cursor} onNavigate={setCursor} /></>}
    </fieldset>;
}

function ApplicationRoleDialog({ application, onClose }: { application: MachineApplication; onClose: () => void }) {
    const { t } = useTranslation(), mutation = useMachineWrite(), [roleIds, setRoleIds] = useState(application.roleIds);
    return <FormDialog title={t('machines.assignRoles')} cancelLabel={t('cancel')} confirmLabel={t('save')} onCancel={onClose} busy={mutation.busy} onSubmit={() => { void mutation.run(`${base}/applications/${encodeURIComponent(application.clientId)}/roles`, { roleIds }, 'PUT', onClose); }}>
        <ErrorNotice code={mutation.error} message={mutation.field('roleIds')} /><MachineRolePicker selected={roleIds} onChange={setRoleIds} disabled={mutation.busy} />
    </FormDialog>;
}

export function MachineApplicationDetailPage({ locale }: { locale: Locale }) {
    const { t } = useTranslation(), location = useLocation(), clientId = new URLSearchParams(location.search).get('clientId') ?? '';
    const query = useResource<MachineApplication>('machines', `${base}/applications/${encodeURIComponent(clientId)}`, `application:${clientId}`, !!clientId);
    const [editing, setEditing] = useState(false), [assigning, setAssigning] = useState(false), [confirmation, setConfirmation] = useState<'disable' | 'rotate' | 'revoke'>(), [secret, setSecret] = useState<Secret>();
    const mutation = useMachineWrite(), application = query.data;
    useClearSecrets(() => { setSecret(undefined); setConfirmation(undefined); setAssigning(false); setEditing(false); }, clientId);
    async function control(kind: 'disable' | 'enable' | 'rotate' | 'revoke') {
        mutation.clear();
        const suffix = kind === 'rotate' ? '/rotate-secret' : kind === 'revoke' ? '/revoke-tokens' : '';
        await mutation.run<{ clientSecret?: string }>(`${base}/applications/${encodeURIComponent(clientId)}${suffix}`, kind === 'disable' || kind === 'enable' ? { disabled: kind === 'disable' } : {}, suffix ? 'POST' : 'PATCH', (result) => { setConfirmation(undefined); if (result.clientSecret) setSecret({ clientId, value: result.clientSecret }); });
    }
    return <><ButtonLink variant="text" className="detail-back" to={listPath(localizedPath(locale, 'admin/machines/applications'), location.search)}>{t('machines.backToApplications')}</ButtonLink>
        <div className="page-heading"><div><h1>{application?.name ?? t('machines.applicationDetails')}</h1><p>{t('machines.applicationsDescription')}</p></div>{application && <Button className="secondary" onClick={() => setEditing(true)}>{t('machines.edit')}</Button>}</div>{clientId ? <ResourceFeedback query={query} /> : <ErrorNotice code="MACHINE_NOT_FOUND" />}
        {application && <><section className="card"><div className="card-heading"><h2>{t('machines.connectionDetails')}</h2></div><div className="card-body stack-form"><TextField label={t('machines.clientId')} value={application.clientId} readOnly />
            {application.issuer && <TextField label={t('machines.tokenEndpoint')} value={`${application.issuer}/oauth2/token`} readOnly />}
            {application.managementResource && <TextField label={t('machines.managementResource')} value={application.managementResource} readOnly />}
            <TextField label={t('machines.authenticationMethod')} value="client_secret_basic" readOnly /><TextField label={t('machines.grantType')} value="client_credentials" readOnly />
        </div></section>
            <section className="card"><div className="card-heading access-heading"><h2>{t('machines.assignedRoles')}</h2><Button className="secondary" onClick={() => setAssigning(true)}>{t('machines.assignRoles')}</Button></div><div className="card-body">{application.roleIds.length ? <div className="access-role-badges">{application.roleIds.map((id) => <span className="badge break-all" key={id}>{application.roles?.find((role) => role.id === id)?.name ?? id}</span>)}</div> : <p className="muted">{t('machines.noAssignedRoles')}</p>}</div></section>
            <section className="card"><div className="card-heading"><h2>{t('machines.allowedScopes')}</h2></div><div className="card-body machine-scopes">{application.scopes?.length ? application.scopes.map((scope) => <code className="break-all" key={scope}>{scope}</code>) : <p className="muted">{t('machines.noScopes')}</p>}</div></section>
            <section className="card"><div className="card-heading"><h2>{t('machines.controls')}</h2><p>{t('machines.controlsDescription')}</p></div><div className="card-body stack-form"><p><span className={`badge ${application.disabled ? 'suspended' : 'active'}`}>{t(application.disabled ? 'machines.disabled' : 'machines.enabled')}</span></p>{!confirmation && <ErrorNotice code={mutation.error} />}
                <div className="action-row"><Button className={application.disabled ? 'primary' : 'danger-button'} busy={mutation.busy} onClick={() => { mutation.clear(); if (application.disabled) void control('enable'); else setConfirmation('disable'); }}>{t(application.disabled ? 'machines.enable' : 'machines.disable')}</Button><Button className="secondary" disabled={mutation.busy} onClick={() => { mutation.clear(); setConfirmation('rotate'); }}>{t('machines.rotate')}</Button><Button className="secondary" disabled={mutation.busy} onClick={() => { mutation.clear(); setConfirmation('revoke'); }}>{t('machines.revoke')}</Button></div>
            </div></section>
        </>}
        {editing && application && <ApplicationDialog application={application} onClose={() => setEditing(false)} />}
        {assigning && application && <ApplicationRoleDialog application={application} onClose={() => setAssigning(false)} />}
        {confirmation && <ConfirmationDialog title={t(`machines.${confirmation}`)} description={t(`machines.${confirmation}Confirm`)} cancelLabel={t('cancel')} confirmLabel={t('confirm')} busy={mutation.busy} error={<ErrorNotice code={mutation.error} />} onCancel={() => { setConfirmation(undefined); mutation.clear(); }} onConfirm={() => { void control(confirmation); }} />}
        {secret && <SecretDialog secret={secret} onClose={() => setSecret(undefined)} />}
    </>;
}

function PermissionPicker({ catalog, permissionIds, managementScopes, onPermissionsChange, onManagementChange, disabled }: { catalog: PermissionCatalog; permissionIds: string[]; managementScopes: string[]; onPermissionsChange: (ids: string[]) => void; onManagementChange: (scopes: string[]) => void; disabled: boolean }) {
    const { t } = useTranslation(), [search, setSearch] = useState(''), [page, setPage] = useState(0);
    const matches = catalog.permissions.filter((permission) => `${permission.name} ${permission.scope} ${permission.resourceName}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    const items = matches.slice(page * 20, page * 20 + 20);
    return <><fieldset className="access-selection" disabled={disabled}><legend>{t('machines.permissions')}</legend><TextField label={t('machines.findPermissions')} value={search} onValueChange={(value) => { setSearch(value); setPage(0); }} maxLength={254} disabled={disabled} />
        <div className="access-selection-items machine-permission-options">{items.map((permission) => <Checkbox key={permission.id} label={`${permission.resourceName} · ${permission.name} (${permission.scope})`} checked={permissionIds.includes(permission.id)} disabled={disabled} onCheckedChange={(checked) => onPermissionsChange(checked ? [...permissionIds, permission.id] : permissionIds.filter((id) => id !== permission.id))} />)}{!items.length && <p className="muted">{t('machines.noPermissions')}</p>}</div>
        <small className="muted">{t('machines.selectedCount', { count: permissionIds.length })}</small><PageNavigation pageInfo={{ previousCursor: page ? String(page - 1) : null, nextCursor: matches.length > (page + 1) * 20 ? String(page + 1) : null }} count={items.length} cursor={page ? String(page) : null} onNavigate={(cursor) => setPage(Number(cursor ?? 0))} />
    </fieldset><fieldset className="access-selection" disabled={disabled}><legend>{t('machines.managementPermissions')}</legend><p className="muted">{t('machines.managementDescription')}</p><div className="access-selection-items">{catalog.managementScopes.map((scope) => <Checkbox key={scope} label={`${t(`machines.managementScopes.${scope.replaceAll(':', '_')}`, { defaultValue: scope })} (${scope})`} checked={managementScopes.includes(scope)} disabled={disabled} onCheckedChange={(checked) => onManagementChange(checked ? [...managementScopes, scope] : managementScopes.filter((value) => value !== scope))} />)}</div></fieldset></>;
}

function MachineRoleDialog({ id, onClose }: { id?: string; onClose: () => void }) {
    const { t } = useTranslation(), mutation = useMachineWrite(), query = useResource<MachineRoleDetail>('machines', `${base}/roles/${id ?? ''}`, `role:${id ?? ''}`, !!id);
    const catalog = useResource<PermissionCatalog>('machines', `${base}/permissions`, 'permission-catalog');
    const [name, setName] = useState(''), [description, setDescription] = useState(''), [permissionIds, setPermissionIds] = useState<string[]>([]), [managementScopes, setManagementScopes] = useState<string[]>([]), [initialized, setInitialized] = useState(!id);
    useEffect(() => { if (query.data && !initialized) { setName(query.data.name); setDescription(query.data.description); setPermissionIds(query.data.permissionIds); setManagementScopes(query.data.managementScopes); setInitialized(true); } }, [query.data, initialized]);
    return <FormDialog title={t(id ? 'machines.editRole' : 'machines.createRole')} cancelLabel={t('cancel')} confirmLabel={t('save')} onCancel={onClose} onSubmit={() => { void mutation.run(`${base}/roles${id ? `/${id}` : ''}`, { name: name.trim(), description: description.trim(), permissionIds, managementScopes }, id ? 'PATCH' : 'POST', onClose); }} busy={mutation.busy} confirmDisabled={!initialized || !catalog.data}>
        {id && !initialized && <ResourceFeedback query={query} />}<ErrorNotice code={mutation.error} />
        {initialized && <><TextField label={t('machines.roleName')} value={name} onValueChange={setName} maxLength={100} required disabled={mutation.busy} error={!!mutation.fields.name} errorText={mutation.field('name')} /><TextField label={t('machines.description')} type="textarea" value={description} onValueChange={setDescription} maxLength={1000} disabled={mutation.busy} error={!!mutation.fields.description} errorText={mutation.field('description')} /><ErrorNotice message={mutation.field('permissionIds') ?? mutation.field('managementScopes')} />
            <ResourceFeedback query={catalog} />{catalog.data && <PermissionPicker catalog={catalog.data} permissionIds={permissionIds} managementScopes={managementScopes} onPermissionsChange={setPermissionIds} onManagementChange={setManagementScopes} disabled={mutation.busy} />}
        </>}
    </FormDialog>;
}

export function MachineRolesPage() {
    const { t } = useTranslation(), state = useMachineList('name'), query = useResource<CursorPage<MachineRole>>('machines', `${base}/roles?${state.query}`, `roles:${state.query}`), mutation = useMachineWrite();
    const [editing, setEditing] = useState<string | null>(), [removing, setRemoving] = useState<MachineRole>();
    return <><div className="page-heading"><div><h1>{t('machines.roles')}</h1><p>{t('machines.rolesDescription')}</p></div><Button onClick={() => setEditing(null)}>{t('machines.createRole')}</Button></div>
        <section className="card user-table-card"><MachineSearch state={state} />{query.error && <CursorRecovery cursor={state.cursor} onReset={() => state.navigatePage(null)} />}<ResourceFeedback query={query} />
            {query.data && <><div className="table-scroll"><table><thead><tr><th>{t('machines.roleName')}</th><th>{t('machines.description')}</th><th><span className="sr-only">{t('machines.editRole')}</span></th></tr></thead><tbody>{query.data.items.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.description}</td><td><div className="action-row"><Button className="text-button" aria-label={`${t('machines.editRole')}: ${item.name}`} onClick={() => setEditing(item.id)}>{t('machines.edit')}</Button><Button className="text-button danger" aria-label={`${t('machines.deleteRole')}: ${item.name}`} onClick={() => { mutation.clear(); setRemoving(item); }}>{t('access.delete')}</Button></div></td></tr>)}</tbody></table>{!query.data.items.length && <p className="empty-state">{t('machines.emptyRoles')}</p>}</div><PageNavigation pageInfo={query.data.pageInfo} count={query.data.items.length} cursor={state.cursor} onNavigate={state.navigatePage} /></>}
        </section>{editing !== undefined && <MachineRoleDialog id={editing ?? undefined} onClose={() => setEditing(undefined)} />}
        {removing && <ConfirmationDialog title={t('machines.deleteRole')} description={t('machines.deleteRoleConfirm')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} busy={mutation.busy} error={<ErrorNotice code={mutation.error} />} onCancel={() => setRemoving(undefined)} onConfirm={() => { void mutation.run(`${base}/roles/${removing.id}`, undefined, 'DELETE', () => setRemoving(undefined)); }} />}
    </>;
}
