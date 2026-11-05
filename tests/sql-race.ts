/** Inject at the actual SQL boundary, including statements executed inside a
 * maintenance-fenced batch. Tracking bind() preserves the original SQL label. */
export function interceptSql(database: D1Database, pattern: RegExp, mutation: () => Promise<unknown>, after = false) {
    let invoked = false;
    const sources = new WeakMap<D1PreparedStatement, string>();
    const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
    const invoke = async () => {
        if (!invoked) { invoked = true; await mutation(); }
    };
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
        const wrapped = new Proxy(statement, { get(target, property) {
            if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
            const value = Reflect.get(target, property, target);
            if (typeof value === 'function' && ['all', 'run', 'first', 'raw'].includes(String(property))) return async (...args: unknown[]) => {
                const matches = pattern.test(sql);
                if (matches && !after) await invoke();
                const result: unknown = await Reflect.apply(value, target, args);
                if (matches && after) await invoke();
                return result;
            };
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        sources.set(wrapped, sql);
        sources.set(statement, sql);
        originals.set(wrapped, statement);
        return wrapped;
    };
    const proxy = new Proxy(database, { get(target, property) {
        if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
        if (property === 'batch') return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
            const matches = statements.some((statement) => pattern.test(sources.get(statement) ?? ''));
            if (matches && !after) await invoke();
            const result = await target.batch<T>(statements.map((statement) => originals.get(statement) ?? statement));
            if (matches && after) await invoke();
            return result;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { proxy, invoked: () => invoked };
}
