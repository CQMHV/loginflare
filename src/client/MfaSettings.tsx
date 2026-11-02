import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { request } from './api';
import { Button, Checkbox, FormDialog, TextField } from './material';
import { ErrorNotice, useFeedback } from './feedback';
import { useClearSecrets } from './page-state';
import { useDataActions } from './data';
import { SecurityDialog, useSecurity } from './security';

interface Enrollment { totpURI: string; backupCodes: string[] }
type Operation = 'enable' | 'regenerate' | 'disable';
const purposes = { enable: 'two-factor/enable', regenerate: 'two-factor/generate-backup-codes', disable: 'two-factor/disable' } as const;

export function MfaSettings({ enabled, refresh }: { enabled: boolean; refresh: () => Promise<void> }) {
    const { t } = useTranslation();
    const actions = useDataActions(), feedback = useFeedback();
    const security = useSecurity();
    const [operation, setOperation] = useState<Operation>();
    useEffect(() => {
        const proof = security.data?.proofPurpose;
        const resumed = (Object.keys(purposes) as Operation[]).find((kind) => purposes[kind] === proof);
        if (resumed) setOperation((current) => current ?? resumed);
    }, [security.data?.proofPurpose]);
    const [code, setCode] = useState('');
    const [enrollment, setEnrollment] = useState<Enrollment>();
    const [backupCodes, setBackupCodes] = useState<string[]>();
    const [saved, setSaved] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    function clear() {
        setOperation(undefined); setCode(''); setEnrollment(undefined); setBackupCodes(undefined); setSaved(false); setError(undefined); setBusy(false);
    }
    const captureSecrets = useClearSecrets(clear);
    function choose(next: Operation) {
        clear(); setOperation(next);
    }

    async function perform(action: Operation | 'verify', password = '') {
        if (busy || !operation || (action === 'verify' && (!enrollment || !saved || !/^\d{6}$/.test(code.trim())))) return;
        const current = captureSecrets();
        setBusy(true); setError(undefined);
        try {
            if (action === 'enable') {
                const result = await request<Enrollment>('/two-factor/enable', { password });
                if (current()) { setEnrollment(result); setBackupCodes(result.backupCodes); setSaved(false); }
            } else if (action === 'regenerate') {
                const result = await request<{ backupCodes: string[] }>('/two-factor/generate-backup-codes', { password });
                if (current()) setBackupCodes(result.backupCodes);
            } else {
                await request(action === 'verify' ? '/two-factor/verify-totp' : '/two-factor/disable', action === 'verify' ? { code: code.trim() } : { password });
                if (!current()) return;
                await refresh();
                if (current()) { clear(); feedback.success(t(action === 'verify' ? 'mfa.enabledSuccess' : 'mfa.disabledSuccess')); }
            }
        } catch (cause) { if (current()) setError(actions.fail(cause)); }
        finally { if (current()) setBusy(false); await actions.invalidate('security'); }
    }

    function submit(event: FormEvent) {
        event.preventDefault();
        if (enrollment) void perform('verify');
    }

    function downloadCodes() {
        if (!backupCodes) return;
        const url = URL.createObjectURL(new Blob([`${t('mfa.backupTitle')}\n\n${backupCodes.join('\n')}\n`], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url; link.download = 'loginflare-recovery-codes.txt'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    const showingCodes = operation === 'regenerate' && !!backupCodes;
    const operationLabel = operation ? `mfa.${operation}` : 'mfa.title';
    return <><section className="card" aria-labelledby="mfa-title">
        <div className="card-heading"><h2 id="mfa-title">{t('mfa.title')}</h2><p>{t('mfa.description')}</p></div>
        <div className="card-body stack-form">
            <p>{t(enabled ? 'mfa.enabled' : 'mfa.disabled')}</p>
            <div className="action-row">{enabled ? <>
                <Button className="secondary" disabled={busy || !security.data} onClick={() => choose('regenerate')}>{t('mfa.regenerate')}</Button>
                <Button className="text-button danger" disabled={busy || !security.data} onClick={() => choose('disable')}>{t('mfa.disable')}</Button>
            </> : <Button disabled={busy || !security.data} onClick={() => choose('enable')}>{t('mfa.enable')}</Button>}</div>
        </div>
    </section>{operation && (enrollment || showingCodes ? <FormDialog title={t(showingCodes ? 'mfa.backupTitle' : operationLabel)} cancelLabel={t(showingCodes ? 'confirm' : 'cancel')} onCancel={() => { if (showingCodes) feedback.success(t('mfa.resetSuccess')); clear(); }} onSubmit={submit} busy={busy}
            confirmLabel={enrollment ? t('mfa.confirm') : undefined} confirmDisabled={!saved || !/^\d{6}$/.test(code.trim())}>
            <ErrorNotice code={error} />
            {enrollment ? <>
                <p>{t('mfa.setup')}</p>
                <QRCodeSVG className="mfa-qr" value={enrollment.totpURI} size={224} marginSize={4} title={t('mfa.qr')} role="img" aria-label={t('mfa.qr')} />
                <TextField label={t('mfa.secret')} value={new URL(enrollment.totpURI).searchParams.get('secret') ?? ''} readOnly />
                <TextField label={t('mfa.code')} name="code" value={code} onValueChange={setCode} autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required />
            </> : null}
            {backupCodes && <div className="mfa-backup-codes">
                <h3>{t('mfa.backupTitle')}</h3><p>{t('mfa.backupHint')}</p>
                <ul aria-label={t('mfa.backupTitle')}>{backupCodes.map((value) => <li key={value}><code>{value}</code></li>)}</ul>
                <Button className="secondary" onClick={downloadCodes}>{t('mfa.download')}</Button>
            </div>}
            {enrollment && <Checkbox label={t('mfa.saved')} checked={saved} onCheckedChange={setSaved} disabled={busy} />}
        </FormDialog> : <SecurityDialog key={operation} title={t(operationLabel)} purpose={purposes[operation]} confirmLabel={t(operationLabel)} busy={busy} error={error} onCancel={clear}
            onConfirm={(password) => { void perform(operation, password); }} danger={operation === 'disable'} passwordLabel={t('mfa.password')} onVerificationLost={() => { setCode(''); setError(undefined); }}>
            {operation !== 'enable' && <p>{t(operation === 'disable' ? 'mfa.disableConfirm' : 'mfa.regenerateHint')}</p>}
        </SecurityDialog>)}
    </>;
}
