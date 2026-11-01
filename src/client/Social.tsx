import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { localizedPath, type Locale } from '../shared/locales';
import type { PublicProvider, SecurityCapabilities, SecurityPurpose } from '../shared/social';
import { inspectImage, maximumAvatarBytes } from '../shared/avatars';
import { ApiError, errorCode, fetchJson, readResponse, request } from './api';
import { Button, ConfirmationDialog, Select, TextField } from './material';
import { ResourceFeedback, useDataActions, useResource } from './data';
import { resolveLocale } from './locale';
import { oauthSearch } from './oauth';
import { useClearSecrets } from './page-state';
import { encodeWebP } from './image-encoding';

export function SocialError({ code }: { code?: string }) {
    const { t } = useTranslation();
    return code ? <div className="notice error" role="alert">{t(`errors.${code}`, { defaultValue: t('errors.UNKNOWN_ERROR') })}</div> : null;
}
export function useSecurity() {
    const query = useResource<SecurityCapabilities>('security', '/api/auth/social/security');
    const expiresAt = query.data?.proofExpiresAt, refetch = query.refetch;
    useEffect(() => {
        if (!expiresAt) return;
        const timer = setTimeout(() => { void refetch(); }, Math.max(0, expiresAt - Date.now()) + 50);
        return () => clearTimeout(timer);
    }, [expiresAt, refetch]);
    return query;
}
export async function startSocial(connectionId: string, purpose: 'login' | 'link' | 'reauth' | 'test', extra: { password?: string; action?: SecurityPurpose; oauth_query?: string } = {}) {
    const result = await request<{ url: string }>('/social/start', { connectionId, locale: resolveLocale(window.location.pathname), purpose, ...extra });
    window.location.assign(result.url);
}
export function SocialButtons({ locale }: { locale: Locale }) {
    const { t } = useTranslation();
    const location = useLocation();
    const providers = useQuery({ queryKey: ['social-providers'], queryFn: ({ signal }) => fetchJson<{ providers: PublicProvider[] }>('/api/social/providers', undefined, undefined, undefined, signal) });
    const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
    return providers.data?.providers.length ? <div className="social-buttons"><SocialError code={error} />{providers.data.providers.map((provider) => <Button className="secondary full" key={provider.id} disabled={busy} lang={locale} onClick={() => {
        setBusy(true); setError(undefined);
        void startSocial(provider.id, 'login', { oauth_query: oauthSearch(location.search) || undefined }).catch((cause) => { setError(errorCode(cause)); setBusy(false); });
    }}>{t('social.continueWith', { name: provider.name })}</Button>)}</div> : null;
}
export function SecurityConfirmation({ purpose, password, onPassword, disabled = false, passwordLabel }: { purpose: SecurityPurpose; password: string; onPassword: (value: string) => void; disabled?: boolean; passwordLabel?: string }) {
    const { t } = useTranslation();
    const query = useSecurity();
    const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
    if (!query.data) return <ResourceFeedback query={query} />;
    if (query.data.hasPassword) return <TextField label={passwordLabel ?? t('currentPassword')} type="password" autoComplete="current-password" value={password} onValueChange={onPassword} maxLength={128} required disabled={disabled} />;
    const providers = query.data.identities.filter((item) => item.enabled);
    return <div className="stack-form security-confirmation"><SocialError code={error} />{query.data.proofPurpose === purpose ? <p className="notice success" role="status">{t('social.confirmed')}</p> : <>
        <p>{t('social.reauthDescription')}</p>{!providers.length && <p className="muted">{t('social.noAvailable')}</p>}
        {providers.map((item) => <Button key={item.id} className="secondary" disabled={busy || disabled} onClick={() => {
            setBusy(true); void startSocial(item.providerId, 'reauth', { action: purpose }).catch((cause) => { setError(errorCode(cause)); setBusy(false); });
        }}>{t('social.continueWith', { name: item.name })}</Button>)}
    </>}</div>;
}
export function SocialSettings() {
    const { t } = useTranslation();
    const query = useSecurity(), actions = useDataActions();
    const [action, setAction] = useState<'link' | 'unlink'>();
    const [connectionId, setConnectionId] = useState(''), [accountId, setAccountId] = useState('');
    const [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false), [error, setError] = useState<string>();
    useClearSecrets(() => { setPassword(''); setConfirm(false); });
    async function perform() {
        setBusy(true); setError(undefined);
        try {
            if (action === 'link') await startSocial(connectionId || query.data!.providers[0]!.id, 'link', { password });
            else { await request('/social/unlink', { accountId, password }); setAction(undefined); setAccountId(''); await actions.invalidate('security'); }
        } catch (cause) { setError(actions.fail(cause)); }
        finally { setBusy(false); setPassword(''); setConfirm(false); await actions.invalidate('security'); }
    }
    return <section className="card"><div className="card-heading"><h2>{t('social.linked')}</h2><p>{t('social.linkedDescription')}</p></div><div className="card-body stack-form">
        <SocialError code={error} /><ResourceFeedback query={query} />
        {query.data && <>{!query.data.identities.length && <p>{t('social.noIdentities')}</p>}
            {query.data.identities.map((item) => <div className="social-identity" key={item.id}><div><strong>{item.name}</strong><p className="muted">{item.accountId}</p>{!item.enabled && <span className="badge">{t('social.unavailable')}</span>}</div><Button className="text-button danger" disabled={busy} onClick={() => { setAction('unlink'); setAccountId(item.id); setPassword(''); }}>{t('social.unlink')}</Button></div>)}
            {!action && <div className="action-row"><Button className="secondary" onClick={() => setAction('link')}>{t('social.link')}</Button></div>}
            {action && <form className="stack-form" onSubmit={(event) => { event.preventDefault(); if (action === 'unlink') setConfirm(true); else void perform(); }}>
                <Select label={t('social.operation')} value={action} options={[{ value: 'link', label: t('social.link') }, { value: 'unlink', label: t('social.unlink') }]} onChange={(value) => { setAction(value as 'link' | 'unlink'); if (value === 'unlink' && !accountId) setAccountId(query.data?.identities[0]?.id ?? ''); setPassword(''); }} />
                {action === 'link' && query.data.providers.length > 0 && <Select label={t('social.provider')} value={connectionId || query.data.providers[0]!.id} options={query.data.providers.map((item) => ({ value: item.id, label: item.name }))} onChange={setConnectionId} />}
                {action === 'unlink' && query.data.identities.length > 0 && <Select label={t('social.linked')} value={accountId || query.data.identities[0]!.id} options={query.data.identities.map((item) => ({ value: item.id, label: `${item.name} · ${item.accountId}` }))} onChange={setAccountId} />}
                <SecurityConfirmation purpose={action} password={password} onPassword={setPassword} disabled={busy} />
                <div className="action-row"><Button type="submit" busy={busy} disabled={action === 'link' ? !query.data.providers.length : !accountId}>{t(`social.${action}`)}</Button><Button className="text-button" disabled={busy} onClick={() => setAction(undefined)}>{t('cancel')}</Button></div>
            </form>}
        </>}
    </div>{confirm && <ConfirmationDialog title={t('social.unlink')} description={t('social.unlinkConfirm')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} onCancel={() => setConfirm(false)} onConfirm={() => { void perform(); }} />}</section>;
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
    return <><h2>{t(status?.stage === 'tested' ? 'social.testResult' : 'social.complete')}</h2><SocialError code={error} />
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
