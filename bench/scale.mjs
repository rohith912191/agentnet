// Scalability benchmark: routing latency, throughput, memory and database cost at increasing
// population sizes and post volumes, plus checks that fan-out and delivery stay bounded.
//
//   node --max-old-space-size=4096 bench/scale.mjs --storage=memory --agents=1000,10000,100000
//   node bench/scale.mjs --storage=pglite --agents=1000,10000
//   node bench/scale.mjs --storage=postgres --database-url=postgres://agentnet:agentnet@localhost:5432/agentnet --agents=1000,10000,100000
//
// Options: --latency-posts=100  --bursts=50,200,500  --webhook-latency-ms=10  --out=bench/results
//
// What is measured, per population size:
//   seeding      registration + verification throughput through the real service layer
//   latency      sequential posts: routing time (router) and end-to-end time (publish -> routed ->
//                notifications delivered), p50/p95/p99
//   throughput   bursts of concurrent posts at increasing volume: posts/s, notifications/s, webhooks/s
//   bounds       per-post push and digest fan-out, per-agent push/digest budgets, candidate cap,
//                each webhook delivered exactly once
//   memory       RSS and heap after seeding and after the run
//   storage      time per repository operation (PostgreSQL: per SQL round trip), table and index
//                sizes, and EXPLAIN ANALYZE of the candidate-generation queries
//
// Synthetic data on one machine: these numbers show how cost grows and where it goes. They are not
// a capacity guarantee for production hardware, traffic or data (see docs/BENCHMARKS.md).

import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatform } from '../src/platform.js';
import { MemoryRepository } from '../src/repo/memory.js';
import { PERSONAS, POSTS } from '../demo/personas.js';
import { createPopulation } from './synthetic.js';
import { round, seededRandom, sleep } from '../src/util.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const STORAGE = args.storage ?? 'memory';
const SIZES = (args.agents ?? '1000,10000').split(',').map(Number);
const LATENCY_POSTS = Number(args['latency-posts'] ?? 100);
const BURSTS = (args.bursts ?? '50,200,500').split(',').map(Number).filter(Boolean);
const WEBHOOK_LATENCY_MS = Number(args['webhook-latency-ms'] ?? 10);
const OUT_DIR = args.out ?? 'bench/results';
const SEED = args.seed ?? 'api'; // api: every agent registers and verifies through the service layer; bulk: personas do, the rest are bulk-inserted
const silent = { debug() {}, info() {}, warn() {}, error: (m, f) => console.error(m, f) };

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const stats = (values) => ({ n: values.length, p50: round(percentile(values, 50), 1), p95: round(percentile(values, 95), 1), p99: round(percentile(values, 99), 1), max: round(Math.max(...values), 1) });
const mb = (bytes) => round(bytes / 1024 / 1024, 1);
const memory = () => {
  const m = process.memoryUsage();
  return { rss_mb: mb(m.rss), heap_used_mb: mb(m.heapUsed), external_mb: mb(m.external + m.arrayBuffers) };
};

/** Wraps a repository so every call is timed (per method: count, total, percentiles). */
function instrument(repo) {
  const timings = new Map();
  const record = (name, ms) => {
    let t = timings.get(name);
    if (!t) timings.set(name, (t = { count: 0, total: 0, samples: [] }));
    t.count++;
    t.total += ms;
    if (t.samples.length < 20_000) t.samples.push(ms);
  };
  const proxy = new Proxy(repo, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function' || prop === 'constructor') return value;
      return (...a) => {
        const started = performance.now();
        const result = value.apply(target, a); // private fields need the real `this`
        if (result && typeof result.then === 'function') return result.finally(() => record(prop, performance.now() - started));
        record(prop, performance.now() - started);
        return result;
      };
    },
  });
  const report = () =>
    Object.fromEntries(
      [...timings.entries()]
        .sort(([, a], [, b]) => b.total - a.total)
        .map(([name, t]) => [name, { calls: t.count, total_ms: round(t.total, 0), p50_ms: round(percentile(t.samples, 50), 2), p95_ms: round(percentile(t.samples, 95), 2) }]),
    );
  const reset = () => timings.clear();
  return { proxy, report, reset };
}

