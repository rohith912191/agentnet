// Database access for PostgresRepository: one small interface over either a node-postgres pool
// (a PostgreSQL server; production, and the Docker-based integration tests) or a PGlite engine
// (the PostgreSQL engine compiled to WebAssembly; used to exercise the same SQL in tests when no
// server is available). Both give real PostgreSQL semantics: SQL, constraints, pgvector, locks.
//
//   db.query(text, params)  -> { rows, rowCount }
//   db.transaction(fn)      -> fn({ query, exec }) inside BEGIN/COMMIT, rolled back if fn throws
//                              (exec runs a multi-statement script, e.g. a migration)
//   db.close()
//
// `schema` isolates a repository in its own PostgreSQL schema (tests run many in one database).

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function checkSchema(schema) {
  if (schema && !SCHEMA_NAME.test(schema)) throw new Error(`invalid schema name: ${schema}`);
  return schema;
}

const normalize = (r) => ({ rows: r.rows, rowCount: r.rowCount ?? r.affectedRows ?? r.rows.length });

/** A PostgreSQL server through node-postgres. */
export async function connectPg({ url, schema, max = 10, statementTimeoutMs = 15_000, applicationName = 'agentnet' }) {
  const { default: pg } = await import('pg');
  checkSchema(schema);
  const options = [`-c TimeZone=UTC`, `-c statement_timeout=${statementTimeoutMs}`];
  if (schema) options.push(`-c search_path=${schema},public`);
  const pool = new pg.Pool({
    connectionString: url,
    max,
    application_name: applicationName,
    options: options.join(' '),
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  pool.on('error', () => {}); // idle-client errors surface on the next query instead of crashing
  return {
    kind: 'postgres',
    pool,
    async query(text, params) {
      return normalize(await pool.query(text, params));
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: async (text, params) => normalize(await client.query(text, params)),
          exec: async (script) => void (await client.query(script)), // simple protocol: multi-statement
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** A PGlite engine (single connection; PGlite serialises queries and transactions). */
export function pgliteDb(engine, { schema } = {}) {
  checkSchema(schema);
  const scope = schema ? `SET LOCAL search_path TO ${schema}, public` : null;
  const wrap = (tx) => ({
    query: async (text, params) => normalize(await tx.query(text, params)),
    exec: async (script) => void (await tx.exec(script)),
  });
  return {
    kind: 'pglite',
    engine,
    async query(text, params) {
      if (!scope) return normalize(await engine.query(text, params));
      // Several repositories share one engine: scope every statement to this one's schema.
      return engine.transaction(async (tx) => {
        await tx.query(scope);
        return normalize(await tx.query(text, params));
      });
    },
    transaction(fn) {
      return engine.transaction(async (tx) => {
        if (scope) await tx.query(scope);
        return fn(wrap(tx));
      });
    },
    async close() {},
  };
}

/** Creates a PGlite engine with pgvector (dev dependency; used by tests and local experiments). */
export async function createPgliteEngine() {
  const [{ PGlite }, { vector }] = await Promise.all([import('@electric-sql/pglite'), import('@electric-sql/pglite-pgvector')]);
  return PGlite.create({ extensions: { vector } });
}
