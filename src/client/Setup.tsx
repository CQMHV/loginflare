import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { resolveLocale } from './locale';
import { selectedBrowserAccountId } from './browser-account-selection';
import './setup.css';

interface ControlStatus {
    mode?: string;
    installed?: boolean;
    installation?: string;
    authenticated?: boolean;
    step?: string;
    schemaReady?: boolean;
    configObserved?: boolean;
    candidateVerified?: boolean;
    candidateCreated?: boolean;
    candidateEmail?: string;
    cleanupPending?: boolean;
    backupConfirmed?: boolean;
    buildId?: string;
    runtimeVersion?: string;
    configRevision?: string;
    turnstileSiteKey?: string;
    authUrl?: string;
    configuration?: { authUrl: string; emailFrom: string; zoneId: string; siteZoneId?: string };
    progress?: Record<string, unknown>;
    error?: string;
    errorDetail?: { code?: string; migration?: string; result?: string; previousFilesRemainCommitted?: boolean };
    code?: string;
}
interface Zone { id: string; name: string }

const english = {
    title: 'Set up your account center', subtitle: 'Connect your Cloudflare services, verify your email, and create your first administrator.',
    maintenance: 'Installation maintenance', maintenanceDescription: 'Review the current state and safely continue a database upgrade. Your installation stays in maintenance until every required check passes.',
    steps: ['Ownership', 'Database', 'Services', 'Administrator', 'Ready'],
    loading: 'Checking installation…', refresh: 'Refresh status', continue: 'Continue', retry: 'Try again',
    owner: 'Verify deployment ownership', token: 'Cloudflare User API Token', tokenHelp: 'Use the scoped User API Token supplied during deployment. It stays in this page’s memory and is never saved in browser storage.',
    permissions: 'Token permissions and deployment guide', authenticate: 'Verify and continue',
    recoveryOwner: 'Restore maintenance access', ownershipHelp: 'A temporary token must prove write control of this Worker. The challenge only changes a dedicated temporary secret.',
    challenge: 'Start ownership check', verifyChallenge: 'Check authorization', waitChallenge: 'Waiting for the ownership challenge to become visible in the running Worker. You can check again safely.',
    adminAuthorize: 'Continue with administrator session', database: 'Initialize the database', databaseHelp: 'Apply the committed migrations and verify the database before creating an account.', prepare: 'Prepare database',
    services: 'Connect services', servicesHelp: 'Choose the public account-center address and sending domain. Existing conflicting DNS records are left in place.',
    loadZones: 'Load my domains', publicUrl: 'Public HTTPS address', sender: 'Sender email address', sendingZone: 'Sending domain', siteZone: 'Website domain (for a custom address)', chooseZone: 'Choose a domain', workersDomain: 'Use the workers.dev address', configure: 'Configure and continue',
    savedDomain: 'Previously selected domain',
    configurationWaiting: 'Waiting for the requested runtime configuration. A new code build is not required; continue after the running configuration is confirmed.',
    emailNotReady: 'Complete sending-domain onboarding in Cloudflare, then return here and continue.', cloudflareDashboard: 'Open Cloudflare',
    publicAddress: 'Continue on your public address', publicAddressHelp: 'The configured address is on another origin. Open it to continue, then enter the installation token again. Credentials are not transferred in the link.',
    administrator: 'Create your administrator', adminHelp: 'The account becomes an administrator only after you verify its email and finish setup in this authorized browser.',
    name: 'Display name', username: 'Username', email: 'Administrator email', password: 'Password', passwordHelp: 'Use 8–128 characters. Keep this password in your password manager.', create: 'Create account and send verification',
    captchaLoading: 'Loading verification…', captchaError: 'Verification could not load. Check your connection and try again.', resend: 'Resend verification email',
    mailSent: 'Check your email', mailHelp: 'Open the verification link on any device, then return here. The email link verifies your address; it does not grant administrator access.', verified: 'Email verified', verifyResult: 'Your email has been verified. Return to the browser where you started installation to finish setup.',
    finish: 'Finish installation', recovery: 'Download recovery information', recoveryHelp: 'Save this private recovery file before completing installation. It contains authentication material and must stay outside Git.',
    complete: 'Your account center is ready', completeHelp: 'Sign in with your verified administrator account. Installation is permanently closed.', login: 'Go to sign in', cleanup: 'Remove temporary credentials', cleanupHelp: 'Installation is complete. Temporary credential cleanup is still pending and can be retried safely.', revoke: 'After cleanup is confirmed, revoke the dedicated installation token in Cloudflare.',
    enter: 'Enter maintenance', backup: 'I have verified the D1 recovery point and matching object-storage backup.', advance: 'Continue upgrade', progress: 'Upgrade progress', phase: 'Phase', stage: 'Step', file: 'Current file', committed: 'Previously committed files', applied: 'Applied files',
    status: 'Status', buildId: 'Application build', runtimeVersion: 'Worker runtime version', configRevision: 'Configuration revision',
    requestFailed: 'The request could not complete. Refresh the status before retrying a write.', operationFailed: 'The operation could not continue.',
    fileRolledBack: 'The current migration file was rolled back. Previously successful files remain committed.',
    commitUnconfirmed: 'The commit result is not confirmed. Check persistent progress before retrying; previously committed files have not been undone.',
    validationFailed: 'Validation has not passed. The installation stays in maintenance; earlier committed migrations are not automatically undone.',
    keyConfirmation: 'No encrypted data was available to prove the existing key. Confirm the key against a trusted backup or the existing Worker binding before continuing.', keyConfirmed: 'I have checked the original authentication key against a trusted source.',
    adoption: 'Existing-installation transition is currently blocked until the platform drain-evidence mechanism is verified. There is no force-unlock option. A checkbox or a fixed delay is not evidence.',
    pending: 'The operation is pending. Check progress before continuing.', openMaintenance: 'Open maintenance',
} as const;
type Copy = { [Key in keyof typeof english]: Key extends 'steps' ? readonly string[] : string };
const chinese: Copy = {
    title: '设置你的账号中心', subtitle: '连接 Cloudflare 服务，验证邮箱并创建首个管理员。',
    maintenance: '安装维护', maintenanceDescription: '查看当前状态并安全继续数据库升级。所有必要检查通过后，实例才会恢复服务。',
    steps: ['验证归属', '数据库', '连接服务', '管理员', '完成'],
    loading: '正在检查安装状态…', refresh: '刷新状态', continue: '继续', retry: '重试',
    owner: '验证部署归属', token: 'Cloudflare 用户 API 令牌', tokenHelp: '使用部署时提供的专用 User API Token。令牌仅保留在本页面内存中，不写入浏览器存储。',
    permissions: '令牌权限与部署说明', authenticate: '验证并继续', recoveryOwner: '恢复维护权限', ownershipHelp: '临时令牌须证明对当前 Worker 的写控制权。验证只更改专用临时机密。',
    challenge: '开始归属验证', verifyChallenge: '检查授权', waitChallenge: '正在等待运行中的 Worker 观察到归属验证挑战。可以安全地再次检查。', adminAuthorize: '使用管理员会话继续',
    database: '初始化数据库', databaseHelp: '应用已提交的迁移，并在创建账号前检查数据库。', prepare: '准备数据库',
    services: '连接服务', servicesHelp: '选择公开账号中心地址和发信域名。遇到 DNS 记录冲突时会停止，不会覆盖现有记录。',
    loadZones: '读取我的域名', publicUrl: '公开 HTTPS 地址', sender: '发件人邮箱', sendingZone: '发信域名', siteZone: '网站域名（自定义地址时选择）', chooseZone: '选择域名', workersDomain: '使用 workers.dev 地址', configure: '配置并继续',
    savedDomain: '此前选定的域名',
    configurationWaiting: '正在等待目标运行配置生效。无需重新构建代码；确认运行配置后即可继续。',
    emailNotReady: '请在 Cloudflare 完成发信域名接入，再返回这里继续。', cloudflareDashboard: '打开 Cloudflare',
    publicAddress: '前往公开地址继续', publicAddressHelp: '所选公开地址属于另一个 Origin。请前往该地址并重新输入安装令牌；链接不会携带凭据。',
    administrator: '创建管理员', adminHelp: '账号验证邮箱后，仍需在此已授权浏览器完成安装，才会成为管理员。',
    name: '显示名称', username: '用户名', email: '管理员邮箱', password: '密码', passwordHelp: '使用 8–128 个字符，并将密码保存在密码管理器中。', create: '创建账号并发送验证邮件',
    captchaLoading: '正在加载人机验证…', captchaError: '人机验证未能加载，请检查网络后重试。', resend: '重发验证邮件',
    mailSent: '请查收验证邮件', mailHelp: '可以在任何设备打开验证链接，然后返回这里。邮件链接仅证明邮箱归属，不授予管理员权限。', verified: '邮箱已验证', verifyResult: '邮箱已验证。请返回开始安装的浏览器完成剩余步骤。',
    finish: '完成安装', recovery: '下载恢复资料', recoveryHelp: '完成安装前，请私密保存恢复资料。其中包含认证材料，必须保存在 Git 之外。',
    complete: '账号中心已就绪', completeHelp: '使用已验证的管理员账号登录。安装入口已永久关闭。', login: '前往登录', cleanup: '清理临时凭据', cleanupHelp: '安装已经完成，临时凭据仍待清理。可以安全重试，不会重新开放安装。', revoke: '确认清理完成后，请在 Cloudflare 撤销专用安装令牌。',
    enter: '进入维护', backup: '我已核实 D1 恢复点及相匹配的对象存储备份。', advance: '继续升级', progress: '升级进度', phase: '阶段', stage: '步骤', file: '当前文件', committed: '此前已提交的文件', applied: '已应用的文件',
    status: '状态', buildId: '应用构建', runtimeVersion: 'Worker 运行时版本', configRevision: '配置修订号',
    requestFailed: '请求未能完成。重试写操作前，请先刷新并核对实际状态。', operationFailed: '操作暂时无法继续。',
    fileRolledBack: '当前迁移文件已回滚。此前成功的文件仍已提交。',
    commitUnconfirmed: '提交结果待确认。请先核对持久化进度，不要盲目重试；此前已提交的文件没有被撤销。',
    validationFailed: '检查尚未通过，实例保持维护状态。此前已提交的迁移不会自动撤销。',
    keyConfirmation: '没有可用于验证原密钥的加密数据。继续前，请通过可信备份或既有 Worker 绑定核对原认证密钥。', keyConfirmed: '我已根据可信来源核对原认证密钥。',
    adoption: '当前版本暂不允许已有实例切换，须先核实平台排空证据机制；目前没有强行解除入口。勾选确认或固定等待不能作为证据。',
    pending: '操作仍在进行，请核对进度后继续。', openMaintenance: '打开维护页面',
};

