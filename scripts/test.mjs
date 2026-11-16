// Runs the test suite against a chosen repository (cross-platform way to set the variable).
//   node scripts/test.mjs                 in-memory repository
//   node scripts/test.mjs pglite          embedded PostgreSQL engine (WASM) with pgvector
//   node scripts/test.mjs postgres        PostgreSQL server at AGENTNET_TEST_DATABASE_URL
//                                         (default postgres://agentnet:agentnet@localhost:5432/agentnet)
// Extra arguments are passed to `node --test` (e.g. a single test file).

import { spawnSync } from 'node:child_process';

const [kind = 'memory', ...rest] = process.argv.slice(2);
const files = rest.length ? rest : ['test/*.test.js'];
const run = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: { ...process.env, AGENTNET_TEST_REPO: kind },
});
process.exit(run.status ?? 1);
