// Repositories for tests. AGENTNET_TEST_REPO selects what the behaviour suites run against:
//   memory    the in-memory reference repository (default)
//   pglite    the PostgreSQL engine (WASM build, with pgvector), embedded in the test process
//   postgres  a PostgreSQL server at AGENTNET_TEST_DATABASE_URL (docker compose up -d postgres)
// Every repository gets its own freshly migrated schema, so tests never share state.

import { randomBytes } from 'node:crypto';
import { MemoryRepository } from '../../src/repo/memory.js';

export const DEFAULT_TEST_DATABASE_URL = 'postgres://agentnet:agentnet@localhost:5432/agentnet';
export const testDatabaseUrl = () => process.env.AGENTNET_TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;

const schemaName = () => `t_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;

let enginePromise = null;
/** One PGlite engine per test process (it takes seconds to boot); repositories use schemas in it. */
export function sharedPglite() {
  enginePromise ??= import('../../src/repo/db.js').then(({ createPgliteEngine }) => createPgliteEngine());
  return enginePromise;
}

const opened = [];

export async function openTestRepository(kind = process.env.AGENTNET_TEST_REPO || 'memory') {
  if (kind === 'memory') return new MemoryRepository();
  const { PostgresRepository } = await import('../../src/repo/postgres.js');
  const schema = schemaName();
  if (kind === 'pglite') return PostgresRepository.onPglite(await sharedPglite(), { schema });
  if (kind === 'postgres') {
    const repo = await PostgresRepository.connect({ url: testDatabaseUrl(), schema, max: 4 });
    opened.push(repo);
    return repo;
  }
  throw new Error(`unknown AGENTNET_TEST_REPO: ${kind}`);
}

/** Drops the schemas this process created on the server and closes their pools. */
export async function closeTestRepositories() {
  const repos = opened.splice(0);
  for (const repo of repos) {
    try {
      await repo.db.query(`DROP SCHEMA IF EXISTS ${repo.schema} CASCADE`);
    } catch {
      // the server may be gone; schemas are prefixed t_ and can be dropped later
    }
    await repo.close().catch(() => {});
  }
}

/** Is a PostgreSQL server reachable at the test URL? (Used to skip server-only tests.) */
export async function postgresAvailable() {
  try {
    const { connectPg } = await import('../../src/repo/db.js');
    const db = await connectPg({ url: testDatabaseUrl(), max: 1 });
    try {
      await db.query('SELECT 1');
      return true;
    } finally {
      await db.close();
    }
  } catch {
    return false;
  }
}
