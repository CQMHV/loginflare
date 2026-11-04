import { managementResource, managementScopes, type ManagementScope } from '../shared/machines';

type Schema = Record<string, unknown>;
const text = (maximum = 255): Schema => ({ type: 'string', minLength: 1, maxLength: maximum });
const uuid: Schema = { type: 'string', format: 'uuid' };
const date: Schema = { type: 'string', format: 'date-time' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, Schema>, required: string[] = [], extra: Schema = {}): Schema => ({ type: 'object', properties, required, additionalProperties: false, ...extra });
const description: Schema = { type: 'string', maxLength: 1000 };
const pageInfo = object({ nextCursor: { type: ['string', 'null'], maxLength: 2048 }, previousCursor: { type: ['string', 'null'], maxLength: 2048 } }, ['nextCursor', 'previousCursor']);
const roleIds: Schema = { type: 'array', items: uuid, maxItems: 100, uniqueItems: true };
const scopes: Schema = { type: 'array', items: { enum: ['openid', 'profile', 'email', 'offline_access'] }, minItems: 1, maxItems: 4, uniqueItems: true, contains: { const: 'openid' } };
const redirectUris: Schema = { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048, description: 'Exact HTTPS URI, no fragment, wildcard, credentials or literal loopback host.' } };
const applicationProperties: Record<string, Schema> = {
    name: text(100), type: { enum: ['web', 'spa'] }, redirectUris, postLogoutRedirectUris: redirectUris, scopes,
};
const resourceProperties: Record<string, Schema> = {
    name: text(100), identifier: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048, description: 'Immutable exact API audience; no query, fragment or credentials. The system management resource is reserved.' },
    description, accessTokenTtl: { type: 'integer', minimum: 60, maximum: 3600, default: 300 },
};
const permissionProperties: Record<string, Schema> = {
    name: text(100), description, scope: { type: 'string', pattern: '^[a-z][a-z0-9:_./-]{0,99}$', description: 'Immutable instance-unique scope. Reserved identity and management scopes cannot be created here.' },
};
const responseSchema = (schema: Schema, message: string) => ({ description: message, content: { 'application/json': { schema } } });
const failure = (message: string) => responseSchema(ref('Error'), message);
const responses = {
    '400': failure('Invalid input, unknown fields, malformed/scope-bound cursor, or invalid field values. fieldErrors identifies submitted fields when available.'),
    '401': { ...failure('Missing, expired, revoked, wrong-audience or otherwise invalid machine access token.'), headers: { 'WWW-Authenticate': { schema: { type: 'string' }, example: 'Bearer error="invalid_token"' } } },
    '403': { ...failure('Missing endpoint scope, current permission loss, protected administrator, or forbidden system/machine administration.'), headers: { 'WWW-Authenticate': { schema: { type: 'string' }, example: 'Bearer error="insufficient_scope", scope="management:users:read"' } } },
    '404': failure('The specified user, login application, resource, permission, business role or audit record does not exist.'),
    '409': failure('The requested change conflicts with current state.'),
    '429': { ...failure('Rate limit reached.'), headers: { 'Retry-After': { schema: { type: 'integer', minimum: 1 } } } },
    '500': failure('The operation could not complete. Verify a write outcome before retrying.'),
    '503': failure('Authentication, database or audit infrastructure is unavailable; access is not granted.'),
};
function pagination(fields: string[] = []) {
    return [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        { name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 2048 }, description: 'Opaque signed cursor, bound to this machine, list and exact lookup. Do not construct or transfer it.' },
        ...(fields.length ? [
            { name: 'lookupField', in: 'query', schema: { type: 'string', enum: fields }, description: 'Use together with lookupValue for an exact lookup.' },
            { name: 'lookupValue', in: 'query', schema: text(254), description: 'Use together with lookupField. Substring filters are not supported.' },
        ] : []),
    ];
}
function operation(method: string, path: string, summary: string, tag: string, scope: ManagementScope, result: Schema, options: { body?: Schema; created?: boolean; lookup?: string[]; paginated?: boolean; detail?: string } = {}) {
    const { body, created, lookup, paginated, detail } = options;
    return {
        operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
        summary, ...(detail ? { description: detail } : {}), tags: [tag],
        security: [{ machineOAuth: [scope] }],
        parameters: [
            ...[...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({ name: match[1], in: 'path', required: true, schema: match[1] === 'id' ? uuid : text(255) })),
            ...(paginated ? pagination(lookup) : []),
        ],
        ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
        responses: { [created ? '201' : '200']: responseSchema(result, created ? 'Created. A client secret, if present, is returned only once.' : 'Successful operation.'), ...responses },
    };
}
const page = (name: string) => object({ items: { type: 'array', maxItems: 100, items: ref(name) }, pageInfo: ref('PageInfo') }, ['items', 'pageInfo'], { additionalProperties: true });
const paths: Record<string, Record<string, unknown>> = {};
function add(method: string, path: string, summary: string, tag: string, scope: ManagementScope, result: Schema, options: Parameters<typeof operation>[6] = {}) {
    (paths[path] ??= {})[method] = operation(method, path, summary, tag, scope, result, options);
}
const status = ref('Status');
add('get', '/users', 'List users', 'Users', 'management:users:read', page('User'), { paginated: true, lookup: ['id', 'username', 'email'] });
add('get', '/users/{userId}', 'Read a user', 'Users', 'management:users:read', ref('User'));
add('patch', '/users/{userId}', 'Update a user display name or suspension', 'Users', 'management:users:write', status, {
    body: object({ name: text(100), banned: { type: 'boolean' } }, [], { minProperties: 1 }),
    detail: 'Does not change native administrator roles, verification state, email, password, MFA or machine identities. Administrator accounts are protected from machine changes.',
});
add('post', '/users/{userId}/revoke-sessions', 'Revoke a user\'s sessions and grants', 'Users', 'management:users:write', status, { body: object({}), detail: 'The user must be eligible for this restricted management operation; no session credentials are returned.' });
add('get', '/applications', 'List login applications', 'Login applications', 'management:applications:read', page('Application'), { paginated: true, lookup: ['clientId', 'name'] });
add('post', '/applications', 'Create a login application', 'Login applications', 'management:applications:write', ref('CreatedApplication'), { body: ref('CreateApplication'), created: true, detail: 'Creates Web or SPA login clients, not machine clients. Persist a Web client\'s one-time secret in private application storage before continuing.' });
add('get', '/applications/{clientId}', 'Read a login application', 'Login applications', 'management:applications:read', ref('Application'));
add('patch', '/applications/{clientId}', 'Update a login application', 'Login applications', 'management:applications:write', status, { body: ref('UpdateApplication'), detail: 'Client type, ownership and machine credentials cannot be changed.' });
add('post', '/applications/{clientId}/rotate-secret', 'Rotate a login application secret', 'Login applications', 'management:applications:write', object({ clientSecret: text(1024) }, ['clientSecret']), { body: object({}), detail: 'The new secret is returned once; the previous secret becomes invalid. Machine client secrets require human administrator controls.' });
add('get', '/resources', 'List business API resources', 'API resources', 'management:resources:read', page('Resource'), { paginated: true, lookup: ['name', 'identifier'] });
add('post', '/resources', 'Create a business API resource', 'API resources', 'management:resources:write', ref('Resource'), { body: object(resourceProperties, ['name', 'identifier']), created: true });
add('get', '/resources/{id}', 'Read a business API resource and its permissions', 'API resources', 'management:resources:read', ref('ResourceDetail'));
add('patch', '/resources/{id}', 'Update a business API resource', 'API resources', 'management:resources:write', status, { body: object({ name: text(100), description, accessTokenTtl: resourceProperties.accessTokenTtl!, disabled: { type: 'boolean' } }) });
add('delete', '/resources/{id}', 'Delete a business API resource', 'API resources', 'management:resources:write', status);
add('get', '/permissions', 'List business permissions', 'API resources', 'management:resources:read', page('Permission'), { paginated: true, lookup: ['scope', 'name'] });
add('post', '/resources/{id}/permissions', 'Create a resource permission', 'API resources', 'management:resources:write', ref('Permission'), { body: object(permissionProperties, ['name', 'scope']), created: true });
add('patch', '/permissions/{id}', 'Update a permission name or description', 'API resources', 'management:resources:write', status, { body: object({ name: text(100), description }) });
add('delete', '/permissions/{id}', 'Delete a business permission', 'API resources', 'management:resources:write', status);
add('get', '/resources/{id}/applications', 'List applications allowed to request a resource', 'API resources', 'management:resources:read', page('LinkedApplication'), { paginated: true });
add('post', '/resources/{id}/applications', 'Link a login application to a resource', 'API resources', 'management:resources:write', status, { body: object({ clientId: text(255) }, ['clientId']), created: true, detail: 'Does not grant a user or machine role. The reserved management resource and machine authority cannot be changed here.' });
add('delete', '/resources/{id}/applications/{clientId}', 'Unlink an application from a resource', 'API resources', 'management:resources:write', status);
add('get', '/roles', 'List user business roles', 'Business roles', 'management:roles:read', page('Role'), { paginated: true, lookup: ['name'] });
add('post', '/roles', 'Create a user business role', 'Business roles', 'management:roles:write', ref('RoleDetail'), { body: object({ name: text(100), description, permissionIds: roleIds }, ['name']), created: true });
add('get', '/roles/{id}', 'Read a user business role and its permissions', 'Business roles', 'management:roles:read', ref('RoleDetail'));
add('patch', '/roles/{id}', 'Update a user business role', 'Business roles', 'management:roles:write', status, { body: object({ name: text(100), description, permissionIds: roleIds }) });
add('delete', '/roles/{id}', 'Delete a user business role', 'Business roles', 'management:roles:write', status);
add('get', '/users/{userId}/roles', 'Read a user\'s business roles', 'Role assignments', 'management:role-assignments:read', object({ roles: { type: 'array', maxItems: 100, items: ref('Role') } }, ['roles']));
add('put', '/users/{userId}/roles', 'Replace a user\'s business role assignments', 'Role assignments', 'management:role-assignments:write', status, { body: object({ roleIds }, ['roleIds']), detail: 'Replaces the complete business role set. Empty roleIds removes all business roles; native administrator privileges and machine roles are unaffected.' });
add('get', '/audit-logs', 'List audit events', 'Audit logs', 'management:audit:read', page('AuditEvent'), { paginated: true, lookup: ['event', 'outcome', 'actorUserId', 'actorClientId', 'targetUserId', 'clientId'] });
add('get', '/audit-logs/{id}', 'Read an audit event', 'Audit logs', 'management:audit:read', ref('AuditEvent'));
paths['/openapi.json'] = { get: { operationId: 'get_openapi', summary: 'Read the public management API contract', security: [], responses: { '200': responseSchema({ type: 'object' }, 'OpenAPI 3.1 document; contains no credentials or instance data.') } } };

