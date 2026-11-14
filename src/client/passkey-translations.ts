export const passkeysEn = {
    title: 'Passkeys', description: 'Sign in using your device or security key. Enabled TOTP is still required after passkey sign-in.',
    add: 'Add passkey', rename: 'Rename passkey', remove: 'Delete passkey', signIn: 'Sign in with a passkey', name: 'Passkey name',
    none: 'No passkeys registered.', unnamed: 'Passkey', unsupported: 'Passkeys need a supported browser and a secure connection.',
    deleteWarning: 'This removes the passkey from Loginflare. You may also remove its saved copy from your password manager. Keep another way to sign in.',
    limit: 'You can register up to 20 passkeys. Adding or managing one requires your current password or a linked provider.',
};
export const passkeysZh = {
    title: '通行密钥', description: '使用设备或安全密钥登录。已开启 TOTP 时，通行密钥登录后仍须验证动态码。',
    add: '添加通行密钥', rename: '重命名通行密钥', remove: '删除通行密钥', signIn: '使用通行密钥登录', name: '通行密钥名称',
    none: '尚未登记通行密钥。', unnamed: '通行密钥', unsupported: '通行密钥需要受支持的浏览器及安全连接。',
    deleteWarning: '此操作从 Loginflare 删除通行密钥，你还可在密码管理器中移除保存的副本。请保留其他可用登录方式。',
    limit: '最多登记 20 个通行密钥。添加或管理时需确认当前密码，或通过已绑定提供方再次认证。',
};
export const passkeyErrorsEn = {
    PASSKEY_ALREADY_REGISTERED: 'This authenticator already has a passkey for this account. Use another authenticator.',
    PASSKEY_NOT_AVAILABLE: 'The passkey or account is unavailable. Reauthenticate and try again.',
    PASSKEY_DELETE_REJECTED: 'Cannot delete this passkey. Check that it belongs to this account and another sign-in method remains.',
    PASSKEY_USER_VERIFICATION_REQUIRED: 'Unlock your device or security key to continue.',
    PASSKEY_CANCELLED: 'The passkey operation was cancelled or timed out.',
    PASSKEY_UNSUPPORTED: 'Passkeys are unavailable in this browser or connection.',
    CHALLENGE_NOT_FOUND: 'The passkey challenge expired or was already used. Start again.',
    FAILED_TO_VERIFY_REGISTRATION: 'Could not register this passkey. Start again.',
    AUTHENTICATION_FAILED: 'Could not verify this passkey. Try another sign-in method.',
    PASSKEY_NOT_FOUND: 'This passkey is no longer registered.',
};
export const passkeyErrorsZh = {
    PASSKEY_ALREADY_REGISTERED: '此认证器已登记当前账号的通行密钥，请使用其他认证器。',
    PASSKEY_NOT_AVAILABLE: '通行密钥或账号不可用，请重新认证后再试。',
    PASSKEY_DELETE_REJECTED: '无法删除该通行密钥，请确认其属于当前账号且仍有其他可用登录方式。',
    PASSKEY_USER_VERIFICATION_REQUIRED: '请解锁设备或安全密钥后继续。',
    PASSKEY_CANCELLED: '通行密钥操作已取消或超时。',
    PASSKEY_UNSUPPORTED: '当前浏览器或连接不支持通行密钥。',
    CHALLENGE_NOT_FOUND: '通行密钥验证已过期或已使用，请重新开始。',
    FAILED_TO_VERIFY_REGISTRATION: '无法登记通行密钥，请重新开始。',
    AUTHENTICATION_FAILED: '无法验证通行密钥，请使用其他登录方式。',
    PASSKEY_NOT_FOUND: '此通行密钥已被移除。',
};
