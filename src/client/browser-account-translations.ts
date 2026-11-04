export const browserAccountsEn = {
    choose: 'Choose an account', description: 'Use an account to continue.', current: 'Current account', signedOut: 'Signed out',
    add: 'Add an account', useAnother: 'Use another account', signOut: 'Sign out', signOutAll: 'Sign out of all accounts',
    signOutAllConfirm: 'Sign out of all accounts in this browser?', remove: 'Remove from this list',
    empty: 'No accounts in this browser.', cancel: 'Cancel sign-in', limit: 'Up to {{count}} accounts can be signed in at once.',
    reauthenticate: 'Sign in again', accountLabel: 'Account: {{email}}',
};
export const browserAccountsZh: typeof browserAccountsEn = {
    choose: '选择账号', description: '选择一个账号继续。', current: '当前账号', signedOut: '已退出',
    add: '添加账号', useAnother: '使用其他账号', signOut: '退出此账号', signOutAll: '退出全部账号',
    signOutAllConfirm: '退出此浏览器中登录的全部账号？', remove: '从列表移除',
    empty: '此浏览器中没有账号。', cancel: '取消登录', limit: '最多可同时登录 {{count}} 个账号。',
    reauthenticate: '重新登录', accountLabel: '账号：{{email}}',
};
export const browserAccountErrorsEn = {
    BROWSER_ACCOUNT_LIMIT: 'Five accounts are already signed in. Sign out of an account before adding another.',
    BROWSER_ACCOUNT_UNAVAILABLE: 'This account is no longer signed in. Sign in again to continue.',
    BROWSER_FLOW_EXPIRED: 'This sign-in has expired. Start again.',
    BROWSER_ACCOUNT_STILL_ACTIVE: 'Sign out of this account before removing it from the list.',
    BROWSER_WRONG_ACCOUNT: 'Use the account you selected to sign in again.',
};
export const browserAccountErrorsZh: typeof browserAccountErrorsEn = {
    BROWSER_ACCOUNT_LIMIT: '已有五个账号登录，请先退出一个账号再添加。',
    BROWSER_ACCOUNT_UNAVAILABLE: '此账号的登录已失效，请重新登录。',
    BROWSER_FLOW_EXPIRED: '本次登录已过期，请重新发起。',
    BROWSER_ACCOUNT_STILL_ACTIVE: '请先退出此账号，再从列表移除。',
    BROWSER_WRONG_ACCOUNT: '请使用刚才选择的账号重新登录。',
};
