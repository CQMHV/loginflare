import {
    createContext, Fragment, useContext, useEffect, useRef, useState,
    type FormEvent, type PropsWithChildren,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { defaultLocale, isLocale, localizedPath, localeToPath, pathToLocale, type Locale } from '../shared/locales';
import { ApiError, captchaRequest, errorCode, fetchJson, request, type Identity, type Session, type User } from './api';
import i18n from './i18n';
import { Button, ButtonLink, Checkbox, ConfirmationDialog, Divider, List, ListItem, MenuButton, NavigationLink, Progress, Select, TextField } from './material';
import { setThemePreference, useTheme, type ThemePreference } from './theme';
import { ApplicationEditor, ApplicationsPage } from './Applications';
import { AuthorizedApplicationsPage } from './AuthorizedApplications';
import { EmailsPage } from './Emails';
import { oauthSearch, providerRequest, withOAuthSearch } from './oauth';
import { CursorRecovery, listParameters, listPath, pageParameters, PageNavigation, type CursorPage } from './pagination';
import { resolveLocale, savePreference } from './locale';
import { ConnectionNotice, DataScope, ResourceFeedback, useConfiguration, useDataActions, useIdentity, useResource } from './data';
import { PageStateProvider, useClearSecrets, usePageDraft } from './page-state';
import { Avatar, AvatarEditor } from './Avatar';
import { ToolbarIcon } from './ToolbarIcon';
import { BrandingUpdates, useBranding } from './branding';
import { BrandingSettings } from './BrandingSettings';
import { MfaSettings } from './MfaSettings';
import { SocialButtons, SocialCompletion, SocialSettings } from './Social';
import { SecurityDialog, useSecurity } from './security';
import { SocialConnectionsPage } from './SocialConnections';
import { ErrorNotice, useFeedback } from './feedback';
import { BrowserAccountChooser, BrowserAccountMenu, useBrowserAccounts } from './BrowserAccounts';
import { cancelBrowserFlow, completeBrowserLogin, ensureBrowserFlow, startBrowserFlow } from './browser-account-actions';
import { browserFlowId, browserFlowTargetAccount, clearBrowserFlow, flowPath, selectedBrowserAccount, selectBrowserAccount } from './browser-context';
import { ApiResourcesPage, ApiResourceDetailPage, BusinessRolesPage, UserBusinessRoles, AuditLogsPage } from './AccessManagement';
import { MachineApplicationsPage, MachineApplicationDetailPage, MachineRolesPage } from './Machines';

interface AppContextValue {
    identity: Identity | null | undefined;
    refresh: () => Promise<void>;
    locale: Locale;
}

const AppContext = createContext<AppContextValue>({ identity: undefined, refresh: async () => {}, locale: defaultLocale });

function useApp() {
    return useContext(AppContext);
}

function Icon({ name, size = 20 }: { name: string; size?: number }) {
    const paths: Record<string, React.ReactNode> = {
        arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
        back: <path d="m14 6-6 6 6 6" />,
        profile: <><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></>,
        shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
        sessions: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 21h8m-4-5v5" /></>,
        users: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-3-5" /></>,
        logout: <><path d="M9 4H4v16h5m5-12 4 4-4 4m-6-4h10" /></>,
        check: <path d="m5 12 4 4L19 6" />,
        mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
        lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" /></>,
        globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
        search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 6 6" /></>,
        light: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
        dark: <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />,
        system: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
    };
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.shield}</svg>;
}

function Brand({ destination }: { destination?: string }) {
    const { locale } = useApp();
    const brand = useBranding();
    return <Link className="brand" to={destination ?? localizedPath(locale)} aria-label={brand.name}>
        <img className="brand-logo" src={brand.logoUrl} alt="" onError={(event) => { if (event.currentTarget.getAttribute('src') !== '/assets/logo.svg') event.currentTarget.src = '/assets/logo.svg'; }} /><span className="brand-name">{brand.name}</span>
        <span className="version-label">BETA</span>
    </Link>;
}

function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
    const { locale, identity } = useApp();
    const location = useLocation();
    const navigate = useNavigate();
    const { t } = useTranslation();
    const feedback = useFeedback();
    const dataActions = useDataActions();

    async function changeLanguage(next: string) {
        if (!isLocale(next)) return;
        savePreference(next);
        const segments = location.pathname.split('/');
        segments[1] = localeToPath[next];
        navigate(`${segments.join('/')}${location.search}${location.hash}`);
        if (identity) {
            try {
                await request('/update-user', { locale: next });
                await dataActions.invalidate('profile', 'user', 'users');
            } catch (cause) {
                const code = dataActions.fail(cause);
                feedback.error(t(`errors.${code}`, { lng: next, defaultValue: t('errors.UNKNOWN_ERROR', { lng: next }) }));
            }
        }
    }

    const options = [{ value: 'en-US', label: 'English' }, { value: 'zh-CN', label: '简体中文' }];
    return <div className="language-control">
        {compact
            ? <MenuButton label={t('language')} icon={<ToolbarIcon name="translate" />} options={options.map((option) => ({ ...option, selected: option.value === locale }))} onSelect={(next) => { void changeLanguage(next); }} />
            : <Select label={t('language')} value={locale} options={options} onChange={(next) => { void changeLanguage(next); }} />}
    </div>;
}

function ThemeSwitcher() {
    const { t } = useTranslation();
    const { preference } = useTheme();
    const options = (['light', 'dark', 'system'] as ThemePreference[]).map((value) => ({ value, label: t(`theme_${value}`), selected: value === preference, icon: <Icon name={value} size={24} /> }));
    return <MenuButton className="theme-control" label={t('theme')} icon={<ToolbarIcon name="contrast" />} options={options} onSelect={(value) => { const option = options.find((option) => option.value === value); if (option) setThemePreference(option.value); }} />;
}

function AccountMenu({ busy, onSignOut }: { busy: boolean; onSignOut: () => void }) {
    const { identity, locale, refresh } = useApp();
    return identity ? <BrowserAccountMenu identity={identity} locale={locale} refresh={refresh} signingOut={busy} onSignOut={onSignOut} /> : null;
}

function Busy() {
    const { t } = useTranslation();
    return <div className="loading-state" role="status"><Progress />{t('loading')}</div>;
}

function AuthLayout({ children }: PropsWithChildren) {
    const { t } = useTranslation();
    const brand = useBranding();
    return <div className="auth-shell">
        <aside className="auth-story">
            <Brand />
            <div className="story-content">
                <span className="eyebrow"><span className="status-dot" />{t('platform')}</span>
                <h1>{t('heroTitle')}</h1>
                <p className="story-description">{t('heroDescription')}</p>
                <div className="identity-art" aria-hidden="true">
                    <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
                    <div className="art-dot dot-one" /><div className="art-dot dot-two" />
                    <div className="identity-card"><div className="art-avatar"><Icon name="profile" size={34} /></div><div className="art-lines"><span /><span /></div><span className="art-check"><Icon name="check" size={19} /></span></div>
                    <div className="floating-lock"><Icon name="lock" size={24} /></div>
                </div>
                <div className="story-feature"><span className="feature-icon"><Icon name="shield" /></span><div><strong>{t('privateTitle')}</strong><p>{t('privateDescription')}</p></div></div>
                <div className="story-feature"><span className="feature-icon"><Icon name="lock" /></span><div><strong>{t('secureTitle')}</strong><p>{t('secureDescription')}</p></div></div>
            </div>
            <p className="story-footer">{t('openSource')}</p>
        </aside>
        <main className="auth-main">
            <div className="auth-top"><div className="mobile-brand"><Brand /></div><div className="display-controls"><LanguageSwitcher compact /><ThemeSwitcher /></div></div>
            <div className="auth-form-container">{children}</div>
            <footer className="auth-footer">{brand.name} <span>·</span> {t('tagline')}</footer>
        </main>
    </div>;
}

