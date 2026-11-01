import { createElement, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MdDialog } from '@material/web/dialog/dialog.js';
import { useTranslation } from 'react-i18next';
import { ApiError, fetchJson, readResponse } from './api';
import { Button, ConfirmationDialog, Progress } from './material';
import { ToolbarIcon } from './ToolbarIcon';
import { useDataActions } from './data';
import { useClearSecrets } from './page-state';
import { avatarIdPattern, avatarMimeType, avatarSize, inspectImage, maximumAvatarBytes, maximumSourceBytes } from '../shared/avatars';

export function Avatar({ name, image, className, fallback }: { name: string; image?: string | null; className: string; fallback?: ReactNode }) {
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
        {source ? <img src={source} alt="" decoding="async" loading={className === 'table-avatar' ? 'lazy' : undefined} referrerPolicy="no-referrer" onError={() => setFailed(source)} /> : fallback ?? (name.trim().slice(0, 1).toUpperCase() || '?')}
    </span>;
}

export function AvatarEditor({ name, image }: { name: string; image?: string | null }) {
    const { t } = useTranslation();
    const actions = useDataActions();
    const input = useRef<HTMLInputElement>(null);
    const [photo, setPhoto] = useState<ImageBitmap>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [removing, setRemoving] = useState(false);
    const capture = useClearSecrets(() => { setPhoto(undefined); setRemoving(false); });
    useEffect(() => () => photo?.close(), [photo]);

    async function choose(file?: File) {
        if (!file) return;
        const current = capture();
        setError(undefined); setBusy(true);
        try {
            if (file.size > maximumSourceBytes) throw new ApiError('AVATAR_FILE_TOO_LARGE', 400);
            const bytes = await file.arrayBuffer();
            if (!current()) return;
            inspectImage(new Uint8Array(bytes));
            let bitmap: ImageBitmap;
            try { bitmap = await createImageBitmap(file); }
            catch { throw new ApiError('AVATAR_ENCODING_FAILED', 400); }
            if (current()) setPhoto(bitmap); else bitmap.close();
        } catch (cause) {
            if (current()) setError(cause instanceof ApiError ? cause.code : 'AVATAR_INVALID_IMAGE');
        } finally { setBusy(false); }
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
        {photo && <CropDialog photo={photo} busy={busy} requestError={error} onCancel={() => setPhoto(undefined)} onSave={save} />}
        {removing && <ConfirmationDialog title={t('avatar.remove')} description={t('avatar.removeConfirm')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} onCancel={() => setRemoving(false)} onConfirm={() => { void remove(); }} />}
    </>;
}

function CropDialog({ photo, busy, requestError, onCancel, onSave }: { photo: ImageBitmap; busy: boolean; requestError?: string; onCancel: () => void; onSave: (blob: Blob) => Promise<void> }) {
    const { t } = useTranslation();
    const dialog = useRef<MdDialog>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const [zoom, setZoom] = useState(1), [horizontal, setHorizontal] = useState(50), [vertical, setVertical] = useState(50);
    const [encoding, setEncoding] = useState(false);
    const [error, setError] = useState<string>();
    const capture = useClearSecrets(() => {});
    useEffect(() => { void dialog.current?.show(); }, []);
    useEffect(() => {
        const context = canvas.current?.getContext('2d');
        if (!context) return;
        const side = Math.min(photo.width, photo.height) / zoom;
        context.clearRect(0, 0, avatarSize, avatarSize);
        context.drawImage(photo, (photo.width - side) * horizontal / 100, (photo.height - side) * vertical / 100, side, side, 0, 0, avatarSize, avatarSize);
    }, [photo, zoom, horizontal, vertical]);
    async function save() {
        const current = capture();
        setEncoding(true); setError(undefined);
        try {
            const target = canvas.current;
            if (!target) throw new Error('Preview unavailable');
            const blob = await new Promise<Blob | null>((resolve) => target.toBlob(resolve, avatarMimeType, 0.86));
            if (!blob || blob.size > maximumAvatarBytes) throw new Error('Image encoding failed');
            if (blob.type !== avatarMimeType) throw new ApiError('AVATAR_WEBP_UNAVAILABLE', 400);
            if (current()) await onSave(blob);
        } catch (cause) { if (current()) setError(cause instanceof ApiError ? cause.code : 'AVATAR_ENCODING_FAILED'); }
        finally { setEncoding(false); }
    }
    const disabled = busy || encoding;
    return createElement('md-dialog', { ref: dialog, className: 'avatar-dialog', 'aria-label': t('avatar.crop'), onCancel: (event: Event) => { event.preventDefault(); if (!disabled) onCancel(); } },
        <div slot="headline">{t('avatar.crop')}</div>,
        <div slot="content" className="avatar-crop-content">
            <p>{t('avatar.hint')}</p>
            <canvas ref={canvas} width={avatarSize} height={avatarSize} role="img" aria-label={t('avatar.preview')} />
            {[[t('avatar.zoom'), zoom, setZoom, 1, 3, 0.01], [t('avatar.horizontal'), horizontal, setHorizontal, 0, 100, 1], [t('avatar.vertical'), vertical, setVertical, 0, 100, 1]].map(([label, value, setter, min, max, step]) => <label className="avatar-slider" key={String(label)}><span>{String(label)}</span><input type="range" aria-label={String(label)} value={Number(value)} min={Number(min)} max={Number(max)} step={Number(step)} disabled={disabled} onChange={(event) => { (setter as (next: number) => void)(Number(event.currentTarget.value)); }} /></label>)}
            {error && <div className="notice error" role="alert">{t(`errors.${error}`)}</div>}
            {requestError && <div className="notice error" role="alert">{t(`errors.${requestError}`, { defaultValue: t('errors.UNKNOWN_ERROR') })}</div>}
        </div>,
        <div slot="actions"><Button className="text-button" disabled={disabled} onClick={onCancel}>{t('cancel')}</Button><Button busy={disabled} onClick={() => { void save(); }}>{t('avatar.save')}</Button></div>,
    );
}
