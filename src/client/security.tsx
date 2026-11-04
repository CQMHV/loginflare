import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { securityPurposes, type SecurityCapabilities, type SecurityPurpose } from '../shared/social';
import { localizedPath } from '../shared/locales';
import { ApiError, request } from './api';
import { identityScope, ResourceFeedback, useDataActions, useIdentity, useResource } from './data';
import { Button, FormDialog, TextField } from './material';
import { ErrorNotice } from './feedback';
import { resolveLocale } from './locale';
import { useClearSecrets } from './page-state';
import { ProviderIcon } from './ProviderIcon';
import { ensureBrowserFlow, startBrowserFlow } from './browser-account-actions';
import { browserFlowId, browserFlowKind, selectedBrowserAccount } from './browser-context';

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

export async function socialAuthorizationUrl(connectionId: string, purpose: 'login' | 'link' | 'reauth' | 'test', extra: { password?: string; action?: SecurityPurpose; oauth_query?: string } = {}) {
    const locale = resolveLocale(window.location.pathname);
    if (purpose === 'login') await ensureBrowserFlow(locale, extra.oauth_query);
    else if (purpose === 'reauth' || !browserFlowId() || browserFlowKind() !== 'security') await startBrowserFlow('security', locale, selectedBrowserAccount());
    const result = await request<{ url: string }>('/social/start', { connectionId, locale, purpose, ...extra });
    return result.url;
}

// This stores only the UI action to reopen after a redirect. Authorization always
// comes from the server's session-bound proof or the current password at submit.
export function useSecurityIntent(module: 'social' | 'emails') {
    const identity = useIdentity().data;
    // Reauthentication rotates the session. This non-authorizing UI selection
    // follows the same user; the new session must supply its own server proof.
    const scope = identity ? JSON.stringify([identity.user.id, identity.user.role ?? 'user']) : '';
    const key = `loginflare.security-intent.${module}`;
    const read = useCallback((): { purpose: SecurityPurpose; targetId?: string } | undefined => {
        try {
            const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
            if (!scope || value?.scope !== scope || typeof value.expiresAt !== 'number' || value.expiresAt <= Date.now()
                || !securityPurposes.includes(value.purpose) || value.targetId !== undefined && (typeof value.targetId !== 'string' || value.targetId.length > 255)) return;
            return { purpose: value.purpose, targetId: value.targetId };
        } catch { return; }
    }, [key, scope]);
    const remember = useCallback((purpose: SecurityPurpose, targetId?: string) => {
        if (!scope) return;
        try { sessionStorage.setItem(key, JSON.stringify({ scope, purpose, targetId, expiresAt: Date.now() + 600_000 })); } catch { /* Reopening the action manually remains available. */ }
    }, [key, scope]);
    const clear = useCallback(() => {
        try { if (JSON.parse(sessionStorage.getItem(key) ?? 'null')?.scope === scope) sessionStorage.removeItem(key); } catch { /* No client state is used to authorize an action. */ }
    }, [key, scope]);
    return { read, remember, clear };
}

