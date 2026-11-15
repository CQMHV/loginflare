export const deletionEn = {
    title: 'Delete account', description: 'Permanently delete your account and every application you own.',
    confirm: 'Request permanent deletion', warning: 'This cannot be undone. Your account and the listed applications will stop working immediately. Their data and authorizations will then be deleted.',
    applications: 'Applications that will be deleted', none: 'You do not own any applications.',
    acknowledge: 'I understand that my account and all applications listed above will be permanently deleted.',
    impact: 'Deleting an application also removes every user’s authorization for it. Other people’s accounts and other applications remain available.',
    retention: 'For security purposes, activity records are kept for 90 days. When other applications sign you out depends on their settings. After your profile photo is deleted, cached copies may remain visible for up to five minutes.',
    receipt: 'Account deletion requested', receiptDescription: 'Your account and its applications are no longer available. Your data is being deleted; you can close this page. This request cannot be cancelled.',
};
export const deletionZh: typeof deletionEn = {
    title: '注销账号', description: '永久删除账号及你拥有的全部应用。',
    confirm: '确认永久注销', warning: '此操作不可撤销。账号及下列应用将立即停用，相关数据与授权会陆续删除。',
    applications: '将被删除的应用', none: '你目前没有自己创建的应用。',
    acknowledge: '我理解账号及上面列出的全部应用都将被永久删除。',
    impact: '删除应用也会删除所有用户对该应用的授权，其他人的账号及其他应用保持可用。',
    retention: '出于安全需要，相关操作记录将保留 90 天。其他应用何时退出登录，取决于各应用的设置。头像删除后，缓存图片最多仍可能显示五分钟。',
    receipt: '已提交账号注销', receiptDescription: '账号及名下应用已停用，相关数据正在删除，你可以关闭此页面。注销请求无法撤销。',
};
export const deletionErrorsEn = {
    ACCOUNT_DELETION_FORBIDDEN: 'This account cannot use self-service deletion.',
    ACCOUNT_DELETION_DEPENDENCY: 'An application managed by your administrator is still linked to this account. Contact your administrator before deleting your account.',
    ACCOUNT_DELETION_PREVIEW_CHANGED: 'Your applications or security state changed. Review the updated list and confirm again.',
    ACCOUNT_DELETION_PREVIEW_EXPIRED: 'Your confirmation is no longer valid. Review the list and confirm again.',
    ACCOUNT_DELETION_MFA_REQUIRED: 'Enter your current six-digit authenticator code.',
    ACCOUNT_DELETION_PENDING: 'This account or application is being permanently deleted.',
};
export const deletionErrorsZh: typeof deletionErrorsEn = {
    ACCOUNT_DELETION_FORBIDDEN: '此账号不支持自助注销。',
    ACCOUNT_DELETION_DEPENDENCY: '仍有由管理员管理的应用关联此账号，请联系管理员处理后再注销。',
    ACCOUNT_DELETION_PREVIEW_CHANGED: '应用清单或安全状态已变化，请重新核对清单并确认。',
    ACCOUNT_DELETION_PREVIEW_EXPIRED: '确认已失效，请重新查看应用清单并确认。',
    ACCOUNT_DELETION_MFA_REQUIRED: '请输入当前的六位身份验证器代码。',
    ACCOUNT_DELETION_PENDING: '此账号或应用正在被永久删除。',
};
