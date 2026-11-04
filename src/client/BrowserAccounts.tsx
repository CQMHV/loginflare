import { createElement, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { localizedPath, type Locale } from '../shared/locales';
import { ApiError, errorCode, fetchJson, type Identity } from './api';
import { Avatar } from './Avatar';
import { Button, ConfirmationDialog, Progress } from './material';
import { ToolbarIcon } from './ToolbarIcon';
import { ErrorNotice } from './feedback';
import { identityKey, ResourceFeedback, useDataActions } from './data';
import { browserAccountsKey, startBrowserFlow, type BrowserAccountList, type BrowserAccountSummary } from './browser-account-actions';
import { browserFlowId, clearBrowserFlow, flowPath, selectedBrowserAccount, selectBrowserAccount, selectBrowserFlowAccount } from './browser-context';
import { oauthSearch, providerRequest, withOAuthSearch } from './oauth';

export function useBrowserAccounts() {
    return useQuery({ queryKey: browserAccountsKey, queryFn: async ({ signal }) => {
        const result = await fetchJson<BrowserAccountList>('/api/browser/accounts', undefined, undefined, undefined, signal);
        if (!Array.isArray(result.accounts)) throw new ApiError('UNKNOWN_ERROR', 502);
        return result;
    }, staleTime: 15_000 });
}

function AccountRows({ accounts, current, busy, choose, remove }: { accounts: BrowserAccountSummary[]; current: string; busy: boolean; choose: (account: BrowserAccountSummary) => void; remove: (account: BrowserAccountSummary) => void }) {
    const { t } = useTranslation();
    return <div className="browser-account-list" role="list" aria-label={t('browserAccounts.choose')}>
        {accounts.map((account) => <div key={account.id} className="browser-account-row" role="listitem">
            <button type="button" className="browser-account-choice" disabled={busy} aria-label={t('browserAccounts.accountLabel', { email: account.user.email })} aria-current={account.id === current ? 'true' : undefined} onClick={() => choose(account)}>
                <Avatar name={account.user.name || account.user.email} image={account.user.image} className="user-avatar" />
                <span className="browser-account-details"><strong>{account.user.name || account.user.email}</strong>{account.user.name && <span>{account.user.email}</span>}{account.status === 'signed-out' && <small>{t('browserAccounts.signedOut')}</small>}{account.id === current && account.status === 'active' && <small>{t('browserAccounts.current')}</small>}</span>
                {account.id === current && account.status === 'active' && <ToolbarIcon name="check" />}
            </button>
            {account.status === 'signed-out' && <Button className="icon-button" disabled={busy} aria-label={`${t('browserAccounts.remove')}: ${account.user.email}`} onClick={() => remove(account)}><ToolbarIcon name="close" /></Button>}
        </div>)}
    </div>;
}

export function BrowserAccountChooser({ locale, refresh }: { locale: Locale; refresh: () => Promise<void> }) {
    const { t } = useTranslation(), navigate = useNavigate(), location = useLocation(), client = useQueryClient();
    const query = useBrowserAccounts();
    const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
    const oauthQuery = oauthSearch(location.search);
    async function choose(account: BrowserAccountSummary) {
        setBusy(true); setError(undefined);
        try {
            if (account.status === 'signed-out') {
                await startBrowserFlow('reauth', locale, account.id, oauthQuery || undefined);
                navigate(flowPath(withOAuthSearch(localizedPath(locale, 'login'), location.search, { email: account.user.email }))); return;
            }
            if (oauthQuery && !browserFlowId()) await startBrowserFlow('oauth', locale, undefined, oauthQuery);
            const result = await fetchJson<{ identity: Identity; accountId: string }>('/api/browser/accounts/select', { accountId: account.id, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) });
            if (!oauthQuery) clearBrowserFlow();
            else selectBrowserFlowAccount(result.accountId);
            selectBrowserAccount(result.accountId);
            client.setQueryData(identityKey, result.identity);
            if (oauthQuery) {
                const next = await providerRequest('/oauth2/continue', { selected: true, oauth_query: oauthQuery });
                if (!next?.redirect) throw new ApiError('INVALID_OAUTH_QUERY', 400);
            } else { await refresh(); navigate(localizedPath(locale, 'account'), { replace: true }); }
        } catch (cause) { setError(errorCode(cause)); }
        finally { setBusy(false); }
    }
    async function add() {
        setBusy(true); setError(undefined);
        try { await startBrowserFlow('add', locale, undefined, oauthQuery || undefined); navigate(flowPath(withOAuthSearch(localizedPath(locale, 'login'), location.search))); }
        catch (cause) { setError(errorCode(cause)); setBusy(false); }
    }
    async function remove(account: BrowserAccountSummary) {
        setBusy(true); setError(undefined);
        try { await fetchJson(`/api/browser/accounts/${encodeURIComponent(account.id)}`, undefined, undefined, 'DELETE'); window.dispatchEvent(new Event('loginflare:accounts-changed')); await query.refetch(); }
        catch (cause) { setError(errorCode(cause)); }
        finally { setBusy(false); }
    }
    return <><h2>{t('browserAccounts.choose')}</h2><p className="section-description">{t('browserAccounts.description')}</p><ErrorNotice code={error} /><ResourceFeedback query={query} />
        {query.data && <><AccountRows accounts={query.data.accounts} current={selectedBrowserAccount()} busy={busy} choose={(account) => { void choose(account); }} remove={(account) => { void remove(account); }} />
            {!query.data.accounts.length && <p className="muted">{t('browserAccounts.empty')}</p>}
            <Button className="secondary full browser-add-account" disabled={busy} onClick={() => { void add(); }}><ToolbarIcon slot="icon" name="add" />{t('browserAccounts.useAnother')}</Button>
        </>}
    </>;
}

