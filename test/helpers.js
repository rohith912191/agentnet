import { after } from 'node:test';
import { createPlatform } from '../src/platform.js';
import { closeTestRepositories, openTestRepository } from './support/repositories.js';
import { deepMerge, seededRandom } from '../src/util.js';
import { PERSONAS } from '../demo/personas.js';

export const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
export const TEST_ADMIN_KEY = 'test-admin-key-0123456789abcdef';

// Defaults are production-safe, so tests opt in to the development conveniences they rely on.
export const DEV_CONFIG = { devAutoVerify: true, adminKey: TEST_ADMIN_KEY, routing: { explorationRate: 0 } };

// The repository the behaviour tests run against: in-memory by default; AGENTNET_TEST_REPO=pglite
// or =postgres runs the same tests on PostgreSQL, each platform in a fresh, migrated schema
// (see test/support/repositories.js and scripts/test.mjs).
const REPO_KIND = process.env.AGENTNET_TEST_REPO || 'memory';
let repoFactory = REPO_KIND === 'memory' ? null : () => openTestRepository(REPO_KIND);
if (REPO_KIND === 'postgres') after(closeTestRepositories);

export function useRepositoryFactory(factory) {
  repoFactory = factory;
}

/**
 * Creates a platform for a test, on the configured repository. `dev: false` starts from the
 * production defaults instead of DEV_CONFIG (for tests of the defaults themselves).
 */
export async function makePlatform(overrides = {}, deps = {}, { dev = true } = {}) {
  const repo = deps.repo ?? (repoFactory ? await repoFactory() : undefined);
  const config = dev ? deepMerge(DEV_CONFIG, overrides) : overrides;
  return createPlatform(config, { llm: null, log: silentLog, rng: seededRandom(1), ...deps, ...(repo ? { repo } : {}) });
}

/** In-process platform with every demo persona registered and verified (no webhooks). */
export async function setup(overrides = {}, deps = {}) {
  const platform = await makePlatform(overrides, deps);
  const agents = {};
  for (const persona of PERSONAS) {
    const { agent } = await platform.registerAgent(persona.profile);
    await platform.verifyAgent(agent);
    agents[persona.key] = await platform.repo.getAgent(agent.id);
  }
  return { platform, agents };
}

/** Fresh copy of an agent's stored state. */
export const reload = (platform, agent) => platform.repo.getAgent(agent.id ?? agent);

export async function publishAndRoute(platform, author, post) {
  const { post: view } = await platform.publishPost(author, post);
  await platform.drain();
  return { post: view, routing: await platform.repo.getRoutingLog(view.id) };
}

export const tierOf = (routing, agent) => routing.decisions.find((d) => d.agent_id === agent.id)?.tier ?? 'not_candidate';
