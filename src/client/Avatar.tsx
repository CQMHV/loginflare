import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, fetchJson, readResponse } from './api';
import { Button, ConfirmationDialog } from './material';
import { useDataActions } from './data';
import { useClearSecrets } from './page-state';
import { ToolbarIcon } from './ToolbarIcon';
import { ImagePicker } from './ImagePicker';
import { avatarIdPattern, avatarSize, maximumAvatarBytes } from '../shared/avatars';
import { ErrorNotice, useFeedback } from './feedback';

export function Avatar({ name, image, className }: { name: string; image?: string | null; className: string }) {
    const { t } = useTranslation();
    const [failed, setFailed] = useState<string>();
    let source: string | undefined;
    if (image && image !== failed) {
        try {
            const url = new URL(image);
            if (url.origin === window.location.origin && url.pathname.startsWith('/avatars/') && avatarIdPattern.test(url.pathname.slice('/avatars/'.length)) && !url.search && !url.hash) source = image;
        } catch { /* Invalid profile data uses the default avatar. */ }
    }
    return <span className={className} role="img" aria-label={t('avatar.label', { name })}>
        {source ? <img src={source} alt="" decoding="async" loading={className === 'table-avatar' ? 'lazy' : undefined} referrerPolicy="no-referrer" onError={() => setFailed(source)} /> : <ToolbarIcon name="person" />}
    </span>;
}

export function AvatarEditor({ name, image }: { name: string; image?: string | null }) {
    const { t } = useTranslation();
    const actions = useDataActions();
    const feedback = useFeedback();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [removing, setRemoving] = useState(false);
    const capture = useClearSecrets(() => { setRemoving(false); setError(undefined); });

    async function save(blob: Blob) {
        const current = capture();
        let response: Response;
        try { response = await fetch('/api/account/avatar', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type, Accept: 'application/json' }, body: blob }); }
        catch { throw new ApiError('NETWORK_ERROR', 0); }
        await readResponse<{ image: string }>(response);
        await actions.invalidate('profile', 'users', 'user');
        if (current()) feedback.success(t('saved'));
    }

    async function remove() {
        const current = capture();
        setBusy(true); setError(undefined);
        try {
            await fetchJson('/api/account/avatar', undefined, undefined, 'DELETE');
            await actions.invalidate('profile', 'users', 'user');
            if (current()) { setRemoving(false); feedback.success(t('saved')); }
        } catch (cause) { if (current()) setError(actions.fail(cause)); }
        finally { setBusy(false); }
    }

    return <>
        <div className="avatar-editor">
            <ImagePicker inputLabel={t('avatar.file')} changeLabel={t('avatar.change')} editLabel={t('avatar.edit')} accept="image/png,image/jpeg,image/webp" busy={busy} outputSize={avatarSize} maximumBytes={maximumAvatarBytes} editorLabels={{ title: t('avatar.crop'), position: t('avatar.position'), preview: t('avatar.preview'), save: t('avatar.save') }} onSave={save} onError={actions.fail} onErrorChange={setError} onBusyChange={setBusy}>
                <Avatar name={name} image={image} className="profile-avatar" />
            </ImagePicker>
            <div className="avatar-description">
                <h3>{t('avatar.title')}</h3><p>{t('avatar.selectHint')}</p>
                {image && <Button className="text-button small" disabled={busy} onClick={() => { setError(undefined); setRemoving(true); }}>{t('avatar.remove')}</Button>}
            </div>
        </div>
        {!removing && <ErrorNotice code={error} />}
        {removing && <ConfirmationDialog title={t('avatar.remove')} description={t('avatar.removeConfirm')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} busy={busy} error={<ErrorNotice code={error} />} onCancel={() => { setRemoving(false); setError(undefined); }} onConfirm={() => { void remove(); }} />}
    </>;
}
