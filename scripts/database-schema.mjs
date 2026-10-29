import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function expectedSchema(root) {
    const database = new DatabaseSync(':memory:');
    try {
        for (const file of readdirSync(resolve(root, 'migrations')).filter((file) => file.endsWith('.sql')).sort()) {
            database.exec(readFileSync(resolve(root, 'migrations', file), 'utf8'));
        }
        const objects = database.prepare("SELECT name, type, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
        const columns = objects.filter((object) => object.type === 'table').flatMap((object) =>
            database.prepare(`PRAGMA table_info("${object.name}")`).all().map((column) => ({ ...column, tableName: object.name })));
        return { objects, columns };
    } finally { database.close(); }
}

const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const canonicalSql = (sql) => (sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_]*|[0-9]+(?:\.[0-9]+)?|[^\s]/g) ?? [])
    .map((token) => token.startsWith("'") ? token : token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"').toLowerCase() : token.toLowerCase()).join(' ');

/** One-time data preparation; request code never supports two date encodings. */
export function prepareDatabase(root, query) {
    const tables = new Set(query("SELECT name FROM sqlite_schema WHERE type = 'table'").map((row) => row.name));
    if (tables.has('oauthClient')) {
        let position = '';
        while (true) {
            const clients = query(`SELECT id, "redirectUris", metadata FROM "oauthClient" WHERE id > ${quote(position)} ORDER BY id LIMIT 50`);
            if (!clients.length) break;
            for (const client of clients) {
                const redirects = JSON.parse(client.redirectUris);
                const origins = [...new Set(redirects.map((uri) => {
                    const url = new URL(uri);
                    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid stored OAuth callback. Resolve it before migrating.');
                    return url.origin;
                }))];
                const metadata = JSON.parse(client.metadata ?? '{}');
                if (JSON.stringify(metadata.loginflareRedirectOrigins) !== JSON.stringify(origins)) {
                    metadata.loginflareRedirectOrigins = origins;
                    const changed = query(`UPDATE "oauthClient" SET metadata = ${quote(JSON.stringify(metadata))} WHERE id = ${quote(client.id)}
                        AND "redirectUris" = ${quote(client.redirectUris)} AND coalesce(metadata, '') = ${quote(client.metadata ?? '')} RETURNING id`);
                    if (changed.length !== 1) throw new Error('An application changed during migration preparation. Stop application writes before retrying.');
                }
            }
            position = clients.at(-1).id;
        }
    }
    const schema = expectedSchema(root);
    for (const table of [...new Set(schema.columns.filter((column) => column.type.toLowerCase() === 'date').map((column) => column.tableName))]) {
        if (!tables.has(table)) continue;
        const fields = schema.columns.filter((column) => column.tableName === table && column.type.toLowerCase() === 'date').map((column) => column.name);
        const condition = fields.map((field) => `typeof("${field}") IN ('integer', 'real')`).join(' OR ');
        const updates = fields.map((field) => `"${field}" = CASE WHEN typeof("${field}") IN ('integer', 'real') THEN strftime('%Y-%m-%dT%H:%M:%fZ', "${field}" / 1000.0, 'unixepoch') ELSE "${field}" END`).join(', ');
        while (true) {
            const rows = query(`UPDATE "${table}" SET ${updates} WHERE id IN (SELECT id FROM "${table}" WHERE ${condition} LIMIT 500) RETURNING id`);
            if (rows.length < 500) break;
        }
    }
    if (tables.has('oauthClient')) {
        while (query(`UPDATE "oauthClient" SET "createdAt" = coalesce("updatedAt", '1970-01-01T00:00:00.000Z')
            WHERE id IN (SELECT id FROM "oauthClient" WHERE "createdAt" IS NULL LIMIT 500) RETURNING id`).length === 500) { /* bounded one-time preparation */ }
    }
}

export function checkDatabase(root, query) {
    const expected = expectedSchema(root);
    const objects = query("SELECT name, type, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'");
    for (const object of expected.objects) {
        const actual = objects.find((value) => value.name === object.name && value.type === object.type);
        if (!actual) throw new Error(`Missing database ${object.type}: ${object.name}`);
        if (canonicalSql(actual.sql) !== canonicalSql(object.sql)) {
            throw new Error(`Database ${object.type} differs from the committed migrations: ${object.name}`);
        }
    }
    for (const table of expected.objects.filter((object) => object.type === 'table')) {
        const actual = query(`PRAGMA table_info("${table.name}")`);
        for (const column of expected.columns.filter((column) => column.tableName === table.name)) {
            const found = actual.find((candidate) => candidate.name === column.name);
            if (!found || found.type.toLowerCase() !== column.type.toLowerCase() || found.notnull !== column.notnull || found.pk !== column.pk) {
                throw new Error(`Database column differs: ${table.name}.${column.name}`);
            }
        }
    }
    if (query('PRAGMA foreign_key_check').length) throw new Error('Database foreign-key validation failed.');
    const wrongDates = expected.columns.filter((column) => column.type.toLowerCase() === 'date').some((column) =>
        query(`SELECT 1 FROM "${column.tableName}" WHERE "${column.name}" IS NOT NULL AND (typeof("${column.name}") <> 'text'
            OR length("${column.name}") <> 24 OR strftime('%Y-%m-%dT%H:%M:%fZ', "${column.name}") IS NULL
            OR "${column.name}" <> strftime('%Y-%m-%dT%H:%M:%fZ', "${column.name}")) LIMIT 1`).length);
    if (wrongDates) throw new Error('Native database dates must be ISO UTC text. Run the migration preparation.');
    if (query('SELECT 1 FROM "oauthClient" WHERE "createdAt" IS NULL LIMIT 1').length) throw new Error('OAuth client creation dates are required for pagination.');
    let position = '';
    while (true) {
        const clients = query(`SELECT id, "redirectUris", metadata FROM "oauthClient" WHERE id > ${quote(position)} ORDER BY id LIMIT 50`);
        if (!clients.length) break;
        for (const client of clients) {
            const origins = [...new Set(JSON.parse(client.redirectUris).map((uri) => new URL(uri).origin))].sort();
            const registered = JSON.parse(client.metadata ?? '{}').loginflareRedirectOrigins ?? [];
            if (!Array.isArray(registered) || JSON.stringify([...new Set(registered)].sort()) !== JSON.stringify(origins)) throw new Error('OAuth callback Origin metadata is inconsistent. Stop application writes and repeat migration preparation.');
        }
        position = clients.at(-1).id;
    }
    const missingUri = query(`SELECT 1 FROM (
        SELECT c."clientId", 'redirect-origin' AS kind, j.value FROM "oauthClient" c, json_each(c.metadata, '$.loginflareRedirectOrigins') j
        UNION ALL SELECT c."clientId", 'post-logout-uri' AS kind, j.value FROM "oauthClient" c, json_each(c."postLogoutRedirectUris") j
    ) expected LEFT JOIN "oauthClientUri" actual ON actual."clientId" = expected."clientId" AND actual.kind = expected.kind AND actual.value = expected.value
        WHERE actual."clientId" IS NULL LIMIT 1`);
    const extraUri = query(`SELECT 1 FROM "oauthClientUri" r JOIN "oauthClient" c ON c."clientId" = r."clientId" WHERE
        (r.kind = 'redirect-origin' AND NOT EXISTS (SELECT 1 FROM json_each(c.metadata, '$.loginflareRedirectOrigins') j WHERE j.value = r.value))
        OR (r.kind = 'post-logout-uri' AND NOT EXISTS (SELECT 1 FROM json_each(c."postLogoutRedirectUris") j WHERE j.value = r.value)) LIMIT 1`);
    if (missingUri.length || extraUri.length) throw new Error('OAuth callback registry is inconsistent.');
    return { tables: expected.objects.filter((object) => object.type === 'table').length, indexes: expected.objects.filter((object) => object.type === 'index').length, triggers: expected.objects.filter((object) => object.type === 'trigger').length };
}
