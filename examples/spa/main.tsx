import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InMemoryWebStorage, UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import './style.css';

const restoreKey = 'loginflare.example.restore';
const manager = new UserManager({
    authority: import.meta.env.VITE_LOGINFLARE_ISSUER || 'http://localhost:5173/api/auth',
    client_id: import.meta.env.VITE_LOGINFLARE_CLIENT_ID || 'replace-with-client-id',
    redirect_uri: `${location.origin}/callback`, post_logout_redirect_uri: `${location.origin}/logout-callback`,
    response_type: 'code', scope: 'openid profile email offline_access', loadUserInfo: true,
    // One renewal coordinator covers manual refresh and access-token-expiring events.
    automaticSilentRenew: false, monitorSession: false,
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: sessionStorage }),
});
let renewal: Promise<User | null> | undefined;
const renew = () => renewal ??= manager.signinSilent().finally(() => { renewal = undefined; });

function App() {
    const [user, setUser] = useState<User | null>(null);
    const [busy, setBusy] = useState(true);
    const [status, setStatus] = useState('Loading configuration…');
    const [failed, setFailed] = useState(false);
    const update = (current: User | null) => {
        setUser(current); setFailed(false);
        setStatus(current && !current.expired ? 'Signed in. Tokens renew automatically while this page is open.' : 'You are signed out of this application.');
        if (current && !current.expired) sessionStorage.setItem(restoreKey, 'true');
    };
    async function run(action: () => Promise<unknown>) {
        setBusy(true);
        try { await action(); }
        catch { setFailed(true); setStatus('The identity request failed or expired. Sign in again to restart the flow.'); }
        finally { setBusy(false); }
    }
    useEffect(() => {
        const loaded = (value: User) => update(value);
        const expired = () => update(null);
        const expiring = () => { void run(async () => { update(await renew()); }); };
        manager.events.addUserLoaded(loaded);
        manager.events.addAccessTokenExpired(expired);
        manager.events.addAccessTokenExpiring(expiring);
        void run(async () => {
            if (!import.meta.env.VITE_LOGINFLARE_CLIENT_ID || import.meta.env.VITE_LOGINFLARE_CLIENT_ID.startsWith('replace-')) throw new Error('Configure client');
            await manager.clearStaleState();
            if (location.pathname === '/callback') {
                const current = await manager.signinRedirectCallback();
                history.replaceState(null, '', '/'); update(current);
            } else if (location.pathname === '/logout-callback') {
                await manager.signoutRedirectCallback();
                history.replaceState(null, '', '/'); update(null);
            } else if (sessionStorage.getItem(restoreKey) === 'true') {
                sessionStorage.removeItem(restoreKey);
                await manager.signinRedirect({ nonce: crypto.randomUUID() });
            } else update(null);
        });
        return () => {
            manager.events.removeUserLoaded(loaded); manager.events.removeAccessTokenExpired(expired);
            manager.events.removeAccessTokenExpiring(expiring);
        };
    }, []);
    const signedIn = !!user && !user.expired;
    return <main>
        <h1>SPA example</h1>
        <p>This React application uses <code>oidc-client-ts</code>. Tokens stay in memory.</p>
        <p id="status" role="status">{status}</p>
        {signedIn && <pre id="profile">{JSON.stringify(user.profile, null, 2)}</pre>}
        <nav>
            {(!signedIn || failed) && <button id="signin" disabled={busy} onClick={() => void run(() => manager.signinRedirect({ nonce: crypto.randomUUID() }))}>Sign in with Loginflare</button>}
            {signedIn && <>
                <button id="refresh" disabled={busy} onClick={() => void run(async () => { update(await renew()); })}>Refresh tokens</button>
                <button id="logout" disabled={busy} onClick={() => void run(async () => {
                    if (renewal) await renewal.catch(() => {});
                    await manager.removeUser(); sessionStorage.removeItem(restoreKey); update(null);
                })}>Sign out of this app</button>
                <button id="logout-center" disabled={busy} onClick={() => void run(async () => {
                    if (renewal) await renewal.catch(() => {});
                    const current = await manager.getUser();
                    sessionStorage.removeItem(restoreKey);
                    await manager.signoutRedirect({ id_token_hint: current?.id_token });
                })}>Sign out of this app and Loginflare</button>
            </>}
        </nav>
        <p>Reloading discards tokens. A signed-in tab starts a new top-level authorization request using its Loginflare session. Each tab owns its own application session.</p>
    </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
