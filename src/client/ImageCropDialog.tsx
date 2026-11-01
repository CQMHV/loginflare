import { createElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import Cropper, { type MediaSize } from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';
import '@material/web/slider/slider.js';
import type { MdDialog } from '@material/web/dialog/dialog.js';
import type { MdSlider } from '@material/web/slider/slider.js';
import { useTranslation } from 'react-i18next';
import { maximumSourceDimension, maximumSourcePixels } from '../shared/avatars';
import { maximumSvgBytes, parseSvg } from '../shared/svg';
import { XMLSerializer } from '@xmldom/xmldom';
import { ApiError } from './api';
import { Button, Progress } from './material';
import { useClearSecrets } from './page-state';
import { ToolbarIcon } from './ToolbarIcon';

export interface ImagePhoto {
    id: string;
    bitmap: ImageBitmap;
    preview: string;
    svg?: { source: string; width: number; height: number };
}

export interface ImageEditorLabels { title: string; position: string; preview: string; save: string }
export interface ImageCropDialogProps {
    photo: ImagePhoto;
    busy: boolean;
    requestError?: string;
    labels: ImageEditorLabels;
    outputSize: number;
    maximumBytes: number;
    shape: 'round' | 'rect';
    onCancel: () => void;
    onSave: (blob: Blob) => Promise<void>;
}

/** Keep the draggable preview bounded while retaining the decoded original for export. */
export function prepareImagePhoto(bitmap: ImageBitmap): ImagePhoto {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const preview = document.createElement('canvas');
    preview.width = Math.max(1, Math.round(bitmap.width * scale));
    preview.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = preview.getContext('2d');
    if (!context) throw new ApiError('IMAGE_ENCODING_FAILED', 400);
    context.drawImage(bitmap, 0, 0, preview.width, preview.height);
    return { id: crypto.randomUUID(), bitmap, preview: preview.toDataURL('image/png') };
}

export async function prepareSvgPhoto(bytes: Uint8Array): Promise<ImagePhoto> {
    let source: string;
    try { source = parseSvg(bytes).source; }
    catch { throw new ApiError('IMAGE_INVALID_IMAGE', 400); }
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
    try { await image.decode(); } catch { throw new ApiError('IMAGE_ENCODING_FAILED', 400); }
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height || width > maximumSourceDimension || height > maximumSourceDimension || width * height > maximumSourcePixels) throw new ApiError('IMAGE_INVALID_IMAGE', 400);
    const scale = Math.min(1, 1600 / Math.max(width, height));
    let bitmap: ImageBitmap | undefined;
    try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
        const drawing = canvas.getContext('2d');
        if (!drawing) throw new ApiError('IMAGE_ENCODING_FAILED', 400);
        // Paint the SVG viewport explicitly; bitmap decoding of intrinsic-size
        // SVG images can otherwise produce an empty preview in Chromium.
        drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
        bitmap = await createImageBitmap(canvas);
        const photo = prepareImagePhoto(bitmap);
        photo.svg = { source, width, height };
        bitmap = undefined;
        return photo;
    } finally { bitmap?.close(); }
}