async function openStorage(size) {
  if (STORAGE === 'memory') return { repo: new MemoryRepository(), close: async () => {} };
  const { PostgresRepository } = await import('../src/repo/postgres.js');
  if (STORAGE === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite-pgvector');
    const dataDir = path.join(os.tmpdir(), `agentnet-bench-${size}-${Date.now()}`);
    const engine = await PGlite.create({ dataDir, extensions: { vector } });
    return { repo: await PostgresRepository.onPglite(engine), close: () => engine.close(), dataDir };
  }
  if (STORAGE === 'postgres') {
    const url = args['database-url'] ?? process.env.AGENTNET_DATABASE_URL;
    if (!url) throw new Error('--database-url is required for --storage=postgres');
    const schema = `bench_${size}_${Date.now().toString(36)}`;
    const repo = await PostgresRepository.connect({ url, schema, max: 20 });
    return { repo, close: async () => (await repo.db.query(`DROP SCHEMA ${schema} CASCADE`), await repo.close()) };
  }
  throw new Error(`unknown storage ${STORAGE}`);
}

/** Webhook endpoint stand-in with network-like latency; records every delivery. */
function webhookSink() {
  const deliveries = new Map(); // notification id -> count
  let total = 0;
  const fetch = async (url, init) => {
    await sleep(WEBHOOK_LATENCY_MS);
    const id = init.headers['x-agentnet-delivery'];
    deliveries.set(id, (deliveries.get(id) ?? 0) + 1);
    total++;
    return new Response('ok', { status: 200 });
  };
  return { fetch, deliveries, total: () => total };
}

async function seed(platform, population, size) {
  const started = performance.now();
  const agents = [];
  const personaAgents = {};
  for (const persona of PERSONAS) {
    const { agent } = await platform.registerAgent(persona.profile);
    await platform.verifyAgent(agent);
    personaAgents[persona.key] = agent;
    agents.push(agent);
  }
  const followTargets = Object.values(personaAgents);
  let subscriptions = 0;
  if (SEED === 'bulk') {
    // Same records registerAgent would store (platform.seedingRecord), written in bulk. Personas
    // above went through the real registration and verification path.
    let batch = [];
    const subs = [];
    const flush = async () => {
      if (batch.length) await platform.repo.insertAgents(batch);
      batch = [];
    };
    for (let i = PERSONAS.length; i < size; i++) {
      const { profile, verify, follows, subscribesTopic } = population.profile(i);
      const record = platform.seedingRecord(profile, { verified: verify });
      batch.push(record);
      agents.push({ id: record.id, company: record.company, industry: record.industry });
      if (follows) subs.push([record.id, { kind: 'agent', target: population.pick(followTargets).id }]);
      if (subscribesTopic) subs.push([record.id, { kind: 'topic', target: population.topicFor() }]);
      if (batch.length === 1_000) await flush();
      if (i % 10_000 === 0 && i > 0) console.log(`    seeded ${i.toLocaleString()} agents (${round((performance.now() - started) / 1000, 1)} s)`);
    }
    await flush();
    for (const [id, sub] of subs) await platform.subscribe({ id }, sub);
    subscriptions = subs.length;
    const seconds = (performance.now() - started) / 1000;
    return { agents, personaAgents, subscriptions, seconds, per_second: round(size / seconds, 0), mode: 'bulk' };
  }
  for (let i = PERSONAS.length; i < size; i++) {
    const { profile, verify, follows, subscribesTopic } = population.profile(i);
    const { agent } = await platform.registerAgent(profile);
    if (verify) await platform.verifyAgent(agent);
    if (follows) {
      await platform.subscribe(agent, { kind: 'agent', target: population.pick(followTargets).id });
      subscriptions++;
    }
    if (subscribesTopic) {
      await platform.subscribe(agent, { kind: 'topic', target: population.topicFor() });
      subscriptions++;
    }
    agents.push(agent);
    if (i % 10_000 === 0 && i > 0) console.log(`    seeded ${i.toLocaleString()} agents (${round((performance.now() - started) / 1000, 1)} s)`);
  }
  const seconds = (performance.now() - started) / 1000;
  return { agents, personaAgents, subscriptions, seconds, per_second: round(size / seconds, 0), mode: 'api' };
}

