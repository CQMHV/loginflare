import { InMemoryWebStorage, UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import './style.css';

const status = document.querySelector<HTMLParagraphElement>('#status')!;
const profile = document.querySelector<HTMLPreElement>('#profile')!;
const signIn = document.querySelector<HTMLButtonElement>('#signin')!;
const refresh = document.querySelector<HTMLButtonElement>('#refresh')!;
const logout = document.querySelector<HTMLButtonElement>('#logout')!;
const logoutCenter = document.querySelector<HTMLButtonElement>('#logout-center')!;
const restoreKey = 'loginflare.example.restore';
const clientId = import.meta.env.VITE_LOGINFLARE_CLIENT_ID;

async function start() {
    if (!clientId || clientId.startsWith('replace-')) throw new Error('Missing client configuration');
    const manager = new UserManager({
        authority: import.meta.env.VITE_LOGINFLARE_ISSUER || 'http://localhost:5173/api/auth',
        client_id: clientId,
        redirect_uri: `${location.origin}/callback`,
        post_logout_redirect_uri: `${location.origin}/logout-callback`,
        response_type: 'code',
        scope: 'openid profile email offline_access',
        loadUserInfo: true,
        automaticSilentRenew: true,
        monitorSession: false,
        userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
        // The SDK stores only the authorization transaction (state/nonce/PKCE) across redirects.
        stateStore: new WebStorageStateStore({ store: sessionStorage }),
    });
    await manager.clearStaleState();

    function render(user: User | null) {
        const signedIn = !!user && !user.expired;
        signIn.hidden = signedIn;
        refresh.hidden = !signedIn;
        logout.hidden = !signedIn;
        logoutCenter.hidden = !signedIn;
        profile.hidden = !signedIn;
        profile.textContent = signedIn ? JSON.stringify(user.profile, null, 2) : '';
        status.textContent = signedIn ? 'Signed in. Tokens renew automatically while this page is open.' : 'You are signed out of this application.';
        if (signedIn) sessionStorage.setItem(restoreKey, 'true');
    }
    async function run(action: () => Promise<unknown>) {
        for (const button of [signIn, refresh, logout, logoutCenter]) button.disabled = true;
        try { await action(); }
        catch {
            status.textContent = 'The identity request failed or expired. Sign in again to restart the flow.';
            signIn.hidden = false;
        } finally {
            for (const button of [signIn, refresh, logout, logoutCenter]) button.disabled = false;
        }
    }

    signIn.onclick = () => void run(() => manager.signinRedirect({ nonce: crypto.randomUUID() }));
    refresh.onclick = () => void run(async () => { render(await manager.signinSilent()); });
    logout.onclick = () => void run(async () => {
        await manager.removeUser();
        sessionStorage.removeItem(restoreKey);
        render(null);
    });
    logoutCenter.onclick = () => void run(async () => {
        const user = await manager.getUser();
        sessionStorage.removeItem(restoreKey);
        await manager.signoutRedirect({ id_token_hint: user?.id_token });
    });
    manager.events.addUserLoaded(render);
    manager.events.addSilentRenewError(() => {
        status.textContent = 'Automatic renewal failed. Sign in again to continue.';
        signIn.hidden = false;
    });
    manager.events.addAccessTokenExpired(() => { render(null); });

    if (location.pathname === '/callback') {
        await run(async () => {
            const user = await manager.signinRedirectCallback();
            history.replaceState(null, '', '/');
            render(user);
        });
    } else if (location.pathname === '/logout-callback') {
        await run(async () => {
            await manager.signoutRedirectCallback();
            history.replaceState(null, '', '/');
            render(null);
        });
    } else if (sessionStorage.getItem(restoreKey) === 'true') {
        // No iframe or token persistence is needed to restore the app after a reload.
        sessionStorage.removeItem(restoreKey);
        await run(() => manager.signinRedirect({ nonce: crypto.randomUUID() }));
    } else render(null);
}

void start().catch(() => {
    status.textContent = 'Configure VITE_LOGINFLARE_CLIENT_ID in examples/spa/.env and restart this example.';
});
