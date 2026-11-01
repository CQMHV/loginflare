import { createElement, useEffect, useRef, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, fetchJson, readResponse } from './api';
import { Button, ConfirmationDialog, Progress } from './material';
import { useDataActions } from './data';
import { useClearSecrets } from './page-state';
import { ToolbarIcon } from './ToolbarIcon';
import { avatarIdPattern, inspectImage, maximumSourceBytes } from '../shared/avatars';
import type { AvatarCropDialogProps, AvatarPhoto } from './AvatarCropDialog';

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
    const input = useRef<HTMLInputElement>(null);
    const [photo, setPhoto] = useState<AvatarPhoto>();
    const [CropDialog, setCropDialog] = useState<ComponentType<AvatarCropDialogProps>>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [removing, setRemoving] = useState(false);
    const capture = useClearSecrets(() => { setPhoto(undefined); setRemoving(false); });
    useEffect(() => () => photo?.bitmap.close(), [photo]);

    async function choose(file?: File) {
        if (!file) return;
        const current = capture();
        let bitmap: ImageBitmap | undefined;
        setError(undefined); setBusy(true);
        try {
            if (file.size > maximumSourceBytes) throw new ApiError('AVATAR_FILE_TOO_LARGE', 400);
            const bytes = await file.arrayBuffer();
            if (!current()) return;
            inspectImage(new Uint8Array(bytes));
            const editor = await import('./AvatarCropDialog').catch(() => { throw new ApiError('AVATAR_EDITOR_LOAD_FAILED', 0); });
            if (!current()) return;
            try { bitmap = await createImageBitmap(file); }
            catch { throw new ApiError('AVATAR_ENCODING_FAILED', 400); }
            const selected = editor.prepareAvatarPhoto(bitmap);
            if (current()) {
                setCropDialog(() => editor.default);
                setPhoto(selected);
                bitmap = undefined;
            }
        } catch (cause) {
            if (current()) setError(cause instanceof ApiError ? cause.code : 'AVATAR_INVALID_IMAGE');
        } finally { bitmap?.close(); setBusy(false); }
    }

    async function save(blob: Blob) {
        setBusy(true); setError(undefined);
        try {
            let response: Response;
            try { response = await fetch('/api/account/avatar', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type, Accept: 'application/json' }, body: blob }); }
            catch { throw new ApiError('NETWORK_ERROR', 0); }
            await readResponse<{ image: string }>(response);
            await actions.invalidate('profile', 'users', 'user');
            setPhoto(undefined);
        } catch (cause) { setError(actions.fail(cause)); }
        finally { setBusy(false); }
    }

    async function remove() {
        setBusy(true); setError(undefined); setRemoving(false);
        try {
            await fetchJson('/api/account/avatar', undefined, undefined, 'DELETE');
            await actions.invalidate('profile', 'users', 'user');
        } catch (cause) { setError(actions.fail(cause)); }
        finally { setBusy(false); }
    }

    return <>
        <div className="avatar-editor">
            <input className="sr-only" ref={input} type="file" tabIndex={-1} accept="image/png,image/jpeg,image/webp" aria-label={t('avatar.file')} disabled={busy} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void choose(file); }} />
            <div className="avatar-photo-control">
                <button type="button" className="avatar-upload-trigger" aria-label={t('avatar.change')} disabled={busy} onClick={() => input.current?.click()}>
                    <Avatar name={name} image={image} className="profile-avatar" />
                    {createElement('md-ripple', { disabled: busy })}{createElement('md-focus-ring')}
                </button>
                <button type="button" className="avatar-edit-button" aria-label={t('avatar.edit')} title={t('avatar.edit')} disabled={busy} aria-busy={busy || undefined} onClick={() => input.current?.click()}>
                    {busy ? <Progress /> : <ToolbarIcon name="edit" />}
                    {createElement('md-ripple', { disabled: busy })}{createElement('md-focus-ring')}
                </button>
            </div>
            <div className="avatar-description">
                <h3>{t('avatar.title')}</h3><p>{t('avatar.selectHint')}</p>
                {image && <Button className="text-button small" disabled={busy} onClick={() => setRemoving(true)}>{t('avatar.remove')}</Button>}
            </div>
        </div>
        {error && !photo && <div className="notice error avatar-error" role="alert">{t(`errors.${error}`, { defaultValue: t('errors.UNKNOWN_ERROR') })}</div>}
        {photo && CropDialog && <CropDialog key={photo.id} photo={photo} busy={busy} requestError={error} onCancel={() => setPhoto(undefined)} onSave={save} />}
        {removing && <ConfirmationDialog title={t('avatar.remove')} description={t('avatar.removeConfirm')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} onCancel={() => setRemoving(false)} onConfirm={() => { void remove(); }} />}
    </>;
}
