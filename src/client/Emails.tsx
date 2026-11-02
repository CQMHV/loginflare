import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import { Button, Divider, FormDialog, List, ListItem, TextField } from './material';
import { ErrorNotice, useFeedback } from './feedback';
import { ResourceFeedback, useDataActions, useResource } from './data';
import { useClearSecrets } from './page-state';
import { SecurityDialog, useSecurity, useSecurityIntent } from './security';

interface EmailAddress {
    id: string;
    email: string;
    verified: boolean;
    primary: boolean;
}

type Action = { kind: 'add' } | { kind: 'resend' | 'set-primary' | 'remove'; address: EmailAddress };
interface Verification { emailId: string; email: string; challengeId: string }

export function EmailsPage() {
    const { t } = useTranslation();
    const security = useSecurity();
    const intent = useSecurityIntent('emails');
    const emailQuery = useResource<{ emails: EmailAddress[] }>('emails', '/api/auth/emails');
    const emails = emailQuery.data?.emails;
    const dataActions = useDataActions();
    const feedback = useFeedback();
    const [action, setAction] = useState<Action>();
    const [verification, setVerification] = useState<Verification>();
    const [email, setEmail] = useState('');
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const captureSecrets = useClearSecrets(() => { setCode(''); setEmail(''); setVerification(undefined); setAction(undefined); setBusy(false); setError(undefined); });
    useEffect(() => {
        if (!emails || action || verification) return;
        const pending = intent.read();
        if (!pending || pending.purpose !== security.data?.proofPurpose) return;
        if (pending.purpose === 'emails/add') {
            intent.clear(); setEmail(''); setAction({ kind: 'add' });
            return;
        }
        const address = emails.find((entry) => entry.id === pending.targetId && !entry.primary);
        if (!address) { intent.clear(); return; }
        if (pending.purpose === 'emails/remove') setAction({ kind: 'remove', address });
        else if (pending.purpose === 'emails/resend' && !address.verified) setAction({ kind: 'resend', address });
        else if (pending.purpose === 'emails/set-primary' && address.verified) setAction({ kind: 'set-primary', address });
        intent.clear();
    }, [emails, action, verification, security.data?.proofPurpose, intent]);

    function choose(next?: Action) {
        intent.clear(); setAction(next); setVerification(undefined); setCode(''); setEmail('');
        setError(undefined);
    }

    async function submit(password: string) {
        if (!action || busy) return;
        const secretsCurrent = captureSecrets();
        setBusy(true); setError(undefined);
        try {
            if (action.kind === 'add') {
                const address = email.trim().toLowerCase();
                const result = await request<{ emailId: string; challengeId: string }>('/emails/add', { email: address, password });
                if (!secretsCurrent()) return;
                setVerification({ ...result, email: address }); setAction(undefined);
            } else if (action.kind === 'resend') {
                const result = await request<{ challengeId: string }>('/emails/resend', { emailId: action.address.id, password });
                if (!secretsCurrent()) return;
                setVerification({ ...result, emailId: action.address.id, email: action.address.email });
                setCode(''); setAction(undefined);
            } else {
                await request(`/emails/${action.kind}`, { emailId: action.address.id, password });
                if (!secretsCurrent()) return;
                feedback.success(t(action.kind === 'remove' ? 'emails.removeDone' : 'emails.primaryDone'));
                setAction(undefined);
            }
            intent.clear(); setEmail('');
            await dataActions.invalidate('emails', ...(action.kind === 'set-primary' ? ['profile', 'user', 'users'] as const : []));
        } catch (cause) {
            if (!secretsCurrent()) return;
            setError(dataActions.fail(cause));
            // An address may already be pending when delivery fails. Keep its
            // resend/remove controls available instead of hiding that state.
            await dataActions.invalidate('emails');
        } finally { if (secretsCurrent()) setBusy(false); await dataActions.invalidate('security'); }
    }

    async function verify(event: FormEvent) {
        event.preventDefault();
        if (!verification || busy) return;
        const current = captureSecrets();
        setBusy(true); setError(undefined);
        try {
            await request('/emails/verify', { challengeId: verification.challengeId, code: code.trim() });
            if (!current()) return;
            setVerification(undefined); setCode(''); feedback.success(t('emails.verifiedDone'));
            await dataActions.invalidate('emails', 'profile', 'user', 'users');
        } catch (cause) { if (current()) setError(dataActions.fail(cause)); }
        finally { if (current()) setBusy(false); }
    }

    const actionTitle = action?.kind === 'add' ? 'emails.add' : action?.kind === 'resend' ? 'emails.resendCode' : action?.kind === 'remove' ? 'emails.remove' : 'emails.setPrimary';
    const actionDescription = action?.kind === 'add' ? 'emails.addDescription' : action?.kind === 'resend' ? 'emails.resendDescription' : action?.kind === 'remove' ? 'emails.removeDescription' : 'emails.primaryDescription';
    return <>
        <div className="page-heading"><div><h1>{t('emails.title')}</h1><p>{t('emails.description')}</p></div><Button disabled={busy || !emails || emails.length >= 10} onClick={() => choose({ kind: 'add' })}>{t('emails.add')}</Button></div>
        <ResourceFeedback query={emailQuery} />
        {emails && emails.length >= 10 && <p className="email-limit muted">{t('emails.limitHint')}</p>}
        {action && <SecurityDialog key={`${action.kind}:${action.kind === 'add' ? '' : action.address.id}`} title={t(actionTitle)} purpose={`emails/${action.kind}`} confirmLabel={t(action.kind === 'add' || action.kind === 'resend' ? 'emails.sendCode' : actionTitle)}
            danger={action.kind === 'remove'} busy={busy} error={error} onCancel={() => choose()} onConfirm={(password) => { void submit(password); }}
            onVerificationLost={() => { setEmail(''); setError(undefined); }} onReauthenticate={() => intent.remember(`emails/${action.kind}`, action.kind === 'add' ? undefined : action.address.id)}>
                <p>{t(actionDescription, { email: action.kind === 'add' ? '' : action.address.email })}</p>
                {action.kind === 'add' && <TextField label={t('emails.newAddress')} type="email" autoComplete="email" value={email} onValueChange={setEmail} maxLength={254} required />}
        </SecurityDialog>}
        {verification && <FormDialog key={verification.challengeId} title={t('emails.verify')} cancelLabel={t('cancel')} confirmLabel={t('emails.verify')} busy={busy} onCancel={() => choose()} onSubmit={(event) => { void verify(event); }}>
                <p>{t('emails.codeSent', { email: verification.email })}</p>
                <ErrorNotice code={error} />
                <TextField label={t('emails.code')} autoComplete="one-time-code" inputMode="numeric" value={code} onValueChange={setCode} pattern="[0-9]{6}" minLength={6} maxLength={6} supportingText={t('emails.codeHint')} required />
                <Button className="text-button" disabled={busy} onClick={() => {
                    const address = emails?.find((entry) => entry.id === verification.emailId);
                    if (address) choose({ kind: 'resend', address });
                }}>{t('emails.resendCode')}</Button>
        </FormDialog>}
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
