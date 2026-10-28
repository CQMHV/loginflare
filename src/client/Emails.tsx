import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { errorCode, request } from './api';
import i18n from './i18n';
import { Button, Divider, List, ListItem, Progress, TextField } from './material';

interface EmailAddress {
    id: string;
    email: string;
    verified: boolean;
    primary: boolean;
}

type Action = { kind: 'add' } | { kind: 'resend' | 'set-primary' | 'remove'; address: EmailAddress };
interface Verification { emailId: string; email: string; challengeId: string }

export function EmailsPage({ refreshIdentity }: { refreshIdentity: () => Promise<void> }) {
    const { t } = useTranslation();
    const [emails, setEmails] = useState<EmailAddress[]>();
    const [action, setAction] = useState<Action>();
    const [verification, setVerification] = useState<Verification>();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [success, setSuccess] = useState<string>();
    const actionSection = useRef<HTMLElement>(null);
    const codeSection = useRef<HTMLElement>(null);
    const load = useCallback(async () => {
        const result = await request<{ emails: EmailAddress[] }>('/emails');
        setEmails(result.emails);
    }, []);
    useEffect(() => {
        let active = true;
        void request<{ emails: EmailAddress[] }>('/emails').then((result) => {
            if (active) setEmails(result.emails);
        }).catch((cause) => { if (active) setError(errorCode(cause)); });
        return () => { active = false; };
    }, []);
    useEffect(() => {
        const section = action ? actionSection.current : verification ? codeSection.current : null;
        section?.querySelector<HTMLElement>('md-outlined-text-field')?.focus();
    }, [action, verification]);

    function choose(next?: Action) {
        setAction(next); setVerification(undefined); setCode(''); setPassword('');
        setError(undefined); setSuccess(undefined);
        if (next?.kind === 'add') setEmail('');
    }

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!action || busy) return;
        setBusy(true); setError(undefined); setSuccess(undefined);
        try {
            if (action.kind === 'add') {
                const address = email.trim().toLowerCase();
                const result = await request<{ emailId: string; challengeId: string }>('/emails/add', { email: address, password });
                setVerification({ ...result, email: address });
                setAction(undefined);
            } else if (action.kind === 'resend') {
                const result = await request<{ challengeId: string }>('/emails/resend', { emailId: action.address.id, password });
                setVerification({ ...result, emailId: action.address.id, email: action.address.email });
                setCode(''); setAction(undefined);
            } else {
                await request(`/emails/${action.kind}`, { emailId: action.address.id, password });
                setSuccess(action.kind === 'remove' ? 'emails.removeDone' : 'emails.primaryDone');
                setAction(undefined);
                await refreshIdentity();
            }
            await load();
        } catch (cause) {
            setError(errorCode(cause));
            // An address may already be pending when delivery fails. Keep its
            // resend/remove controls available instead of hiding that state.
            await load().catch(() => {});
        } finally { setPassword(''); setBusy(false); }
    }

    async function verify(event: FormEvent) {
        event.preventDefault();
        if (!verification || busy) return;
        setBusy(true); setError(undefined); setSuccess(undefined);
        try {
            await request('/emails/verify', { challengeId: verification.challengeId, code: code.trim() });
            setVerification(undefined); setCode(''); setSuccess('emails.verifiedDone');
            await load(); await refreshIdentity();
        } catch (cause) { setError(errorCode(cause)); }
        finally { setBusy(false); }
    }

    const actionTitle = action?.kind === 'add' ? 'emails.add' : action?.kind === 'resend' ? 'emails.resendCode' : action?.kind === 'remove' ? 'emails.remove' : 'emails.setPrimary';
    const actionDescription = action?.kind === 'add' ? 'emails.addDescription' : action?.kind === 'resend' ? 'emails.resendDescription' : action?.kind === 'remove' ? 'emails.removeDescription' : 'emails.primaryDescription';
    return <>
        <div className="page-heading"><div><h1>{t('emails.title')}</h1><p>{t('emails.description')}</p></div><Button disabled={busy || !emails || emails.length >= 10} onClick={() => choose({ kind: 'add' })}>{t('emails.add')}</Button></div>
        {error && <div className="notice error" role="alert">{i18n.exists(`errors.${error}`) ? t(`errors.${error}`) : t('errors.UNKNOWN_ERROR')}</div>}
        {success && <div className="notice success" role="status">{t(success)}</div>}
        {!emails && !error && <div className="loading-state" role="status"><Progress />{t('loading')}</div>}
        {!emails && error && <Button className="secondary" onClick={() => { setError(undefined); void load().catch((cause) => setError(errorCode(cause))); }}>{t('tryAgain')}</Button>}
        {emails && emails.length >= 10 && <p className="email-limit muted">{t('emails.limitHint')}</p>}
        {action && <section ref={actionSection} className="card email-action" aria-labelledby="email-action-title">
            <div className="card-heading"><h2 id="email-action-title">{t(actionTitle)}</h2><p>{t(actionDescription, { email: action.kind === 'add' ? '' : action.address.email })}</p></div>
            <form className="card-body stack-form" onSubmit={(event) => { void submit(event); }}>
                {action.kind === 'add' && <TextField label={t('emails.newAddress')} type="email" autoComplete="email" value={email} onValueChange={setEmail} maxLength={254} required />}
                <TextField label={t('currentPassword')} type="password" autoComplete="current-password" value={password} onValueChange={setPassword} maxLength={128} supportingText={t('emails.passwordHint')} required />
                <div className="action-row"><Button type="submit" className={action.kind === 'remove' ? 'danger-button' : 'primary'} busy={busy}>{t(action.kind === 'add' || action.kind === 'resend' ? 'emails.sendCode' : actionTitle)}</Button><Button className="secondary" disabled={busy} onClick={() => choose()}>{t('cancel')}</Button></div>
            </form>
        </section>}
        {verification && <section ref={codeSection} className="card" aria-labelledby="email-code-title">
            <div className="card-heading"><h2 id="email-code-title">{t('emails.verify')}</h2><p role="status">{t('emails.codeSent', { email: verification.email })}</p></div>
            <form className="card-body stack-form" onSubmit={(event) => { void verify(event); }}>
                <TextField label={t('emails.code')} autoComplete="one-time-code" inputMode="numeric" value={code} onValueChange={setCode} pattern="[0-9]{6}" minLength={6} maxLength={6} supportingText={t('emails.codeHint')} required />
                <div className="action-row"><Button type="submit" busy={busy}>{t('emails.verify')}</Button><Button className="secondary" disabled={busy} onClick={() => {
                    const address = emails?.find((entry) => entry.id === verification.emailId);
                    if (address) choose({ kind: 'resend', address });
                }}>{t('emails.resendCode')}</Button><Button className="text-button" disabled={busy} onClick={() => choose()}>{t('cancel')}</Button></div>
            </form>
        </section>}
        {emails && <section className="card"><div className="card-heading"><h2>{t('emails.list')}</h2><p>{t('emails.rules')}</p></div><List className="email-list" label={t('emails.list')}>
            {emails.map((address, index) => <Fragment key={address.id}>
                {index > 0 && <Divider />}
                <ListItem className="email-row" headline={<strong>{address.email}</strong>} supportingText={<div className="email-description">
                    <div className="email-badges"><span className={`badge ${address.primary ? 'current' : ''}`}>{t(address.primary ? 'emails.primary' : 'emails.additional')}</span><span className={`badge ${address.verified ? 'verified' : ''}`}>{t(address.verified ? 'verified' : 'emails.pending')}</span></div>{address.primary && <p>{t('emails.primaryHint')}</p>}
                    {!address.primary && <div className="email-actions">{!address.verified && <Button className="secondary small" disabled={busy} onClick={() => choose({ kind: 'resend', address })} aria-label={`${t('emails.resendCode')}: ${address.email}`}>{t('emails.resendCode')}</Button>}{address.verified && <Button className="secondary small" disabled={busy} onClick={() => choose({ kind: 'set-primary', address })} aria-label={`${t('emails.setPrimary')}: ${address.email}`}>{t('emails.setPrimary')}</Button>}<Button className="text-button danger" disabled={busy} onClick={() => choose({ kind: 'remove', address })} aria-label={`${t('emails.remove')}: ${address.email}`}>{t('emails.remove')}</Button></div>}
                </div>} />
            </Fragment>)}
        </List></section>}
    </>;
}