class ControlRequestError extends Error {}
async function api(path: string, body?: Record<string, unknown>) {
    let response: Response;
    const headers: Record<string, string> = body ? { 'Content-Type': 'application/json' } : {};
    if (path === '/api/maintenance/authorize' && body !== undefined) {
        const accountId = selectedBrowserAccountId();
        if (accountId) headers['X-Loginflare-Account'] = accountId;
    }
    try {
        response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
            headers, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new ControlRequestError('NETWORK_ERROR'); }
    let value: Record<string, unknown>;
    try { value = await response.json(); } catch { throw new ControlRequestError('INVALID_RESPONSE'); }
    if (!response.ok) throw new ControlRequestError(typeof value.code === 'string' ? value.code : 'REQUEST_FAILED');
    return value;
}

function Captcha({ sitekey, language, onToken, reset }: { sitekey: string; language: string; onToken: (token: string) => void; reset: number }) {
    const container = useRef<HTMLDivElement>(null);
    const [error, setError] = useState(false);
    useEffect(() => {
        let disposed = false;
        let widget: string | undefined;
        onToken(''); setError(false);
        const mount = () => {
            if (disposed || !container.current || !window.turnstile) return;
            widget = window.turnstile.render(container.current, { sitekey, language, size: 'normal',
                theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', callback: onToken,
                'expired-callback': () => onToken(''), 'error-callback': () => { onToken(''); setError(true); } });
        };
        let script: HTMLScriptElement | undefined;
        if (window.turnstile) mount();
        else {
            script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true;
            script.onload = mount; script.onerror = () => { if (!disposed) setError(true); }; document.head.appendChild(script);
        }
        return () => { disposed = true; if (widget) window.turnstile?.remove(widget); script?.remove(); };
    }, [sitekey, language, onToken, reset]);
    return <div className="setup-captcha"><div ref={container} />{error && <p role="alert">{language === 'zh-cn' ? chinese.captchaError : english.captchaError}</p>}</div>;
}