interface TurnstileApi {
    render: (element: HTMLElement, options: { sitekey: string; language: string; size: 'normal' | 'compact'; theme: 'light' | 'dark'; callback: (token: string) => void; 'expired-callback': () => void; 'error-callback': () => void }) => string;
    remove: (widget: string) => void;
}

declare global {
    interface Window { turnstile?: TurnstileApi }
}

let turnstileLoader: Promise<void> | undefined;

function loadTurnstile(): Promise<void> {
    if (window.turnstile) return Promise.resolve();
    if (!turnstileLoader) {
        turnstileLoader = new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => { turnstileLoader = undefined; script.remove(); reject(new Error('turnstile')); };
            document.head.appendChild(script);
        });
    }
    return turnstileLoader;
}

function Captcha({ onToken, resetKey }: { onToken: (token: string) => void; resetKey: number }) {
    const container = useRef<HTMLDivElement>(null);
    const { locale } = useApp();
    const { theme } = useTheme();
    const { t } = useTranslation();
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [retry, setRetry] = useState(0);
    const configuration = useConfiguration();

    useEffect(() => {
        let disposed = false;
        let widget: string | undefined;
        onToken('');
        setStatus('loading');
        void Promise.all([configuration(), loadTurnstile()]).then(([config]) => {
            if (disposed || !container.current) return;
            if (!config.turnstileSiteKey || !window.turnstile) throw new Error('configuration');
            widget = window.turnstile.render(container.current, {
                sitekey: config.turnstileSiteKey,
                language: locale === 'zh-CN' ? 'zh-cn' : 'en-us',
                size: window.innerWidth < 360 ? 'compact' : 'normal',
                theme,
                callback: (token) => { onToken(token); setStatus('ready'); },
                'expired-callback': () => { onToken(''); },
                'error-callback': () => { onToken(''); setStatus('error'); },
            });
            setStatus('ready');
        }).catch(() => { if (!disposed) setStatus('error'); });
        return () => {
            disposed = true;
            if (widget && window.turnstile) window.turnstile.remove(widget);
        };
    }, [locale, theme, resetKey, retry, onToken, configuration]);

    return <div className="captcha-area">
        <div ref={container} />
        {status === 'loading' && <small className="muted" role="status">{t('captchaLoading')}</small>}
        {status === 'error' && <div className="captcha-error" role="alert">{t('captchaError')} <Button type="button" className="text-button" onClick={() => setRetry((value) => value + 1)}>{t('tryAgain')}</Button></div>}
    </div>;
}

type AuthMode = 'login' | 'signup' | 'verify-email' | 'forgot-password' | 'reset-password' | 'verified';

