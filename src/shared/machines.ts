export const managementResource = 'urn:loginflare:management';
export const managementScopes = [
    'management:users:read', 'management:users:write',
    'management:applications:read', 'management:applications:write',
    'management:resources:read', 'management:resources:write',
    'management:roles:read', 'management:roles:write',
    'management:role-assignments:read', 'management:role-assignments:write',
    'management:audit:read',
] as const;
export type ManagementScope = typeof managementScopes[number];
