import { createElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import Cropper, { type MediaSize } from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';
import '@material/web/slider/slider.js';
import type { MdDialog } from '@material/web/dialog/dialog.js';
import type { MdSlider } from '@material/web/slider/slider.js';
import { useTranslation } from 'react-i18next';
import { avatarMimeType, avatarSize, maximumAvatarBytes } from '../shared/avatars';
import { ApiError } from './api';
import { Button, Progress } from './material';
import { useClearSecrets } from './page-state';
import { ToolbarIcon } from './ToolbarIcon';

export interface AvatarPhoto {
    id: string;
    bitmap: ImageBitmap;
    preview: string;
}

export interface AvatarCropDialogProps {
    photo: AvatarPhoto;
    busy: boolean;
    requestError?: string;
    onCancel: () => void;
    onSave: (blob: Blob) => Promise<void>;
}

/** Keep the draggable preview bounded while retaining the decoded original for export. */
export function prepareAvatarPhoto(bitmap: ImageBitmap): AvatarPhoto {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const preview = document.createElement('canvas');
    preview.width = Math.max(1, Math.round(bitmap.width * scale));
    preview.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = preview.getContext('2d');
    if (!context) throw new ApiError('AVATAR_ENCODING_FAILED', 400);
    context.drawImage(bitmap, 0, 0, preview.width, preview.height);
    return { id: crypto.randomUUID(), bitmap, preview: preview.toDataURL('image/png') };
}

export default function AvatarCropDialog({ photo, busy, requestError, onCancel, onSave }: AvatarCropDialogProps) {
    const { t } = useTranslation();
    const dialog = useRef<MdDialog>(null);
    const shown = useRef(false);
    const stage = useRef<HTMLDivElement>(null);
    const hintId = useId();
    const [opened, setOpened] = useState(false);
    const [crop, setCrop] = useState({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1);
    const [rotation, setRotation] = useState(0);
    const [cropSize, setCropSize] = useState<{ width: number; height: number }>();
    const [mediaSize, setMediaSize] = useState<MediaSize>();
    const [ready, setReady] = useState(false);
    const [encoding, setEncoding] = useState(false);
    const [error, setError] = useState<string>();
    const capture = useClearSecrets(() => {});
    const disabled = busy || encoding;
    // At 100%, fill the crop frame exactly, rather than the larger editor stage.
    const fitZoom = cropSize && mediaSize ? Math.max(cropSize.width / mediaSize.width, cropSize.height / mediaSize.height) : 1;
    const renderedZoom = fitZoom * zoom;

    useEffect(() => {
        const element = dialog.current;
        if (!element) return;
        const afterOpen = () => setOpened(true);
        element.addEventListener('opened', afterOpen);
        // Strict Mode replays effects; show the native dialog once per mount.
        if (!shown.current) { shown.current = true; void element.show(); }
        return () => element.removeEventListener('opened', afterOpen);
    }, []);
    useEffect(() => {
        const element = stage.current;
        if (!opened || !element) return;
        const measure = () => {
            const side = Math.max(1, Math.min(element.clientWidth, element.clientHeight) - 48);
            setCropSize({ width: side, height: side });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [opened]);
    const updateArea = useCallback(() => { setReady(true); }, []);
    const updateMediaSize = useCallback((next: MediaSize) => {
        setMediaSize((previous) => previous?.width === next.width && previous.height === next.height && previous.naturalWidth === next.naturalWidth && previous.naturalHeight === next.naturalHeight ? previous : next);
    }, []);

    function changeZoom(next: number) {
        if (disabled) return;
        const value = Math.min(4, Math.max(1, next));
        if (value === 1) setCrop({ x: 0, y: 0 });
        setZoom(value);
    }
    function reset() {
        setReady(false); setError(undefined);
        setCrop({ x: 0, y: 0 }); setZoom(1); setRotation(0);
    }
    async function save() {
        const current = capture();
        if (!ready || !cropSize || !mediaSize || disabled) return;
        setEncoding(true); setError(undefined);
        try {
            const { bitmap } = photo;
            const output = document.createElement('canvas');
            output.width = output.height = avatarSize;
            const context = output.getContext('2d');
            if (!context) throw new Error('Canvas unavailable');
            context.imageSmoothingQuality = 'high';
            // Replay the displayed transform so the saved composition matches the preview.
            context.translate(avatarSize / 2, avatarSize / 2);
            context.scale(avatarSize / cropSize.width, avatarSize / cropSize.height);
            context.translate(crop.x, crop.y);
            context.rotate(rotation * Math.PI / 180);
            context.scale(mediaSize.width / bitmap.width * renderedZoom, mediaSize.height / bitmap.height * renderedZoom);
            context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
            const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, avatarMimeType, 0.86));
            if (!blob || blob.size > maximumAvatarBytes) throw new Error('Image encoding failed');
            if (blob.type !== avatarMimeType) throw new ApiError('AVATAR_WEBP_UNAVAILABLE', 400);
            if (current()) await onSave(blob);
        } catch (cause) { if (current()) setError(cause instanceof ApiError ? cause.code : 'AVATAR_ENCODING_FAILED'); }
        finally { setEncoding(false); }
    }

    const pristine = crop.x === 0 && crop.y === 0 && zoom === 1 && rotation === 0;
    const percentage = `${Math.round(zoom * 100)}%`;
    return createElement('md-dialog', { ref: dialog, className: 'avatar-dialog', 'aria-label': t('avatar.crop'), onCancel: (event: Event) => { event.preventDefault(); if (!disabled) onCancel(); } },
        <div slot="headline" className="avatar-crop-headline"><span>{t('avatar.crop')}</span><div className="avatar-crop-tools">
            <Button className="icon-button" disabled={disabled || !ready} aria-label={t('avatar.rotate')} title={t('avatar.rotate')} onClick={() => { setReady(false); setRotation((value) => (value + 90) % 360); }}><ToolbarIcon name="rotate_right" /></Button>
            <Button className="icon-button" disabled={disabled || pristine} aria-label={t('avatar.reset')} title={t('avatar.reset')} onClick={reset}><ToolbarIcon name="restart_alt" /></Button>
        </div></div>,
        <div slot="content" className="avatar-crop-content">
            <p>{t('avatar.cropHint')}</p>
            <span className="sr-only" id={hintId}>{t('avatar.keyboardHint')}</span>
            <div className="avatar-crop-stage" ref={stage}>
                {opened && cropSize ? <Cropper image={photo.preview} crop={crop} zoom={renderedZoom} rotation={rotation} aspect={1} cropShape="round" cropSize={cropSize} objectFit="contain" minZoom={fitZoom} maxZoom={fitZoom * 4} showGrid={false} disableAutomaticStylesInjection
                    onCropChange={(next) => { if (!disabled) setCrop(next); }} onZoomChange={(next) => changeZoom(next / fitZoom)} onCropAreaChange={updateArea} setMediaSize={updateMediaSize}
                    cropperProps={{ role: 'region', 'aria-label': t('avatar.position'), 'aria-describedby': hintId, 'aria-disabled': disabled, tabIndex: disabled ? -1 : 0 }}
                    mediaProps={{ alt: t('avatar.preview'), onError: () => { setReady(false); setError('AVATAR_ENCODING_FAILED'); } }}
                    style={{ containerStyle: { pointerEvents: disabled ? 'none' : undefined } }}
                /> : <Progress />}
            </div>
            <div className="avatar-crop-zoom">
                <Button className="icon-button" disabled={disabled || !ready || zoom <= 1} aria-label={t('avatar.zoomOut')} title={t('avatar.zoomOut')} onClick={() => changeZoom(zoom - .1)}><ToolbarIcon name="remove" /></Button>
                {createElement('md-slider', { min: 1, max: 4, step: .01, value: zoom, disabled: disabled || !ready, 'aria-label': t('avatar.zoom'), 'aria-valuetext': percentage, valueLabel: percentage,
                    onInput: (event: Event) => changeZoom((event.currentTarget as MdSlider).value ?? 1),
                })}
                <Button className="icon-button" disabled={disabled || !ready || zoom >= 4} aria-label={t('avatar.zoomIn')} title={t('avatar.zoomIn')} onClick={() => changeZoom(zoom + .1)}><ToolbarIcon name="add" /></Button>
                <output aria-hidden="true">{percentage}</output>
            </div>
            {error && <div className="notice error" role="alert">{t(`errors.${error}`)}</div>}
            {requestError && <div className="notice error" role="alert">{t(`errors.${requestError}`, { defaultValue: t('errors.UNKNOWN_ERROR') })}</div>}
        </div>,
        <div slot="actions"><Button className="text-button" disabled={disabled} onClick={onCancel}>{t('cancel')}</Button><Button busy={disabled} disabled={!ready || !mediaSize} onClick={() => { void save(); }}>{t('avatar.save')}</Button></div>,
    );
}
