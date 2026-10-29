import {
    createContext, Fragment, useCallback, useContext, useEffect, useRef, useState,
    type FormEvent, type PropsWithChildren,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { defaultLocale, isLocale, localizedPath, localeToPath, pathToLocale, type Locale } from '../shared/locales';
import { ApiError, captchaRequest, errorCode, fetchJson, request, type Identity, type Session, type User } from './api';
import i18n from './i18n';
import { Button, ButtonLink, Checkbox, ConfirmationDialog, Divider, LanguageSelect, List, ListItem, NavigationLink, Progress, Select, TextField, ThemeMenu } from './material';
import { setThemePreference, useTheme, type ThemePreference } from './theme';
import { ApplicationEditor, ApplicationsPage } from './Applications';
import { EmailsPage } from './Emails';
import { oauthSearch, providerRequest, withOAuthSearch } from './oauth';
import { CursorRecovery, listParameters, listPath, pageParameters, PageNavigation, type CursorPage } from './pagination';

const preferenceKey = 'loginflare.locale';

interface AppContextValue {
    identity: Identity | null | undefined;
    refresh: () => Promise<void>;
    locale: Locale;
}

const AppContext = createContext<AppContextValue>({ identity: undefined, refresh: async () => {}, locale: defaultLocale });

function useApp() {
    return useContext(AppContext);
}

function readPreference(): Locale | undefined {
    try {
        const value = localStorage.getItem(preferenceKey);
        return isLocale(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

function savePreference(locale: Locale) {
    try {
        localStorage.setItem(preferenceKey, locale);
    } catch {
        // Private browsing may disable local storage. The URL still controls language.
    }
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
    return <Link className="brand" to={destination ?? localizedPath(locale)} aria-label="Loginflare">
        <span className="brand-mark"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M13.5 2C14.5 7 8 7.5 8 12c0 1.8 1.5 3 3 3-1-3 3-4 3-6 4 3.5 5.5 5.4 5.5 8A7.5 7.5 0 0 1 4.5 17C4.5 10.5 12 8.5 13.5 2Z" fill="currentColor" /></svg></span>
        Loginflare<span className="version-label">BETA</span>
    </Link>;
}

function LanguageSwitcher() {
    const { locale, identity, refresh } = useApp();
    const location = useLocation();
    const navigate = useNavigate();
    const { t } = useTranslation();
    const [error, setError] = useState<string>();

    async function changeLanguage(next: Locale) {
        savePreference(next);
        const segments = location.pathname.split('/');
        segments[1] = localeToPath[next];
        navigate(`${segments.join('/')}${location.search}${location.hash}`);
        setError(undefined);
        if (identity) {
            try {
                await request('/update-user', { locale: next });
                await refresh();
            } catch (cause) {
                setError(errorCode(cause));
            }
        }
    }

    return <div className="language-control">
        <Icon name="globe" size={16} />
        <LanguageSelect label={t('language')} value={locale} onChange={(next) => { void changeLanguage(next); }} />
        {error && <ErrorNotice code={error} />}
    </div>;
}

function ThemeSwitcher() {
    const { t } = useTranslation();
    const { preference } = useTheme();
    return <ThemeMenu label={t('theme')} currentLabel={t(`theme_${preference}`)} icon={<Icon name={preference} />} options={(['light', 'dark', 'system'] as ThemePreference[]).map((value) => ({ value, label: t(`theme_${value}`), selected: value === preference, icon: <Icon name={value} /> }))} onChange={setThemePreference} />;
}

function ErrorNotice({ code }: { code?: string }) {
    const { t } = useTranslation();
    if (!code) return null;
    const key = `errors.${code}`;
    return <div className="notice error" role="alert">{i18n.exists(key) ? t(key) : t('errors.UNKNOWN_ERROR')}</div>;
}

function SuccessNotice({ message }: { message?: string }) {
    return message ? <div className="notice success" role="status"><Icon name="check" size={17} /><span>{message}</span></div> : null;
}

function Busy() {
    const { t } = useTranslation();
    return <div className="loading-state" role="status"><Progress />{t('loading')}</div>;
}

function AuthLayout({ children }: PropsWithChildren) {
    const { t } = useTranslation();
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
            <div className="auth-top"><div className="mobile-brand"><Brand /></div><div className="display-controls"><ThemeSwitcher /><LanguageSwitcher /></div></div>
            <div className="auth-form-container">{children}</div>
            <footer className="auth-footer">Loginflare <span>·</span> {t('tagline')}</footer>
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

    useEffect(() => {
        let disposed = false;
        let widget: string | undefined;
        onToken('');
        setStatus('loading');
        void Promise.all([fetchJson<{ turnstileSiteKey: string }>('/api/config'), loadTurnstile()]).then(([config]) => {
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
    }, [locale, theme, resetKey, retry, onToken]);

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
    const [success, setSuccess] = useState<string>();
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
    const token = new URLSearchParams(location.search).get('token');
    const urlError = new URLSearchParams(location.search).get('error');
    const needsCaptcha = ['login', 'signup', 'verify-email'].includes(mode) || (mode === 'forgot-password' && !recoveryChallenge);
    const oauthQuery = oauthSearch(location.search);
    const authPath = (page: string, extra?: Record<string, string>) => withOAuthSearch(localizedPath(locale, page), location.search, extra);
    const callbackURL = `${window.location.origin}${authPath('verified')}`;

    useEffect(() => {
        setError(undefined);
        setSuccess(undefined);
        setPassword('');
        setConfirmPassword('');
        setRecoveryChallenge(undefined);
        setRecoveryCode('');
    }, [mode]);

    if (identity && !oauthQuery && (mode === 'login' || mode === 'signup')) return <Navigate to={localizedPath(locale, 'account')} replace />;

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
        setError(undefined);
        setSuccess(undefined);
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
                    const identifier = loginIdentifier.trim();
                    const path = identifier.includes('@') ? '/sign-in/email' : '/sign-in/username';
                    const credentials = { ...(identifier.includes('@') ? { email: identifier } : { username: identifier }), password, rememberMe };
                    if (oauthQuery) {
                        const result = await providerRequest(path, credentials, captchaToken);
                        savePreference(locale);
                        if (result?.redirect) return;
                        throw new ApiError('INVALID_OAUTH_QUERY', 400);
                    }
                    await captchaRequest(path, credentials, captchaToken);
                    await refresh();
                    savePreference(locale);
                    navigate(localizedPath(locale, 'account'), { replace: true });
                    break;
                }
                case 'signup':
                    await captchaRequest('/sign-up/email', { email: email.trim(), username: username.trim(), password, name, locale, callbackURL }, captchaToken);
                    savePreference(locale);
                    navigate(authPath('verify-email', { email }));
                    break;
                case 'verify-email':
                    await captchaRequest('/send-verification-email', { email, callbackURL }, captchaToken);
                    setSuccess('emailRequested');
                    break;
                case 'forgot-password':
                    if (recoveryChallenge) {
                        const result = await request<{ token: string }>('/emails/recovery/verify', { challengeId: recoveryChallenge, code: recoveryCode.trim() });
                        navigate(authPath('reset-password', { token: result.token }));
                    } else {
                        const result = await captchaRequest<{ challengeId: string }>('/emails/recovery/start', { identifier: loginIdentifier.trim(), email: email.trim() }, captchaToken);
                        setRecoveryChallenge(result.challengeId);
                        setSuccess('emails.recoveryRequested');
                    }
                    break;
                case 'reset-password':
                    await request('/reset-password', { token, newPassword: password });
                    await refresh();
                    setSuccess('resetDone');
                    setPassword('');
                    setConfirmPassword('');
                    break;
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
        <ErrorNotice code={urlError ? 'INVALID_TOKEN' : error === 'PASSWORD_MISMATCH' ? undefined : error} />
        {error === 'PASSWORD_MISMATCH' && <div className="notice error" role="alert">{t('passwordMismatch')}</div>}
        <SuccessNotice message={success ? t(success) : undefined} />
        {mode === 'verified' && !urlError ? <ButtonLink className="primary full" to={authPath('login')}>{t('login')}<Icon name="arrow" size={18} /></ButtonLink> :
            mode === 'reset-password' && (!token || urlError) ? <div className="notice error" role="alert">{t('invalidLink')}</div> :
            mode === 'reset-password' && success ? <ButtonLink className="primary full" to={authPath('login')}>{t('login')}<Icon name="arrow" size={18} /></ButtonLink> :
            mode !== 'verified' && <form onSubmit={(event) => { void submit(event); }} className="stack-form">
                {mode === 'signup' && <TextField label={t('name')} autoComplete="nickname" name="name" value={name} onValueChange={setName} placeholder={t('namePlaceholder')} maxLength={100} required />}
                {mode === 'signup' && <TextField label={t('username')} autoComplete="username" name="username" value={username} onValueChange={setUsername} placeholder={t('usernamePlaceholder')} minLength={3} maxLength={30} pattern="[a-zA-Z0-9_.]+" supportingText={t('usernameHint')} required />}
                {mode === 'login' && <TextField label={t('loginIdentifier')} autoComplete="username" type="text" name="identifier" value={loginIdentifier} onValueChange={setLoginIdentifier} placeholder={t('loginIdentifierPlaceholder')} maxLength={254} required />}
                {mode === 'forgot-password' && !recoveryChallenge && <>
                    <TextField label={t('emails.recoveryIdentifier')} autoComplete="username" name="identifier" value={loginIdentifier} onValueChange={setLoginIdentifier} placeholder={t('loginIdentifierPlaceholder')} maxLength={254} required />
                    <TextField label={t('emails.recoveryAddress')} autoComplete="email" type="email" name="email" value={email} onValueChange={setEmail} placeholder={t('emailPlaceholder')} maxLength={254} supportingText={t('emails.recoveryAddressHint')} required />
                </>}
                {mode === 'forgot-password' && recoveryChallenge && <TextField label={t('emails.code')} autoComplete="one-time-code" inputMode="numeric" name="code" value={recoveryCode} onValueChange={setRecoveryCode} pattern="[0-9]{6}" minLength={6} maxLength={6} supportingText={t('emails.codeHint')} required />}
                {(mode === 'signup' || mode === 'verify-email') && <TextField label={t('email')} autoComplete="email" type="email" name="email" value={email} onValueChange={setEmail} placeholder={t('emailPlaceholder')} maxLength={254} required />}
                {['login', 'signup', 'reset-password'].includes(mode) && <TextField label={t(mode === 'reset-password' ? 'newPassword' : 'password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} type="password" name="password" value={password} onValueChange={setPassword} minLength={mode === 'login' ? undefined : 8} maxLength={128} supportingText={mode === 'login' ? undefined : t('passwordHint')} required />}
                {(mode === 'signup' || mode === 'reset-password') && <TextField label={t('confirmPassword')} autoComplete="new-password" type="password" name="confirmPassword" value={confirmPassword} onValueChange={setConfirmPassword} minLength={8} maxLength={128} required />}
                {mode === 'login' && <div className="form-options"><Checkbox label={t('rememberMe')} checked={rememberMe} onCheckedChange={setRememberMe} /><Link to={authPath('forgot-password')}>{t('forgotPassword')}</Link></div>}
                {needsCaptcha && <Captcha onToken={setCaptchaToken} resetKey={captchaReset} />}
                <Button type="submit" className="primary full" busy={busy} disabled={needsCaptcha && !captchaToken}>{busy ? t('working') : t(mode === 'login' ? 'login' : mode === 'signup' ? 'signup' : mode === 'verify-email' ? 'resend' : mode === 'forgot-password' ? recoveryChallenge ? 'emails.recoveryVerify' : 'emails.sendCode' : 'resetPassword')}<Icon name="arrow" size={18} /></Button>
                {mode === 'forgot-password' && recoveryChallenge && <Button className="text-button" disabled={busy} onClick={() => {
                    setRecoveryChallenge(undefined); setRecoveryCode(''); setSuccess(undefined); setError(undefined); setCaptchaToken(''); setCaptchaReset((value) => value + 1);
                }}>{t('emails.recoveryStartOver')}</Button>}
            </form>}
        {mode === 'login' && <><p className="auth-crosslink">{t('noAccount')} <Link to={authPath('signup')}>{t('signup')}</Link></p><Link className="resend-link" to={authPath('verify-email', loginIdentifier.includes('@') ? { email: loginIdentifier.trim() } : undefined)}>{t('resend')}</Link></>}
        {mode === 'signup' && <p className="auth-crosslink">{t('haveAccount')} <Link to={authPath('login')}>{t('login')}</Link></p>}
        {mode === 'signup' && error && <Link className="resend-link" to={authPath('verify-email', { email })}>{t('resend')}</Link>}
        {['verify-email', 'forgot-password', 'reset-password'].includes(mode) && <Link className="back-link" to={authPath('login')}><Icon name="back" size={15} />{t('backToLogin')}</Link>}
    </AuthLayout>;
}

function ConsentPage() {
    const { locale, identity } = useApp();
    const { t } = useTranslation();
    const location = useLocation();
    const [consent, setConsent] = useState<{ client: { clientId: string; name: string }; scopes: string[] }>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const query = oauthSearch(location.search);
    useEffect(() => {
        if (!identity || !query) return;
        let current = true;
        setError(undefined); setConsent(undefined);
        void fetchJson<{ client: { clientId: string; name: string }; scopes: string[] }>(`/api/oauth/consent?${new URLSearchParams({ oauth_query: query })}`).then((data) => {
            if (current) setConsent(data);
        }).catch((cause) => { if (current) setError(errorCode(cause)); });
        return () => { current = false; };
    }, [query, identity]);
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
        <ErrorNotice code={error} />
        {!consent && !error && <Busy />}
        {consent && <>
            <p className="section-description">{t('oauth.consentDescription', { name: consent.client.name })}</p>
            <p className="consent-account">{t('oauth.consentAccount', { email: identity.user.email })}</p>
            <p>{t('oauth.consentPermissions')}</p>
            <ul className="consent-permissions">{consent.scopes.map((scope) => <li key={scope}>{t(`oauth.scope_${scope}`)}</li>)}</ul>
            <p className="section-description">{t('oauth.consentNotice')}</p>
            <div className="action-row"><Button busy={busy} onClick={() => { void decide(true); }}>{t('oauth.allow')}</Button><Button className="secondary" disabled={busy} onClick={() => { void decide(false); }}>{t('oauth.deny')}</Button></div>
        </>}
        {error && <p className="oauth-context">{t('oauth.restartAuthorization')}</p>}
    </AuthLayout>;
}

function Protected({ adminOnly = false }: { adminOnly?: boolean }) {
    const { identity, locale } = useApp();
    if (identity === undefined) return <Busy />;
    if (!identity) return <Navigate to={localizedPath(locale, 'login')} replace />;
    if (adminOnly && identity.user.role !== 'admin') return <StatePage forbidden />;
    return <Outlet />;
}

interface AppFrameProps {
    area: 'account' | 'admin';
    title: string;
    home: string;
    navigationLabel: string;
    navigation: React.ReactNode;
    switchTarget?: { to: string; label: string; icon: string };
}

function AppFrame({ area, title, home, navigationLabel, navigation, switchTarget }: AppFrameProps) {
    const { identity, locale, refresh } = useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();

    async function signOut() {
        setBusy(true);
        try {
            await request('/sign-out', {});
            await refresh();
            navigate(localizedPath(locale, 'login'), { replace: true });
        } catch (cause) {
            setError(errorCode(cause));
        } finally {
            setBusy(false);
        }
    }

    return <div className="app-shell" data-area={area}>
        <aside className="sidebar">
            <Brand destination={home} />
            <nav aria-label={navigationLabel}>{navigation}</nav>
            <div className="sidebar-bottom"><span className="small-cloud">☁</span><p>{t('tagline')}</p><small>Cloudflare Workers + D1</small></div>
        </aside>
        <div className="app-content">
            <header className="app-header"><div className="mobile-brand"><Brand destination={home} /></div><div className="header-actions"><ThemeSwitcher /><LanguageSwitcher /><span className="header-separator" /><span className="user-avatar" aria-label={identity?.user.name}>{identity?.user.name.slice(0, 1).toUpperCase()}</span><Button className="icon-button" busy={busy} onClick={() => { void signOut(); }} aria-label={t('signout')} title={t('signout')}><Icon name="logout" /></Button></div></header>
            <div className="workspace-bar"><span className="workspace-title"><Icon name={area === 'admin' ? 'shield' : 'profile'} />{title}</span>{switchTarget && <Link className="workspace-switch" to={switchTarget.to}><Icon name={switchTarget.icon} size={18} />{switchTarget.label}<Icon name="arrow" size={16} /></Link>}</div>
            <main className="page-content"><ErrorNotice code={error} /><Outlet /></main>
            <footer className="app-footer">Loginflare <span>·</span> {t('openSource')}</footer>
        </div>
    </div>;
}

function AccountLayout() {
    const { identity, locale } = useApp();
    const { t } = useTranslation();
    return <AppFrame area="account" title={t('accountCenter')} home={localizedPath(locale, 'account')} navigationLabel={t('accountNavigation')}
        navigation={<><p className="nav-label">{t('account')}</p>
            <NavigationLink end to={localizedPath(locale, 'account')}><Icon name="profile" />{t('profile')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'account/emails')}><Icon name="mail" />{t('emails.title')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'account/security')}><Icon name="shield" />{t('security')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'account/sessions')}><Icon name="sessions" />{t('sessions')}</NavigationLink></>}
        switchTarget={identity?.user.role === 'admin' ? { to: localizedPath(locale, 'admin/users'), label: t('adminConsole'), icon: 'shield' } : undefined} />;
}

function AdminLayout() {
    const { locale } = useApp();
    const { t } = useTranslation();
    return <AppFrame area="admin" title={t('adminConsole')} home={localizedPath(locale, 'admin/users')} navigationLabel={t('adminNavigation')}
        navigation={<><p className="nav-label">{t('adminConsole')}</p>
            <NavigationLink to={localizedPath(locale, 'admin/users')}><Icon name="users" />{t('users')}</NavigationLink>
            <NavigationLink to={localizedPath(locale, 'admin/applications')}><Icon name="globe" />{t('oauth.applications')}</NavigationLink></>}
        switchTarget={{ to: localizedPath(locale, 'account'), label: t('accountCenter'), icon: 'profile' }} />;
}

function PageHeading({ title, description, children }: PropsWithChildren<{ title: string; description: string }>) {
    return <div className="page-heading"><div><h1>{title}</h1><p>{description}</p></div>{children}</div>;
}

function ProfilePage() {
    const { identity, locale, refresh } = useApp();
    const { t } = useTranslation();
    const [name, setName] = useState(identity?.user.name ?? '');
    const [username, setUsername] = useState(identity?.user.username ?? '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [saved, setSaved] = useState(false);
    useEffect(() => { setUsername(identity?.user.username ?? ''); }, [identity?.user.username]);
    async function save(event: FormEvent) {
        event.preventDefault();
        setBusy(true); setError(undefined); setSaved(false);
        try {
            await request('/update-user', { name, ...(username.trim() ? { username: username.trim() } : {}) });
            await refresh(); setSaved(true);
        } catch (cause) { setError(errorCode(cause)); }
        finally { setBusy(false); }
    }
    return <>
        <PageHeading title={t('profileTitle')} description={t('profileDescription')} />
        <div className="profile-overview"><span className="profile-avatar">{identity?.user.name.slice(0, 1).toUpperCase()}</span><div><h2>{identity?.user.name}</h2></div></div>
        <section className="card"><div className="card-heading"><h2>{t('accountDetails')}</h2><p>{t('accountDetailsDescription')}</p></div><form className="card-body stack-form" onSubmit={(event) => { void save(event); }}>
            <ErrorNotice code={error} /><SuccessNotice message={saved ? t('saved') : undefined} />
            <TextField label={t('name')} name="name" autoComplete="nickname" value={name} onValueChange={setName} maxLength={100} required />
            <TextField label={t('username')} name="username" autoComplete="username" value={username} onValueChange={setUsername} placeholder={t('usernamePlaceholder')} minLength={3} maxLength={30} pattern="[a-zA-Z0-9_.]+" supportingText={`${t('usernameHint')}${identity?.user.username ? '' : ` ${t('usernameNotSetHint')}`}`} required={!!identity?.user.username} />
            <div className="form-footer"><Button className="primary" type="submit" busy={busy}>{t('save')}</Button></div>
        </form></section>
        <section className="card"><div className="card-heading"><h2>{t('preferences')}</h2><p>{t('preferencesDescription')}</p></div><List className="preference-list" label={t('preferences')}><ListItem headline={t('language')} end={<LanguageSwitcher />} /></List></section>
        <div className="account-metadata"><span>{t('memberSince')} {formatDate(identity?.user.createdAt, locale)}</span><span>{t('accountId')}: <code>{identity?.user.id}</code></span></div>
    </>;
}

function SecurityPage() {
    const { t } = useTranslation();
    const { refresh } = useApp();
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [success, setSuccess] = useState(false);
    async function submit(event: FormEvent) {
        event.preventDefault();
        setSuccess(false); setError(undefined);
        if (newPassword !== confirmation) { setError('PASSWORD_MISMATCH'); return; }
        setBusy(true);
        try {
            await request('/change-password', { currentPassword, newPassword, revokeOtherSessions: true });
            setCurrentPassword(''); setNewPassword(''); setConfirmation(''); setSuccess(true);
            await refresh();
        } catch (cause) { setError(errorCode(cause)); }
        finally { setBusy(false); }
    }
    return <><PageHeading title={t('securityTitle')} description={t('securityDescription')} /><section className="card"><div className="card-heading"><h2>{t('changePassword')}</h2><p>{t('changePasswordDescription')}</p></div><form className="card-body stack-form" onSubmit={(event) => { void submit(event); }}>
        <ErrorNotice code={error === 'PASSWORD_MISMATCH' ? undefined : error} />
        {error === 'PASSWORD_MISMATCH' && <div className="notice error" role="alert">{t('passwordMismatch')}</div>}
        <SuccessNotice message={success ? t('passwordChanged') : undefined} />
        <TextField label={t('currentPassword')} type="password" name="currentPassword" autoComplete="current-password" value={currentPassword} onValueChange={setCurrentPassword} required />
        <TextField label={t('newPassword')} type="password" name="newPassword" autoComplete="new-password" value={newPassword} onValueChange={setNewPassword} minLength={8} maxLength={128} required supportingText={t('passwordHint')} />
        <TextField label={t('confirmPassword')} type="password" name="confirmPassword" autoComplete="new-password" value={confirmation} onValueChange={setConfirmation} minLength={8} maxLength={128} required />
        <div className="form-footer"><Button type="submit" className="primary" busy={busy}>{t('changePassword')}</Button></div>
    </form></section></>;
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
    const [data, setData] = useState<CursorPage<Session> & { hasOtherSessions: boolean }>();
    const [revision, setRevision] = useState(0);
    const [error, setError] = useState<string>();
    const [success, setSuccess] = useState<string>();
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let current = true;
        setData(undefined); setError(undefined);
        void fetchJson<CursorPage<Session> & { hasOtherSessions: boolean }>(`/api/account/sessions?${query}`)
            .then((result) => { if (current) setData(result); })
            .catch((cause) => { if (current) setError(errorCode(cause)); });
        return () => { current = false; };
    }, [query, revision]);
    function navigatePage(nextCursor: string | null) {
        setParameters(nextCursor ? { cursor: nextCursor } : {});
    }
    async function revoke(session?: Session) {
        setBusy(true); setError(undefined); setSuccess(undefined);
        try {
            if (session) await request('/revoke-session', { token: session.token });
            else await request('/revoke-other-sessions', {});
            await refresh();
            if (!session) navigatePage(null);
            setRevision((value) => value + 1);
            setSuccess(session ? 'sessionRevoked' : 'othersRevoked');
        } catch (cause) { setError(errorCode(cause)); }
        finally { setBusy(false); }
    }
    return <><PageHeading title={t('sessionsTitle')} description={t('sessionsDescription')} /><ErrorNotice code={error} />{error && <CursorRecovery cursor={cursor} onReset={() => navigatePage(null)} />}<SuccessNotice message={success ? t(success) : undefined} /><section className="card"><div className="card-heading heading-with-action"><h2>{t('activeSessions')}</h2><Button className="secondary small" busy={busy} disabled={!data?.hasOtherSessions} onClick={() => { void revoke(); }}>{t('revokeOthers')}</Button></div>
        {!data && !error && <Busy />}
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
    const [query, setQuery] = useState(lookupValue);
    const [field, setField] = useState(lookupField);
    const [data, setData] = useState<CursorPage<User>>();
    const [error, setError] = useState<string>();
    const requestQuery = pageParameters(location.search);
    useEffect(() => { setQuery(lookupValue); setField(lookupField); }, [lookupValue, lookupField]);
    useEffect(() => {
        let current = true;
        setError(undefined); setData(undefined);
        void fetchJson<CursorPage<User>>(`/api/admin/users?${requestQuery}`).then((result) => { if (current) setData(result); }).catch((cause) => { if (current) setError(errorCode(cause)); });
        return () => { current = false; };
    }, [requestQuery]);
    function navigatePage(nextCursor: string | null) {
        const next = listParameters(location.search);
        if (nextCursor) next.set('cursor', nextCursor); else next.delete('cursor');
        setParameters(next);
    }
    const userPath = (id: string) => listPath(localizedPath(locale, 'admin/users/detail'), location.search, { id });
    return <><PageHeading title={t('usersTitle')} description={t('usersDescription')} /><ErrorNotice code={error} />{error && <CursorRecovery cursor={cursor} onReset={() => navigatePage(null)} />}<section className="card user-table-card"><form className="search-bar" onSubmit={(event) => { event.preventDefault(); const value = query.trim(); setParameters(value ? { lookupField: field, lookupValue: value } : {}); }}><div className="search-field"><Select label={t('lookupField')} value={field} options={[{ value: 'email', label: t('email') }, { value: 'username', label: t('username') }, { value: 'id', label: t('accountId') }]} onChange={setField} /></div><div className="search-input"><TextField label={t('searchUsers')} value={query} onValueChange={setQuery} maxLength={254} supportingText={t('exactLookupHint')} /></div><Button className="secondary" type="submit">{t('search')}</Button></form>
        {!data && !error && <Busy />}
        {data && <><div className="table-scroll"><table><thead><tr><th>{t('user')}</th><th>{t('status')}</th><th>{t('role')}</th><th>{t('joined')}</th><th><span className="sr-only">{t('userDetails')}</span></th></tr></thead><tbody>{data.items.map((user) => <tr key={user.id}><td><Link className="table-user" to={userPath(user.id)}><span className="table-avatar">{user.name.slice(0, 1).toUpperCase()}</span><span><strong>{user.name}</strong><small>{user.email}</small></span></Link></td><td><UserStatus user={user} /></td><td><span className="role-label">{t(user.role === 'admin' ? 'admin' : 'user')}</span></td><td className="muted">{formatDate(user.createdAt, locale)}</td><td><ButtonLink variant="icon" to={userPath(user.id)} aria-label={`${t('userDetails')}: ${user.email}`}><Icon name="arrow" size={18} /></ButtonLink></td></tr>)}</tbody></table>{data.items.length === 0 && <p className="empty-state">{t('usersEmpty')}</p>}</div><PageNavigation pageInfo={data.pageInfo} count={data.items.length} cursor={cursor} onNavigate={navigatePage} /></>}
    </section></>;
}

function UserDetailPage() {
    const location = useLocation();
    const userId = new URLSearchParams(location.search).get('id') ?? '';
    const { locale } = useApp();
    const { t } = useTranslation();
    const [user, setUser] = useState<User>();
    const [reason, setReason] = useState('');
    const [error, setError] = useState<string>();
    const [success, setSuccess] = useState(false);
    const [busy, setBusy] = useState(false);
    const load = useCallback(async () => {
        try { setUser(await request<User>(`/admin/get-user?${new URLSearchParams({ id: userId ?? '' })}`)); }
        catch (cause) { setError(errorCode(cause)); }
    }, [userId]);
    useEffect(() => { void load(); }, [load]);
    const [confirmation, setConfirmation] = useState<'ban-user' | 'revoke-user-sessions'>();
    async function action(kind: 'ban-user' | 'unban-user' | 'revoke-user-sessions', confirmed = false) {
        if (!user || user.role === 'admin') return;
        if (!confirmed && kind !== 'unban-user') { setConfirmation(kind); return; }
        setBusy(true); setError(undefined); setSuccess(false);
        try {
            await request(`/admin/${kind}`, { userId: user.id, ...(kind === 'ban-user' && reason.trim() ? { banReason: reason.trim() } : {}) });
            await load(); setSuccess(true);
        } catch (cause) { setError(errorCode(cause)); }
        finally { setBusy(false); }
    }
    return <>{confirmation && <ConfirmationDialog title={t(confirmation === 'ban-user' ? 'suspend' : 'revokeAll')} description={t(confirmation === 'ban-user' ? 'confirmSuspend' : 'confirmRevoke')} cancelLabel={t('cancel')} confirmLabel={t('confirm')} onCancel={() => setConfirmation(undefined)} onConfirm={() => { const kind = confirmation; setConfirmation(undefined); void action(kind, true); }} />}<ButtonLink variant="text" className="detail-back" to={listPath(localizedPath(locale, 'admin/users'), location.search)}><Icon name="back" size={15} />{t('backToUsers')}</ButtonLink><PageHeading title={t('userDetails')} description={user?.email ?? ''} /><ErrorNotice code={error} /><SuccessNotice message={success ? t('userUpdated') : undefined} />{!user && !error && <Busy />}{user && <>
        <section className="card"><div className="card-body user-detail-grid"><div><small>{t('name')}</small><strong>{user.name}</strong></div><div><small>{t('email')}</small><strong>{user.email}</strong></div><div><small>{t('status')}</small><UserStatus user={user} /></div><div><small>{t('role')}</small><strong>{t(user.role === 'admin' ? 'admin' : 'user')}</strong></div><div><small>{t('joined')}</small><strong>{formatDate(user.createdAt, locale)}</strong></div><div><small>{t('emailVerification')}</small><strong>{t(user.emailVerified ? 'verified' : 'unverified')}</strong></div><div className="full-width"><small>{t('accountId')}</small><code>{user.id}</code></div>{user.banReason && <div className="full-width"><small>{t('reason')}</small><strong>{user.banReason}</strong></div>}</div></section>
        <section className="card"><div className="card-heading"><h2>{t('manageUser')}</h2><p>{t('manageUserDescription')}</p></div><div className="card-body">{user.role === 'admin' ? <p className="muted">{t('adminProtected')}</p> : <div className="stack-form">{!user.banned && <TextField label={t('reason')} type="textarea" value={reason} maxLength={500} placeholder={t('reasonPlaceholder')} onValueChange={setReason} />}<div className="action-row"><Button className={user.banned ? 'primary' : 'danger-button'} busy={busy} onClick={() => { void action(user.banned ? 'unban-user' : 'ban-user'); }}>{t(user.banned ? 'restore' : 'suspend')}</Button><Button className="secondary" busy={busy} onClick={() => { void action('revoke-user-sessions'); }}>{t('revokeAll')}</Button></div></div>}</div></section>
    </>}</>;
}

function StatePage({ forbidden = false }: { forbidden?: boolean }) {
    const { t } = useTranslation();
    const { locale } = useApp();
    return <div className="state-page"><Brand /><span className="state-code">{forbidden ? '403' : '404'}</span><h1>{t(forbidden ? 'forbiddenTitle' : 'notFoundTitle')}</h1><p>{t(forbidden ? 'forbiddenDescription' : 'notFoundDescription')}</p><ButtonLink className="primary" to={localizedPath(locale, 'account')}>{t('home')}<Icon name="arrow" size={18} /></ButtonLink></div>;
}

function LocaleRoutes() {
    const { pathname } = useLocation();
    const { locale, refresh } = useApp();
    const segment = pathname.split('/')[1] ?? '';
    if (!pathToLocale[segment] || pathname !== pathname.toLowerCase()) return <StatePage />;
    return <Routes>
        <Route path="/:language">
            <Route index element={<Navigate to="account" replace />} />
            <Route path="login" element={<AuthPage mode="login" />} />
            <Route path="signup" element={<AuthPage mode="signup" />} />
            <Route path="verify-email" element={<AuthPage mode="verify-email" />} />
            <Route path="verified" element={<AuthPage mode="verified" />} />
            <Route path="forgot-password" element={<AuthPage mode="forgot-password" />} />
            <Route path="reset-password" element={<AuthPage mode="reset-password" />} />
            <Route path="consent" element={<ConsentPage />} />
            <Route element={<Protected />}>
                <Route element={<AccountLayout />}>
                    <Route path="account" element={<ProfilePage />} />
                    <Route path="account/emails" element={<EmailsPage refreshIdentity={refresh} />} />
                    <Route path="account/security" element={<SecurityPage />} />
                    <Route path="account/sessions" element={<SessionsPage />} />
                </Route>
                <Route element={<Protected adminOnly />}>
                    <Route element={<AdminLayout />}>
                        <Route path="admin" element={<Navigate to={localizedPath(locale, 'admin/users')} replace />} />
                        <Route path="admin/users" element={<UsersPage />} />
                        <Route path="admin/users/detail" element={<UserDetailPage />} />
                        <Route path="admin/applications" element={<ApplicationsPage locale={locale} />} />
                        <Route path="admin/applications/new" element={<ApplicationEditor key="new" locale={locale} create />} />
                        <Route path="admin/applications/detail" element={<ApplicationEditor key="detail" locale={locale} />} />
                    </Route>
                </Route>
            </Route>
            <Route path="*" element={<StatePage />} />
        </Route>
        <Route path="*" element={<StatePage />} />
    </Routes>;
}

export default function App() {
    const location = useLocation();
    const locale = pathToLocale[location.pathname.split('/')[1] ?? ''] ?? defaultLocale;
    const [identity, setIdentity] = useState<Identity | null>();
    const [loadError, setLoadError] = useState<string>();
    const refresh = useCallback(async () => {
        try {
            setIdentity(await request<Identity | null>('/get-session'));
            setLoadError(undefined);
        } catch (cause) {
            setLoadError(errorCode(cause));
            setIdentity(null);
        }
    }, []);

    useEffect(() => {
        void refresh();
        const focus = () => { void refresh(); };
        window.addEventListener('focus', focus);
        return () => window.removeEventListener('focus', focus);
    }, [refresh]);

    useEffect(() => {
        document.documentElement.lang = locale;
        void i18n.changeLanguage(locale);
        document.title = 'Loginflare';
    }, [locale]);

    const context = { identity, refresh, locale };
    if (location.pathname === '/') {
        if (identity === undefined && !loadError) return <Busy />;
        const preferred = readPreference() ?? (isLocale(identity?.user.locale) ? identity.user.locale : defaultLocale);
        return <AppContext.Provider value={context}><Navigate to={localizedPath(preferred)} replace /></AppContext.Provider>;
    }

    return <AppContext.Provider value={context}>
        {loadError && <div className="global-error"><ErrorNotice code={loadError} /><Button type="button" className="text-button" onClick={() => { void refresh(); }}>{i18n.t('tryAgain')}</Button></div>}
        <LocaleRoutes />
    </AppContext.Provider>;
}
