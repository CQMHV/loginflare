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
        missing: 'Add the installation inputs under Worker secrets in Cloudflare.',
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
        login: 'Go to sign in', again: 'Request a setup link',
    },
    zh: {
        title: '安装登录服务', progress: 'Cloudflare 正在准备你的登录服务。',
        target: '检查 Cloudflare 部署', domain: '连接登录域名',
        sending: '配置邮件发送', turnstile: '准备安全设置', ready: '已就绪',
        missing: '请在 Cloudflare 的 Worker 机密中填写安装信息。',
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
        login: '前往登录', again: '请求安装链接',
    },
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
                if (value.step === 'ready') return;
                if (value.canStart) {
                    try { await post('start', {}); }
                    catch (reason) { if (!stopped) setError(reason instanceof Error ? reason.message : 'INSTALLATION_UNAVAILABLE'); }
                }
            } catch { if (!stopped) setError('INSTALLATION_UNAVAILABLE'); }
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
    const issue = error || status?.error;
    const detail = !error ? status?.detail : undefined;
    const readable = issue === 'DNS_CONFLICT' ? text.conflict : issue === 'EMAIL_DNS_PENDING' ? text.pending
        : issue === 'INVALID_OR_EXPIRED_LINK' ? text.invalid : issue === 'INVALID_INPUT' ? text.input
        : issue === 'EMAIL_DELIVERY_FAILED' ? text.delivery : issue === 'INSTALLATION_UNAVAILABLE' ? text.unavailable : issue;
    return <main className="setup-shell">
        <header className="setup-brand"><img src={status?.branding.logoUrl ?? '/favicon.svg'} alt="" /> {status?.branding.name ?? defaultBranding.name}</header>
        <section className="setup-card">
            <h1>{status?.canonical && status.step === 'ready' && !complete && !status.completed ? text.inviteTitle : text.title}</h1>
            {issue && <p className="setup-notice" role={issue === 'EMAIL_DNS_PENDING' ? 'status' : 'alert'}>{readable}{detail && <> <code>{detail}</code></>}</p>}
            {complete || status?.completed ? <><p>{text.complete}</p><a href={status?.publicUrl ?? '/'}>{text.login}</a></>
                : status?.step !== 'ready' ? <>
                    <p>{text.progress}</p>
                    {status && <p role="status">{text[status.step]}</p>}
                    {status && !status.canStart && <p>{text.missing}</p>}
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
        </section>
    </main>;
}
