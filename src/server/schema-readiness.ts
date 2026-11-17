declare const __LOGINFLARE_MIGRATIONS__: { name: string; digest: string }[];
export const requiredMigrations = __LOGINFLARE_MIGRATIONS__;

const cache = new WeakMap<D1Database, Map<string, { until: number; value: Promise<void> }>>();

/** Only completed managed instances call this; installation and liveness stay available. */
export async function requireSchema(db: D1Database, instance: string, fresh = false): Promise<void> {
    let instances = cache.get(db);
    if (!instances) { instances = new Map(); cache.set(db, instances); }
    const current = instances.get(instance);
    if (!fresh && current && current.until > Date.now()) return current.value;
    const value = (async () => {
        const ledger = (await db.prepare('SELECT name, digest FROM lfReleaseMigration ORDER BY name').all<{ name: string; digest: string }>()).results;
        const applied = new Map(ledger.map(({ name, digest }) => [name, digest]));
        if (requiredMigrations.some(({ name, digest }) => applied.get(name) !== digest)) throw new Error('SCHEMA_UPGRADE_REQUIRED');
    })();
    const entry = { until: Date.now() + 30_000, value };
    // A binding can outlive a repaired installation; retain only the latest identity.
    instances.clear(); instances.set(instance, entry);
    try { await value; }
    catch (error) {
        if (instances.get(instance) === entry) instances.delete(instance);
        throw error;
    }
}
