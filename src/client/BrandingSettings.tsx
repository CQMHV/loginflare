import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, fetchJson, readResponse } from './api';
import { Button, Select, TextField } from './material';
import { ResourceFeedback, useDataActions, useResource } from './data';
import { useClearSecrets, usePageDraft } from './page-state';
import { colorSchemes, defaultBranding, maximumBrandLogoBytes, type Branding } from '../shared/branding';
import { ImagePicker } from './ImagePicker';
import { ErrorNotice, useFeedback } from './feedback';

type Draft = Pick<Branding, 'name' | 'primaryColor' | 'colorScheme' | 'logoId' | 'logoUrl' | 'revision'>;
function sameSettings(value: Pick<Draft, 'name' | 'primaryColor' | 'colorScheme' | 'logoId'>, other: Pick<Draft, 'name' | 'primaryColor' | 'colorScheme' | 'logoId'>) {
    return value.name === other.name && value.primaryColor.toLowerCase() === other.primaryColor.toLowerCase() && value.colorScheme === other.colorScheme && value.logoId === other.logoId;
}
export function BrandingSettings() {
    const { t } = useTranslation();
    const feedback = useFeedback();
    const query = useResource<Branding>('branding', '/api/admin/branding');
    const actions = useDataActions();
    const [draft, setDraft, clearDraft] = usePageDraft<Draft>('admin:branding');
    const current = draft ?? query.data;
    const changed = !!draft && (!query.data || !sameSettings(draft, query.data));
    const isDefault = !!current && sameSettings(current, defaultBranding);
    const [busy, setBusy] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string>();
    const capture = useClearSecrets(() => {});
    function edit(value: Partial<Draft>) {
        if (!current) return;
        const next = { ...current, ...value };
        setDraft(query.data && sameSettings(next, query.data) ? undefined : next);
        setError(undefined);
    }
    async function upload(source: Blob) {
        const active = capture();
        const response = await fetch('/api/admin/branding/logo', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': source.type, Accept: 'application/json' }, body: source }).catch(() => { throw new ApiError('NETWORK_ERROR', 0); });
        const logo = await readResponse<Pick<Branding, 'logoId' | 'logoUrl'>>(response);
        if (active()) edit(logo);
    }
    async function save(event: FormEvent) {
        event.preventDefault(); if (!current || !changed) return;
        const active = capture(); setBusy(true); setError(undefined);
        try {
            const result = await fetchJson<Branding>('/api/admin/branding', { name: current.name, primaryColor: current.primaryColor, colorScheme: current.colorScheme, logoId: current.logoId, revision: current.revision }, undefined, 'PUT');
            await actions.brandingSaved(result);
            if (active()) { clearDraft(draft); feedback.success(t('saved')); }
        } catch (cause) { if (active()) setError(actions.fail(cause)); }
        finally { if (active()) setBusy(false); }
    }
    return <>
        <div className="page-heading"><div><h1>{t('branding.title')}</h1></div></div>
        <ResourceFeedback query={query} />
        {current && <section className="card"><form className="card-body stack-form branding-form" onSubmit={(event) => { void save(event); }}>
            <ErrorNotice code={error} />
            <div className="branding-logo-editor">
                <ImagePicker inputLabel={t('branding.chooseLogo')} changeLabel={t('branding.chooseLogo')} editLabel={t('branding.editLogo')} accept="image/svg+xml,image/png,image/jpeg,image/webp" shape="rounded" busy={uploading} disabled={busy} allowSvg outputSize={512} maximumBytes={maximumBrandLogoBytes} editorLabels={{ title: t('branding.crop'), position: t('branding.position'), preview: t('branding.preview'), save: t('branding.useLogo') }} onSave={upload} onError={actions.fail} onErrorChange={setError} onBusyChange={setUploading}>
                    <img className="branding-logo-image" src={current.logoUrl} alt="" />
                </ImagePicker>
                {current.logoId && <Button className="text-button" disabled={busy || uploading} onClick={() => edit({ logoId: null, logoUrl: '/assets/logo.svg' })}>{t('branding.defaultLogo')}</Button>}
            </div>
            <TextField label={t('branding.name')} value={current.name} onValueChange={(name) => edit({ name })} maxLength={100} required disabled={busy || uploading} />
            <div className="branding-color-row"><input className="branding-color-picker" type="color" aria-label={t('branding.colorPicker')} value={/^#[0-9a-f]{6}$/i.test(current.primaryColor) ? current.primaryColor : defaultBranding.primaryColor} disabled={busy || uploading} onChange={(event) => edit({ primaryColor: event.currentTarget.value })} /><TextField label={t('branding.primaryColor')} value={current.primaryColor} onValueChange={(primaryColor) => edit({ primaryColor })} pattern="#[0-9a-fA-F]{6}" required disabled={busy || uploading} /></div>
            <Select label={t('branding.colorScheme')} value={current.colorScheme} disabled={busy || uploading} options={colorSchemes.map((scheme) => ({ value: scheme, label: t(`branding.schemes.${scheme}`) }))} onChange={(value) => { const colorScheme = colorSchemes.find((scheme) => scheme === value); if (colorScheme) edit({ colorScheme }); }} />
            <div className="form-footer"><Button className="text-button" disabled={busy || uploading || isDefault} onClick={() => edit({ ...defaultBranding, revision: current.revision, logoUrl: '/assets/logo.svg' })}>{t('branding.reset')}</Button>{changed && <Button className="text-button" disabled={busy || uploading} onClick={() => setDraft(undefined)}>{t('discardDraft')}</Button>}<Button type="submit" busy={busy} disabled={uploading || !changed}>{t('save')}</Button></div>
        </form></section>}
    </>;
}
