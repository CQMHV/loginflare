import { createElement, useEffect, useRef, useState, type ComponentType, type PropsWithChildren } from 'react';
import { Progress } from './material';
import { ToolbarIcon } from './ToolbarIcon';
import { ApiError } from './api';
import { useClearSecrets } from './page-state';
import { inspectImage } from '../shared/avatars';
import { maximumImageBytes, maximumSourceBytes } from '../shared/image-limits';
import type { ImageCropDialogProps, ImageEditorLabels, ImagePhoto } from './ImageCropDialog';

export function ImagePicker({ children, inputLabel, changeLabel, editLabel, accept, busy = false, disabled = false, shape = 'circle', allowSvg = false, outputSize, editorLabels, onSave, onError, onErrorChange, onBusyChange }: PropsWithChildren<{
    inputLabel: string;
    changeLabel: string;
    editLabel: string;
    accept: string;
    busy?: boolean;
    disabled?: boolean;
    shape?: 'circle' | 'rounded';
    allowSvg?: boolean;
    outputSize: number;
    editorLabels: ImageEditorLabels;
    onSave: (blob: Blob) => Promise<void>;
    onError: (cause: unknown) => string;
    onErrorChange: (code: string | undefined) => void;
    onBusyChange?: (busy: boolean) => void;
}>) {
    const input = useRef<HTMLInputElement>(null);
    const [photo, setPhoto] = useState<ImagePhoto>();
    const [Dialog, setDialog] = useState<ComponentType<ImageCropDialogProps>>();
    const [working, setWorking] = useState(false);
    const [error, setError] = useState<string>();
    function report(code?: string) { setError(code); onErrorChange(photo ? undefined : code); }
    function progress(value: boolean) { setWorking(value); onBusyChange?.(value); }
    const capture = useClearSecrets(() => { setPhoto(undefined); report(); progress(false); });
    useEffect(() => () => photo?.bitmap.close(), [photo]);
    const unavailable = busy || disabled || working;

    async function choose(file: File) {
        const active = capture(); progress(true); report();
        let bitmap: ImageBitmap | undefined, selected: ImagePhoto | undefined;
        try {
            const svg = allowSvg && file.type === 'image/svg+xml';
            if (svg && file.size > maximumImageBytes) throw new ApiError('IMAGE_SVG_TOO_LARGE', 413);
            if (file.size > maximumSourceBytes) throw new ApiError('IMAGE_FILE_TOO_LARGE', 413);
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (!active()) return;
            if (!svg) {
                try { inspectImage(bytes); } catch { throw new ApiError('IMAGE_INVALID_IMAGE', 400); }
            }
            const editor = await import('./ImageCropDialog').catch(() => { throw new ApiError('IMAGE_EDITOR_LOAD_FAILED', 0); });
            if (!active()) return;
            if (svg) selected = await editor.prepareSvgPhoto(bytes);
            else {
                try { bitmap = await createImageBitmap(file); } catch { throw new ApiError('IMAGE_ENCODING_FAILED', 400); }
                selected = editor.prepareImagePhoto(bitmap);
                bitmap = undefined;
            }
            if (active()) {
                setDialog(() => editor.default); setPhoto(selected); selected = undefined;
            }
        } catch (cause) { if (active()) report(onError(cause instanceof ApiError ? cause : new ApiError('IMAGE_ENCODING_FAILED', 400))); }
        finally { bitmap?.close(); selected?.bitmap.close(); if (active()) progress(false); }
    }
    async function save(blob: Blob) {
        const active = capture(); progress(true); report();
        try { await onSave(blob); if (active()) setPhoto(undefined); }
        catch (cause) { if (active()) report(onError(cause)); }
        finally { if (active()) progress(false); }
    }
    return <><div className="image-picker" data-shape={shape}>
        <input hidden ref={input} type="file" accept={accept} aria-label={inputLabel} disabled={unavailable} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void choose(file);
        }} />
        <button type="button" className="image-upload-trigger" aria-label={changeLabel} title={changeLabel} disabled={unavailable} aria-busy={working || undefined} onClick={() => input.current?.click()}>
            {children}
            {createElement('md-ripple', { disabled: unavailable })}{createElement('md-focus-ring')}
        </button>
        <button type="button" className="image-edit-button" aria-label={editLabel} title={editLabel} disabled={unavailable} aria-busy={working || undefined} onClick={() => input.current?.click()}>
            {working ? <Progress /> : <ToolbarIcon name="edit" />}
            {createElement('md-ripple', { disabled: unavailable })}{createElement('md-focus-ring')}
        </button>
    </div>{photo && Dialog && <Dialog key={photo.id} photo={photo} busy={working || busy} requestError={error} labels={editorLabels} outputSize={outputSize} shape={shape === 'circle' ? 'round' : 'rect'} onCancel={() => { setPhoto(undefined); report(); }} onSave={save} />}</>;
}
