import { useEffect, useState, type FormEvent } from 'react';
import { defaultBranding } from '../shared/branding';
import './styles.css';
import './setup.css';

type Status = { step: 'target' | 'domain' | 'sending' | 'turnstile' | 'ready'; canonical: boolean;
    publicUrl?: string; completed: boolean; error?: string; detail?: string; canStart: boolean; branding: { name: string; logoUrl: string } };
const copy = {
    en: {
        title: 'Set up your login service', progress: 'Cloudflare is preparing your login service.',
        target: 'Checking the Cloudflare deployment', domain: 'Connecting the login domain',
        sending: 'Configuring email delivery', turnstile: 'Preparing security settings', ready: 'Ready',
        missing: 'In Cloudflare, open this Worker’s Settings → Variables and Secrets and check these three Worker secrets. Add or correct the missing values there, not in build variables.',
        originHint: 'Your login hostname, such as auth.example.com.', emailHint: 'The mailbox for the first administrator.',
        tokenHint: 'A short-lived User API Token for the account and zone in the deployment guide.',
        currentStep: 'Current step', diagnostic: 'Diagnostic code', docs: 'Deployment and recovery guide',
        open: 'Open your login domain', complete: 'Installation is complete.',
        inviteTitle: 'Create the first administrator', invite: 'Send setup link',
        inviteHelp: 'We’ll send a setup link to the administrator address specified in Cloudflare.',
        sent: 'Check that mailbox for the link. It expires in 20 minutes.',
        username: 'Username', password: 'Password', create: 'Create administrator',
        invalid: 'This link is invalid or has expired. Request a new setup link.',
        unavailable: 'Could not continue. Try again in a moment.',
        conflict: 'A DNS record conflicts with this deployment. Resolve the record in Cloudflare to continue.',
        pending: 'Waiting for Cloudflare to verify the sending domain.',
        delivery: 'Cloudflare could not send the email. Check Email Sending in Cloudflare and try again.',
        input: 'Use 3–30 letters, digits, dots or underscores and a password of 8–128 characters.',
        permission: 'Cloudflare denied setup access. Check that CF_SETUP_TOKEN is active and has the account and zone permissions listed in the deployment guide. Keep this page open after correcting the Worker secret.',
        userToken: 'Set CF_SETUP_TOKEN to an active Cloudflare User API Token, not an Account API Token. Follow the deployment guide to select the account, zone and permissions.',
        invalidToken: 'CF_SETUP_TOKEN has an invalid format. Check the Worker secret for extra spaces and use the complete User API Token.',
        limited: 'Cloudflare is receiving too many requests. Keep this page open while setup waits and checks progress automatically; avoid repeatedly refreshing or creating resources.',
        uncertain: 'Cloudflare’s result could not be confirmed. A previous request may have succeeded. Keep this page and instance: setup checks existing resources before continuing. Do not create replacements or delete resources to retry.',
        requestFailed: 'Cloudflare could not complete this step. Check the Worker’s installation logs and the Cloudflare service status. Keep existing resources while this page checks progress automatically.',
        invalidDomain: 'Check SETUP_ORIGIN in the Worker secrets. Use your login hostname, such as auth.example.com, without a path or query. A workers.dev hostname cannot be the login domain.',
        invalidEmail: 'Check SETUP_ADMIN_EMAIL in the Worker secrets. Use a complete email address whose inbox you can access.',
        identity: 'The deployment identity could not be verified. Check that this Worker, its bindings and version metadata come from the project’s deployment process. Keep the original resources and consult the deployment guide.',
        zone: 'No active zone was found for this login hostname in the selected account. Check SETUP_ORIGIN, the zone status and the token’s account and zone access.',
        reservedDomain: 'This hostname is reserved for sending email. Choose a different login hostname, such as auth.example.com, in SETUP_ORIGIN.',
        domainConflict: 'This login hostname is connected to another Worker. Check the existing custom-domain assignment in Cloudflare before changing it; do not remove an unrelated service.',
        emailDns: 'Cloudflare has not provided the email DNS records yet. Keep this page open while setup checks again automatically. If this continues, check Email Sending and the Worker logs.',
        storage: 'The private instance-storage binding is missing. Check the PRIVATE R2 binding created by the deployment process. For an existing instance, keep its original private bucket.',
        initializedStorage: 'The private bucket already contains instance keys. Do not overwrite or reinitialize it. Check the original Worker, D1 and R2 bindings using the recovery guide.',
        database: 'This database already contains accounts and cannot be used for a new installation. Do not clear existing data. Use the recovery guide for an existing instance, or a separate empty database for a new one.',
        keys: 'The original instance keys are missing or do not match this installation. Check the original PRIVATE bucket binding and recovery instructions. Do not replace the keys or reset the database.',
        widget: 'The existing Turnstile configuration does not match this installation, or its secret could not be obtained. Check Turnstile and the Worker logs while keeping the existing instance and resources.',
        unexpected: 'This installation step could not be completed. Check the Worker’s installation logs using the diagnostic code below and follow the deployment and recovery guide. Keep the existing instance and resources.',
        login: 'Go to sign in', again: 'Request a setup link',
    },
    zh: {
        title: '安装登录服务', progress: 'Cloudflare 正在准备你的登录服务。',
        target: '检查 Cloudflare 部署', domain: '连接登录域名',
        sending: '配置邮件发送', turnstile: '准备安全设置', ready: '已就绪',
        missing: '请在 Cloudflare 打开此 Worker 的“设置 → 变量和机密”，核对以下三项 Worker 机密，并补全或修正缺失内容。不要填写到构建变量中。',
        originHint: '登录域名，例如 auth.example.com。', emailHint: '接收首个管理员安装链接的邮箱。',
        tokenHint: '按部署说明限定账号、站点和权限的短期 User API Token。',
        currentStep: '当前步骤', diagnostic: '诊断码', docs: '部署与恢复说明',
        open: '打开正式登录域名', complete: '安装已完成。',
        inviteTitle: '创建首个管理员', invite: '发送安装链接',
        inviteHelp: '安装链接会发往你在 Cloudflare 指定的管理员邮箱。',
        sent: '请到该邮箱查收安装链接。链接在 20 分钟后失效。',
        username: '用户名', password: '密码', create: '创建管理员',
        invalid: '链接无效或已过期，请重新请求安装链接。',
        unavailable: '暂时无法继续，请稍后重试。',
        conflict: '发现冲突的 DNS 记录。请在 Cloudflare 解决冲突后继续。',
        pending: '正在等待 Cloudflare 验证发信域名。',
        delivery: 'Cloudflare 未能发送邮件。请检查 Cloudflare 的 Email Sending 后重试。',
        input: '用户名须为 3–30 个字母、数字、点或下划线；密码须为 8–128 个字符。',
        permission: 'Cloudflare 拒绝了安装授权。请核对 CF_SETUP_TOKEN 是否有效，以及是否包含部署说明中所列账号和站点的权限。修正 Worker 机密后，保持此页面打开。',
        userToken: '请将 CF_SETUP_TOKEN 设置为有效的 Cloudflare 用户 API 令牌（User API Token），不能使用账户 API 令牌（Account API Token）。按部署说明选择账号、站点和权限。',
        invalidToken: 'CF_SETUP_TOKEN 格式无效。请核对 Worker 机密是否包含多余空格，并使用完整的用户 API 令牌。',
        limited: 'Cloudflare 请求过于频繁。请保持页面打开，等待安装程序自动检查进度，避免反复刷新或创建资源。',
        uncertain: '暂时无法确认 Cloudflare 的处理结果，之前的请求可能已经成功。请保留当前页面和实例，安装程序会先核对已有资源再继续。不要通过重复创建或删除资源来重试。',
        requestFailed: 'Cloudflare 未能完成当前步骤。请检查 Worker 安装日志和 Cloudflare 服务状态；保留已有资源，此页面会自动检查进度。',
        invalidDomain: '请核对 Worker 机密中的 SETUP_ORIGIN，填写 auth.example.com 这样的登录域名，不包含路径或查询参数，不能使用 workers.dev 域名。',
        invalidEmail: '请核对 Worker 机密中的 SETUP_ADMIN_EMAIL，填写能够正常查收邮件的完整邮箱地址。',
        identity: '无法确认部署身份。请核对此 Worker、绑定和版本元数据是否来自本项目的部署流程，保留原有资源并查阅部署说明。',
        zone: '在所选账号中未找到此登录域名对应的有效站点。请核对 SETUP_ORIGIN、站点状态，以及令牌对该账号和站点的访问权限。',
        reservedDomain: '此域名已预留用于发送邮件。请在 SETUP_ORIGIN 中选择 auth.example.com 这样的其他登录域名。',
        domainConflict: '此登录域名已连接到其他 Worker。请先在 Cloudflare 核对现有自定义域名归属，不要移除无关服务。',
        emailDns: 'Cloudflare 暂未提供发信所需的 DNS 记录。请保持页面打开，等待安装程序自动检查；若持续无法继续，请检查 Email Sending 和 Worker 日志。',
        storage: '缺少实例私有存储绑定。请检查部署流程创建的 PRIVATE R2 绑定；恢复已有实例时，应保留原来的私有桶。',
        initializedStorage: '私有桶中已存在实例密钥，请勿覆盖或重新初始化。请按恢复说明核对原有 Worker、D1 和 R2 绑定。',
        database: '此数据库已存在账号，不能用于全新安装。请勿清空已有数据；已有实例应按恢复说明处理，新实例应使用独立的空数据库。',
        keys: '原有实例密钥缺失或与当前安装不匹配。请按恢复说明核对原 PRIVATE 桶绑定，不要替换密钥或重置数据库。',
        widget: '现有 Turnstile 配置与此安装不匹配，或尚未获取其密钥。请检查 Turnstile 和 Worker 日志，并保留当前实例及已有资源。',
        unexpected: '当前安装步骤未能完成。请使用下方诊断码检查 Worker 安装日志，并参照部署与恢复说明处理，保留已有实例和资源。',
        login: '前往登录', again: '请求安装链接',
    },
};