export function BrowserAccountMenu({ identity, locale, refresh, signingOut, onSignOut }: { identity: Identity; locale: Locale; refresh: () => Promise<void>; signingOut: boolean; onSignOut: () => void }) {
    const { t } = useTranslation(), navigate = useNavigate(), client = useQueryClient(), actions = useDataActions();
    const query = useBrowserAccounts();
    const container = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false), [all, setAll] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
    useEffect(() => {
        if (!open) return;
        const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
        const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
        document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
        if (!container.current?.querySelector('.browser-account-popover')?.contains(document.activeElement)) container.current?.querySelector<HTMLButtonElement>('.browser-account-choice')?.focus();
        return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
    }, [open, query.data]);
    async function choose(account: BrowserAccountSummary) {
        setBusy(true); setError(undefined);
        try {
            if (account.status === 'signed-out') { await startBrowserFlow('reauth', locale, account.id); navigate(flowPath(`${localizedPath(locale, 'login')}?${new URLSearchParams({ email: account.user.email })}`)); }
            else {
                const result = await fetchJson<{ identity: Identity; accountId: string }>('/api/browser/accounts/select', { accountId: account.id });
                clearBrowserFlow(); selectBrowserAccount(result.accountId); client.setQueryData(identityKey, result.identity); await refresh(); navigate(localizedPath(locale, 'account'));
            }
            setOpen(false);
        } catch (cause) { setError(errorCode(cause)); }
        finally { setBusy(false); }
    }
    async function add() {
        setBusy(true); setError(undefined);
        try { await startBrowserFlow('add', locale); setOpen(false); navigate(flowPath(localizedPath(locale, 'login'))); }
        catch (cause) { setError(errorCode(cause)); }
        finally { setBusy(false); }
    }
    async function remove(account: BrowserAccountSummary) {
        setBusy(true); setError(undefined);
        try { await fetchJson(`/api/browser/accounts/${encodeURIComponent(account.id)}`, undefined, undefined, 'DELETE'); window.dispatchEvent(new Event('loginflare:accounts-changed')); await query.refetch(); }
        catch (cause) { setError(errorCode(cause)); }
        finally { setBusy(false); }
    }
    async function signOutAll() {
        setBusy(true); setError(undefined);
        try { await fetchJson('/api/browser/accounts/sign-out-all', {}); clearBrowserFlow(); actions.signOut(true); selectBrowserAccount(''); setAll(false); navigate(localizedPath(locale, 'select-account'), { replace: true }); }
        catch (cause) { setError(errorCode(cause)); }
        finally { setBusy(false); }
    }
    return <div className="browser-account-menu" ref={container}>
        <button ref={trigger} type="button" className="avatar-menu-trigger account-menu" aria-label={t('accountMenu')} aria-description={identity.user.name || identity.user.email} aria-expanded={open} aria-haspopup="dialog" disabled={signingOut} onClick={() => { setError(undefined); setOpen(!open); }}><Avatar name={identity.user.name || identity.user.email} image={identity.user.image} className="user-avatar" />{createElement('md-ripple')}{createElement('md-focus-ring')}</button>
        {open && <div className="browser-account-popover" role="dialog" aria-label={t('browserAccounts.choose')}><ErrorNotice code={error} />
            {query.data ? <AccountRows accounts={query.data.accounts} current={selectedBrowserAccount()} busy={busy} choose={(account) => { void choose(account); }} remove={(account) => { void remove(account); }} /> : <div className="loading-state"><Progress /></div>}
            <div className="browser-account-actions"><Button className="text-button" disabled={busy} onClick={() => { setOpen(false); navigate(localizedPath(locale, 'account')); }}>{t('profile')}</Button>
                <Button className="text-button" disabled={busy} onClick={() => { void add(); }}><ToolbarIcon slot="icon" name="add" />{t('browserAccounts.add')}</Button>
                <Button className="text-button" disabled={busy} onClick={() => { setOpen(false); onSignOut(); }}>{t('signout')}</Button>
                <Button className="text-button" disabled={busy} onClick={() => { setOpen(false); setAll(true); }}>{t('browserAccounts.signOutAll')}</Button>
            </div>
        </div>}
        {all && <ConfirmationDialog title={t('browserAccounts.signOutAll')} description={t('browserAccounts.signOutAllConfirm')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} busy={busy} error={<ErrorNotice code={error} />} onCancel={() => { setAll(false); setError(undefined); }} onConfirm={() => { void signOutAll(); }} />}
    </div>;
}