function AuthPage({ mode }: { mode: AuthMode }) {
    const { locale, identity, refresh } = useApp();
    const { t } = useTranslation();
    const location = useLocation();
    const navigate = useNavigate();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [resetComplete, setResetComplete] = useState(false);
    const [resetAccount, setResetAccount] = useState<string>();
    const feedback = useFeedback();
    const [captchaToken, setCaptchaToken] = useState('');
    const [captchaReset, setCaptchaReset] = useState(0);
    const [email, setEmail] = useState(() => new URLSearchParams(location.search).get('email') ?? '');
    const [loginIdentifier, setLoginIdentifier] = useState(() => new URLSearchParams(location.search).get('email') ?? '');
    const [username, setUsername] = useState('');
    const [name, setName] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [rememberMe, setRememberMe] = useState(true);
    const [recoveryChallenge, setRecoveryChallenge] = useState<string>();
    const [recoveryCode, setRecoveryCode] = useState('');
    const captureSecrets = useClearSecrets(() => { setPassword(''); setConfirmPassword(''); setRecoveryCode(''); setRecoveryChallenge(undefined); setCaptchaToken(''); setCaptchaReset((value) => value + 1); }, mode);
    const token = new URLSearchParams(location.search).get('token');
    const urlError = new URLSearchParams(location.search).get('error');
    const needsCaptcha = ['login', 'signup', 'verify-email'].includes(mode) || (mode === 'forgot-password' && !recoveryChallenge);
    const oauthQuery = oauthSearch(location.search);
    const authPath = (page: string, extra?: Record<string, string>) => withOAuthSearch(localizedPath(locale, page), location.search, extra);
    const callbackURL = `${window.location.origin}${authPath('verified')}`;
    const browserAccounts = useBrowserAccounts();
    const selectingInitial = useRef(false);

    useEffect(() => {
        setError(undefined);
        setBusy(false);
        setResetComplete(false);
        setResetAccount(undefined);
        setPassword('');
        setConfirmPassword('');
        setRecoveryChallenge(undefined);
        setRecoveryCode('');
    }, [mode]);

    useEffect(() => {
        if (mode !== 'login' || oauthQuery || browserFlowId() || selectedBrowserAccount() || selectingInitial.current) return;
        const active = browserAccounts.data?.accounts.filter((account) => account.status === 'active');
        if (active?.length !== 1) return;
        selectingInitial.current = true;
        void fetchJson<{ accountId: string }>('/api/browser/accounts/select', { accountId: active[0].id }).then(async (result) => {
            selectBrowserAccount(result.accountId); await refresh(); navigate(localizedPath(locale, 'account'), { replace: true });
        }).catch((cause) => { setError(errorCode(cause)); selectingInitial.current = false; });
    }, [mode, oauthQuery, browserAccounts.data, refresh, navigate, locale]);

    if (mode === 'login' && !oauthQuery && !browserFlowId() && !selectedBrowserAccount() && (!browserAccounts.data || !error && browserAccounts.data.accounts.filter((account) => account.status === 'active').length === 1)) return <AuthLayout>{browserAccounts.data ? <Busy /> : <ResourceFeedback query={browserAccounts} />}</AuthLayout>;
    if (!browserFlowId() && !oauthQuery && mode === 'login' && browserAccounts.data?.accounts.length && (!identity || !selectedBrowserAccount()) && browserAccounts.data.accounts.filter((account) => account.status === 'active').length !== 1) return <Navigate to={authPath('select-account')} replace />;
    if (identity && !browserFlowId() && !oauthQuery && (mode === 'login' || mode === 'signup')) return <Navigate to={localizedPath(locale, 'account')} replace />;

    const titleKeys: Record<AuthMode, string> = {
        login: 'loginTitle', signup: 'signupTitle', 'verify-email': 'verificationTitle',
        'forgot-password': 'forgotTitle', 'reset-password': 'resetTitle', verified: 'verifiedTitle',
    };
    const descriptionKeys: Record<AuthMode, string> = {
        login: 'loginDescription', signup: 'signupDescription', 'verify-email': 'verificationDescription',
        'forgot-password': 'forgotDescription', 'reset-password': 'resetDescription', verified: 'verifiedDescription',
    };

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const secretsCurrent = captureSecrets();
        setError(undefined);
        if (needsCaptcha && !captchaToken) {
            setError('CAPTCHA_TOKEN_MISSING');
            return;
        }
        if ((mode === 'signup' || mode === 'reset-password') && password !== confirmPassword) {
            setError('PASSWORD_MISMATCH');
            return;
        }
        setBusy(true);
        try {
            switch (mode) {
                case 'login': {
                    const form = new FormData(event.currentTarget);
                    const identifier = String(form.get('identifier') ?? '').trim();
                    const path = identifier.includes('@') ? '/sign-in/email' : '/sign-in/username';
                    const credentials = {
                        ...(identifier.includes('@') ? { email: identifier } : { username: identifier }),
                        password: String(form.get('password') ?? ''),
                        rememberMe,
                    };
                    await ensureBrowserFlow(locale, oauthQuery || undefined);
                    if (oauthQuery) {
                        const result = await providerRequest(path, credentials, captchaToken);
                        if (!secretsCurrent()) return;
                        savePreference(locale);
                        if (result?.twoFactorRedirect) {
                            setPassword('');
                            await refresh();
                            navigate(authPath('two-factor'), { replace: true });
                            return;
                        }
                        if (result?.redirect) { await completeBrowserLogin(result, true); return; }
                        throw new ApiError('INVALID_OAUTH_QUERY', 400);
                    }
                    const result = await captchaRequest<{ twoFactorRedirect?: boolean; browserAccountId?: string }>(path, credentials, captchaToken);
                    if (!secretsCurrent()) return;
                    setPassword('');
                    if (!result.twoFactorRedirect) await completeBrowserLogin(result);
                    await refresh();
                    savePreference(locale);
                    navigate(result.twoFactorRedirect ? flowPath(localizedPath(locale, 'two-factor')) : localizedPath(locale, 'account'), { replace: true });
                    break;
                }
                case 'signup':
                    await captchaRequest('/sign-up/email', { email: email.trim(), username: username.trim(), password, name, locale, callbackURL }, captchaToken);
                    savePreference(locale);
                    navigate(authPath('verify-email', { email }));
                    break;
                case 'verify-email':
                    await captchaRequest('/send-verification-email', { email, callbackURL }, captchaToken);
                    feedback.success(t('emailRequested'));
                    break;
                case 'forgot-password':
                    if (recoveryChallenge) {
                        const result = await request<{ token: string }>('/emails/recovery/verify', { challengeId: recoveryChallenge, code: recoveryCode.trim() });
                        if (secretsCurrent()) navigate(authPath('reset-password', { token: result.token }));
                    } else {
                        const result = await captchaRequest<{ challengeId: string }>('/emails/recovery/start', { identifier: loginIdentifier.trim(), email: email.trim() }, captchaToken);
                        if (secretsCurrent()) setRecoveryChallenge(result.challengeId);
                    }
                    break;
                case 'reset-password': {
                    const targetAccount = browserFlowTargetAccount() || undefined;
                    await request('/reset-password', { token, newPassword: password });
                    setResetAccount(targetAccount);
                    clearBrowserFlow();
                    try { await refresh(); }
                    catch (cause) {
                        if (!(cause instanceof ApiError && [401, 403].includes(cause.status))) throw cause;
                        selectBrowserAccount('', false);
                    }
                    setResetComplete(true);
                    setPassword('');
                    setConfirmPassword('');
                    break;
                }
            }
        } catch (cause) {
            setError(errorCode(cause));
        } finally {
            setBusy(false);
            if (needsCaptcha) setCaptchaReset((value) => value + 1);
        }
    }

    return <AuthLayout>
        {['verify-email', 'forgot-password', 'reset-password', 'verified'].includes(mode) && <div className="auth-step-icon"><Icon name={mode === 'verified' ? 'check' : mode === 'verify-email' ? 'mail' : 'lock'} size={26} /></div>}
        <h2>{t(titleKeys[mode])}</h2>
        <p className="section-description">{t(descriptionKeys[mode])}</p>
        {oauthQuery && <p className="oauth-context">{t('oauth.authorizationPending')}</p>}
        {mode === 'verified' ? urlError ? <ErrorNotice code="INVALID_TOKEN" /> : <ButtonLink className="primary full" to={authPath('login')}>{t('login')}<Icon name="arrow" size={18} /></ButtonLink> :
            mode === 'reset-password' && (!token || urlError) ? <ErrorNotice message={t('invalidLink')} /> :
            mode === 'reset-password' && resetComplete ? <><p className="section-description" role="status">{t('resetDone')}</p><Button className="primary full" busy={busy} onClick={() => {
                setBusy(true); setError(undefined);
                void startBrowserFlow(resetAccount ? 'reauth' : selectedBrowserAccount() ? 'add' : 'login', locale, resetAccount, oauthQuery || undefined).then(() => navigate(flowPath(authPath('login')))).catch((cause) => { setError(errorCode(cause)); setBusy(false); });
            }}>{t('login')}<Icon name="arrow" size={18} /></Button><ErrorNotice code={error} /></> :
            <form onSubmit={(event) => { void submit(event); }} className="stack-form">
                <ErrorNotice code={urlError ? 'INVALID_TOKEN' : error === 'PASSWORD_MISMATCH' ? undefined : error} message={error === 'PASSWORD_MISMATCH' ? t('passwordMismatch') : undefined} />
                {mode === 'signup' && <TextField label={t('name')} autoComplete="nickname" name="name" value={name} onValueChange={setName} placeholder={t('namePlaceholder')} maxLength={100} required />}
                {mode === 'signup' && <TextField label={t('username')} autoComplete="username" name="username" value={username} onValueChange={setUsername} placeholder={t('usernamePlaceholder')} minLength={3} maxLength={30} pattern="[a-zA-Z0-9_.]+" supportingText={t('usernameHint')} required />}
                {mode === 'login' && <TextField label={t('loginIdentifier')} autoComplete="username" type="text" name="identifier" value={loginIdentifier} onValueChange={setLoginIdentifier} placeholder={t('loginIdentifierPlaceholder')} maxLength={254} required />}
                {mode === 'forgot-password' && !recoveryChallenge && <>
                    <TextField label={t('emails.recoveryIdentifier')} autoComplete="username" name="identifier" value={loginIdentifier} onValueChange={setLoginIdentifier} placeholder={t('loginIdentifierPlaceholder')} maxLength={254} required />
                    <TextField label={t('emails.recoveryAddress')} autoComplete="email" type="email" name="email" value={email} onValueChange={setEmail} placeholder={t('emailPlaceholder')} maxLength={254} supportingText={t('emails.recoveryAddressHint')} required />
                </>}
                {mode === 'forgot-password' && recoveryChallenge && <><p role="status">{t('emails.recoveryRequested')}</p><TextField label={t('emails.code')} autoComplete="one-time-code" inputMode="numeric" name="code" value={recoveryCode} onValueChange={setRecoveryCode} pattern="[0-9]{6}" minLength={6} maxLength={6} supportingText={t('emails.codeHint')} required /></>}
                {(mode === 'signup' || mode === 'verify-email') && <TextField label={t('email')} autoComplete="email" type="email" name="email" value={email} onValueChange={setEmail} placeholder={t('emailPlaceholder')} maxLength={254} required />}
                {['login', 'signup', 'reset-password'].includes(mode) && <TextField label={t(mode === 'reset-password' ? 'newPassword' : 'password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} type="password" name="password" value={password} onValueChange={setPassword} minLength={mode === 'login' ? undefined : 8} maxLength={128} supportingText={mode === 'login' ? undefined : t('passwordHint')} required />}
                {(mode === 'signup' || mode === 'reset-password') && <TextField label={t('confirmPassword')} autoComplete="new-password" type="password" name="confirmPassword" value={confirmPassword} onValueChange={setConfirmPassword} minLength={8} maxLength={128} required />}
                {mode === 'login' && <div className="form-options"><Checkbox label={t('rememberMe')} checked={rememberMe} onCheckedChange={setRememberMe} /><Link to={authPath('forgot-password')}>{t('forgotPassword')}</Link></div>}
                {needsCaptcha && <Captcha onToken={setCaptchaToken} resetKey={captchaReset} />}
                <Button type="submit" className="primary full" busy={busy} disabled={needsCaptcha && !captchaToken}>{busy ? t('working') : t(mode === 'login' ? 'login' : mode === 'signup' ? 'signup' : mode === 'verify-email' ? 'resend' : mode === 'forgot-password' ? recoveryChallenge ? 'emails.recoveryVerify' : 'emails.sendCode' : 'resetPassword')}<Icon name="arrow" size={18} /></Button>
                {mode === 'forgot-password' && recoveryChallenge && <Button className="text-button" disabled={busy} onClick={() => {
                    setRecoveryChallenge(undefined); setRecoveryCode(''); setError(undefined); setCaptchaToken(''); setCaptchaReset((value) => value + 1);
                }}>{t('emails.recoveryStartOver')}</Button>}
            </form>}
        {['login', 'signup'].includes(mode) && <SocialButtons locale={locale} />}
        {mode === 'login' && <p className="auth-crosslink">{t('noAccount')} <Link to={authPath('signup')}>{t('signup')}</Link></p>}
        {mode === 'signup' && <p className="auth-crosslink">{t('haveAccount')} <Link to={authPath('login')}>{t('login')}</Link></p>}
        {mode === 'signup' && error && <Link className="resend-link" to={authPath('verify-email', { email })}>{t('resend')}</Link>}
        {browserFlowId() && ['login', 'signup', 'verify-email'].includes(mode) && <Button className="text-button full" disabled={busy} onClick={() => { void cancelBrowserFlow().then(async (previous) => { await refresh(); navigate(localizedPath(locale, previous ? 'account' : 'select-account'), { replace: true }); }).catch((cause) => setError(errorCode(cause))); }}>{t('browserAccounts.cancel')}</Button>}
        {['verify-email', 'forgot-password', 'reset-password'].includes(mode) && <Link className="back-link" to={authPath('login')}><Icon name="back" size={15} />{t('backToLogin')}</Link>}
    </AuthLayout>;
}

function TwoFactorPage() {
    const { locale, identity, refresh } = useApp();
    const { t } = useTranslation();
    const location = useLocation();
    const navigate = useNavigate();
    const [backup, setBackup] = useState(false);
    const [code, setCode] = useState('');
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const captureSecrets = useClearSecrets(() => setCode(''));
    const query = oauthSearch(location.search);
    const social = new URLSearchParams(location.search).get('social') === '1';
    async function submit(event: FormEvent) {
        event.preventDefault();
        const current = captureSecrets();
        setBusy(true); setError(undefined);
        try {
            const path = backup ? '/two-factor/verify-backup-code' : '/two-factor/verify-totp';
            if (query) {
                const result = await providerRequest(path, { code: code.trim() });
                if (!result?.redirect) throw new ApiError('INVALID_OAUTH_QUERY', 400);
                return;
            }
            const result = await request<{ browserAccountId?: string }>(path, { code: code.trim() });
            if (!current()) return;
            setCode('');
            if (!social) await completeBrowserLogin(result);
            await refresh();
            savePreference(locale);
            navigate(social ? flowPath(localizedPath(locale, 'social/complete')) : localizedPath(locale, 'account'), { replace: true });
        } catch (cause) { if (current()) setError(errorCode(cause)); }
        finally { setBusy(false); }
    }
    if (identity && !browserFlowId() && !query && !social) return <Navigate to={localizedPath(locale, 'account')} replace />;
    return <AuthLayout>
        <div className="auth-step-icon"><Icon name="shield" size={26} /></div>
        <h2>{t('mfa.challengeTitle')}</h2>
        <p className="section-description">{t(backup ? 'mfa.backupDescription' : 'mfa.challengeDescription')}</p>
        {query && <p className="oauth-context">{t('oauth.authorizationPending')}</p>}
        <form className="stack-form" onSubmit={(event) => { void submit(event); }}>
            <ErrorNotice code={error} />
            <TextField label={t(backup ? 'mfa.backupCode' : 'mfa.code')} name="code" value={code} onValueChange={setCode} autoComplete="one-time-code" inputMode={backup ? 'text' : 'numeric'} pattern={backup ? undefined : '[0-9]{6}'} minLength={backup ? undefined : 6} maxLength={backup ? 32 : 6} required />
            <Button type="submit" className="primary full" busy={busy}>{t('mfa.verify')}</Button>
            <Button className="text-button" disabled={busy} onClick={() => { setBackup(!backup); setCode(''); setError(undefined); }}>{t(backup ? 'mfa.useAuthenticator' : 'mfa.useBackup')}</Button>
        </form>
        <Link className="back-link" to={withOAuthSearch(localizedPath(locale, 'login'), location.search)}>{t('backToLogin')}</Link>
        {browserFlowId() && <Button className="text-button full" disabled={busy} onClick={() => { void cancelBrowserFlow().then(async (previous) => { await refresh(); navigate(localizedPath(locale, previous ? 'account' : 'select-account'), { replace: true }); }).catch((cause) => setError(errorCode(cause))); }}>{t('browserAccounts.cancel')}</Button>}
    </AuthLayout>;
}

function SocialCompletionPage() {
    const { locale, refresh } = useApp();
    return <AuthLayout><SocialCompletion locale={locale} refresh={refresh} /></AuthLayout>;
}

function SelectAccountPage() {
    const { locale, refresh } = useApp();
    return <AuthLayout><BrowserAccountChooser locale={locale} refresh={refresh} /></AuthLayout>;
}

function ConsentPage() {
    const brand = useBranding();
    const { locale, identity } = useApp();
    const { t } = useTranslation();
    const location = useLocation();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const query = oauthSearch(location.search);
    const consentQuery = useResource<{ client: { clientId: string; name: string }; scopes: string[]; resource?: { name: string; identifier: string }; permissions?: { scope: string; name: string; description: string }[] }>('consent', `/api/oauth/consent?${new URLSearchParams({ oauth_query: query })}`, query, !!query);
    const consent = consentQuery.data;
    const consentError = error ?? (consentQuery.error ? errorCode(consentQuery.error) : undefined);
    async function decide(accept: boolean) {
        setBusy(true); setError(undefined);
        try {
            const result = await providerRequest('/oauth2/consent', { accept });
            if (!result?.redirect) throw new ApiError('INVALID_OAUTH_QUERY', 400);
        }
        catch (cause) { setError(errorCode(cause)); setBusy(false); }
    }
    if (!query) return <AuthLayout><h2>{t('oauth.consentTitle')}</h2><ErrorNotice code="INVALID_OAUTH_QUERY" /><p className="oauth-context">{t('oauth.restartAuthorization')}</p></AuthLayout>;
    if (identity === undefined) return <AuthLayout><Busy /></AuthLayout>;
    if (!identity) return <Navigate to={withOAuthSearch(localizedPath(locale, 'login'), location.search)} replace />;
    return <AuthLayout>
        <div className="auth-step-icon"><Icon name="shield" size={26} /></div>
        <h2>{t('oauth.consentTitle')}</h2>
        {!consent && <ErrorNotice code={consentError} />}
        {!consent && !consentError && <Busy />}
        {consent && <>
            <p className="section-description">{t('oauth.consentDescription', { name: consent.client.name, brand: brand.name })}</p>
            <p className="consent-account">{t('oauth.consentAccount', { email: identity.user.email })}</p>
            {consent.resource && <div className="consent-resource"><strong>{consent.resource.name}</strong><code className="break-all">{consent.resource.identifier}</code></div>}
            <p>{t('oauth.consentPermissions')}</p>
            <ul className="consent-permissions">{consent.scopes.map((scope) => { const permission = consent.permissions?.find((item) => item.scope === scope); return <li key={scope}>{permission?.name || t(`oauth.scope_${scope}`, { defaultValue: scope })}{permission?.description && <small>{permission.description}</small>}</li>; })}</ul>
            <p className="section-description">{t('oauth.consentNotice')}</p>
            <ErrorNotice code={error} />
            <div className="action-row"><Button busy={busy} onClick={() => { void decide(true); }}>{t('oauth.allow')}</Button><Button className="secondary" disabled={busy} onClick={() => { void decide(false); }}>{t('oauth.deny')}</Button></div>
        </>}
        {!consent && consentError && <p className="oauth-context">{t('oauth.restartAuthorization')}</p>}
    </AuthLayout>;
}

function Protected({ adminOnly = false, developerOnly = false }: { adminOnly?: boolean; developerOnly?: boolean }) {
    const { identity, locale } = useApp();
    if (identity === undefined) return <Busy />;
    if (!identity) return <Navigate to={flowPath(localizedPath(locale, 'login'))} replace />;
    if (adminOnly && identity.user.role !== 'admin') return <StatePage forbidden />;
    if (developerOnly && (identity.user.banned || !identity.user.emailVerified)) return <StatePage forbidden />;
    return <Outlet />;
}

type AppArea = 'account' | 'developer' | 'admin';

interface AppFrameProps {
    area: AppArea;
    title: string;
    home: string;
    navigationLabel: string;
    navigation: React.ReactNode;
}

function AreaSwitcher({ area, title }: { area: AppArea; title: string }) {
    const { identity, locale } = useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const icon = <Icon name={area === 'admin' ? 'shield' : area === 'developer' ? 'globe' : 'profile'} />;
    const options = [
        { value: 'account', label: t('accountCenter'), icon: <Icon name="profile" size={24} />, selected: area === 'account' },
        ...(identity?.user.emailVerified && !identity.user.banned ? [{ value: 'developer', label: t('developerCenter'), icon: <Icon name="globe" size={24} />, selected: area === 'developer' }] : []),
        ...(identity?.user.role === 'admin' ? [{ value: 'admin', label: t('adminConsole'), icon: <Icon name="shield" size={24} />, selected: area === 'admin' }] : []),
    ];
    return <div className="area-selector">
        {options.length > 1 ? <MenuButton variant="navigation" placement="above" label={t('switchArea')} description={title} icon={icon} options={options}
            onSelect={(next) => {
                if (next !== area && options.some((option) => option.value === next)) navigate(localizedPath(locale, next === 'admin' ? 'admin/users' : next === 'developer' ? 'developer/applications' : 'account'));
            }} /> : <div className="area-label">{icon}<span>{title}</span></div>}
    </div>;
}

function AppFrame({ area, title, home, navigationLabel, navigation }: AppFrameProps) {
    const brand = useBranding();
    const { locale } = useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [busy, setBusy] = useState(false);
    const feedback = useFeedback();
    const dataActions = useDataActions();
    const captureSignOut = useClearSecrets(() => setBusy(false));

    async function signOut() {
        const current = captureSignOut();
        setBusy(true);
        try {
            await request('/sign-out', {});
            dataActions.signOut();
            if (!current()) return;
            clearBrowserFlow(); selectBrowserAccount('');
            navigate(localizedPath(locale, 'select-account'), { replace: true });
        } catch (cause) {
            const code = dataActions.fail(cause);
            feedback.error(t(`errors.${code}`, { defaultValue: t('errors.UNKNOWN_ERROR') }));
        } finally {
            if (current()) setBusy(false);
        }
    }

    return <div className="app-shell" data-area={area}>
        <aside className="sidebar">
            <Brand destination={home} />
            <nav aria-label={navigationLabel}>{navigation}</nav>
            <AreaSwitcher area={area} title={title} />
        </aside>
        <div className="app-content">
            <header className="app-header"><div className="mobile-brand"><Brand destination={home} /></div><div className="header-actions"><LanguageSwitcher compact /><ThemeSwitcher /><AccountMenu busy={busy} onSignOut={() => { void signOut(); }} /></div></header>
            <main className="page-content"><ConnectionNotice /><Outlet /></main>
            <footer className="app-footer">{brand.name} <span>·</span> {t('openSource')}</footer>
        </div>
    </div>;
}

function AccountLayout() {
    const { locale } = useApp();
    const { t } = useTranslation();
    return <AppFrame area="account" title={t('accountCenter')} home={localizedPath(locale, 'account')} navigationLabel={t('accountNavigation')}
        navigation={<>
            <NavigationLink end to={localizedPath(locale, 'account')}><Icon name="profile" />{t('profile')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'account/emails')}><Icon name="mail" />{t('emails.title')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'account/security')}><Icon name="shield" />{t('security')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'account/sessions')}><Icon name="sessions" />{t('sessions')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'account/applications')}><Icon name="globe" />{t('oauth.authorizedApplicationsTitle')}</NavigationLink></>} />;
}