async function routedLog(platform, postId) {
  const log = await platform.repo.getRoutingLog(postId);
  if (!log) throw new Error(`post ${postId} was not routed`);
  return log;
}

async function latencyPhase(platform, population, authors) {
  const routing = [];
  const endToEnd = [];
  const logs = [];
  const scenario = [POSTS.swiggyDiwali, POSTS.flipkartSale, POSTS.bajajLaunch, POSTS.hdfcRates];
  for (let k = 0; k < LATENCY_POSTS; k++) {
    const author = authors[k % authors.length];
    const input = k < scenario.length && author.persona ? { ...scenario[k], body: `${scenario[k].body} Ref L${k}.` } : population.post(author);
    const started = performance.now();
    const { post } = await platform.publishPost(author, input);
    await platform.drain({ timeoutMs: 120_000 });
    endToEnd.push(performance.now() - started);
    const log = await routedLog(platform, post.id);
    routing.push(log.latency_ms);
    logs.push(log);
  }
  return { routing_ms: stats(routing), end_to_end_ms: stats(endToEnd), logs };
}

async function burstPhase(platform, population, authors, volume, sink) {
  const deliveredBefore = sink.total();
  const started = performance.now();
  const published = await Promise.all(
    Array.from({ length: volume }, (_, k) => {
      const author = authors[(k * 7919) % authors.length];
      return platform.publishPost(author, population.post(author));
    }),
  );
  await platform.drain({ timeoutMs: 600_000 });
  const seconds = (performance.now() - started) / 1000;
  const logs = [];
  const lag = [];
  for (const { post } of published) {
    logs.push(await routedLog(platform, post.id));
    const stored = await platform.repo.getPost(post.id);
    lag.push(Date.parse(stored.routed_at) - Date.parse(stored.created_at));
  }
  const notifications = logs.reduce((s, l) => s + l.counts.push + l.counts.digest, 0);
  const webhooks = sink.total() - deliveredBefore;
  return {
    posts: volume,
    seconds: round(seconds, 2),
    posts_per_second: round(volume / seconds, 1),
    notifications,
    notifications_per_second: round(notifications / seconds, 0),
    webhooks_delivered: webhooks,
    webhooks_per_second: round(webhooks / seconds, 0),
    publish_to_routed_ms: stats(lag),
    logs,
  };
}

/** Checks every bound the platform promises, over all routing logs and notifications. */
async function verifyBounds(platform, logs, agents, sink) {
  const cfg = platform.config.routing;
  const violations = [];
  let maxPush = 0;
  let maxDigestNonSubscriber = 0;
  let maxCandidates = 0;
  for (const log of logs) {
    maxPush = Math.max(maxPush, log.counts.push);
    const requested = log.decisions.filter((d) => d.tier === 'digest' && d.features.follow === 1).length;
    maxDigestNonSubscriber = Math.max(maxDigestNonSubscriber, log.counts.digest - requested);
    maxCandidates = Math.max(maxCandidates, log.counts.candidates - log.counts.subscribers);
    if (log.counts.push > cfg.maxPushPerPost) violations.push(`post ${log.post_id}: ${log.counts.push} pushes`);
    if (log.counts.digest - requested > cfg.maxDigestPerPost) violations.push(`post ${log.post_id}: ${log.counts.digest - requested} unrequested digests`);
    if (log.counts.candidates - log.counts.subscribers > cfg.maxCandidates) violations.push(`post ${log.post_id}: ${log.counts.candidates} candidates`);
  }
  // Per-agent budgets: every post in a run falls inside one hour, so lifetime counts must fit the hourly budget.
  const perAgent = new Map();
  for (const log of logs) {
    for (const d of log.decisions) {
      if (d.tier === 'none') continue;
      const c = perAgent.get(d.agent_id) ?? { push: 0, digest: 0 };
      c[d.tier]++;
      perAgent.set(d.agent_id, c);
    }
  }
  let maxAgentPush = 0;
  let maxAgentDigest = 0;
  for (const [, c] of perAgent) {
    maxAgentPush = Math.max(maxAgentPush, c.push);
    maxAgentDigest = Math.max(maxAgentDigest, c.digest);
  }
  if (maxAgentPush > cfg.defaultPushBudgetPerHour) violations.push(`an agent received ${maxAgentPush} pushes in under an hour`);
  if (maxAgentDigest > cfg.defaultDigestBudgetPerDay) violations.push(`an agent received ${maxAgentDigest} digests in a day`);
  // Delivery: every push to an agent with a webhook is delivered exactly once.
  const duplicates = [...sink.deliveries.values()].filter((c) => c > 1).length;
  if (duplicates) violations.push(`${duplicates} webhooks delivered more than once`);
  const undelivered = [];
  for (const log of logs.slice(-50)) {
    for (const n of await platform.repo.notificationsForPost(log.post_id)) {
      if (n.event === 'post.matched' && n.tier === 'push' && !['delivered', 'in_inbox'].includes(n.status)) undelivered.push(`${n.id}:${n.status}`);
    }
  }
  if (undelivered.length) violations.push(`${undelivered.length} pushes not delivered (sample: ${undelivered.slice(0, 3).join(', ')})`);
  return {
    max_push_per_post: maxPush,
    max_unrequested_digest_per_post: maxDigestNonSubscriber,
    max_discovered_candidates_per_post: maxCandidates,
    max_pushes_per_agent: maxAgentPush,
    max_digests_per_agent: maxAgentDigest,
    webhooks_delivered: sink.total(),
    duplicate_webhooks: duplicates,
    violations,
  };
}

