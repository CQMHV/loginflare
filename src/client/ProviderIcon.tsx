import { useState } from 'react';
import { avatarIdPattern } from '../shared/avatars';
import type { ConnectionType } from '../shared/social';
import googleIcon from './assets/google.png';

// Brand artwork sources and terms are recorded in third-party/social-icons/NOTICE.
function PresetIcon({ type }: { type: ConnectionType }) {
    if (type === 'google') return <img className="provider-icon-google" src={googleIcon} alt="" decoding="async" />;
    if (type === 'github') return <svg className="provider-icon-github" viewBox="0 0 16 16" fill="currentColor" focusable="false">
        <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
    </svg>;
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" focusable="false"><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18M5 6.5c4 2 10 2 14 0M5 17.5c4-2 10-2 14 0" /></svg>;
}

export function ProviderIcon({ type, iconUrl, slot, className = '' }: { type: ConnectionType; iconUrl?: string | null; slot?: string; className?: string }) {
    const [failed, setFailed] = useState<string>();
    let source: string | undefined;
    if (iconUrl) {
        try {
            const url = new URL(iconUrl, window.location.origin);
            if (url.origin === window.location.origin && url.pathname.startsWith('/social/icons/') && avatarIdPattern.test(url.pathname.slice('/social/icons/'.length)) && !url.search && !url.hash) source = url.pathname;
        } catch { /* Invalid icon metadata uses the default symbol. */ }
    }
    return <span slot={slot} className={`provider-icon ${className}`} aria-hidden="true">
        {source && source !== failed ? <img src={source} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(source)} />
            : <PresetIcon type={type} />}
    </span>;
}
