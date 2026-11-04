import { expect, it } from 'vitest';
import { managementOpenApi } from '../src/server/management-openapi';
import { accessManagement } from '../src/server/access-management';
import { managementApi } from '../src/server/management-api';
import { managementScopes } from '../src/shared/machines';

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

it('documents every concrete access-management and versioned API method', () => {
    for (const route of [...accessManagement.routes, ...managementApi.routes].filter((route) => route.method !== 'ALL')) {
        const path = route.path.replace(/:([A-Za-z]+)/g, '{$1}').replace(/\/$/, '');
        expect(managementOpenApi.paths[path]?.[route.method.toLowerCase()], `${route.method} ${path}`).toBeDefined();
    }
});

it('assigns exactly one known machine scope to each protected operation and documents error behavior', () => {
    for (const [path, methods] of Object.entries(managementOpenApi.paths)) for (const [method, raw] of Object.entries(methods)) {
        expect(record(raw)).toBe(true);
        if (!record(raw)) continue;
        if (path === '/openapi.json') { expect(raw.security).toEqual([]); continue; }
        expect(Array.isArray(raw.security)).toBe(true);
        const security = raw.security as Array<{ machineOAuth: string[] }>;
        expect(security).toHaveLength(1); expect(security[0].machineOAuth).toHaveLength(1);
        expect([...managementScopes]).toContain(security[0].machineOAuth[0]);
        expect(record(raw.responses)).toBe(true);
        for (const code of ['400', '401', '403', '429']) expect(Object.hasOwn(raw.responses as object, code), `${method} ${path} ${code}`).toBe(true);
        const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
        const parameters = raw.parameters as Array<{ name: string; in: string; required?: boolean }>;
        for (const name of names) expect(parameters).toContainEqual(expect.objectContaining({ name, in: 'path', required: true }));
    }
});

it('exposes a versioned public contract without machine-authority or administrator mutation paths', () => {
    expect(managementOpenApi.openapi).toBe('3.1.0');
    expect(managementOpenApi.servers).toEqual([{ url: '/api/management/v1' }]);
    expect(Object.keys(managementOpenApi.paths).some((path) => /machine|admin|set-password|set-role/.test(path))).toBe(false);
    expect(managementOpenApi.components.schemas.CreateApplication.properties).toMatchObject({ type: { enum: ['web', 'spa'] } });
    const userPatch = managementOpenApi.paths['/users/{userId}'].patch as { requestBody: { content: { 'application/json': { schema: { properties: object; additionalProperties: boolean } } } } };
    expect(Object.keys(userPatch.requestBody.content['application/json'].schema.properties).sort()).toEqual(['banned', 'name']);
    expect(userPatch.requestBody.content['application/json'].schema.additionalProperties).toBe(false);
    const serialized = JSON.stringify(managementOpenApi);
    expect(serialized).not.toContain('BETTER_AUTH_SECRET'); expect(serialized).not.toContain('MACHINE_CLIENT_SECRET');
});
