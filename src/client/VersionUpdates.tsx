import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { UpdateStatus } from '../shared/releases';
import { useResource } from './data';
import { Button } from './material';

function useUpdates() {
    return useResource<UpdateStatus>('updates', '/api/admin/updates');
}

export function UpdateNotice({ details }: { details: string }) {
    const { t } = useTranslation();
    const { data } = useUpdates();
    return data?.status === 'available' ? <div className="notice">
        <span role="status">{t('updates.available', { version: data.availableVersion })}</span>
        {' '}<Link to={details}>{t('updates.details')}</Link>
    </div> : null;
}

export function VersionUpdates() {
    const { t } = useTranslation();
    const { data, isPending, isFetching, refetch } = useUpdates();
    const status = data?.status ?? (isPending ? 'checking' : 'unavailable');
    return <>
        <div className="page-heading"><div><h1>{t('updates.title')}</h1></div></div>
        <section className="card">
            <div className="card-body stack-form">
                {data && <p>{t('updates.installed', { version: data.currentVersion })}{data.currentCommit && <> · <code>{data.currentCommit.slice(0, 12)}</code></>}</p>}
                <p role="status">{t(`updates.${status}`, { version: data?.availableVersion })}</p>
                {status === 'unavailable' && <div><Button className="secondary" busy={isFetching} onClick={() => { void refetch(); }}>{t('tryAgain')}</Button></div>}
                {data?.status === 'available' && <>
                    {data.actionUrl ? <p><a href={data.actionUrl}>{t('updates.prepare')}</a> · {t('updates.confirmOnGitHub')}</p>
                        : <p>{t('updates.repositoryMissing')}</p>}
                </>}
                {data?.releaseUrl && <p><a href={data.releaseUrl}>{t('updates.releaseNotes')}</a></p>}
                {data?.status === 'available' && !data.actionUrl && <p><a href="https://github.com/CQMHV/loginflare/blob/main/docs/upgrading.md">{t('updates.configure')}</a></p>}
            </div>
        </section>
    </>;
}