const issueMessages: Record<string, keyof typeof copy.en> = {
    DNS_CONFLICT: 'conflict', EMAIL_DNS_PENDING: 'pending', INVALID_OR_EXPIRED_LINK: 'invalid', INVALID_INPUT: 'input',
    EMAIL_DELIVERY_FAILED: 'delivery', INSTALLATION_UNAVAILABLE: 'unavailable',
    CLOUDFLARE_PERMISSION_DENIED: 'permission', USER_API_TOKEN_REQUIRED: 'userToken', INVALID_CLOUDFLARE_TOKEN: 'invalidToken',
    CLOUDFLARE_RATE_LIMITED: 'limited', CLOUDFLARE_RESULT_UNCERTAIN: 'uncertain',
    CLOUDFLARE_INVALID_RESPONSE: 'uncertain', CLOUDFLARE_RESPONSE_TOO_LARGE: 'uncertain', CLOUDFLARE_REDIRECT_REJECTED: 'uncertain',
    CLOUDFLARE_REQUEST_FAILED: 'requestFailed', INVALID_LOGIN_DOMAIN: 'invalidDomain', INVALID_ADMIN_EMAIL: 'invalidEmail',
    DEPLOYMENT_INPUTS_REQUIRED: 'missing', DEPLOYMENT_TOKEN_REQUIRED: 'missing',
    DEPLOYMENT_IDENTITY_MISSING: 'identity', DEPLOYMENT_IDENTITY_MISMATCH: 'identity', ACTIVE_ZONE_NOT_FOUND: 'zone',
    LOGIN_DOMAIN_RESERVED: 'reservedDomain', DOMAIN_CONFLICT: 'domainConflict', EMAIL_DNS_NOT_READY: 'emailDns',
    PRIVATE_STORAGE_REQUIRED: 'storage', PRIVATE_STORAGE_ALREADY_INITIALIZED: 'initializedStorage', EMPTY_DATABASE_REQUIRED: 'database',
    INSTANCE_KEYS_MISSING: 'keys', INSTANCE_KEYS_MISMATCH: 'keys', TURNSTILE_RESOURCE_CONFLICT: 'widget', TURNSTILE_SECRET_UNAVAILABLE: 'widget',
};