function AdminLayout() {
    const { locale } = useApp();
    const { t } = useTranslation();
    return <AppFrame area="admin" title={t('adminConsole')} home={localizedPath(locale, 'admin/users')} navigationLabel={t('adminNavigation')}
        navigation={<>
            <NavigationLink to={localizedPath(locale, 'admin/users')}><Icon name="users" />{t('users')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'admin/applications')}><Icon name="globe" />{t('oauth.applications')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'admin/access/resources')}><Icon name="globe" />{t('access.resources')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'admin/access/roles')}><Icon name="shield" />{t('access.roles')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'admin/machines/applications')}><Icon name="sessions" />{t('machines.applications')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'admin/machines/roles')}><Icon name="shield" />{t('machines.roles')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'admin/audit-logs')}><Icon name="sessions" />{t('access.audit')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'admin/branding')}><ToolbarIcon name="settings" />{t('branding.title')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'admin/social-connections')}><Icon name="globe" />{t('social.title')}</NavigationLink></>} />;
}

function DeveloperLayout() {
    const { locale } = useApp();
    const { t } = useTranslation();
    return <AppFrame area="developer" title={t('developerCenter')} home={localizedPath(locale, 'developer/applications')} navigationLabel={t('developerNavigation')}
        navigation={<NavigationLink to={localizedPath(locale, 'developer/applications')}><Icon name="globe" />{t('oauth.myApplications')}</NavigationLink>} />;
}

