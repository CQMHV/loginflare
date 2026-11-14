import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { unstable_splitSqlQuery } from 'wrangler';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (value) => createHash('sha256').update(value).digest('hex');

function firstToken(sql) {
    let rest = sql.trimStart();
    while (rest.startsWith('--') || rest.startsWith('/*')) {
        if (rest.startsWith('--')) {
            const end = rest.indexOf('\n');
            rest = end === -1 ? '' : rest.slice(end + 1).trimStart();
        } else {
            const end = rest.indexOf('*/', 2);
            if (end === -1) throw new Error('Unterminated SQL comment.');
            rest = rest.slice(end + 2).trimStart();
        }
    }
    return rest.replace(/;\s*$/, '').trim();
}

/** Wrangler's SQLite-aware parser preserves complete CREATE TRIGGER statements. */
export function migrationStatements(source, name = 'migration') {
    let statements = unstable_splitSqlQuery(source).filter((sql) => firstToken(sql));
    const begins = /^BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?$/i;
    const commits = /^(?:COMMIT|END)(?:\s+TRANSACTION)?$/i;
    if (statements.length && begins.test(firstToken(statements[0]))) {
        if (!commits.test(firstToken(statements.at(-1)))) throw new Error(`${name}: unbalanced transaction wrapper.`);
        statements = statements.slice(1, -1);
    }
    for (const statement of statements) {
        const text = firstToken(statement);
        if (/^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(text)) {
            throw new Error(`${name}: nested or unsupported top-level transaction statement.`);
        }
        if (Buffer.byteLength(statement, 'utf8') > 100_000) throw new Error(`${name}: SQL statement exceeds D1's 100 KB limit.`);
        // Migration sources are self-contained SQL, never parameterized input.
        // Quoted strings/identifiers and comments are consumed as whole tokens.
        const tokens = statement.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[?:@$][A-Za-z0-9_]*/g) ?? [];
        if (tokens.some((token) => /^[?:@$]/.test(token))) throw new Error(`${name}: migration SQL cannot contain unbound parameters.`);
    }
    return statements;
}

export function buildMigrationBundle(root = projectRoot) {
    const database = new DatabaseSync(':memory:');
    try {
        const migrations = readdirSync(resolve(root, 'migrations')).filter((name) => /^\d+_.+\.sql$/.test(name)).sort().map((name) => {
            const source = readFileSync(resolve(root, 'migrations', name), 'utf8').replace(/\r\n/g, '\n');
            const statements = migrationStatements(source, name);
            try { database.exec(source); }
            catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }); }
            return { name, hash: hash(source), statements };
        });
        const objects = database.prepare("SELECT name, type, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
        const columns = objects.filter((object) => object.type === 'table').flatMap((object) =>
            database.prepare(`PRAGMA table_info("${object.name}")`).all().map((column) => ({ ...column, tableName: object.name })));
        const foreignKeys = objects.filter((object) => object.type === 'table').flatMap((object) =>
            database.prepare(`PRAGMA foreign_key_list("${object.name}")`).all().map((key) => ({ ...key, tableName: object.name })));
        return { format: 1, hash: hash(JSON.stringify(migrations.map(({ name, hash: digest }) => ({ name, hash: digest })))), migrations, objects, columns, foreignKeys };
    } finally { database.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const bundle = buildMigrationBundle();
    console.log(`Validated ${bundle.migrations.length} migrations (${bundle.hash.slice(0, 12)}).`);
}
