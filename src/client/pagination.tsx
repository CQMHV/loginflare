import { useTranslation } from 'react-i18next';
import { Button } from './material';

export interface PageInfo {
    nextCursor: string | null;
    previousCursor: string | null;
}

export interface CursorPage<T> {
    items: T[];
    pageInfo: PageInfo;
}

export function listParameters(search: string): URLSearchParams {
    const source = new URLSearchParams(search);
    const parameters = new URLSearchParams();
    for (const key of ['cursor', 'lookupField', 'lookupValue']) {
        const value = source.get(key);
        if (value) parameters.set(key, value);
    }
    return parameters;
}

export function listPath(path: string, search: string, extra?: Record<string, string>): string {
    const parameters = listParameters(search);
    for (const [key, value] of Object.entries(extra ?? {})) parameters.set(key, value);
    return `${path}${parameters.size ? `?${parameters}` : ''}`;
}

export function pageParameters(search: string): string {
    const parameters = listParameters(search);
    parameters.set('limit', '20');
    return parameters.toString();
}

export function CursorRecovery({ cursor, onReset }: { cursor: string | null; onReset: () => void }) {
    const { t } = useTranslation();
    return cursor ? <div className="list-recovery"><Button className="secondary" onClick={onReset}>{t('returnLatest')}</Button></div> : null;
}

export function PageNavigation({ pageInfo, count, cursor, onNavigate }: {
    pageInfo: PageInfo;
    count: number;
    cursor: string | null;
    onNavigate: (cursor: string | null) => void;
}) {
    const { t } = useTranslation();
    return <div className="pagination"><small>{t('itemsOnPage', { count })}</small><div>
        <Button className="secondary small" disabled={!pageInfo.previousCursor} onClick={() => onNavigate(pageInfo.previousCursor)}>{t('previous')}</Button>
        <Button className="secondary small" disabled={!pageInfo.nextCursor} onClick={() => onNavigate(pageInfo.nextCursor)}>{t('next')}</Button>
        <Button className="text-button small" disabled={!cursor} onClick={() => onNavigate(null)}>{t('returnLatest')}</Button>
    </div></div>;
}
