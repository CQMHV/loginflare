import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnAbortService } from '@simplewebauthn/browser';
import { ApiError, request } from './api';
import { identityScope, ResourceFeedback, useDataActions, useIdentity, useResource } from './data';
import { SecurityDialog, useSecurity, useSecurityIntent } from './security';
import { Button, TextField } from './material';
import { useClearSecrets } from './page-state';
import type { SecurityPurpose } from '../shared/social';
import { providerRequest } from './oauth';

export { browserSupportsWebAuthn };
export const cancelPasskey = () => WebAuthnAbortService.cancelCeremony();
export async function authenticatePasskey(oauthQuery: string, current: () => boolean) {
    const optionsJSON = await request<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/passkey/generate-authenticate-options');
    if (!current()) throw new ApiError('BROWSER_FLOW_EXPIRED', 409);
    const response = await startAuthentication({ optionsJSON });
    if (!current()) throw new ApiError('BROWSER_FLOW_EXPIRED', 409);
    return providerRequest('/passkey/verify-authentication', { response, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) });
}

interface Credential { id: string; name: string | null; createdAt: string; deviceType: string; backedUp: boolean }
export function passkeyError(cause: unknown) {
    if (cause instanceof ApiError) return cause;
    if (cause instanceof Error) {
        const underlying = cause.cause instanceof Error ? cause.cause : cause;
        if (['NotAllowedError', 'AbortError'].includes(underlying.name)) return new ApiError('PASSKEY_CANCELLED', 400);
        if (underlying.name === 'InvalidStateError') return new ApiError('PASSKEY_ALREADY_REGISTERED', 400);
    }
    return new ApiError('PASSKEY_UNSUPPORTED', 400);
}
export function Passkeys() {
    const { t } = useTranslation(), identity = useIdentity().data, actions = useDataActions(), security = useSecurity(), intent = useSecurityIntent('passkeys');
    const query = useResource<Credential[]>('passkeys', '/api/auth/passkey/list-user-passkeys');
    const [action, setAction] = useState<'add' | 'rename' | 'delete'>(), [target, setTarget] = useState(''), [name, setName] = useState('');
    const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
    const clear = () => { WebAuthnAbortService.cancelCeremony(); setAction(undefined); setTarget(''); setName(''); setBusy(false); setError(undefined); intent.clear(); };
    const capture = useClearSecrets(clear, identityScope(identity));
    useEffect(() => () => WebAuthnAbortService.cancelCeremony(), []);
    useEffect(() => {
        const pending = intent.read();
        if (pending && security.data && pending.purpose === security.data.proofPurpose && pending.purpose.startsWith('passkeys/') && (security.data.proofExpiresAt ?? 0) > Date.now()) {
            setAction(pending.purpose.slice('passkeys/'.length) as 'add' | 'rename' | 'delete'); setTarget(pending.targetId ?? '');
        }
    }, [security.data?.proofPurpose, security.data?.proofExpiresAt]);
    function open(next: 'add' | 'rename' | 'delete', row?: Credential) {
        setError(undefined); setAction(next); setTarget(row?.id ?? ''); setName(row?.name ?? ''); intent.remember(`passkeys/${next}` as SecurityPurpose, row?.id);
    }
    async function submit(password: string) {
        if (busy || !action || action !== 'delete' && !name.trim()) return;
        const current = capture(); setBusy(true); setError(undefined);
        try {
            if (action === 'add') {
                const optionsJSON = await request<Parameters<typeof startRegistration>[0]['optionsJSON']>('/passkey/generate-register-options', { password });
                if (!current()) return;
                const response = await startRegistration({ optionsJSON });
                if (!current()) return;
                await request('/passkey/verify-registration', { response, name: name.trim() });
            } else await request(`/passkey/${action === 'rename' ? 'update-passkey' : 'delete-passkey'}`, { id: target, ...(action === 'rename' ? { name: name.trim() } : {}), password });
            if (current()) { clear(); await actions.invalidate('passkeys'); }
        } catch (cause) { if (current()) setError(actions.fail(passkeyError(cause))); }
        finally { if (current()) setBusy(false); }
    }
    return <section className="card" aria-labelledby="passkeys-title"><div className="card-heading"><h2 id="passkeys-title">{t('passkeys.title')}</h2><p>{t('passkeys.description')}</p></div><div className="card-body stack-form">
        <ResourceFeedback query={query} />{query.data && (query.data.length ? <ul>{query.data.map((row) => <li key={row.id}><p>{row.name || t('passkeys.unnamed')} · {new Date(row.createdAt).toLocaleDateString()}</p>
            <Button className="text-button" disabled={busy} onClick={() => open('rename', row)}>{t('passkeys.rename')}</Button><Button className="text-button danger" disabled={busy} onClick={() => open('delete', row)}>{t('passkeys.remove')}</Button></li>)}</ul> : <p>{t('passkeys.none')}</p>)}
        <p>{t('passkeys.limit')}</p>{browserSupportsWebAuthn() ? <Button disabled={busy || (query.data?.length ?? 0) >= 20} onClick={() => open('add')}>{t('passkeys.add')}</Button> : <p>{t('passkeys.unsupported')}</p>}
        {action && <SecurityDialog title={t(`passkeys.${action === 'delete' ? 'remove' : action}`)} purpose={`passkeys/${action}` as SecurityPurpose} confirmLabel={t(`passkeys.${action === 'delete' ? 'remove' : action}`)}
            onCancel={clear} onConfirm={(password) => { void submit(password); }} busy={busy} error={error} danger={action === 'delete'} confirmDisabled={action !== 'delete' && !name.trim()}>
            {action === 'delete' ? <p>{t('passkeys.deleteWarning')}</p> : <TextField label={t('passkeys.name')} value={name} onValueChange={setName} maxLength={100} required disabled={busy} />}
        </SecurityDialog>}
    </div></section>;
}
