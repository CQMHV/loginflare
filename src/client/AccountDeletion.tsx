import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiError, fetchJson } from './api';
import { useIdentity, useDataActions, identityScope } from './data';
import { SecurityDialog, useSecurity } from './security';
import { Button, Checkbox, TextField } from './material';
import { useClearSecrets } from './page-state';
import { clearBrowserFlow, selectBrowserAccount } from './browser-context';
import { localizedPath, type Locale } from '../shared/locales';
import { resolveLocale } from './locale';

interface Preview { preview: string; applications: { clientId: string; name: string | null }[] }
export function AccountDeletion() {
    const { t } = useTranslation(), identity = useIdentity().data, actions = useDataActions(), security = useSecurity();
    const [open, setOpen] = useState(false), [preview, setPreview] = useState<Preview>(), [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(), [confirmed, setConfirmed] = useState(false), [code, setCode] = useState('');
    const clear = () => { setOpen(false); setPreview(undefined); setBusy(false); setError(undefined); setConfirmed(false); setCode(''); };
    const capture = useClearSecrets(clear, identityScope(identity));
    async function load() {
        const active = capture(); setPreview(undefined); setConfirmed(false); setCode(''); setBusy(true);
        try { const next = await fetchJson<Preview>('/api/account/deletion-preview'); if (active()) setPreview(next); }
        catch (cause) { if (active()) setError(actions.fail(cause)); }
        finally { if (active()) setBusy(false); }
    }
    useEffect(() => {
        if (identity?.user.role === 'user' && security.data?.proofPurpose === 'account/delete' && (security.data.proofExpiresAt ?? 0) > Date.now()) {
            setOpen(true); void load();
        }
    }, [identity?.user.role, security.data?.proofPurpose, security.data?.proofExpiresAt]);
    if (!identity || identity.user.role !== 'user') return null;
    const needsCode = !!identity.user.twoFactorEnabled && !!security.data?.hasPassword;
    async function submit(password: string) {
        if (busy || !preview || !confirmed || needsCode && !/^\d{6}$/.test(code.trim())) return;
        const active = capture(); setBusy(true); setError(undefined);
        try {
            await fetchJson('/api/account/delete', { preview: preview.preview, ...(security.data?.hasPassword ? { password } : {}), ...(needsCode ? { code: code.trim() } : {}) });
            if (active()) {
                actions.signOut(); clearBrowserFlow(); selectBrowserAccount('', false);
                window.location.assign(localizedPath(resolveLocale(window.location.pathname), 'account-deleted'));
            }
        } catch (cause) {
            if (!active()) return;
            setError(actions.fail(cause)); setCode('');
            if (cause instanceof ApiError && ['ACCOUNT_DELETION_PREVIEW_CHANGED', 'ACCOUNT_DELETION_MFA_REQUIRED'].includes(cause.code)) await actions.invalidate('profile', 'security');
            if (cause instanceof ApiError && ['ACCOUNT_DELETION_PREVIEW_CHANGED', 'ACCOUNT_DELETION_PREVIEW_EXPIRED'].includes(cause.code)) await load();
        } finally { if (active()) setBusy(false); }
    }
    return <><section className="card" aria-labelledby="deletion-title">
        <div className="card-heading"><h2 id="deletion-title">{t('deletion.title')}</h2><p>{t('deletion.description')}</p></div>
        <div className="card-body"><Button className="text-button danger" onClick={() => { setError(undefined); setOpen(true); void load(); }}>{t('deletion.title')}</Button></div>
    </section>{open && <SecurityDialog title={t('deletion.title')} purpose="account/delete" confirmLabel={t('deletion.confirm')} busy={busy} error={error} danger
        confirmDisabled={!preview || !confirmed || needsCode && !/^\d{6}$/.test(code.trim())} onConfirm={(password) => { void submit(password); }} onCancel={clear}
        onVerificationLost={() => { setConfirmed(false); setCode(''); }}>
        <p>{t('deletion.warning')}</p><p>{t('deletion.impact')}</p>
        <h3>{t('deletion.applications')}</h3>
        {preview && (preview.applications.length ? <ul>{preview.applications.map((app) => <li key={app.clientId}>{app.name || app.clientId} <code>{app.clientId}</code></li>)}</ul> : <p>{t('deletion.none')}</p>)}
        <p>{t('deletion.retention')}</p>
        <Checkbox label={t('deletion.acknowledge')} checked={confirmed} onCheckedChange={setConfirmed} disabled={!preview || busy} />
        {needsCode && <TextField label={t('mfa.code')} name="deletionCode" value={code} onValueChange={setCode} inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={6} pattern="[0-9]{6}" required disabled={busy} />}
    </SecurityDialog>}</>;
}
export function AccountDeletionReceipt({ locale }: { locale: Locale }) {
    const { t } = useTranslation();
    return <main className="auth-shell"><section className="card"><div className="card-heading"><h1>{t('deletion.receipt')}</h1><p>{t('deletion.receiptDescription')}</p></div>
        <div className="card-body"><p>{t('deletion.retention')}</p><Link to={localizedPath(locale, 'login')}>{t('signIn')}</Link></div></section></main>;
}