async function storageDetails(repo, samplePost) {
  if (STORAGE === 'memory') return null;
  const db = repo.db;
  const sizes = await db.query(
    `SELECT c.relname AS name, c.relkind AS kind, pg_total_relation_size(c.oid) AS bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'i') ORDER BY bytes DESC LIMIT 14`,
  );
  const vector = `[${Array.from(samplePost.vector).join(',')}]`;
  const explain = async (sql, params, setup = []) =>
    db.transaction(async (tx) => {
      for (const statement of [setup].flat()) await tx.query(statement);
      const { rows } = await tx.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params);
      return rows.map((r) => r['QUERY PLAN']);
    });
  const ann = await explain('SELECT agent_id, embedding <=> $1::vector AS d FROM agent_interests ORDER BY embedding <=> $1::vector LIMIT 600', [vector], ['SET LOCAL hnsw.ef_search = 600', 'SET LOCAL hnsw.iterative_scan = relaxed_order']);
  const discover = await explain(
    `SELECT a.id FROM agents a WHERE (a.retrieval_concepts && $1::text[] OR a.industry = ANY($2::text[])) ORDER BY a.id LIMIT 2000`,
    [['festive', 'food', 'delivery'], ['payments', 'banking']],
  );
  return {
    relations: sizes.rows.map((r) => ({ name: r.name, kind: r.kind === 'i' ? 'index' : 'table', mb: mb(Number(r.bytes)) })),
    explain_ann: ann,
    explain_candidate_index: discover,
  };
}

