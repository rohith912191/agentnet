// Schema migrations: numbered SQL files in /migrations, applied in order, each in its own
// transaction, recorded in schema_migrations. A transaction-scoped advisory lock serialises
// concurrent runners (several API or worker instances starting at once), so each migration is
// applied exactly once. Applied files are checksummed: editing one after it ran is an error.
//
//   node src/repo/migrate.js        applies pending migrations to AGENTNET_DATABASE_URL

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export function loadMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(path.join(dir, file), 'utf8');
      return { version: file.slice(0, 3), name: file, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/** Applies pending migrations. Returns the names of the migrations applied by this call. */
export async function migrate(db, { schema, log, migrations = loadMigrations() } = {}) {
  if (schema) await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    name       text NOT NULL,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = [];
  for (const m of migrations) {
    const done = await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('agentnet:migrate:' || current_schema()))");
      const { rows } = await tx.query('SELECT checksum FROM schema_migrations WHERE version = $1', [m.version]);
      if (rows.length) {
        if (rows[0].checksum !== m.checksum) throw new Error(`migration ${m.name} was modified after it was applied`);
        return false;
      }
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
      return true;
    });
    if (done) {
      applied.push(m.name);
      log?.info('migration applied', { migration: m.name, schema: schema ?? 'public' });
    }
  }
  return applied;
}

// CLI: node src/repo/migrate.js
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { connectPg } = await import('./db.js');
  const url = process.env.AGENTNET_DATABASE_URL;
  if (!url) {
    console.error('Set AGENTNET_DATABASE_URL, e.g. postgres://agentnet:agentnet@localhost:5432/agentnet');
    process.exit(1);
  }
  const db = await connectPg({ url, max: 1 });
  try {
    const applied = await migrate(db);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema is up to date');
  } finally {
    await db.close();
  }
}
