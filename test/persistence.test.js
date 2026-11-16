// Everything survives an application restart and a database restart: agent accounts (their API
// keys keep working), profiles, posts, comments, subscriptions, notifications and inboxes,
// acknowledgements, routing decisions, the learned model and per-agent affinity, dead letters,
// and open identity reviews. Runs on the PostgreSQL engine with an on-disk data directory, and on
// a PostgreSQL server when one is available.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatform } from '../src/platform.js';
import { POSTS, PERSONAS } from '../demo/personas.js';
import { DEV_CONFIG, silentLog } from './helpers.js';
import { postgresAvailable, testDatabaseUrl } from './support/repositories.js';
import { deepMerge, seededRandom } from '../src/util.js';

const hasPglite = await import('@electric-sql/pglite-pgvector').then(() => true, () => false);
const hasServer = await postgresAvailable();
const CONFIG = deepMerge(DEV_CONFIG, { allowInsecureWebhooks: true, delivery: { baseBackoffMs: 5, maxBackoffMs: 10 } });

function endpoints() {
  let gone = true; // Delhivery's endpoint answers 410 until it is fixed
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, id: JSON.parse(init.body).id });
    return new Response(url.includes('delhivery') && gone ? 'gone' : 'ok', { status: url.includes('delhivery') && gone ? 410 : 200 });
  };
  return { calls, fetch, fix: () => (gone = false) };
}

/** The observable state of the platform, through its own use cases. */
async function snapshot(platform, keys, postIds) {
  const out = { agents: {}, inboxes: {}, subscriptions: {}, routing: {}, comments: {} };
  for (const [name, key] of Object.entries(keys)) {
    const agent = await platform.authenticate(`Bearer ${key}`);
    out.agents[name] = await platform.viewSelf(agent);
    out.inboxes[name] = (await platform.inbox(agent, { limit: 100 })).notifications;
    out.subscriptions[name] = (await platform.listSubscriptions(agent)).subscriptions;
  }
  for (const id of postIds) {
    out.routing[id] = await platform.routingReport(id);
    out.comments[id] = (await platform.listComments(id)).comments;
  }
  out.model = await platform.learner.snapshot();
  out.affinity = await platform.learner.affinity(out.agents.hdfc.id, ['festive', 'promotion']);
  out.deadLetters = (await platform.deadLetters()).dead_letters;
  out.identityReviews = (await platform.identityReviewQueue()).reviews;
  out.feed = (await platform.listPosts({ limit: 50 }, { id: out.agents.swiggy.id })).posts;
  return out;
}

async function firstLife(platform) {
  const keys = {};
  for (const persona of PERSONAS) {
    const delivery = persona.key === 'delhivery' ? { webhook_url: 'http://agent.delhivery.example/hook' } : persona.key === 'phonepe' ? { webhook_url: 'http://agent.phonepe.example/hook' } : undefined;
    const { agent, credentials } = await platform.registerAgent({ ...persona.profile, ...(delivery ? { delivery } : {}) });
    await platform.verifyAgent(agent);
    keys[persona.key] = credentials.api_key;
  }
  const as = (name) => platform.authenticate(`Bearer ${keys[name]}`);
  await platform.subscribe(await as('makemytrip'), { kind: 'agent', target: (await as('swiggy')).id });
  const diwali = (await platform.publishPost(await as('swiggy'), POSTS.swiggyDiwali)).post;
  const sale = (await platform.publishPost(await as('flipkart'), POSTS.flipkartSale)).post; // Delhivery push -> 410 -> dead letter
  await platform.drain();
  await platform.addComment(await as('phonepe'), diwali.id, { body: 'PhonePe can add ₹50 cashback at checkout.' });
  const hdfcMatch = await platform.repo.matchFor(diwali.id, (await as('hdfc')).id);
  await platform.feedback(await as('hdfc'), hdfcMatch.id, { relevant: false, reason: 'not this quarter' });
  const phonepeItems = (await platform.inbox(await as('phonepe'))).notifications;
  await platform.ackMany(await as('phonepe'), { ids: phonepeItems.map((n) => n.id) });
  const { agent: lookalike, credentials } = await platform.registerAgent({ ...PERSONAS[1].profile, company: 'PhonePay', domain: 'phonepay.example' });
  await platform.verifyAgent(lookalike); // opens an identity review
  keys.phonepay = credentials.api_key;
  await platform.drain();
  return { keys, postIds: [diwali.id, sale.id] };
}

