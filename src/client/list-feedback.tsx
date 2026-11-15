import { useTranslation } from 'react-i18next';
import type { PropsWithChildren } from 'react';
import { useLocation } from 'react-router-dom';
import { Button } from './material';

export function SearchReset({ onReset }: { onReset: () => void }) {
    const { t } = useTranslation(), { search } = useLocation();
    return new URLSearchParams(search).get('lookupValue') ? <Button className="text-button" onClick={onReset}>{t('clearSearch')}</Button> : null;
}

export function EmptyList({ message, children }: PropsWithChildren<{ message: string }>) {
    const { t } = useTranslation(), { search } = useLocation(), parameters = new URLSearchParams(search);
    const value = parameters.get('lookupValue'), cursor = parameters.get('cursor');
    return <div className="empty-state" role="status">
        <p>{cursor ? t('emptyPage') : value ? t('noSearchResults') : message}</p>
        {value && <><p>{t('searchCondition')}: <code>{value}</code></p>{!cursor && <p>{t('searchRecovery')}</p>}</>}
        {!value && !cursor && children}
    </div>;
}
