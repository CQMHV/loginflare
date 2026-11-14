import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useSearchParams } from 'react-router-dom';
import { businessEventTypes } from '../shared/webhooks';
import { localizedPath, type Locale } from '../shared/locales';
import { fetchJson } from './api';
import { Button, ButtonLink, Checkbox, ConfirmationDialog, FormDialog, Select, TextField } from './material';
import { ErrorNotice } from './feedback';
import { ResourceFeedback, useDataActions, useResource } from './data';
import { useClearSecrets } from './page-state';
import { pageParameters, listParameters, PageNavigation, type CursorPage } from './pagination';

const base = '/api/admin/webhooks';
interface Subscription { id: string; name: string; url: string; events: string; enabled: number; version: number; generation: number; createdAt: string }
interface Delivery { id: string; eventId: string; subscriptionId: string; generation: number; status: string; type: string; subjectId: string; attempts: number; totalAttempts: number; cycle: number; nextAttemptAt: number; lastCode: string | null; httpStatus: number | null; createdAt: string }
function DeliveryMetadata({ row, locale }: { row: Pick<Delivery, 'subscriptionId' | 'createdAt' | 'status' | 'nextAttemptAt'>; locale: Locale }) {
    const { t } = useTranslation();
    return <dl className="access-event-details">
        <div><dt>{t('webhooks.subscriptionId')}</dt><dd><code>{row.subscriptionId}</code></dd></div>
        <div><dt>{t('created')}</dt><dd><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString(locale)}</time></dd></div>
        <div><dt>{t('webhooks.next')}</dt><dd>{row.status === 'pending' ? <time dateTime={new Date(row.nextAttemptAt).toISOString()}>{new Date(row.nextAttemptAt).toLocaleString(locale)}</time> : '—'}</dd></div>
    </dl>;
}
function usePages() {
    const location = useLocation(), [parameters, set] = useSearchParams();
    return { query: pageParameters(location.search), cursor: parameters.get('cursor'), navigate: (cursor: string | null) => { const next = listParameters(location.search); if (cursor) next.set('cursor', cursor); else next.delete('cursor'); set(next); } };
}
function useWrite() {
    const actions = useDataActions(), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
    const capture = useClearSecrets(() => { setBusy(false); setError(undefined); });
    async function run(path: string, body: unknown, method: 'POST' | 'PUT' | 'DELETE', done: (value: { secret?: string }) => void) {
        if (busy) return; const current = capture(); setBusy(true); setError(undefined);
        try { const value = await fetchJson<{ secret?: string }>(path, body, undefined, method); await actions.invalidate('webhooks'); if (current()) done(value); }
        catch (cause) { if (current()) setError(actions.fail(cause)); }
        finally { if (current()) setBusy(false); }
    }
    return { busy, error, run, clear: () => setError(undefined) };
}
function Editor({ value, onClose, onSaved }: { value: Subscription | null; onClose: () => void; onSaved: (secret?: string) => void }) {
    const { t } = useTranslation(), mutation = useWrite();
    const [name, setName] = useState(value?.name ?? ''), [url, setUrl] = useState(value?.url ?? ''), [events, setEvents] = useState<string[]>(value ? JSON.parse(value.events) : [...businessEventTypes]), [enabled, setEnabled] = useState(!!value?.enabled);
    return <FormDialog title={t(value ? 'webhooks.edit' : 'webhooks.create')} cancelLabel={t('cancel')} confirmLabel={t('webhooks.save')} busy={mutation.busy} onCancel={onClose} onSubmit={() => {
        void mutation.run(value ? `${base}/${value.id}` : base, { name, url, events, enabled, ...(value ? { version: value.version } : {}) }, value ? 'PUT' : 'POST', (result) => onSaved(result.secret));
    }}><ErrorNotice code={mutation.error} /><TextField label={t('webhooks.name')} name="webhookName" value={name} onValueChange={setName} maxLength={100} required disabled={mutation.busy} />
        <TextField label={t('webhooks.url')} name="webhookUrl" value={url} onValueChange={setUrl} maxLength={2048} autoComplete="off" required disabled={mutation.busy} />
        <fieldset disabled={mutation.busy}><legend>{t('webhooks.events')}</legend>{businessEventTypes.map((type) => <Checkbox key={type} label={t(`webhooks.types.${type.replace('.', '_')}`)} checked={events.includes(type)} onCheckedChange={(checked) => setEvents(checked ? [...events, type] : events.filter((item) => item !== type))} />)}</fieldset>
        <Checkbox label={t('webhooks.enabled')} checked={enabled} onCheckedChange={setEnabled} disabled={mutation.busy} /><p>{t('webhooks.policy')}</p>
    </FormDialog>;
}
export function WebhooksPage({ locale }: { locale: Locale }) {
    const { t } = useTranslation(), page = usePages(), mutation = useWrite();
    const query = useResource<CursorPage<Subscription>>('webhooks', base + '?' + page.query, page.query);
    const [editing, setEditing] = useState<Subscription | null | undefined>(), [action, setAction] = useState<{ type: 'rotate' | 'remove'; row: Subscription }>(), [secret, setSecret] = useState<string>();
    useClearSecrets(() => { setEditing(undefined); setAction(undefined); setSecret(undefined); });
    return <><div className="page-heading"><div><h1>{t('webhooks.title')}</h1><p>{t('webhooks.description')}</p></div><Button onClick={() => setEditing(null)}>{t('webhooks.create')}</Button></div>
        <ButtonLink className="secondary" to={localizedPath(locale, 'admin/webhooks/deliveries')}>{t('webhooks.records')}</ButtonLink><ErrorNotice code={mutation.error} /><ResourceFeedback query={query} />
        {query.data && <><div className="table-scroll" role="region" aria-label={t('webhooks.title')} tabIndex={0}><table><thead><tr><th scope="col">{t('webhooks.name')}</th><th scope="col">{t('webhooks.url')}</th><th scope="col">{t('webhooks.status')}</th><th scope="col">{t('webhooks.events')}</th><th scope="col">{t('webhooks.actions')}</th></tr></thead><tbody>
            {query.data.items.map((row) => <tr key={row.id}><th scope="row"><strong>{row.name}</strong><br /><small className="muted">{row.id}</small></th><td>{row.url}</td><td>{t(row.enabled ? 'webhooks.enabled' : 'webhooks.disabled')}</td><td>{JSON.parse(row.events).map((type: string) => t(`webhooks.types.${type.replace('.', '_')}`)).join(', ')}</td><td>
                <Button className="text-button" onClick={() => setEditing(row)}>{t('webhooks.edit')}</Button><Button className="text-button" disabled={mutation.busy} onClick={() => { mutation.clear(); setAction({ type: 'rotate', row }); }}>{t('webhooks.rotate')}</Button><Button className="text-button danger" disabled={!!row.enabled || mutation.busy} onClick={() => { mutation.clear(); setAction({ type: 'remove', row }); }}>{t('webhooks.remove')}</Button>
            </td></tr>)}</tbody></table></div>{!query.data.items.length && <p>{t('webhooks.empty')}</p>}<PageNavigation count={query.data.items.length} pageInfo={query.data.pageInfo} cursor={page.cursor} onNavigate={page.navigate} /></>}
        {editing !== undefined && <Editor value={editing} onClose={() => setEditing(undefined)} onSaved={(key) => { setEditing(undefined); setSecret(key); }} />}
        {action && <ConfirmationDialog title={t(`webhooks.${action.type === 'rotate' ? 'rotate' : 'remove'}`)} description={t(action.type === 'rotate' ? 'webhooks.rotateHint' : 'webhooks.deleteHint')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} busy={mutation.busy} error={<ErrorNotice code={mutation.error} />} onCancel={() => setAction(undefined)} onConfirm={() => {
            void mutation.run(`${base}/${action.row.id}${action.type === 'rotate' ? '/rotate-secret' : ''}`, { version: action.row.version }, action.type === 'rotate' ? 'POST' : 'DELETE', (result) => { setAction(undefined); setSecret(result.secret); });
        }} />}
        {secret && <FormDialog title={t('webhooks.secretTitle')} cancelLabel={t('webhooks.close')} confirmLabel={t('webhooks.savedSecret')} onCancel={() => setSecret(undefined)} onSubmit={() => setSecret(undefined)}><p>{t('webhooks.secretHint')}</p><TextField label={t('webhooks.secret')} name="webhookSecret" value={secret} readOnly autoComplete="off" /></FormDialog>}
    </>;
}
export function WebhookDeliveriesPage({ locale }: { locale: Locale }) {
    const { t } = useTranslation(), page = usePages(), mutation = useWrite(), [parameters, setParameters] = useSearchParams();
    const query = useResource<CursorPage<Delivery>>('webhooks', `${base}/deliveries?${page.query}`, 'deliveries:' + page.query);
    const [field, setField] = useState(parameters.get('lookupField') ?? 'status'), [value, setValue] = useState(parameters.get('lookupValue') ?? ''), [selected, setSelected] = useState<Delivery>(), [retry, setRetry] = useState<Delivery>();
    useClearSecrets(() => { setSelected(undefined); setRetry(undefined); });
    const detail = useResource<Omit<Delivery, 'attempts'> & { data: string; attempts: { number: number; cycle: number; outcome: string; code: string | null; httpStatus: number | null }[] }>('webhooks', `${base}/deliveries/${selected?.id ?? ''}`, 'detail:' + (selected?.id ?? ''), !!selected);
    return <><div className="page-heading"><h1>{t('webhooks.records')}</h1><ButtonLink className="secondary" to={localizedPath(locale, 'admin/webhooks')}>{t('webhooks.title')}</ButtonLink></div>
        <form className="search-bar" aria-label={t('search')} onSubmit={(event) => { event.preventDefault(); setParameters(value.trim() ? { lookupField: field, lookupValue: value.trim() } : {}); }}>
            <Select label={t('lookupField')} value={field} onChange={setField} options={['status', 'subscriptionId', 'eventId'].map((value) => ({ value, label: t('webhooks.' + value) }))} /><TextField label={t('search')} name="webhookLookup" value={value} onValueChange={setValue} maxLength={254} /><Button type="submit">{t('search')}</Button>
        </form><ErrorNotice code={mutation.error} /><ResourceFeedback query={query} />
        {query.data && <><div className="table-scroll" role="region" aria-label={t('webhooks.records')} tabIndex={0}><table><thead><tr><th scope="col">{t('webhooks.eventId')}</th><th scope="col">{t('webhooks.type')}</th><th scope="col">{t('webhooks.status')}</th><th scope="col">{t('webhooks.attempts')}</th><th scope="col">{t('webhooks.actions')}</th></tr></thead><tbody>{query.data.items.map((row) => <tr key={row.id}><th scope="row"><code>{row.eventId}</code></th><td>{t(`webhooks.types.${row.type.replace('.', '_')}`)}</td><td>{t('webhooks.' + row.status)}<small className="muted">{row.lastCode}</small></td><td>{row.totalAttempts}</td><td><Button className="text-button" onClick={() => setSelected(row)}>{t('webhooks.details')}</Button><Button className="text-button" disabled={row.status === 'pending' || mutation.busy} onClick={() => { mutation.clear(); setRetry(row); }}>{t('webhooks.retry')}</Button></td></tr>)}</tbody></table></div>
            {!query.data.items.length && <p>{t('webhooks.noDeliveries')}</p>}<PageNavigation count={query.data.items.length} pageInfo={query.data.pageInfo} cursor={page.cursor} onNavigate={page.navigate} /></>}
        {selected && <FormDialog title={t('webhooks.details')} cancelLabel={t('webhooks.close')} onCancel={() => setSelected(undefined)}><ResourceFeedback query={detail} />{detail.data && <><DeliveryMetadata row={detail.data} locale={locale} /><p>{t('webhooks.eventId')}: <code>{detail.data.eventId}</code></p><p>{t('webhooks.subject')}: <code>{detail.data.subjectId}</code></p><p>{t('webhooks.generation')}: {detail.data.generation}</p><pre>{JSON.stringify(JSON.parse(detail.data.data), null, 2)}</pre><div className="table-scroll" role="region" aria-label={t('webhooks.attempts')} tabIndex={0}><table><thead><tr><th scope="col">#</th><th scope="col">{t('webhooks.status')}</th><th scope="col">{t('webhooks.code')}</th><th scope="col">HTTP</th></tr></thead><tbody>{detail.data.attempts.map((attempt) => <tr key={attempt.number}><th scope="row">{attempt.number}</th><td>{t('webhooks.' + attempt.outcome)}</td><td>{attempt.code ?? '—'}</td><td>{attempt.httpStatus ?? '—'}</td></tr>)}</tbody></table></div></>}</FormDialog>}
        {retry && <ConfirmationDialog title={t('webhooks.retry')} description={t('webhooks.retryHint')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} busy={mutation.busy} error={<ErrorNotice code={mutation.error} />} onCancel={() => setRetry(undefined)} onConfirm={() => { void mutation.run(`${base}/deliveries/${retry.id}/retry`, { cycle: retry.cycle }, 'POST', () => setRetry(undefined)); }} />}
    </>;
}