async function restartScenario(openRepo) {
  const hooks = endpoints();
  let { repo, close } = await openRepo();
  const life1 = createPlatform(CONFIG, { repo, llm: null, log: silentLog, rng: seededRandom(1), fetch: hooks.fetch });
  const { keys, postIds } = await firstLife(life1);
  const before = await snapshot(life1, keys, postIds);
  assert.equal(before.deadLetters.length, 1, 'setup: one dead letter');
  assert.equal(before.identityReviews.length, 1, 'setup: one open identity review');
  assert.ok(before.model.updates >= 2, 'setup: the model learned');
  await life1.shutdown();
  await close(); // the database stops too

  ({ repo, close } = await openRepo());
  const life2 = createPlatform(CONFIG, { repo, llm: null, log: silentLog, rng: seededRandom(1), fetch: hooks.fetch });
  try {
    const after = await snapshot(life2, keys, postIds);
    assert.deepEqual(after, before, 'identical state after the restart');

    // ...and the restarted platform keeps working on that state.
    await assert.rejects(life2.reroutePost(postIds[0]), { status: 409 }, 'a routed post is not routed again');
    hooks.fix();
    const redelivered = await life2.redeliverDeadLetters({});
    assert.deepEqual(redelivered, { requeued: 1, delivered_immediately: 1 });
    const swiggy = await life2.authenticate(`Bearer ${keys.swiggy}`);
    const { post } = await life2.publishPost(swiggy, POSTS.swiggyNavratri);
    await life2.drain();
    assert.equal((await life2.repo.getPost(post.id)).status, 'routed');
    assert.ok((await life2.repo.matchFor(post.id, after.agents.phonepe.id)), 'new posts are routed after the restart');
    await life2.shutdown();
  } finally {
    await close();
  }
}

test('application and database restart: all state survives and the platform carries on (PostgreSQL engine, on disk)', { skip: !hasPglite && 'PGlite not installed' }, async () => {
  const [{ PGlite }, { vector }, { PostgresRepository }] = await Promise.all([import('@electric-sql/pglite'), import('@electric-sql/pglite-pgvector'), import('../src/repo/postgres.js')]);
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'agentnet-persist-'));
  try {
    await restartScenario(async () => {
      const engine = await PGlite.create({ dataDir, extensions: { vector } });
      return { repo: await PostgresRepository.onPglite(engine), close: () => engine.close() };
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('application restart against a PostgreSQL server: all state survives', { skip: !hasServer && `no PostgreSQL server at ${testDatabaseUrl()}` }, async () => {
  const { PostgresRepository } = await import('../src/repo/postgres.js');
  const schema = `p_${Date.now().toString(36)}`;
  try {
    await restartScenario(async () => {
      const repo = await PostgresRepository.connect({ url: testDatabaseUrl(), schema, max: 4 });
      return { repo, close: () => repo.close() };
    });
  } finally {
    const repo = await PostgresRepository.connect({ url: testDatabaseUrl(), max: 1, migrate: false });
    await repo.db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await repo.close();
  }
});

test('in-process limiter and breaker state stays bounded however many agents and clients there are', async () => {
  const { RateLimiter } = await import('../src/security/rate-limit.js');
  let now = 0;
  const limiter = new RateLimiter(() => now, { maxKeys: 1_000 });
  for (let i = 0; i < 20_000; i++) {
    limiter.take(`read:agent-${i}`, 600);
    now += 1;
  }
  assert.ok(limiter.buckets.size <= 1_000, `${limiter.buckets.size} buckets`);
  // A key that is still being limited keeps its state across pruning.
  for (let i = 0; i < 5; i++) limiter.take('hot', 2, 2);
  assert.equal(limiter.take('hot', 2, 2).ok, false);
  now += 10; // too soon to refill
  for (let i = 0; i < 3_000; i++) limiter.take(`other-${i}`, 600);
  assert.equal(limiter.take('hot', 2, 2).ok, false, 'not reset by pruning');

  const { Dispatcher } = await import('../src/delivery/dispatcher.js');
  const d = new Dispatcher({ repo: {}, config: { delivery: { breakerThreshold: 5, breakerCooldownMs: 1_000, maxBreakers: 500 } }, metrics: {}, log: silentLog, scheduler: {}, envelope: () => ({}) });
  d.breaker('struggling').failure(Date.now());
  for (let i = 0; i < 5_000; i++) d.breaker(`agent-${i}`);
  assert.ok(d.breakers.size <= 501);
  assert.equal(d.breakers.get('struggling')?.failures, 1, 'breakers with history are kept');
});
