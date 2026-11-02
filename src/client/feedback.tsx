import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from './material';
import { ToolbarIcon } from './ToolbarIcon';
import { useIdentity } from './data';

type Feedback = { id: number; message: string; kind: 'success' | 'error' };
const FeedbackContext = createContext({ success: (_message: string) => {}, error: (_message: string) => {} });

export function FeedbackProvider({ children }: PropsWithChildren) {
    const [feedback, setFeedback] = useState<Feedback>();
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const sequence = useRef(0);
    const { pathname } = useLocation();
    const owner = useIdentity().data?.user.id;
    const page = pathname.split('/').slice(2).join('/');
    const current = useRef({ owner, page });
    current.current = { owner, page };
    const { t } = useTranslation();
    const notify = useCallback((message: string, kind: Feedback['kind']) => {
        if (current.current.owner !== owner || current.current.page !== page) return;
        setHovered(false); setFocused(false); setFeedback({ id: ++sequence.current, message, kind });
    }, [owner, page]);
    const success = useCallback((message: string) => notify(message, 'success'), [notify]);
    const error = useCallback((message: string) => notify(message, 'error'), [notify]);
    const actions = useMemo(() => ({ success, error }), [success, error]);
    useEffect(() => { setFeedback(undefined); }, [pathname]);
    useEffect(() => { setFeedback(undefined); }, [owner]);
    useEffect(() => {
        const clear = () => setFeedback(undefined);
        window.addEventListener('pagehide', clear);
        return () => window.removeEventListener('pagehide', clear);
    }, []);
    useEffect(() => {
        if (!feedback || feedback.kind === 'error' || hovered || focused) return;
        const timer = setTimeout(() => setFeedback((current) => current?.id === feedback.id ? undefined : current), 6000);
        return () => clearTimeout(timer);
    }, [feedback, hovered, focused]);
    return <FeedbackContext.Provider value={actions}>{children}
        {feedback && <div className={`feedback-toast ${feedback.kind}`} key={feedback.id} role={feedback.kind === 'error' ? 'alert' : 'status'} aria-atomic="true"
            onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
            <ToolbarIcon name={feedback.kind === 'success' ? 'check' : 'error'} /><span>{feedback.message}</span>
            <Button className="icon-button" aria-label={t('dismissNotification')} onClick={() => setFeedback(undefined)}><ToolbarIcon name="close" /></Button>
        </div>}
    </FeedbackContext.Provider>;
}

export function useFeedback() { return useContext(FeedbackContext); }

export function ErrorNotice({ code, message }: { code?: string; message?: string }) {
    const { t, i18n } = useTranslation();
    const notice = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const element = notice.current;
        if (!element) return;
        element.focus({ preventScroll: true });
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [code, message]);
    if (!code && !message) return null;
    return <div ref={notice} className="notice error" role="alert" tabIndex={-1}>{message ?? t(i18n.exists(`errors.${code}`) ? `errors.${code}` : 'errors.UNKNOWN_ERROR')}</div>;
}