// Keep the proof in this tab's memory only. Removing the fragment also keeps
// it out of copied addresses after the administrator opens the page.
const initialToken = /^#[0-9a-f]{64}$/.test(location.hash) ? location.hash.slice(1) : '';
if (location.hash) history.replaceState(null, '', location.pathname);

async function post(action: string, input: object) {
    const response = await fetch(`/api/setup/${action}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const result = await response.json() as { code?: string };
    if (!response.ok) throw new Error(result.code ?? 'INSTALLATION_UNAVAILABLE');
}

export default function Setup() {
    const chinese = location.pathname.startsWith('/zh-cn/') || (!location.pathname.startsWith('/en-us/') && navigator.language.startsWith('zh'));
    const text = copy[chinese ? 'zh' : 'en'], locale = chinese ? 'zh-CN' : 'en-US';
    const [status, setStatus] = useState<Status>();
    useEffect(() => {
        if (status) document.title = status.branding.name;
    }, [status?.branding.name]);
    const [token, setToken] = useState(initialToken);
    const [error, setError] = useState('');
    const [progressError, setProgressError] = useState('');
    const [sent, setSent] = useState(false);
    const [complete, setComplete] = useState(false);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let stopped = false, timer: ReturnType<typeof setTimeout>;
        const refresh = async () => {
            try {
                const response = await fetch('/api/setup/status');
                if (!response.ok) throw new Error();
                const value = await response.json() as Status;
                if (stopped) return;
                setStatus(value);
                setProgressError('');
                if (value.step === 'ready') return;
                if (value.canStart) {
                    try { await post('start', {}); }
                    catch (reason) { if (!stopped) setProgressError(reason instanceof Error ? reason.message : 'INSTALLATION_UNAVAILABLE'); }
                }
            } catch { if (!stopped) setProgressError('INSTALLATION_UNAVAILABLE'); }
            if (!stopped) timer = setTimeout(() => void refresh(), 3000);
        };
        void refresh();
        return () => { stopped = true; clearTimeout(timer); };
    }, []);
    const submit = async (event?: FormEvent<HTMLFormElement>) => {
        event?.preventDefault();
        const fields = event ? new FormData(event.currentTarget) : null;
        setError(''); setBusy(true);
        try {
            if (fields) {
                await post('claim', { token, username: fields.get('username'), password: fields.get('password'), locale });
                setToken(''); setComplete(true);
            } else {
                await post('invite', { locale });
                setSent(true);
            }
        } catch (reason) { setError(reason instanceof Error ? reason.message : 'INSTALLATION_UNAVAILABLE'); }
        finally { setBusy(false); }
    };
    const issue = error || progressError || status?.error;
    const detail = !error && !progressError ? status?.detail : undefined;
    const readable = issue ? text[Object.hasOwn(issueMessages, issue) ? issueMessages[issue] : 'unexpected'] : undefined;
    const needsInputs = status?.step !== 'ready' && status && (!status.canStart || ['DEPLOYMENT_INPUTS_REQUIRED', 'DEPLOYMENT_TOKEN_REQUIRED'].includes(issue ?? ''));
    return <main className="setup-shell">
        <header className="setup-brand"><img src={status?.branding.logoUrl ?? '/favicon.svg'} alt="" /> {status?.branding.name ?? defaultBranding.name}</header>
        <section className="setup-card">
            <h1>{status?.canonical && status.step === 'ready' && !complete && !status.completed ? text.inviteTitle : text.title}</h1>
            {status && status.step !== 'ready' && <p role="status">{text.currentStep}: {text[status.step]}</p>}
            {issue && <div className="setup-notice" role={issue === 'EMAIL_DNS_PENDING' ? 'status' : 'alert'}><p>{readable}</p>{detail && <p><code>{detail}</code></p>}<small>{text.diagnostic}: <code>{issue}</code></small></div>}
            {needsInputs && <>{readable !== text.missing && <p>{text.missing}</p>}<ul className="setup-inputs"><li><code>SETUP_ORIGIN</code> — {text.originHint}</li><li><code>SETUP_ADMIN_EMAIL</code> — {text.emailHint}</li><li><code>CF_SETUP_TOKEN</code> — {text.tokenHint}</li></ul></>}
            {complete || status?.completed ? <><p>{text.complete}</p><a href={status?.publicUrl ?? '/'}>{text.login}</a></>
                : status?.step !== 'ready' ? <>
                    <p>{text.progress}</p>
                </> : !status.canonical ? <a href={`${status.publicUrl}/setup`}>{text.open}</a>
                : token ? <form onSubmit={(event) => void submit(event)}>
                    <label>{text.username}<input name="username" autoComplete="username" pattern="[a-zA-Z0-9_.]{3,30}" required /></label>
                    <label>{text.password}<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required /></label>
                    <button disabled={busy}>{text.create}</button>
                    {issue === 'INVALID_OR_EXPIRED_LINK' && <button type="button" onClick={() => { setToken(''); setError(''); }}>{text.again}</button>}
                </form> : <>
                    <p>{text.inviteHelp}</p>
                    {sent ? <p role="status">{text.sent}</p> : <button disabled={busy} onClick={() => void submit()}>{text.invite}</button>}
                </>}
            <a href={`https://github.com/CQMHV/loginflare/blob/main/docs/deployment${chinese ? '.zh-CN' : ''}.md`} target="_blank" rel="noreferrer">{text.docs}</a>
        </section>
    </main>;
}