function PageHeading({ title, description, children }: PropsWithChildren<{ title: string; description: string }>) {
    return <div className="page-heading"><div><h1>{title}</h1><p>{description}</p></div>{children}</div>;
}

function ProfilePage() {
    const { identity, locale } = useApp();
    const identityQuery = useIdentity();
    const { t } = useTranslation();
    const [draft, setDraft, clearDraft] = usePageDraft<{ name?: string; username?: string }>('profile');
    const name = draft?.name ?? identity?.user.name ?? '';
    const username = draft?.username ?? identity?.user.username ?? '';
    const dataActions = useDataActions();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const feedback = useFeedback();
    async function save(event: FormEvent) {
        event.preventDefault();
        setBusy(true); setError(undefined);
        try {
            await request('/update-user', { ...(name.trim() ? { name } : {}), ...(username.trim() ? { username: username.trim() } : {}) });
            await dataActions.invalidate('profile', 'user', 'users'); clearDraft(draft); feedback.success(t('saved'));
        } catch (cause) { setError(dataActions.fail(cause)); }
        finally { setBusy(false); }
    }
    return <>
        <PageHeading title={t('profileTitle')} description={t('profileDescription')} />
        <ResourceFeedback query={{ ...identityQuery, error: null }} />
        <section className="card profile-card" aria-labelledby="profile-account-title"><div className="card-heading"><h2 id="profile-account-title">{t('accountDetails')}</h2><p>{t('accountDetailsDescription')}</p></div><div className="card-body">
            <AvatarEditor name={identity?.user.name || identity?.user.email || ''} image={identity?.user.image} />
            <Divider />
            <form className="stack-form profile-form" onSubmit={(event) => { void save(event); }}>
                <ErrorNotice code={error} />
                <TextField label={t('name')} name="name" autoComplete="nickname" value={name} onValueChange={(name) => setDraft({ ...draft, name })} maxLength={100} required={!!identity?.user.name} />
                <TextField label={t('username')} name="username" autoComplete="username" value={username} onValueChange={(username) => setDraft({ ...draft, username })} placeholder={t('usernamePlaceholder')} minLength={3} maxLength={30} pattern="[a-zA-Z0-9_.]+" supportingText={`${t('usernameHint')}${identity?.user.username ? '' : ` ${t('usernameNotSetHint')}`}`} required={!!identity?.user.username} />
                <div className="form-footer">{draft && <Button className="text-button" onClick={() => setDraft(undefined)}>{t('discardDraft')}</Button>}<Button className="primary" type="submit" busy={busy}>{t('save')}</Button></div>
            </form>
            <dl className="account-metadata"><div><dt>{t('memberSince')}</dt><dd>{formatDate(identity?.user.createdAt, locale)}</dd></div><div><dt>{t('accountId')}</dt><dd><code>{identity?.user.id}</code></dd></div></dl>
        </div></section>
        <section className="card"><div className="card-heading"><h2>{t('preferences')}</h2><p>{t('preferencesDescription')}</p></div><List className="preference-list" label={t('preferences')}><ListItem headline={t('language')} end={<LanguageSwitcher />} /></List></section>
    </>;
}

