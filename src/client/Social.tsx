import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { localizedPath, type Locale } from '../shared/locales';
import type { PublicProvider } from '../shared/social';
import { inspectImage, maximumAvatarBytes } from '../shared/avatars';
import { ApiError, errorCode, fetchJson, readResponse, request } from './api';
import { Button, TextField } from './material';
import { ErrorNotice, useFeedback } from './feedback';
import { useDataActions } from './data';
import { oauthSearch } from './oauth';
import { useClearSecrets } from './page-state';
import { encodeWebP } from './image-encoding';
import { SecurityDialog, socialAuthorizationUrl, useSecurity, useSecurityIntent } from './security';
export function SocialButtons({ locale }: { locale: Locale }) {
    const { t } = useTranslation();
    const location = useLocation();
    const providers = useQuery({ queryKey: ['social-providers'], queryFn: ({ signal }) => fetchJson<{ providers: PublicProvider[] }>('/api/social/providers', undefined, undefined, undefined, signal) });
    const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
    const capture = useClearSecrets(() => { setBusy(false); setError(undefined); });
    return providers.data?.providers.length ? <div className="social-buttons"><ErrorNotice code={error} />{providers.data.providers.map((provider) => <Button className="secondary full" key={provider.id} disabled={busy} lang={locale} onClick={() => {
        setBusy(true); setError(undefined);
        const active = capture();
        void socialAuthorizationUrl(provider.id, 'login', { oauth_query: oauthSearch(location.search) || undefined }).then((url) => { if (active()) window.location.assign(url); }).catch((cause) => { if (active()) { setError(errorCode(cause)); setBusy(false); } });
    }}>{t('social.continueWith', { name: provider.name })}</Button>)}</div> : null;
}
export function SocialSettings() {
    const { t } = useTranslation();
    const query = useSecurity(), actions = useDataActions(), feedback = useFeedback();
    const { read, remember, clear } = useSecurityIntent('social');
    type Action = { kind: 'link' | 'unlink'; id: string };
    const [action, setAction] = useState<Action>();
    const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
    const capture = useClearSecrets(() => { setAction(undefined); setError(undefined); setBusy(false); });
    const data = query.data;
    const identities = data?.identities ?? [];
    const providers = (data?.providers ?? []).filter((provider) => !identities.some((identity) => identity.providerId === provider.id));
    const selected = action?.kind === 'link' ? providers.find((provider) => provider.id === action.id) : identities.find((identity) => identity.id === action?.id);
    useEffect(() => {
        if (action || !data) return;
        const pending = read();
        if (!pending?.targetId || !['link', 'unlink'].includes(pending.purpose) || data.proofPurpose !== pending.purpose) return;
        const available = pending.purpose === 'link' ? data.providers.some((item) => item.id === pending.targetId && !data.identities.some((identity) => identity.providerId === item.id)) : data.identities.some((item) => item.id === pending.targetId);
        if (available) setAction({ kind: pending.purpose as 'link' | 'unlink', id: pending.targetId });
        else clear();
    }, [action, data, read, clear]);
    async function perform(currentPassword: string) {
        const target = action;
        if (busy || !target || !data) return;
        if (data.hasPassword ? !currentPassword : data.proofPurpose !== target.kind || !data.proofExpiresAt || data.proofExpiresAt <= Date.now()) { setError('SOCIAL_REAUTH_REQUIRED'); return; }
        const entry = target.kind === 'link' ? providers.find((provider) => provider.id === target.id) : identities.find((identity) => identity.id === target.id);
        if (!entry) return;
        const active = capture();
        setBusy(true); setError(undefined);
        try {
            if (target.kind === 'link') { const url = await socialAuthorizationUrl(target.id, 'link', { password: currentPassword }); if (active()) { clear(); window.location.assign(url); } }
            else { await request('/social/unlink', { accountId: target.id, password: currentPassword }); if (active()) { clear(); setAction(undefined); feedback.success(t('social.unlinked', { name: entry.name })); } }
        } catch (cause) { if (active()) setError(actions.fail(cause)); }
        finally { if (active()) setBusy(false); await actions.invalidate('security'); }
    }
    function choose(target: Action) {
        clear(); setAction(target); setError(undefined);
    }
    if (!data || (!identities.length && !providers.length)) return null;
    return <><section className="card" aria-labelledby="social-accounts-title"><div className="card-heading"><h2 id="social-accounts-title">{t('social.accounts')}</h2><p>{t('social.accountsDescription')}</p></div><div className="card-body stack-form">
        <div className="social-account-list">
            {identities.map((item) => {
                const lastMethod = !data.hasPassword && !identities.some((other) => other.id !== item.id && other.enabled);
                return <div className="social-account" key={item.id}><div className="social-identity"><div><strong>{item.name}</strong><p className="muted">{t('social.connected')}{!item.enabled && <> · {t('social.unavailable')}</>}</p>{identities.filter((other) => other.providerId === item.providerId).length > 1 && <small className="muted break-all">{item.accountId}</small>}</div><Button className="text-button danger" aria-label={t('social.unlinkProvider', { name: item.name })} disabled={busy || lastMethod} onClick={() => choose({ kind: 'unlink', id: item.id })}>{t('social.unlink')}</Button></div>{lastMethod && <p className="muted social-login-hint">{t('social.keepLoginMethod')}</p>}</div>;
            })}
            {providers.map((provider) => <div className="social-account" key={provider.id}><div className="social-identity"><div><strong>{provider.name}</strong><p className="muted">{t('social.notLinked')}</p></div><Button className="secondary" aria-label={t('social.linkProvider', { name: provider.name })} disabled={busy} onClick={() => choose({ kind: 'link', id: provider.id })}>{t('social.link')}</Button></div></div>)}
        </div>
    </div></section>
        {action && selected && <SecurityDialog key={`${action.kind}:${action.id}`} title={t(action.kind === 'link' ? 'social.linkProvider' : 'social.unlinkProvider', { name: selected.name })} purpose={action.kind}
            confirmLabel={t(action.kind === 'link' ? 'social.continueLink' : 'social.confirmUnlink', { name: selected.name })} danger={action.kind === 'unlink'} busy={busy} error={error}
            onCancel={() => { clear(); setAction(undefined); setError(undefined); }} onConfirm={(password) => { void perform(password); }} onVerificationLost={() => setError(undefined)} onReauthenticate={() => remember(action.kind, action.id)}>
            {action.kind === 'unlink' && <p>{t('social.unlinkConfirm', { name: selected.name })}</p>}
        </SecurityDialog>}
    </>;
}
interface FlowStatus { stage: string; purpose: string; email?: string; hasAvatarSource?: boolean; profile?: { name: string; email?: string; subject: string } }
export function SocialCompletion({ locale, refresh }: { locale: Locale; refresh: () => Promise<void> }) {
    const { t } = useTranslation(), navigate = useNavigate(), location = useLocation();
    const [status, setStatus] = useState<FlowStatus>(), [email, setEmail] = useState(''), [code, setCode] = useState('');
    const [error, setError] = useState<string>(() => new URLSearchParams(location.search).get('error') ?? ''), [busy, setBusy] = useState(false);
    const actions = useDataActions();
    useClearSecrets(() => setCode(''));
    useEffect(() => {
        if (new URLSearchParams(location.search).has('error')) return;
        const controller = new AbortController();
        void request<FlowStatus>('/social/flow', undefined, controller.signal).then((value) => { setStatus(value); setEmail(value.email ?? ''); if (value.stage === 'mfa') navigate(`${localizedPath(locale, 'two-factor')}?social=1`, { replace: true }); })
            .catch((cause) => { if (!controller.signal.aborted) setError(errorCode(cause)); });
        return () => controller.abort();
    }, [locale, location.search, navigate]);
    async function finish() {
        if (busy) return;
        setBusy(true); setError('');
        try {
            if (status?.hasAvatarSource) {
                try {
                    const source = await fetch('/api/auth/social/avatar-source', { credentials: 'same-origin' });
                    if (!source.ok) throw new Error('avatar');
                    const bytes = new Uint8Array(await source.arrayBuffer()); inspectImage(bytes);
                    const bitmap = await createImageBitmap(new Blob([bytes]));
                    try {
                        const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
                        const drawing = canvas.getContext('2d'); if (!drawing) throw new Error('canvas');
                        drawing.imageSmoothingQuality = 'high';
                        const side = Math.min(bitmap.width, bitmap.height);
                        drawing.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
                        await readResponse(await fetch('/api/account/avatar', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/webp', 'X-Avatar-Import': 'if-empty' }, body: await encodeWebP(canvas, maximumAvatarBytes) }));
                    } finally { bitmap.close(); }
                } catch { /* Profile imports are retried on a later sign-in. */ }
            }
            const result = await request<{ redirect: string | boolean; url?: string }>('/social/finish', {});
            await refresh(); await actions.invalidate('security', 'profile');
            if (result.redirect === true && result.url) window.location.assign(result.url);
            else if (typeof result.redirect === 'string') navigate(result.redirect, { replace: true });
            else throw new ApiError('INVALID_OAUTH_QUERY', 400);
        } catch (cause) { setError(errorCode(cause)); setBusy(false); }
    }
    async function verify(event: FormEvent) {
        event.preventDefault(); setBusy(true); setError('');
        try {
            if (status?.stage === 'code') {
                const result = await request<{ twoFactorRedirect?: boolean }>('/social/verify-email', { code });
                setCode('');
                if (result.twoFactorRedirect) { navigate(`${localizedPath(locale, 'two-factor')}?social=1`); return; }
                setStatus(await request<FlowStatus>('/social/flow')); await refresh();
            } else { await request('/social/email', { email }); setStatus({ ...status!, stage: 'code', email }); }
        } catch (cause) { setError(errorCode(cause)); } finally { setBusy(false); }
    }
    return <><h2>{t(status?.stage === 'tested' ? 'social.testResult' : 'social.complete')}</h2><ErrorNotice code={error} />
        {!status && !error && <p role="status">{t('loading')}</p>}
        {status && ['email', 'code'].includes(status.stage) ? <form className="stack-form" onSubmit={(event) => { void verify(event); }}><p>{t('social.emailDescription')}</p>
            {status.stage === 'code' ? <><p role="status">{t('social.codeSent', { email: status.email })}</p><TextField label={t('emails.code')} value={code} onValueChange={setCode} autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required /><Button className="text-button" disabled={busy} onClick={() => setStatus({ ...status, stage: 'email' })}>{t('social.sendCode')}</Button></> : <TextField label={t('email')} value={email} onValueChange={setEmail} type="email" maxLength={254} required />}
            <Button type="submit" busy={busy}>{t(status.stage === 'code' ? 'social.verify' : 'social.sendCode')}</Button></form> : status && status.stage !== 'mfa' && <>
            {status.stage === 'tested' && <><p>{t('social.testDescription')}</p><dl><dt>{t('name')}</dt><dd>{status.profile?.name || '—'}</dd><dt>{t('email')}</dt><dd>{status.profile?.email || '—'}</dd><dt>Subject</dt><dd className="break-all">{status.profile?.subject}</dd></dl></>}
            <Button className="full" busy={busy} onClick={() => { void finish(); }}>{t('social.finish')}</Button>
        </>}
        {error && <Link className="back-link" to={localizedPath(locale, 'login')}>{t('backToLogin')}</Link>}
    </>;
}
