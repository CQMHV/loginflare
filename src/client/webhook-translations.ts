export const webhooksEn = {
    title: 'Webhooks', description: 'Send signed account events to your public HTTPS endpoint.', create: 'Create webhook', edit: 'Edit webhook', remove: 'Delete configuration', close: 'Close', actions: 'Actions',
    name: 'Webhook name', url: 'Destination URL', events: 'Events', enabled: 'Enabled', disabled: 'Disabled', save: 'Save webhook', records: 'Delivery records',
    policy: 'Changing the destination, events, enabled state or signing key cancels queued deliveries from the previous configuration. In-flight requests may finish.',
    secretTitle: 'Save the signing key', secret: 'Signing key', secretHint: 'This key is shown once. Store it securely in your receiver; it never belongs in browser code.', savedSecret: 'I have saved the signing key',
    rotate: 'Rotate signing key', rotateHint: 'Disable the subscription, rotate the key, update your receiver and enable it again. Redeliver retained events if needed.',
    deleteHint: 'Only disabled configurations without retained delivery records can be deleted.', empty: 'No webhooks configured.', noDeliveries: 'No delivery records.',
    eventId: 'Event ID', subscriptionId: 'Subscription ID', status: 'Status', type: 'Event type', attempts: 'Attempts', next: 'Next attempt', details: 'View details', retry: 'Redeliver event',
    retryHint: 'Send this same event ID using the current configuration. The receiver may have processed it already and must handle duplicates safely.',
    pending: 'Pending', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', uncertain: 'Uncertain', code: 'Result code', subject: 'Account ID', generation: 'Configuration generation',
    types: { user_created: 'Account created', email_verified: 'Email verified', user_updated: 'Profile updated', user_suspended: 'Account suspended', user_restored: 'Account restored', user_deleted: 'Account deleted' },
};
export const webhooksZh: typeof webhooksEn = {
    title: '业务事件通知', description: '向公开 HTTPS 接收地址发送签名的账号事件。', create: '创建 Webhook', edit: '编辑 Webhook', remove: '删除配置', close: '关闭', actions: '操作',
    name: 'Webhook 名称', url: '投递地址', events: '事件类型', enabled: '已启用', disabled: '已停用', save: '保存 Webhook', records: '投递记录',
    policy: '修改地址、事件类型、启用状态或签名密钥，会取消旧配置的待投递记录。已经发送的请求可能继续完成。',
    secretTitle: '保存签名密钥', secret: '签名密钥', secretHint: '密钥仅显示一次，请安全保存到接收端，不要放入浏览器代码。', savedSecret: '我已保存签名密钥',
    rotate: '轮换签名密钥', rotateHint: '请先停用订阅，轮换密钥并更新接收端，再重新启用；需要时重投保留期内的事件。',
    deleteHint: '仅可删除已停用且没有保留投递记录的配置。', empty: '尚未配置 Webhook。', noDeliveries: '暂无投递记录。',
    eventId: '事件 ID', subscriptionId: '订阅 ID', status: '状态', type: '事件类型', attempts: '尝试次数', next: '下次尝试', details: '查看详情', retry: '重投事件',
    retryHint: '使用当前配置重新投递同一事件 ID。接收方可能已经处理过，须安全地处理重复事件。',
    pending: '待投递', succeeded: '已成功', failed: '已失败', cancelled: '已取消', uncertain: '结果不明', code: '结果代码', subject: '账号 ID', generation: '配置代次',
    types: { user_created: '账号创建', email_verified: '邮箱验证', user_updated: '资料更新', user_suspended: '账号停用', user_restored: '账号恢复', user_deleted: '账号删除' },
};
export const webhookErrorsEn = { WEBHOOK_INVALID_TARGET: 'Use a public HTTPS destination. Private addresses, redirects and nonstandard ports are not allowed.', WEBHOOK_LIMIT_REACHED: 'At most 20 enabled webhooks and 100 configurations are allowed.', WEBHOOK_CHANGED: 'The configuration changed. Refresh and review it before trying again.', WEBHOOK_RETRY_REJECTED: 'Enable the subscription and refresh. Only retained, completed deliveries can be redelivered.', WEBHOOK_DELETE_REJECTED: 'Disable this configuration and wait until its retained deliveries expire before deleting it.' };
export const webhookErrorsZh = { WEBHOOK_INVALID_TARGET: '请使用公开 HTTPS 地址，不允许私网地址、重定向或非标准端口。', WEBHOOK_LIMIT_REACHED: '最多启用 20 个 Webhook，总配置最多 100 个。', WEBHOOK_CHANGED: '配置已变化，请刷新并核对后再试。', WEBHOOK_RETRY_REJECTED: '请先启用订阅并刷新，仅可重投保留期内已完成的记录。', WEBHOOK_DELETE_REJECTED: '请先停用配置，等待保留的投递记录过期后再删除。' };
