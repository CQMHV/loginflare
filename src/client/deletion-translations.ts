export const deletionEn = {
    title: 'Delete account', description: 'Permanently delete your account and every application you own.',
    confirm: 'Request permanent deletion', warning: 'This cannot be undone. Your account and the listed applications stop working immediately. Background cleanup removes their data and authorizations.',
    applications: 'Applications that will be deleted', none: 'You do not own any applications.',
    acknowledge: 'I understand that my account and all applications listed above will be permanently deleted.',
    impact: 'Deleting an application also removes every user’s authorization for it. Other people’s accounts and other applications remain available.',
    retention: 'Security audit records remain for 90 days. Existing application sessions and offline-verified tokens follow each application’s policy. Cached profile photos can remain visible for up to five minutes after object removal.',
    receipt: 'Account deletion requested', receiptDescription: 'Your account and its applications are now unavailable. Cleanup continues in the background and retries after interruptions. This request cannot be cancelled.',
};
export const deletionZh: typeof deletionEn = {
    title: '注销账号', description: '永久删除账号及你拥有的全部应用。',
    confirm: '确认永久注销', warning: '此操作不可撤销。账号及下列应用将立即停止使用，后台任务继续清理其数据与授权。',
    applications: '将被删除的应用', none: '你目前没有自己创建的应用。',
    acknowledge: '我理解账号及上面列出的全部应用都将被永久删除。',
    impact: '删除应用也会删除所有用户对该应用的授权，其他人的账号及其他应用保持可用。',
    retention: '安全审计记录保留 90 天。业务应用自己的会话及离线验证的令牌遵循各应用策略。头像对象删除后，已缓存图片最多仍可显示五分钟。',
    receipt: '已提交账号注销', receiptDescription: '账号及名下应用已停止使用。后台继续清理数据，中断后会重试。注销请求不可取消。',
};
export const deletionErrorsEn = {
    ACCOUNT_DELETION_FORBIDDEN: 'This account cannot use self-service deletion.',
    ACCOUNT_DELETION_DEPENDENCY: 'An instance-managed application still references this account. Ask the instance operator to resolve it before deletion.',
    ACCOUNT_DELETION_PREVIEW_CHANGED: 'Your applications or security state changed. Review the updated list and confirm again.',
    ACCOUNT_DELETION_PREVIEW_EXPIRED: 'The confirmation expired or belongs to another session. Review the list and confirm again.',
    ACCOUNT_DELETION_MFA_REQUIRED: 'Enter your current six-digit authenticator code.',
    ACCOUNT_DELETION_PENDING: 'This account or application is being permanently deleted.',
};
export const deletionErrorsZh: typeof deletionErrorsEn = {
    ACCOUNT_DELETION_FORBIDDEN: '此账号不支持自助注销。',
    ACCOUNT_DELETION_DEPENDENCY: '仍有实例管理的应用引用此账号，请联系实例运营者处理后再注销。',
    ACCOUNT_DELETION_PREVIEW_CHANGED: '应用清单或安全状态已变化，请重新核对清单并确认。',
    ACCOUNT_DELETION_PREVIEW_EXPIRED: '确认已过期或属于其他会话，请重新核对清单并确认。',
    ACCOUNT_DELETION_MFA_REQUIRED: '请输入当前的六位身份验证器代码。',
    ACCOUNT_DELETION_PENDING: '此账号或应用正在被永久删除。',
};