function SecurityPage() {
    const { t } = useTranslation();
    const { identity, refresh } = useApp();
    const security = useSecurity();
    const hasPassword = security.data?.hasPassword;
    const dataActions = useDataActions();
    const [editingPassword, setEditingPassword] = useState(false);
    const [newPassword, setNewPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const feedback = useFeedback();
    function clear() { setEditingPassword(false); setNewPassword(''); setConfirmation(''); setError(undefined); }
    const captureSecrets = useClearSecrets(clear);
    useEffect(() => {
        if (!hasPassword && security.data?.proofPurpose === 'set-password' && (security.data.proofExpiresAt ?? 0) > Date.now()) setEditingPassword(true);
    }, [hasPassword, security.data?.proofPurpose, security.data?.proofExpiresAt]);
    async function submit(verifiedPassword: string) {
        if (busy || !editingPassword || !security.data) return;
        setError(undefined);
        if (hasPassword ? !verifiedPassword : security.data.proofPurpose !== 'set-password' || (security.data.proofExpiresAt ?? 0) <= Date.now()) { setError('SOCIAL_REAUTH_REQUIRED'); return; }
        if (newPassword !== confirmation) { setError('PASSWORD_MISMATCH'); return; }
        const current = captureSecrets();
        setBusy(true);
        try {
            if (hasPassword) await request('/change-password', { currentPassword: verifiedPassword, newPassword, revokeOtherSessions: true });
            else await request('/social/set-password', { newPassword });
            if (!current()) return;
            await dataActions.invalidate('sessions', 'security');
            await refresh();
            clear(); feedback.success(t('passwordChanged'));
        } catch (cause) { if (current()) setError(dataActions.fail(cause)); }
        finally { setBusy(false); }
    }
    const passwordTitle = t(hasPassword ? 'changePassword' : 'social.setPassword');
    return <><PageHeading title={t('securityTitle')} description={t('securityDescription')} /><ResourceFeedback query={security} />{security.data && <>
        <section className="card"><div className="card-heading"><h2>{passwordTitle}</h2><p>{t(hasPassword ? 'changePasswordDescription' : 'social.passwordless')}</p></div><div className="card-body"><Button disabled={busy} onClick={() => { clear(); setEditingPassword(true); }}>{passwordTitle}</Button></div></section>
        {editingPassword && <SecurityDialog title={passwordTitle} purpose="set-password" confirmLabel={passwordTitle} busy={busy} error={error === 'PASSWORD_MISMATCH' ? undefined : error}
            confirmDisabled={!newPassword || !confirmation} onConfirm={(verifiedPassword) => { void submit(verifiedPassword); }} onCancel={clear}
            onVerificationLost={() => { setNewPassword(''); setConfirmation(''); setError(undefined); }}>
            {error === 'PASSWORD_MISMATCH' && <ErrorNotice message={t('passwordMismatch')} />}
            <TextField label={t('newPassword')} type="password" name="newPassword" autoComplete="new-password" value={newPassword} onValueChange={setNewPassword} minLength={8} maxLength={128} required supportingText={t('passwordHint')} />
            <TextField label={t('confirmPassword')} type="password" name="confirmPassword" autoComplete="new-password" value={confirmation} onValueChange={setConfirmation} minLength={8} maxLength={128} required />
        </SecurityDialog>}
        <SocialSettings /><MfaSettings enabled={!!identity?.user.twoFactorEnabled} refresh={refresh} /></>}</>;
}

function formatDate(value: string | undefined, locale: Locale): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

function deviceName(agent?: string | null): string {
    if (!agent) return '';
    const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : '';
    const os = /Windows/.test(agent) ? 'Windows' : /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Macintosh/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : '';
    return [browser, os].filter(Boolean).join(' · ') || agent.slice(0, 80);
}

function SessionsPage() {
    const { identity, locale, refresh } = useApp();
    const { t } = useTranslation();
    const [parameters, setParameters] = useSearchParams();
    const cursor = parameters.get('cursor');
    const query = pageParameters(parameters.toString());
    const sessionQuery = useResource<CursorPage<Session> & { hasOtherSessions: boolean }>('sessions', `/api/account/sessions?${query}`, query);
    const data = sessionQuery.data;
    const dataActions = useDataActions();
    const feedback = useFeedback();
    const [busy, setBusy] = useState(false);
    function navigatePage(nextCursor: string | null) {
        setParameters(nextCursor ? { cursor: nextCursor } : {});
    }
    async function revoke(session?: Session) {
        setBusy(true);
        try {
            if (session) await request('/revoke-session', { token: session.token });
            else await request('/revoke-other-sessions', {});
            await refresh();
            if (!session) navigatePage(null);
            await dataActions.invalidate('sessions');
            feedback.success(t(session ? 'sessionRevoked' : 'othersRevoked'));
        } catch (cause) {
            const code = dataActions.fail(cause);
            feedback.error(t(`errors.${code}`, { defaultValue: t('errors.UNKNOWN_ERROR') }));
        }
        finally { setBusy(false); }
    }
    return <><PageHeading title={t('sessionsTitle')} description={t('sessionsDescription')} />{sessionQuery.error && <CursorRecovery cursor={cursor} onReset={() => navigatePage(null)} />}<section className="card"><div className="card-heading heading-with-action"><h2>{t('activeSessions')}</h2><Button className="secondary small" busy={busy} disabled={!data?.hasOtherSessions} onClick={() => { void revoke(); }}>{t('revokeOthers')}</Button></div>
        <ResourceFeedback query={sessionQuery} />
        {data?.items.length === 0 && <p className="empty-state">{t('sessionsEmpty')}</p>}
        {!!data?.items.length && <List className="session-list" label={t('activeSessions')}>{data.items.map((session, index) => <Fragment key={session.id}>
            {index > 0 && <Divider />}
            <ListItem className="session-row" start={<span className="session-icon"><Icon name="sessions" size={25} /></span>}
                headline={<div className="session-headline"><strong>{deviceName(session.userAgent) || t('unknownDevice')}</strong>{session.id === identity?.session.id && <span className="badge current">{t('currentSession')}</span>}</div>}
                supportingText={<div className="session-description"><p>{session.ipAddress || t('unknownIp')}</p><small>{t('signedIn')} {formatDate(session.createdAt, locale)} <span>·</span> {t('expires')} {formatDate(session.expiresAt, locale)}</small><Button className="text-button danger" busy={busy} onClick={() => { void revoke(session); }}>{t('revoke')}</Button></div>}
            />
        </Fragment>)}</List>}
        {data && <PageNavigation pageInfo={data.pageInfo} count={data.items.length} cursor={cursor} onNavigate={navigatePage} />}
    </section></>;
}

function UserStatus({ user }: { user: User }) {
    const { t } = useTranslation();
    return <span className={`badge ${user.banned ? 'suspended' : 'active'}`}><span className="status-dot" />{t(user.banned ? 'suspended' : 'active')}</span>;
}

function UsersPage() {
    const { locale } = useApp();
    const { t } = useTranslation();
    const location = useLocation();
    const [parameters, setParameters] = useSearchParams();
    const cursor = parameters.get('cursor');
    const lookupField = parameters.get('lookupField') ?? 'email';
    const lookupValue = parameters.get('lookupValue') ?? '';
    const requestQuery = pageParameters(location.search);
    const [searchDraft, setSearchDraft] = usePageDraft<{ query?: string; field?: string }>(`users-search:${requestQuery}`);
    const query = searchDraft?.query ?? lookupValue;
    const field = searchDraft?.field ?? lookupField;
    const setQuery = (query: string) => setSearchDraft({ ...searchDraft, query });
    const setField = (field: string) => setSearchDraft({ ...searchDraft, field });
    const userQuery = useResource<CursorPage<User>>('users', `/api/admin/users?${requestQuery}`, requestQuery);
    const data = userQuery.data;
    function navigatePage(nextCursor: string | null) {
        const next = listParameters(location.search);
        if (nextCursor) next.set('cursor', nextCursor); else next.delete('cursor');
        setParameters(next);
    }
    const userPath = (id: string) => listPath(localizedPath(locale, 'admin/users/detail'), location.search, { id });
    return <><PageHeading title={t('usersTitle')} description={t('usersDescription')} />{userQuery.error && <CursorRecovery cursor={cursor} onReset={() => navigatePage(null)} />}<section className="card user-table-card"><form className="search-bar" onSubmit={(event) => { event.preventDefault(); const value = query.trim(); setSearchDraft(undefined); setParameters(value ? { lookupField: field, lookupValue: value } : {}); }}><div className="search-field"><Select label={t('lookupField')} value={field} options={[{ value: 'email', label: t('email') }, { value: 'username', label: t('username') }, { value: 'id', label: t('accountId') }]} onChange={setField} /></div><div className="search-input"><TextField label={t('searchUsers')} value={query} onValueChange={setQuery} maxLength={254} supportingText={t('exactLookupHint')} /></div><Button className="secondary" type="submit">{t('search')}</Button></form>
        <ResourceFeedback query={userQuery} />
        {data && <><div className="table-scroll"><table><thead><tr><th>{t('user')}</th><th>{t('status')}</th><th>{t('role')}</th><th>{t('joined')}</th><th><span className="sr-only">{t('userDetails')}</span></th></tr></thead><tbody>{data.items.map((user) => <tr key={user.id}><td><Link className="table-user" to={userPath(user.id)}><Avatar name={user.name} image={user.image} className="table-avatar" /><span><strong>{user.name}</strong><small>{user.email}</small></span></Link></td><td><UserStatus user={user} /></td><td><span className="role-label">{t(user.role === 'admin' ? 'admin' : 'user')}</span></td><td className="muted">{formatDate(user.createdAt, locale)}</td><td><ButtonLink variant="icon" to={userPath(user.id)} aria-label={`${t('userDetails')}: ${user.email}`}><Icon name="arrow" size={18} /></ButtonLink></td></tr>)}</tbody></table>{data.items.length === 0 && <p className="empty-state">{t('usersEmpty')}</p>}</div><PageNavigation pageInfo={data.pageInfo} count={data.items.length} cursor={cursor} onNavigate={navigatePage} /></>}
    </section></>;
}

function UserDetailPage() {
    const location = useLocation();
    const userId = new URLSearchParams(location.search).get('id') ?? '';
    const { locale } = useApp();
    const { t } = useTranslation();
    const userQuery = useResource<User>('user', `/api/auth/admin/get-user?${new URLSearchParams({ id: userId })}`, userId);
    const user = userQuery.data;
    const [reasonDraft, setReason, clearReason] = usePageDraft<string>(`user-reason:${userId}`);
    const reason = reasonDraft ?? '';
    const dataActions = useDataActions();
    const [error, setError] = useState<string>();
    const feedback = useFeedback();
    const [busy, setBusy] = useState(false);
    const [confirmation, setConfirmation] = useState<'ban-user' | 'revoke-user-sessions'>();
    async function action(kind: 'ban-user' | 'unban-user' | 'revoke-user-sessions', confirmed = false) {
        if (!user || user.role === 'admin') return;
        if (!confirmed && kind !== 'unban-user') { setError(undefined); setConfirmation(kind); return; }
        setBusy(true); setError(undefined);
        try {
            await request(`/admin/${kind}`, { userId: user.id, ...(kind === 'ban-user' && reason.trim() ? { banReason: reason.trim() } : {}) });
            await dataActions.invalidate('user', 'users'); clearReason(reasonDraft); setConfirmation(undefined); feedback.success(t('userUpdated'));
        } catch (cause) { setError(dataActions.fail(cause)); }
        finally { setBusy(false); }
    }
    return <>{confirmation && <ConfirmationDialog title={t(confirmation === 'ban-user' ? 'suspend' : 'revokeAll')} description={t(confirmation === 'ban-user' ? 'confirmSuspend' : 'confirmRevoke')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} busy={busy} error={<ErrorNotice code={error} />} onCancel={() => { setConfirmation(undefined); setError(undefined); }} onConfirm={() => { void action(confirmation, true); }} />}<ButtonLink variant="text" className="detail-back" to={listPath(localizedPath(locale, 'admin/users'), location.search)}><Icon name="back" size={15} />{t('backToUsers')}</ButtonLink><PageHeading title={t('userDetails')} description={user?.email ?? ''}>{user && <Avatar name={user.name} image={user.image} className="profile-avatar" />}</PageHeading><ResourceFeedback query={userQuery} />{user && <>
        <section className="card"><div className="card-body user-detail-grid"><div><small>{t('name')}</small><strong>{user.name}</strong></div><div><small>{t('email')}</small><strong>{user.email}</strong></div><div><small>{t('status')}</small><UserStatus user={user} /></div><div><small>{t('role')}</small><strong>{t(user.role === 'admin' ? 'admin' : 'user')}</strong></div><div><small>{t('joined')}</small><strong>{formatDate(user.createdAt, locale)}</strong></div><div><small>{t('emailVerification')}</small><strong>{t(user.emailVerified ? 'verified' : 'unverified')}</strong></div><div className="full-width"><small>{t('accountId')}</small><code>{user.id}</code></div>{user.banReason && <div className="full-width"><small>{t('reason')}</small><strong>{user.banReason}</strong></div>}</div></section>
        <section className="card"><div className="card-heading"><h2>{t('manageUser')}</h2><p>{t('manageUserDescription')}</p></div><div className="card-body">{user.role === 'admin' ? <p className="muted">{t('adminProtected')}</p> : <div className="stack-form">{!confirmation && <ErrorNotice code={error} />}{!user.banned && <TextField label={t('reason')} type="textarea" value={reason} maxLength={500} placeholder={t('reasonPlaceholder')} onValueChange={setReason} />}<div className="action-row"><Button className={user.banned ? 'primary' : 'danger-button'} busy={busy} onClick={() => { void action(user.banned ? 'unban-user' : 'ban-user'); }}>{t(user.banned ? 'restore' : 'suspend')}</Button><Button className="secondary" busy={busy} onClick={() => { void action('revoke-user-sessions'); }}>{t('revokeAll')}</Button></div></div>}</div></section>
        <UserBusinessRoles userId={user.id} />
    </>}</>;
}

function StatePage({ forbidden = false }: { forbidden?: boolean }) {
    const { t } = useTranslation();
    const { locale } = useApp();
    return <div className="state-page"><Brand /><span className="state-code">{forbidden ? '403' : '404'}</span><h1>{t(forbidden ? 'forbiddenTitle' : 'notFoundTitle')}</h1><p>{t(forbidden ? 'forbiddenDescription' : 'notFoundDescription')}</p><ButtonLink className="primary" to={localizedPath(locale, 'account')}>{t('home')}<Icon name="arrow" size={18} /></ButtonLink></div>;
}

function LocaleRoutes() {
    const { pathname, search, hash } = useLocation();
    const { locale, identity } = useApp();
    const segment = pathname.split('/')[1] ?? '';
    if (!pathToLocale[segment] || pathname !== pathname.toLowerCase()) return <StatePage />;
    return <Routes>
        <Route path="/:language">
            <Route index element={identity === undefined ? <Busy /> : <Navigate to={{ pathname: localizedPath(locale, identity ? 'account' : 'login'), search, hash }} replace />} />
            <Route path="login" element={<AuthPage mode="login" />} />
            <Route path="select-account" element={<SelectAccountPage />} />
            <Route path="two-factor" element={<TwoFactorPage />} />
            <Route path="social/complete" element={<SocialCompletionPage />} />
            <Route path="signup" element={<AuthPage mode="signup" />} />
            <Route path="verify-email" element={<AuthPage mode="verify-email" />} />
            <Route path="verified" element={<AuthPage mode="verified" />} />
            <Route path="forgot-password" element={<AuthPage mode="forgot-password" />} />
            <Route path="reset-password" element={<AuthPage mode="reset-password" />} />
            <Route path="consent" element={<ConsentPage />} />
            <Route element={<Protected />}>
                <Route element={<AccountLayout />}>
                    <Route path="account" element={<ProfilePage />} />
                    <Route path="account/emails" element={<EmailsPage />} />
                    <Route path="account/security" element={<SecurityPage />} />
                    <Route path="account/sessions" element={<SessionsPage />} />
                    <Route path="account/applications" element={<AuthorizedApplicationsPage locale={locale} />} />
                </Route>
                <Route element={<Protected developerOnly />}>
                    <Route element={<DeveloperLayout />}>
                        <Route path="developer" element={<Navigate to={localizedPath(locale, 'developer/applications')} replace />} />
                        <Route path="developer/applications" element={<ApplicationsPage locale={locale} area="developer" />} />
                        <Route path="developer/applications/new" element={<ApplicationEditor key="developer:new" locale={locale} area="developer" create />} />
                        <Route path="developer/applications/detail" element={<ApplicationEditor key={`developer:${new URLSearchParams(search).get('clientId') ?? ''}`} locale={locale} area="developer" />} />
                    </Route>
                </Route>
                <Route element={<Protected adminOnly />}>
                    <Route element={<AdminLayout />}>
                        <Route path="admin" element={<Navigate to={localizedPath(locale, 'admin/users')} replace />} />
                        <Route path="admin/users" element={<UsersPage />} />
                        <Route path="admin/branding" element={<BrandingSettings />} />
                        <Route path="admin/social-connections" element={<SocialConnectionsPage />} />
                        <Route path="admin/access/resources" element={<ApiResourcesPage locale={locale} />} />
                        <Route path="admin/access/resources/detail" element={<ApiResourceDetailPage key={new URLSearchParams(search).get('id') ?? ''} locale={locale} />} />
                        <Route path="admin/access/roles" element={<BusinessRolesPage />} />
                        <Route path="admin/machines/applications" element={<MachineApplicationsPage locale={locale} />} />
                        <Route path="admin/machines/applications/detail" element={<MachineApplicationDetailPage key={new URLSearchParams(search).get('clientId') ?? ''} locale={locale} />} />
                        <Route path="admin/machines/roles" element={<MachineRolesPage />} />
                        <Route path="admin/audit-logs" element={<AuditLogsPage locale={locale} />} />
                        <Route path="admin/users/detail" element={<UserDetailPage key={new URLSearchParams(search).get('id') ?? ''} />} />
                        <Route path="admin/applications" element={<ApplicationsPage locale={locale} />} />
                        <Route path="admin/applications/detail" element={<ApplicationEditor key={`admin:${new URLSearchParams(search).get('clientId') ?? ''}`} locale={locale} />} />
                    </Route>
                </Route>
            </Route>
            <Route path="*" element={<StatePage />} />
        </Route>
        <Route path="*" element={<StatePage />} />
    </Routes>;
}

export default function App() {
    const brand = useBranding();
    const location = useLocation();
    const identityQuery = useIdentity();
    const identity = identityQuery.data === undefined && identityQuery.isError ? null : identityQuery.data;
    const locale = resolveLocale(location.pathname, identity?.user.locale);
    const loadError = identityQuery.error ? errorCode(identityQuery.error) : undefined;
    const refresh = identityQuery.refresh;

    useEffect(() => {
        document.documentElement.lang = locale;
        void i18n.changeLanguage(locale);
        document.title = brand.name;
    }, [locale, brand.name]);

    useEffect(() => {
        if (!browserFlowId() && !selectedBrowserAccount() && identity?.browserAccountId) selectBrowserAccount(identity.browserAccountId);
    }, [identity]);

    const context = { identity, refresh, locale };
    const privatePage = /^\/(en-us|zh-cn)\/(account|admin|developer)(\/|$)/.test(location.pathname);
    const pageScope = privatePage ? identity ? `${identity.user.id}:${identity.session.id}:${identity.user.role ?? 'user'}` : '' : 'authentication';
    return <AppContext.Provider value={context}><BrandingUpdates /><DataScope identity={identity}><PageStateProvider key={pageScope}>
        {loadError && <div className="global-error"><ErrorNotice code={loadError} /><Button type="button" className="text-button" onClick={() => { void identityQuery.refetch(); }}>{i18n.t('tryAgain')}</Button></div>}
        {location.pathname === '/' ? (identity === undefined && !loadError ? <Busy /> : <Navigate to={{ pathname: localizedPath(locale, identity ? 'account' : 'login'), search: location.search, hash: location.hash }} replace />) : <LocaleRoutes />}
    </PageStateProvider></DataScope></AppContext.Provider>;
}