async function runSize(size) {
  console.log(`\n== ${size.toLocaleString()} agents, storage: ${STORAGE}`);
  const storage = await openStorage(size);
  const { proxy, report, reset } = instrument(storage.repo);
  const sink = webhookSink();
  const platform = createPlatform(
    {
      devAutoVerify: true,
      allowInsecureWebhooks: true,
      limits: { postsPerMinute: 1e9, commentsPerMinute: 1e9, registrationsPerHourGlobal: 1e9, registrationsPerHourPerClient: 1e9, feedbackPerMinute: 1e9 },
      delivery: { baseBackoffMs: 50 },
    },
    { repo: proxy, llm: null, log: silent, rng: seededRandom(11), fetch: sink.fetch },
  );
  const population = createPopulation({ size, seed: 7 });
  const memBefore = memory();
  const seeded = await seed(platform, population, size);
  const memSeeded = memory();
  console.log(`    seeding: ${seeded.seconds.toFixed(1)} s (${seeded.per_second}/s), ${seeded.subscriptions} subscriptions, RSS ${memSeeded.rss_mb} MB`);
  const seedingOps = report();
  reset();

  // Personas author the scenario posts; everyone else draws from the synthetic population.
  const personaAuthors = Object.values(seeded.personaAgents).map((a) => ({ ...a, persona: true }));
  const others = seeded.agents.slice(PERSONAS.length).filter((_, i) => i % 3 === 0);
  const authors = [...personaAuthors.slice(0, 4), ...others.slice(0, 400)];

  const latency = await latencyPhase(platform, population, authors);
  console.log(`    latency (${LATENCY_POSTS} sequential posts): routing p50 ${latency.routing_ms.p50} ms p95 ${latency.routing_ms.p95} ms; end-to-end p50 ${latency.end_to_end_ms.p50} ms p95 ${latency.end_to_end_ms.p95} ms`);
  const latencyOps = report();
  reset();

  const bursts = [];
  for (const volume of BURSTS) {
    const b = await burstPhase(platform, population, authors, volume, sink);
    bursts.push(b);
    console.log(`    burst of ${volume} concurrent posts: ${b.seconds} s, ${b.posts_per_second} posts/s, ${b.notifications_per_second} notifications/s, ${b.webhooks_per_second} webhooks/s, publish->routed p95 ${b.publish_to_routed_ms.p95} ms`);
  }
  const burstOps = report();
  const memAfter = memory();

  const allLogs = [...latency.logs, ...bursts.flatMap((b) => b.logs)];
  const bounds = await verifyBounds(platform, allLogs, seeded.agents, sink);
  console.log(`    bounds: max push/post ${bounds.max_push_per_post}, max unrequested digest/post ${bounds.max_unrequested_digest_per_post}, max pushes/agent ${bounds.max_pushes_per_agent}, duplicates ${bounds.duplicate_webhooks}, violations ${bounds.violations.length}`);
  const candidates = stats(allLogs.map((l) => l.counts.candidates));
  const trimmed = stats(allLogs.map((l) => l.counts.candidates_trimmed));
  const sample = await platform.repo.getPost(latency.logs[0].post_id);
  const details = await storageDetails(storage.repo, sample);
  await platform.shutdown();
  await storage.close();

  return {
    agents: size,
    storage: STORAGE,
    seeding: { mode: seeded.mode, seconds: round(seeded.seconds, 1), agents_per_second: seeded.per_second, subscriptions: seeded.subscriptions },
    memory: { before: memBefore, after_seeding: memSeeded, after_run: memAfter, per_agent_kb: round(((memSeeded.rss_mb - memBefore.rss_mb) * 1024) / size, 2) },
    candidates_per_post: candidates,
    candidates_trimmed_per_post: trimmed,
    latency: { posts: LATENCY_POSTS, routing_ms: latency.routing_ms, end_to_end_ms: latency.end_to_end_ms },
    bursts: bursts.map(({ logs, ...b }) => b),
    bounds,
    storage_ops: { seeding: Object.fromEntries(Object.entries(seedingOps).slice(0, 8)), latency_phase: latencyOps, bursts: Object.fromEntries(Object.entries(burstOps).slice(0, 12)) },
    storage_details: details,
  };
}

const environment = {
  date: new Date().toISOString(),
  node: process.version,
  platform: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: `${os.cpus()[0]?.model} x${os.cpus().length}`,
  memory_gb: round(os.totalmem() / 1024 ** 3, 1),
  storage: STORAGE,
  webhook_latency_ms: WEBHOOK_LATENCY_MS,
};
console.log(`AgentNet scalability benchmark | ${environment.cpu} | ${environment.memory_gb} GB | Node ${environment.node} | storage ${STORAGE}`);
const results = [];
for (const size of SIZES) results.push(await runSize(size));
mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `scale-${STORAGE}-${SIZES.join('_')}-${Date.now()}.json`);
writeFileSync(file, JSON.stringify({ environment, results }, null, 2));
console.log(`\nresults: ${file}`);
const failed = results.filter((r) => r.bounds.violations.length);
if (failed.length) {
  console.error('BOUND VIOLATIONS:', failed.map((r) => `${r.agents}: ${r.bounds.violations.join('; ')}`).join(' | '));
  process.exit(2);
}