export default function ImageCropDialog({ photo, busy, requestError, labels, outputSize, maximumBytes, shape, onCancel, onSave }: ImageCropDialogProps) {
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
    const rotatedWidth = mediaSize ? (rotation % 180 === 0 ? mediaSize.width : mediaSize.height) : 0;
    const rotatedHeight = mediaSize ? (rotation % 180 === 0 ? mediaSize.height : mediaSize.width) : 0;
    const fitZoom = cropSize && rotatedWidth && rotatedHeight ? Math.max(cropSize.width / rotatedWidth, cropSize.height / rotatedHeight) : 1;
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
            const width = outputSize, height = outputSize;
            if (photo.svg) {
                const { source, width: sourceWidth, height: sourceHeight } = photo.svg;
                const { document } = parseSvg(new TextEncoder().encode(source));
                const original = document.documentElement!;
                original.setAttribute('x', '0'); original.setAttribute('y', '0');
                original.setAttribute('width', String(sourceWidth)); original.setAttribute('height', String(sourceHeight));
                // Keep the source viewport identical to its standalone image.
                original.setAttribute('style', `${original.getAttribute('style') ?? ''};width:${sourceWidth}px!important;height:${sourceHeight}px!important;overflow:hidden!important`);
                const transform = `translate(${width / 2} ${height / 2}) scale(${width / cropSize.width} ${height / cropSize.height}) translate(${crop.x} ${crop.y}) rotate(${rotation}) scale(${mediaSize.width / sourceWidth * renderedZoom} ${mediaSize.height / sourceHeight * renderedZoom}) translate(${-sourceWidth / 2} ${-sourceHeight / 2})`;
                const result = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g transform="${transform}">${new XMLSerializer().serializeToString(original)}</g></svg>`;
                const blob = new Blob([result], { type: 'image/svg+xml' });
                if (blob.size > maximumSvgBytes) throw new ApiError('IMAGE_SVG_TOO_LARGE', 400);
                if (current()) await onSave(blob);
                return;
            }
            const output = document.createElement('canvas');
            output.width = width; output.height = height;
            const context = output.getContext('2d');
            if (!context) throw new Error('Canvas unavailable');
            context.imageSmoothingQuality = 'high';
            // Replay the displayed transform so the saved composition matches the preview.
            context.translate(width / 2, height / 2);
            context.scale(width / cropSize.width, height / cropSize.height);
            context.translate(crop.x, crop.y);
            context.rotate(rotation * Math.PI / 180);
            context.scale(mediaSize.width / bitmap.width * renderedZoom, mediaSize.height / bitmap.height * renderedZoom);
            context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
            const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/webp', 0.86));
            if (!blob || blob.size > maximumBytes) throw new Error('Image encoding failed');
            if (blob.type !== 'image/webp') throw new ApiError('IMAGE_WEBP_UNAVAILABLE', 400);
            if (current()) await onSave(blob);
        } catch (cause) { if (current()) setError(cause instanceof ApiError ? cause.code : 'IMAGE_ENCODING_FAILED'); }
        finally { setEncoding(false); }
    }

    const pristine = crop.x === 0 && crop.y === 0 && zoom === 1 && rotation === 0;
    const percentage = `${Math.round(zoom * 100)}%`;
    return createElement('md-dialog', { ref: dialog, className: 'image-crop-dialog', 'aria-label': labels.title, onCancel: (event: Event) => { event.preventDefault(); if (!disabled) onCancel(); } },
        <div slot="headline" className="image-crop-headline"><span>{labels.title}</span><div className="image-crop-tools">
            <Button className="icon-button" disabled={disabled || !ready} aria-label={t('imageEditor.rotate')} title={t('imageEditor.rotate')} onClick={() => { setReady(false); setRotation((value) => (value + 90) % 360); }}><ToolbarIcon name="rotate_right" /></Button>
            <Button className="icon-button" disabled={disabled || pristine} aria-label={t('imageEditor.reset')} title={t('imageEditor.reset')} onClick={reset}><ToolbarIcon name="restart_alt" /></Button>
        </div></div>,
        <div slot="content" className="image-crop-content">
            <p>{t('imageEditor.cropHint')}</p>
            <span className="sr-only" id={hintId}>{t('imageEditor.keyboardHint')}</span>
            <div className="image-crop-stage" ref={stage}>
                {opened && cropSize ? <Cropper image={photo.preview} crop={crop} zoom={renderedZoom} rotation={rotation} aspect={1} cropShape={shape} cropSize={cropSize} objectFit="contain" minZoom={fitZoom} maxZoom={fitZoom * 4} showGrid={false} disableAutomaticStylesInjection
                    onCropChange={(next) => { if (!disabled) setCrop(next); }} onZoomChange={(next) => changeZoom(next / fitZoom)} onCropAreaChange={updateArea} setMediaSize={updateMediaSize}
                    cropperProps={{ role: 'region', 'aria-label': labels.position, 'aria-describedby': hintId, 'aria-disabled': disabled, tabIndex: disabled ? -1 : 0 }}
                    mediaProps={{ alt: labels.preview, onError: () => { setReady(false); setError('IMAGE_ENCODING_FAILED'); } }}
                    style={{ containerStyle: { pointerEvents: disabled ? 'none' : undefined } }}
                /> : <Progress />}
            </div>
            <div className="image-crop-zoom">
                <Button className="icon-button" disabled={disabled || !ready || zoom <= 1} aria-label={t('imageEditor.zoomOut')} title={t('imageEditor.zoomOut')} onClick={() => changeZoom(zoom - .1)}><ToolbarIcon name="remove" /></Button>
                {createElement('md-slider', { min: 1, max: 4, step: .01, value: zoom, disabled: disabled || !ready, 'aria-label': t('imageEditor.zoom'), 'aria-valuetext': percentage, valueLabel: percentage,
                    onInput: (event: Event) => changeZoom((event.currentTarget as MdSlider).value ?? 1),
                })}
                <Button className="icon-button" disabled={disabled || !ready || zoom >= 4} aria-label={t('imageEditor.zoomIn')} title={t('imageEditor.zoomIn')} onClick={() => changeZoom(zoom + .1)}><ToolbarIcon name="add" /></Button>
                <output aria-hidden="true">{percentage}</output>
            </div>
            {error && <div className="notice error" role="alert">{t(`errors.${error}`)}</div>}
            {requestError && <div className="notice error" role="alert">{t(`errors.${requestError}`, { defaultValue: t('errors.UNKNOWN_ERROR') })}</div>}
        </div>,
        <div slot="actions"><Button className="text-button" disabled={disabled} onClick={onCancel}>{t('cancel')}</Button><Button busy={disabled} disabled={!ready || !mediaSize} onClick={() => { void save(); }}>{labels.save}</Button></div>,
    );
}