export function SecurityDialog({ title, purpose, children, confirmLabel, onConfirm, onCancel, busy = false, error, confirmDisabled = false, danger = false, passwordLabel, onVerificationLost, onReauthenticate }: PropsWithChildren<{
    title: string; purpose: SecurityPurpose; confirmLabel: string; onConfirm: (verifiedPassword: string) => void; onCancel: () => void;
    busy?: boolean; error?: string; confirmDisabled?: boolean; danger?: boolean; passwordLabel?: string;
    onVerificationLost?: () => void; onReauthenticate?: () => void;
}>) {
    const { t } = useTranslation();
    const query = useSecurity(), actions = useDataActions();
    const scope = identityScope(useIdentity().data);
    const [password, setPassword] = useState('');
    const [claim, setClaim] = useState<{ password: string; expiresAt: number; purpose: SecurityPurpose; scope: string }>();
    const [checking, setChecking] = useState(false), [verificationError, setVerificationError] = useState<string>();
    const [rejectedProof, setRejectedProof] = useState<number>();
    const [now, setNow] = useState(Date.now);
    const reset = useRef(onVerificationLost); reset.current = onVerificationLost;
    const capture = useClearSecrets(() => { setPassword(''); setClaim(undefined); setVerificationError(undefined); setChecking(false); });
    const data = query.data;
    const proof = data?.proofPurpose === purpose && data.proofExpiresAt && data.proofExpiresAt !== rejectedProof ? data.proofExpiresAt : undefined;
    const expiresAt = data?.hasPassword ? claim?.purpose === purpose && claim.scope === scope ? claim.expiresAt : undefined : proof;
    const verified = !!expiresAt && expiresAt > now;
    const previouslyVerified = useRef(false);
    useEffect(() => {
        if (!expiresAt) return;
        const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()) + 1);
        return () => clearTimeout(timer);
    }, [expiresAt]);
    useEffect(() => {
        if (previouslyVerified.current && !verified) {
            setPassword(''); setClaim(undefined); setVerificationError((current) => current ?? 'SOCIAL_REAUTH_REQUIRED'); reset.current?.();
        }
        previouslyVerified.current = verified;
    }, [verified]);
    useEffect(() => {
        if (!error || !['INVALID_PASSWORD', 'SOCIAL_REAUTH_REQUIRED'].includes(error)) return;
        setVerificationError(error); setPassword(''); setClaim(undefined); setRejectedProof(data?.proofExpiresAt); reset.current?.();
    }, [error, data?.proofExpiresAt]);
    async function verifyPassword() {
        if (busy || checking || !password || !data?.hasPassword) return;
        const active = capture();
        setChecking(true); setVerificationError(undefined);
        try {
            const result = await request<{ status: boolean }>('/verify-password', { password });
            if (result.status !== true) throw new ApiError('INVALID_PASSWORD', 400);
            if (active()) { setNow(Date.now()); setClaim({ password, expiresAt: Date.now() + 300_000, purpose, scope }); setPassword(''); }
        } catch (cause) { if (active()) { setVerificationError(actions.fail(cause)); setPassword(''); } }
        finally { if (active()) setChecking(false); }
    }
    async function reauthenticate(connectionId: string) {
        if (checking || busy) return;
        const active = capture(); setChecking(true); setVerificationError(undefined);
        try { onReauthenticate?.(); const url = await socialAuthorizationUrl(connectionId, 'reauth', { action: purpose }); if (active()) window.location.assign(url); }
        catch (cause) { if (active()) { setVerificationError(actions.fail(cause)); setChecking(false); } }
    }
    return <FormDialog title={title} cancelLabel={t('cancel')} confirmLabel={verified ? confirmLabel : data?.hasPassword ? t('social.verifyAndContinue') : undefined}
        confirmDisabled={verified ? confirmDisabled : !password} busy={busy || checking} danger={verified && danger} onCancel={onCancel}
        onSubmit={() => { if (verified) onConfirm(data?.hasPassword ? claim!.password : ''); else void verifyPassword(); }}>
        {!data ? <ResourceFeedback query={query} /> : verified ? <><ErrorNotice code={error} />{children}</> : <>
            <p>{t('social.confirmFor', { action: title })}</p><ErrorNotice code={verificationError} />
            {data.hasPassword ? <TextField label={passwordLabel ?? t('currentPassword')} type="password" autoComplete="current-password" value={password} onValueChange={setPassword} maxLength={128} required disabled={busy || checking} /> : <>
                <p>{t('social.reauthDescription')}</p>
                {data.identities.filter((item) => item.enabled).map((item) => <Button key={item.id} className="secondary" disabled={busy || checking} onClick={() => { void reauthenticate(item.providerId); }}><ProviderIcon slot="icon" type={item.type} iconUrl={item.iconUrl} />{t('social.continueWith', { name: item.name })}</Button>)}
                {!data.identities.some((item) => item.enabled) && <><p>{t('social.noAvailable')}</p><Link to={localizedPath(resolveLocale(window.location.pathname), 'forgot-password')}>{t('forgotPassword')}</Link></>}
            </>}
        </>}
    </FormDialog>;
}
