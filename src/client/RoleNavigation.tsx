import { useTranslation } from 'react-i18next';
import { localizedPath, type Locale } from '../shared/locales';
import { NavigationLink } from './material';

export function RoleNavigation({ locale }: { locale: Locale }) {
    const { t } = useTranslation();
    return <nav className="role-navigation" aria-label={t('administration.roleTypes')}>
        <NavigationLink to={localizedPath(locale, 'admin/access/roles')}>{t('access.roles')}</NavigationLink>
        <NavigationLink to={localizedPath(locale, 'admin/machines/roles')}>{t('machines.roles')}</NavigationLink>
    </nav>;
}