export default function Setup() {
    const locale = resolveLocale(location.pathname);
    const language = locale === 'zh-CN' ? 'zh-cn' : 'en-us';
    const text: Copy = locale === 'zh-CN' ? chinese : english;
    const maintenance = location.pathname.includes('/maintenance');
    const verifiedPage = /\/setup\/verified\/?$/.test(location.pathname);
    const base = maintenance ? '/api/maintenance' : '/api/setup';
    const [status, setStatus] = useState<ControlStatus | null>(null);
    const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
    const [actionUrl, setActionUrl] = useState('');
    const [token, setToken] = useState(''); const [challengeId, setChallengeId] = useState('');
    const [recoveryNonce] = useState(() => crypto.randomUUID() + crypto.randomUUID());
    const [zones, setZones] = useState<Zone[]>([]); const [zoneId, setZoneId] = useState(''); const [siteZoneId, setSiteZoneId] = useState('');
    const [authUrl, setAuthUrl] = useState(location.origin); const [emailFrom, setEmailFrom] = useState('');
    const [name, setName] = useState(''); const [username, setUsername] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
    const [captchaToken, setCaptchaToken] = useState(''); const [captchaReset, setCaptchaReset] = useState(0);
    const [backupConfirmed, setBackupConfirmed] = useState(false); const [keyConfirmed, setKeyConfirmed] = useState(false);
    const active = useRef(true);
    const refresh = useCallback(async () => {
        const value = await api(`${base}/status`); setStatus(value as ControlStatus); return value as ControlStatus;
    }, [base]);
    useEffect(() => {
        active.current = true;
        document.documentElement.lang = locale;
        document.title = `${maintenance ? text.maintenance : text.title} · Loginflare`;
        if (!/^\/(en-us|zh-cn)\//.test(location.pathname)) history.replaceState(null, '', `/${language}${location.pathname}${location.search}${location.hash}`);
        if (verifiedPage) return () => { active.current = false; };
        const check = () => { void refresh().catch(() => { if (active.current) setError('NETWORK_ERROR'); }); };
        check(); const timer = window.setInterval(check, 5000);
        return () => { active.current = false; window.clearInterval(timer); };
    }, [language, locale, maintenance, refresh, text, verifiedPage]);
    async function action(path: string, body: Record<string, unknown> = {}) {
        setBusy(true); setError(''); setNotice(''); setActionUrl('');
        try {
            const prepare = path === '/api/setup/prepare';
            const upgrade = path === '/api/maintenance/advance';
            const configure = path === '/api/setup/configure';
            const repeated = prepare || upgrade || configure;
            const deadline = Date.now() + 55_000;
            for (let step = 0; step < (repeated ? 200 : 1) && active.current; step++) {
                const value = await api(path, body);
                if (!active.current) return false;
                if (typeof value.challengeId === 'string') { setChallengeId(value.challengeId); setNotice(text.waitChallenge); }
                if (Array.isArray(value.zones)) setZones(value.zones.filter((zone): zone is Zone => !!zone && typeof zone.id === 'string' && typeof zone.name === 'string'));
                if (typeof value.actionUrl === 'string') {
                    try { const destination = new URL(value.actionUrl); if (destination.protocol === 'https:' && destination.hostname === 'dash.cloudflare.com') setActionUrl(destination.toString()); }
                    catch { /* Only trusted dashboard links are actionable. */ }
                }
                const current = await refresh();
                if (current.error) throw new ControlRequestError(current.error);
                if (value.code === 'EMAIL_SERVICE_NOT_READY') { setNotice(text.emailNotReady); break; }
                const done = prepare ? current.schemaReady || current.progress?.phase === 'complete'
                    : upgrade ? current.mode === 'ready'
                    : configure ? current.configObserved : true;
                if (done) break;
                if (Date.now() >= deadline || step === 199 || configure && current.step === 'observed') {
                    setNotice(configure ? text.configurationWaiting : text.pending); break;
                }
            }
            return true;
        } catch (failure) { setError(failure instanceof ControlRequestError ? failure.message : 'REQUEST_FAILED'); return false; }
        finally { setBusy(false); }
    }
    const submit = (handler: () => Promise<unknown>) => (event: FormEvent) => { event.preventDefault(); if (!busy) void handler(); };
    const installed = status?.installed === true || status?.installation === 'complete';
    const stateError = error || status?.error || status?.errorDetail?.code || (typeof status?.progress?.error === 'string' ? status.progress.error : '');
    const matchingDetail = status?.errorDetail?.code === stateError ? status.errorDetail : undefined;
    const errorResult = stateError === 'MIGRATION_FILE_ROLLED_BACK' ? 'current-file-rolled-back'
        : ['MIGRATION_COMMIT_UNCONFIRMED', 'UPGRADE_STEP_FAILED'].includes(stateError) ? 'commit-unconfirmed' : matchingDetail?.result;
    const failureDescription = errorResult === 'current-file-rolled-back' ? text.fileRolledBack
        : errorResult === 'commit-unconfirmed' ? text.commitUnconfirmed
        : errorResult === 'validation-failed' || status?.mode === 'failed' ? text.validationFailed : text.operationFailed;
    const keyRequired = stateError === 'KEY_CONFIRMATION_REQUIRED';
    const adoption = status?.mode === 'adoption' || status?.mode === 'adoption_required' || stateError === 'VERIFIED_LEGACY_DRAIN_REQUIRED' || stateError === 'LEGACY_DRAIN_REQUIRED' || stateError === 'LEGACY_DRAIN_UNVERIFIED';
    const currentStep = installed ? 4 : status?.candidateEmail ? 3 : status?.configObserved ? 3 : status?.schemaReady ? 2 : status?.authenticated ? 1 : 0;
    const pagePath = `/${language}/${maintenance ? 'maintenance' : 'setup'}`;
    const savedConfiguration = status?.configuration;
    const configurationInput = savedConfiguration ?? { authUrl, emailFrom, zoneId, siteZoneId };
    let canonicalAddress: string | null = null;
    if (status?.configObserved && status.authUrl) {
        try {
            const address = new URL(status.authUrl);
            if (address.protocol === 'https:' && address.origin !== location.origin) canonicalAddress = `${address.origin}/${language}/setup`;
        } catch { /* An invalid configuration cannot become a navigation target. */ }
    }
    function secretField() {
        return <label className="setup-label">{text.token}<input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false} disabled={busy} /></label>;
    }
    const progressRows = ['phase', 'stage', 'file', 'committed', 'applied'].flatMap((key) => {
        const value = key === 'file' ? status?.progress?.currentFile ?? status?.progress?.file ?? matchingDetail?.migration : status?.progress?.[key];
        const description = Array.isArray(value) ? value.filter((item) => typeof item === 'string').join(', ') : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
        return description ? [{ key, value: description.slice(0, 1500) }] : [];
    });
    return <main className="setup-shell">
        <header className="setup-header"><span className="setup-brand"><img src="/favicon.svg" alt="" />Loginflare</span><a href={pagePath.replace(`/${language}/`, language === 'zh-cn' ? '/en-us/' : '/zh-cn/')}>{language === 'zh-cn' ? 'English' : '简体中文'}</a></header>
        <div className="setup-heading"><h1>{verifiedPage ? text.verified : maintenance ? text.maintenance : text.title}</h1><p>{verifiedPage ? text.verifyResult : maintenance ? text.maintenanceDescription : text.subtitle}</p></div>
        {verifiedPage ? <a href={`/${language}/setup`}>{text.continue}</a> : <div className="setup-grid">
            <ol className="setup-steps" aria-label={maintenance ? text.progress : text.title}>{text.steps.map((label, index) => <li key={label} aria-current={index === currentStep ? 'step' : undefined}><span className="setup-step-number">{index < currentStep ? '✓' : index + 1}</span>{label}</li>)}</ol>
            <div className="setup-content" aria-busy={busy}>
                {!status && !error && <p role="status">{text.loading}</p>}
                {stateError && <div className="setup-notice error" role="alert">{stateError === 'NETWORK_ERROR' || stateError === 'INVALID_RESPONSE' ? text.requestFailed : failureDescription}{/^[A-Z0-9_:-]{1,100}$/.test(stateError) && <p><code>{stateError}</code></p>}{matchingDetail?.migration && <p>{text.file}: <code>{matchingDetail.migration.slice(0, 256)}</code></p>}</div>}
                {notice && <div className="setup-notice" role="status">{notice}{actionUrl && <p><a href={actionUrl} target="_blank" rel="noreferrer">{text.cloudflareDashboard}</a></p>}</div>}
                {adoption && <div className="setup-notice" role="status">{text.adoption}</div>}
                {status && !status.authenticated && <section className="setup-card"><h2>{maintenance ? text.recoveryOwner : text.owner}</h2><p>{maintenance ? text.ownershipHelp : text.tokenHelp}</p><form onSubmit={submit(() => action(maintenance ? '/api/maintenance/challenge' : '/api/setup/authenticate', maintenance ? { token, nonce: recoveryNonce } : { token }))}>{secretField()}<div className="setup-actions"><button className="setup-button" disabled={busy || !token}>{maintenance ? text.challenge : text.authenticate}</button>{maintenance && <button className="setup-button secondary" type="button" disabled={busy} onClick={() => { void action('/api/maintenance/authorize'); }}>{text.adminAuthorize}</button>}</div></form>{challengeId && <button className="setup-button secondary" disabled={busy} onClick={() => { void action('/api/maintenance/verify', { challengeId, nonce: recoveryNonce }); }}>{text.verifyChallenge}</button>}<a href={`https://github.com/CQMHV/loginflare/blob/main/docs/deployment${language === 'zh-cn' ? '.zh-CN' : ''}.md`} target="_blank" rel="noreferrer">{text.permissions}</a></section>}
                {status?.authenticated && !maintenance && !installed && <>
                    {!status.schemaReady && <section className="setup-card"><h2>{text.database}</h2><p>{text.databaseHelp}</p><button className="setup-button" disabled={busy || adoption} onClick={() => { void action('/api/setup/prepare', keyRequired && keyConfirmed ? { confirmUnverifiableKey: true } : {}); }}>{text.prepare}</button></section>}
                    {status.schemaReady && !status.configObserved && <section className="setup-card"><h2>{text.services}</h2><p>{text.servicesHelp}</p><button className="setup-button secondary" disabled={busy} onClick={() => { void action('/api/setup/options', token ? { token } : {}); }}>{text.loadZones}</button><form onSubmit={submit(() => action('/api/setup/configure', { ...(token ? { token } : {}), authUrl: configurationInput.authUrl, emailFrom: configurationInput.emailFrom, zoneId: configurationInput.zoneId, ...(configurationInput.siteZoneId ? { siteZoneId: configurationInput.siteZoneId } : {}) }))}>
                        <label className="setup-label">{text.publicUrl}<input type="url" readOnly={!!savedConfiguration} value={configurationInput.authUrl} required onChange={(event) => setAuthUrl(event.target.value)} disabled={busy} /></label>
                        <label className="setup-label">{text.sender}<input type="email" readOnly={!!savedConfiguration} value={configurationInput.emailFrom} required onChange={(event) => setEmailFrom(event.target.value)} disabled={busy} autoComplete="off" /></label>
                        <label className="setup-label">{text.sendingZone}<select aria-label={text.sendingZone} value={configurationInput.zoneId} required onChange={(event) => setZoneId(event.target.value)} disabled={busy || !!savedConfiguration}><option value="">{text.chooseZone}</option>{configurationInput.zoneId && !zones.some((zone) => zone.id === configurationInput.zoneId) && <option value={configurationInput.zoneId}>{text.savedDomain}</option>}{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
                        <label className="setup-label">{text.siteZone}<select aria-label={text.siteZone} value={configurationInput.siteZoneId ?? ""} onChange={(event) => setSiteZoneId(event.target.value)} disabled={busy || !!savedConfiguration}><option value="">{text.workersDomain}</option>{configurationInput.siteZoneId && !zones.some((zone) => zone.id === configurationInput.siteZoneId) && <option value={configurationInput.siteZoneId}>{text.savedDomain}</option>}{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label>
                        <button className="setup-button" disabled={busy || !configurationInput.zoneId}>{text.configure}</button>
                    </form>{status.step === 'observed' && <p role="status">{text.configurationWaiting}</p>}</section>}
                    {canonicalAddress && <section className="setup-card"><h2>{text.publicAddress}</h2><p>{text.publicAddressHelp}</p><a href={canonicalAddress}>{text.publicAddress}</a></section>}
                    {status.configObserved && !canonicalAddress && !status.candidateCreated && <section className="setup-card"><h2>{text.administrator}</h2><p>{text.adminHelp}</p><form onSubmit={submit(async () => {
                        const success = await action('/api/setup/candidate', { name, username, email: status.candidateEmail ?? email, password, locale, captchaToken });
                        setPassword(''); setCaptchaToken(''); setCaptchaReset((value) => value + 1); return success;
                    })}>
                        <label className="setup-label">{text.name}<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} autoComplete="name" disabled={busy} /></label>
                        <label className="setup-label">{text.username}<input value={username} onChange={(event) => setUsername(event.target.value)} required minLength={3} maxLength={30} pattern="[A-Za-z0-9_.]+" autoComplete="username" disabled={busy} /></label>
                        <label className="setup-label">{text.email}<input type="email" value={status.candidateEmail ?? email} readOnly={!!status.candidateEmail} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" disabled={busy} /></label>
                        <label className="setup-label">{text.password}<input type="password" aria-label={text.password} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} maxLength={128} autoComplete="new-password" disabled={busy} /><span>{text.passwordHelp}</span></label>
                        {status.turnstileSiteKey && <Captcha sitekey={status.turnstileSiteKey} language={language} onToken={setCaptchaToken} reset={captchaReset} />}
                        <button className="setup-button" disabled={busy || !captchaToken}>{text.create}</button>
                    </form></section>}
                    {status.candidateCreated && status.candidateEmail && !canonicalAddress && <section className="setup-card"><h2>{status.candidateVerified ? text.verified : text.mailSent}</h2><p>{status.candidateEmail}</p><p>{text.mailHelp}</p>{!status.candidateVerified && <><Captcha sitekey={status.turnstileSiteKey ?? ''} language={language} onToken={setCaptchaToken} reset={captchaReset} /><button className="setup-button secondary" disabled={busy || !captchaToken} onClick={() => { void action('/api/setup/resend', { captchaToken }); setCaptchaReset((value) => value + 1); }}>{text.resend}</button></>}{status.candidateVerified && <><p>{text.recoveryHelp}</p><a href="/api/setup/recovery" download="loginflare-recovery.json">{text.recovery}</a><button className="setup-button" disabled={busy} onClick={async () => { if (await action('/api/setup/finish')) { setPassword(''); setCaptchaToken(''); } }}>{text.finish}</button></>}</section>}
                </>}
                {status?.authenticated && maintenance && <section className="setup-card">
                    <h2>{text.progress}</h2>
                    {keyRequired && <><p>{text.keyConfirmation}</p><label className="setup-check"><input type="checkbox" checked={keyConfirmed} onChange={(event) => setKeyConfirmed(event.target.checked)} />{text.keyConfirmed}</label></>}
                    {status.mode === 'ready' || !status.backupConfirmed ? <>
                        <label className="setup-check"><input type="checkbox" checked={backupConfirmed} disabled={busy || adoption} onChange={(event) => setBackupConfirmed(event.target.checked)} />{text.backup}</label>
                        <button className="setup-button" disabled={busy || adoption || !backupConfirmed} onClick={() => { void action('/api/maintenance/enter', { backupConfirmed }); }}>{text.enter}</button>
                    </> : !adoption && <button className="setup-button" disabled={busy || (keyRequired && !keyConfirmed)} onClick={() => { void action('/api/maintenance/advance', keyRequired ? { confirmUnverifiableKey: keyConfirmed } : {}); }}>{text.advance}</button>}
                </section>}
                {installed && !maintenance && <section className="setup-card"><h2>{text.complete}</h2><p>{text.completeHelp}</p><a href={`/${language}/login`}>{text.login}</a><a href={`/${language}/maintenance`}>{text.openMaintenance}</a></section>}
                {status?.authenticated && status.cleanupPending && <section className="setup-card"><h2>{text.cleanup}</h2><p>{text.cleanupHelp}</p>{secretField()}<button className="setup-button secondary" disabled={busy} onClick={async () => { if (await action('/api/setup/cleanup', token ? { token } : {})) setToken(''); }}>{text.cleanup}</button><p>{text.revoke}</p></section>}
                {(status || error) && <div className="setup-actions"><button className="setup-button secondary" disabled={busy} onClick={() => { setError(''); void refresh().catch(() => setError('NETWORK_ERROR')); }}>{text.refresh}</button></div>}
                {status && <footer className="setup-meta"><dl className="setup-details"><dt>{text.status}</dt><dd>{status.mode ?? status.step ?? '—'}</dd>{progressRows.map((row) => <div key={row.key} style={{ display: 'contents' }}><dt>{text[row.key as 'phase' | 'stage' | 'file' | 'committed' | 'applied']}</dt><dd>{row.value}</dd></div>)}{(['buildId', 'runtimeVersion', 'configRevision'] as const).map((key) => status[key] && <div key={key} style={{ display: 'contents' }}><dt>{text[key]}</dt><dd>{status[key]}</dd></div>)}</dl></footer>}
            </div>
        </div>}
    </main>;
}
