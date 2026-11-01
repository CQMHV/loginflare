import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { request } from './api';
import i18n from './i18n';
import { Button, Checkbox, ConfirmationDialog, Select, TextField } from './material';
import { useClearSecrets } from './page-state';
import { useDataActions } from './data';
import { SecurityConfirmation, useSecurity } from './Social';

interface Enrollment { totpURI: string; backupCodes: string[] }

export function MfaSettings({ enabled, refresh }: { enabled: boolean; refresh: () => Promise<void> }) {
    const { t } = useTranslation();
    const actions = useDataActions();
    const security = useSecurity();
    const [operation, setOperation] = useState<'regenerate' | 'disable'>('regenerate');
    useEffect(() => {
        if (security.data?.proofPurpose === 'two-factor/disable') setOperation('disable');
    }, [security.data?.proofPurpose]);
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [enrollment, setEnrollment] = useState<Enrollment>();
    const [backupCodes, setBackupCodes] = useState<string[]>();
    const [saved, setSaved] = useState(false);
    const [confirmDisable, setConfirmDisable] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [success, setSuccess] = useState<string>();
    const captureSecrets = useClearSecrets(() => {
        setPassword(''); setCode(''); setEnrollment(undefined); setBackupCodes(undefined); setSaved(false); setConfirmDisable(false);
    });

    async function perform(action: 'enable' | 'verify' | 'disable' | 'regenerate') {
        const current = captureSecrets();
        setBusy(true); setError(undefined); setSuccess(undefined);
        try {
            if (action === 'enable') {
                const result = await request<Enrollment>('/two-factor/enable', { password });
                if (current()) { setEnrollment(result); setBackupCodes(result.backupCodes); setSaved(false); }
            } else if (action === 'regenerate') {
                const result = await request<{ backupCodes: string[] }>('/two-factor/generate-backup-codes', { password });
                if (current()) { setBackupCodes(result.backupCodes); setSuccess('mfa.resetSuccess'); }
            } else {
                await request(action === 'verify' ? '/two-factor/verify-totp' : '/two-factor/disable', action === 'verify' ? { code: code.trim() } : { password });
                if (!current()) return;
                setEnrollment(undefined); setBackupCodes(undefined); setCode(''); setConfirmDisable(false);
                await refresh();
                setSuccess(action === 'verify' ? 'mfa.enabledSuccess' : 'mfa.disabledSuccess');
            }
        } catch (cause) { if (current()) setError(actions.fail(cause)); }
        finally { setBusy(false); setPassword(''); await actions.invalidate('security'); }
    }

    function submit(event: FormEvent) {
        event.preventDefault();
        if (!enrollment && enabled && !security.data?.hasPassword && operation === 'disable') setConfirmDisable(true);
        else void perform(enrollment ? 'verify' : enabled ? 'regenerate' : 'enable');
    }

    function downloadCodes() {
        if (!backupCodes) return;
        const url = URL.createObjectURL(new Blob([`${t('mfa.backupTitle')}\n\n${backupCodes.join('\n')}\n`], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url; link.download = 'loginflare-recovery-codes.txt'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    const errorKey = `errors.${error}`;
    return <section className="card" aria-labelledby="mfa-title">
        <div className="card-heading"><h2 id="mfa-title">{t('mfa.title')}</h2><p>{t('mfa.description')}</p></div>
        <div className="card-body stack-form">
            <p>{t(enabled ? 'mfa.enabled' : 'mfa.disabled')}</p>
            {error && <div className="notice error" role="alert">{i18n.exists(errorKey) ? t(errorKey) : t('errors.UNKNOWN_ERROR')}</div>}
            {success && <div className="notice success" role="status">{t(success)}</div>}
            <form className="stack-form mfa-form" onSubmit={submit}>
                {enrollment ? <>
                    <p>{t('mfa.setup')}</p>
                    <QRCodeSVG className="mfa-qr" value={enrollment.totpURI} size={224} marginSize={4} title={t('mfa.qr')} role="img" aria-label={t('mfa.qr')} />
                    <TextField label={t('mfa.secret')} value={new URL(enrollment.totpURI).searchParams.get('secret') ?? ''} readOnly />
                    <TextField label={t('mfa.code')} name="code" value={code} onValueChange={setCode} autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required />
                </> : <>
                    {enabled && security.data && !security.data.hasPassword && <Select label={t('social.operation')} value={operation} options={[{ value: 'regenerate', label: t('mfa.regenerate') }, { value: 'disable', label: t('mfa.disable') }]} onChange={(value) => setOperation(value as 'regenerate' | 'disable')} />}
                    <SecurityConfirmation purpose={!enabled ? 'two-factor/enable' : !security.data?.hasPassword && operation === 'disable' ? 'two-factor/disable' : 'two-factor/generate-backup-codes'} password={password} onPassword={setPassword} disabled={busy} passwordLabel={t('mfa.password')} />
                    {enabled && <p className="muted">{t('mfa.regenerateHint')}</p>}
                </>}
                {enrollment && <Checkbox label={t('mfa.saved')} checked={saved} onCheckedChange={setSaved} />}
                <div className="action-row">
                    <Button type="submit" busy={busy} disabled={!!enrollment && !saved}>{t(enrollment ? 'mfa.confirm' : enabled ? !security.data?.hasPassword && operation === 'disable' ? 'mfa.disable' : 'mfa.regenerate' : 'mfa.enable')}</Button>
                    {enabled && !enrollment && security.data?.hasPassword && <Button className="secondary" disabled={busy || !password} onClick={() => setConfirmDisable(true)}>{t('mfa.disable')}</Button>}
                    {enrollment && <Button className="text-button" disabled={busy} onClick={() => { setEnrollment(undefined); setBackupCodes(undefined); setCode(''); }}>{t('cancel')}</Button>}
                </div>
            </form>
            {backupCodes && <div className="mfa-backup-codes">
                <h3>{t('mfa.backupTitle')}</h3><p>{t('mfa.backupHint')}</p>
                <ul aria-label={t('mfa.backupTitle')}>{backupCodes.map((value) => <li key={value}><code>{value}</code></li>)}</ul>
                <Button className="secondary" onClick={downloadCodes}>{t('mfa.download')}</Button>
            </div>}
        </div>
        {confirmDisable && <ConfirmationDialog title={t('mfa.disable')} description={t('mfa.disableConfirm')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} onCancel={() => setConfirmDisable(false)} onConfirm={() => { void perform('disable'); }} />}
    </section>;
}