/** Public, versioned contract. No instance secret, environment or user record is embedded. */
export const managementOpenApi = {
    openapi: '3.1.0',
    info: { title: 'Loginflare Management API', version: '1.0.0', description: 'Machine-authenticated management of users, login applications, business access control and audit records. Use client_credentials with the reserved management resource. Machine credentials, machine roles, administrator privileges and the system resource cannot be managed through this API.' },
    servers: [{ url: '/api/management/v1' }],
    paths,
    components: {
        securitySchemes: {
            machineOAuth: {
                type: 'oauth2', description: `Machine client credentials only. Request resource=${managementResource}. Browser sessions, user access tokens and ID Tokens are not accepted.`,
                'x-resource': managementResource,
                flows: { clientCredentials: { tokenUrl: '/api/auth/oauth2/token', scopes: Object.fromEntries(managementScopes.map((scope) => [scope, scope.replace(/^management:/, '').replaceAll(':', ' ')])) } },
            },
        },
        schemas: {
            Error: object({ code: text(100), error: text(100), fieldErrors: { type: 'object', additionalProperties: { type: 'string' } } }, [], { additionalProperties: true }),
            Status: object({ status: { const: true } }, ['status']), PageInfo: pageInfo,
            User: object({ id: text(), name: { type: 'string' }, username: { type: ['string', 'null'] }, email: { type: 'string', format: 'email' }, emailVerified: { type: 'boolean' }, role: { type: ['string', 'null'] }, banned: { type: 'boolean' }, image: { type: ['string', 'null'] }, locale: { type: 'string' }, createdAt: date }, ['id', 'name', 'email', 'emailVerified', 'banned', 'createdAt'], { additionalProperties: true }),
            CreateApplication: object(applicationProperties, Object.keys(applicationProperties)),
            UpdateApplication: object({ name: applicationProperties.name!, redirectUris, postLogoutRedirectUris: redirectUris, scopes, disabled: { type: 'boolean' } }, [], { minProperties: 1 }),
            Application: object({ clientId: text(), ...applicationProperties, disabled: { type: 'boolean' }, createdAt: date, ownerId: { type: ['string', 'null'] } }, ['clientId', 'name', 'type'], { additionalProperties: true }),
            CreatedApplication: { allOf: [ref('Application'), { type: 'object', properties: { clientSecret: { type: 'string', description: 'Returned once for Web applications. Absent for SPA applications.' } } }] },
            Resource: object({ id: uuid, ...resourceProperties, disabled: { type: 'boolean' }, createdAt: date }, ['id', 'name', 'identifier', 'disabled', 'accessTokenTtl', 'createdAt'], { additionalProperties: true }),
            ResourceDetail: { allOf: [ref('Resource'), { type: 'object', properties: { permissions: { type: 'array', maxItems: 100, items: ref('Permission') } }, required: ['permissions'] }] },
            Permission: object({ id: uuid, resourceId: uuid, ...permissionProperties, createdAt: date }, ['id', 'resourceId', 'name', 'scope', 'description', 'createdAt']),
            LinkedApplication: object({ clientId: text(), name: { type: 'string' }, createdAt: date }, ['clientId', 'name', 'createdAt']),
            Role: object({ id: uuid, name: text(100), description, createdAt: date }, ['id', 'name', 'description', 'createdAt'], { additionalProperties: true }),
            RoleDetail: { allOf: [ref('Role'), { type: 'object', properties: { permissionIds: roleIds, permissions: { type: 'array', maxItems: 100, items: ref('Permission') } } }] },
            AuditEvent: object({ id: uuid, event: text(100), outcome: { enum: ['success', 'failure'] }, actorUserId: { type: ['string', 'null'] }, actorClientId: { type: ['string', 'null'] }, targetUserId: { type: ['string', 'null'] }, clientId: { type: ['string', 'null'] }, targetType: { type: ['string', 'null'] }, targetId: { type: ['string', 'null'] }, reason: { type: ['string', 'null'] }, requestId: text(100), ipAddress: { type: ['string', 'null'] }, userAgent: { type: ['string', 'null'] }, createdAt: date }, ['id', 'event', 'outcome', 'requestId', 'createdAt'], { additionalProperties: true }),
        },
    },
};
