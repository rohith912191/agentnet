// P2 phase 3: worker architecture. Several instances share one database; the database decides who
// does what (routing leases, delivery claims, SKIP LOCKED relays), schedules are persisted, dead
// workers' work is recovered, and shutdown is graceful within a deadline.
//
// In-process tests run "instances" as separate platform objects (own scheduler, relay, timers,
// breakers) over one shared repository: in memory, or on PostgreSQL with AGENTNET_TEST_REPO=pglite.
// The multi-process test (real processes, PostgreSQL server, Redis) needs both servers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlatform } from '../src/platform.js';
import { startRuntime } from '../src/runtime.js';
import { POSTS, PERSONAS } from '../demo/personas.js';
import { DEV_CONFIG, TEST_ADMIN_KEY, makePlatform, silentLog } from './helpers.js';
import { openTestRepository, postgresAvailable, testDatabaseUrl } from './support/repositories.js';
import { deepMerge, seededRandom, sleep } from '../src/util.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hookFor = (key) => `http://agent.${key}.example/hook`;
const BASE = { allowInsecureWebhooks: true, delivery: { baseBackoffMs: 5, maxBackoffMs: 20 } };

/** Webhook endpoints shared by all instances; `respond(call)` decides each answer. */
function endpoints() {
  const calls = [];
  let respond = () => new Response('ok', { status: 200 });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const call = { url, id: body.id, type: body.type, post: body.data?.post?.id, attempt: Number(init.headers['x-agentnet-attempt']) };
    calls.push(call);
    return respond(call, init);
  };
  return { calls, fetch, setRespond: (fn) => (respond = fn) };
}

/** A transport that accepts nothing: events stay in the outbox until a test hands them out. */
const HOLD_EVENTS = { publish: async () => { throw new Error('held for the test'); } };

/** N platform instances over one repository (+ the agents, registered through instance 0). */
async function cluster(n, overrides = {}, hooks = endpoints(), { transport } = {}) {
  const repo = await openTestRepository();
  const config = deepMerge(DEV_CONFIG, BASE, overrides);
  const instances = Array.from({ length: n }, (_, i) =>
    createPlatform(config, { repo, llm: null, log: silentLog, rng: seededRandom(i + 1), fetch: hooks.fetch, ...(transport ? { transport } : {}) }),
  );
  const agents = {};
  for (const persona of PERSONAS) {
    const delivery = ['phonepe', 'hdfc'].includes(persona.key) ? { webhook_url: hookFor(persona.key) } : undefined;
    const { agent } = await instances[0].registerAgent({ ...persona.profile, ...(delivery ? { delivery } : {}) });
    await instances[0].verifyAgent(agent);
    agents[persona.key] = await repo.getAgent(agent.id);
  }
  return { repo, instances, agents, hooks };
}

const sendsOf = (hooks, type = 'post.matched') => {
  const per = {};
  for (const c of hooks.calls.filter((x) => x.type === type)) per[c.id] = (per[c.id] ?? 0) + 1;
  return per;
};

async function until(predicate, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await sleep(10);
  }
}

// ---- several instances, one database ----------------------------------------------------------

test('two routing instances handling the same event route the post once; two delivery instances send each webhook once', async () => {
  // Events stay in the outbox, so nothing is routed or delivered until the test hands the same
  // event to both instances at once, as a queue redelivering a message would.
  const { repo, instances: [a, b], agents, hooks } = await cluster(2, {}, endpoints(), { transport: HOLD_EVENTS });
  const posts = [];
  for (const p of [POSTS.swiggyDiwali, POSTS.swiggyNavratri]) posts.push((await a.publishPost(agents.swiggy, p)).post);
  for (const post of posts) assert.equal((await repo.getPost(post.id)).routing.attempts, 0, 'not routed before the race');
  for (const post of posts) await Promise.all([a.handlers['post.published']({ postId: post.id }), b.handlers['post.published']({ postId: post.id })]);
  const matched = [];
  for (const post of posts) matched.push(...(await repo.notificationsForPost(post.id)).filter((n) => n.event === 'post.matched'));
  for (const n of matched) await Promise.all([a.handlers['notification.created']({ notificationId: n.id }), b.handlers['notification.created']({ notificationId: n.id })]);
  await Promise.all([a.drain(), b.drain()]);

  for (const post of posts) assert.equal((await repo.getPost(post.id)).routing.attempts, 1, 'routed by exactly one instance');
  const perAgent = {};
  for (const n of matched) perAgent[`${n.post_id}:${n.agent_id}`] = (perAgent[`${n.post_id}:${n.agent_id}`] ?? 0) + 1;
  assert.ok(Object.values(perAgent).every((c) => c === 1), 'one notification per post and agent');
  const sends = sendsOf(hooks);
  const pushed = matched.filter((n) => n.tier === 'push');
  assert.ok(pushed.length >= 2);
  for (const n of pushed) assert.equal(sends[n.id], 1, `webhook ${n.id} sent once`);
});

test('a webhook retry scheduled by an instance that stopped is run by another instance', async () => {
  const hooks = endpoints();
  const { repo, instances: [a, b], agents } = await cluster(2, { delivery: { baseBackoffMs: 150, maxBackoffMs: 150 }, queue: { duePollMs: 20 } }, hooks);
  let down = true;
  hooks.setRespond(() => new Response(down ? 'busy' : 'ok', { status: down ? 503 : 200 }));
  const { post } = await a.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await a.bus.drain();
  const n = await repo.matchFor(post.id, agents.phonepe.id);
  assert.equal(n.status, 'retry_scheduled');
  await a.shutdown(); // instance A goes away; its local retry timer is gone with it

  down = false;
  b.startJobs(['due-deliveries']);
  try {
    await until(async () => (await repo.getNotification(n.id)).status === 'delivered');
  } finally {
    b.stopJobs();
  }
  assert.deepEqual(hooks.calls.filter((c) => c.id === n.id).map((c) => c.attempt), [1, 2], 'attempt 2 ran on instance B');
  assert.ok(b.metrics.get('webhook_retries_from_schedule') >= 1);
  await b.drain();
});

test('a routing retry scheduled by an instance that stopped is run by another instance', async () => {
  const { repo, instances: [a, b], agents } = await cluster(2, { recovery: { retryBaseMs: 100, retryMaxMs: 100 }, queue: { duePollMs: 20 } });
  const route = a.router.route.bind(a.router);
  a.router.route = () => Promise.reject(new Error('vector index unavailable')); // A's attempt fails
  const { post } = await a.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await a.bus.drain();
  assert.equal((await repo.getPost(post.id)).status, 'retrying');
  a.router.route = route;
  await a.shutdown();

  b.startJobs(['due-routing-retries']);
  try {
    await until(async () => (await repo.getPost(post.id)).status === 'routed');
  } finally {
    b.stopJobs();
  }
  await b.drain();
  const stored = await repo.getPost(post.id);
  assert.equal(stored.routing.attempts, 2);
  assert.ok(b.metrics.get('routing_retries_from_schedule') >= 1);
});

test('deliveries a dead worker left behind are recovered: claimed but never finished, and never dispatched', async () => {
  const { repo, instances: [a, b], agents, hooks } = await cluster(2, { queue: { staleDeliveryGraceMs: 0, staleQueuedMs: 0 }, delivery: { timeoutMs: 50 } });
  const { post } = await a.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await a.drain();
  const [phonepe, hdfc] = await Promise.all([repo.matchFor(post.id, agents.phonepe.id), repo.matchFor(post.id, agents.hdfc.id)]);
  // Worker A "died" mid-request for PhonePe (claimed, never finished), and before handing HDFC's
  // notification to delivery at all (committed, never dispatched).
  const old = new Date(Date.now() - 60_000).toISOString();
  assert.ok(await repo.saveDeliveryState({ ...phonepe, status: 'delivering', delivery: { ...phonepe.delivery, delivered_at: null, claimed_at: old } }));
  assert.ok(await repo.saveDeliveryState({ ...hdfc, status: 'queued', delivery: { ...hdfc.delivery, delivered_at: null } }));
  const sentBefore = hooks.calls.length;

  const result = await b.recoverStaleDeliveries(Date.now() + 1_000);
  assert.deepEqual(result, { recovered_in_flight: 1, recovered_queued: 1 });
  await b.drain();
  assert.equal((await repo.getNotification(phonepe.id)).status, 'delivered');
  assert.equal((await repo.getNotification(hdfc.id)).status, 'delivered');
  const resent = hooks.calls.slice(sentBefore);
  assert.deepEqual(resent.map((c) => c.url).sort(), [hookFor('hdfc'), hookFor('phonepe')]);
  assert.ok(resent.every((c, i, all) => all.findIndex((x) => x.id === c.id) === i), 'same delivery ids, once each on recovery');
});

// ---- runtime: roles and graceful shutdown -------------------------------------------------------

test('separate worker roles refuse to start without a queue; unknown roles are rejected', async () => {
  const platform = await makePlatform();
  await assert.rejects(startRuntime({ platform, role: 'routing', queue: null }), /needs a queue: set AGENTNET_REDIS_URL/);
  await assert.rejects(startRuntime({ platform, role: 'scheduler', queue: null }), /unknown role/);
});

test('graceful shutdown: the API stops accepting requests and in-flight deliveries finish before exit', async () => {
  let release;
  const hooks = endpoints();
  hooks.setRespond((call) => (call.type === 'post.matched' ? new Promise((resolve) => (release = () => resolve(new Response('ok', { status: 200 })))) : new Response('ok', { status: 200 })));
  const platform = await makePlatform(BASE, { fetch: hooks.fetch });
  const runtime = await startRuntime({ platform, role: 'all', queue: null, port: 0, host: '127.0.0.1', shutdownTimeoutMs: 5_000 });
  const base = `http://127.0.0.1:${runtime.address().port}`;
  const call = (method, p, { key, body } = {}) =>
    fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body && JSON.stringify(body) }).then(async (r) => ({
      status: r.status,
      body: await r.json().catch(() => null),
    }));
  const keys = {};
  for (const key of ['swiggy', 'phonepe']) {
    const profile = PERSONAS.find((p) => p.key === key).profile;
    const res = await call('POST', '/v1/agents', { body: key === 'phonepe' ? { ...profile, delivery: { webhook_url: hookFor('phonepe') } } : profile });
    keys[key] = res.body.credentials.api_key;
    await call('POST', '/v1/agents/me/verify', { key: keys[key] });
  }
  const posted = await call('POST', '/v1/posts', { key: keys.swiggy, body: POSTS.swiggyDiwali });
  assert.equal(posted.status, 202);
  await until(() => Boolean(release)); // PhonePe's webhook request is in flight

  const stopping = runtime.stop();
  await sleep(50);
  await assert.rejects(fetch(`${base}/healthz`), 'no new requests are accepted while shutting down');
  release();
  assert.equal(await stopping, 'clean');
  const [n] = (await platform.repo.notificationsForPost(posted.body.id)).filter((x) => x.event === 'post.matched' && x.tier === 'push');
  assert.equal(n.status, 'delivered', 'the in-flight delivery completed and was recorded');
});

test('shutdown is bounded: work that does not finish by the deadline is left for recovery', async () => {
  const hooks = endpoints();
  hooks.setRespond(() => new Promise(() => {})); // an endpoint that never answers
  const platform = await makePlatform({ ...BASE, delivery: { timeoutMs: 60_000 } }, { fetch: hooks.fetch });
  const { agent: author } = await platform.registerAgent(PERSONAS[0].profile);
  await platform.verifyAgent(author);
  const { agent: hooked } = await platform.registerAgent({ ...PERSONAS[1].profile, delivery: { webhook_url: hookFor('phonepe') } });
  await platform.verifyAgent(hooked);
  const runtime = await startRuntime({ platform, role: 'all', queue: null, port: 0, host: '127.0.0.1', shutdownTimeoutMs: 300 });
  const { post } = await platform.publishPost(author, POSTS.swiggyDiwali);
  await until(async () => (await platform.repo.notificationsForPost(post.id)).some((n) => n.status === 'delivering'));
  const started = Date.now();
  assert.equal(await runtime.stop(), 'timeout');
  assert.ok(Date.now() - started < 2_000, 'the deadline was honoured');
  const stuck = (await platform.repo.notificationsForPost(post.id)).find((n) => n.status === 'delivering');
  assert.ok(stuck.delivery.claimed_at, 'the claim time lets a surviving worker recover it (stale-deliveries job)');
});

// ---- real processes: PostgreSQL server + Redis ---------------------------------------------------

const REDIS_URL = process.env.AGENTNET_TEST_REDIS_URL || 'redis://localhost:6379';
async function redisAvailable() {
  try {
    const { createClient } = await import('redis');
    const c = createClient({ url: REDIS_URL, socket: { connectTimeout: 1_000, reconnectStrategy: false } });
    c.on('error', () => {});
    await c.connect();
    await c.quit();
    return true;
  } catch {
    return false;
  }
}
const serversUp = (await postgresAvailable()) && (await redisAvailable());

test('separate api, routing and delivery processes (two of each worker) deliver every match exactly once, surviving a killed worker', { skip: !serversUp && `needs PostgreSQL (${testDatabaseUrl()}) and Redis (${REDIS_URL}) servers` }, async (t) => {
  const received = [];
  const receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      received.push({ path: req.url, id: body.id, type: body.type });
      res.writeHead(200).end();
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  const hook = (name) => `http://127.0.0.1:${receiver.address().port}/${name}`;
  t.after(() => new Promise((r) => receiver.close(r)));

  // A fresh database schema and stream prefix for this run.
  const { connectPg } = await import('../src/repo/db.js');
  const schema = `w_${Date.now().toString(36)}`;
  const url = new URL(testDatabaseUrl());
  url.searchParams.set('options', `-c search_path=${schema},public`);
  const admin = await connectPg({ url: testDatabaseUrl(), max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  });
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    AGENTNET_DATABASE_URL: url.toString(),
    AGENTNET_REDIS_URL: REDIS_URL,
    AGENTNET_DEV_AUTO_VERIFY: 'true',
    AGENTNET_ALLOW_INSECURE_WEBHOOKS: 'true',
    AGENTNET_ADMIN_KEY: TEST_ADMIN_KEY,
    LOG_LEVEL: 'warn',
  };
  const procs = [];
  const start = (role, extra = {}) => {
    const child = spawn(process.execPath, ['src/main.js', `--role=${role}`], { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'ignore', 'pipe'] });
    procs.push(child);
    return child;
  };
  t.after(() => procs.forEach((p) => p.kill()));
  const port = 18_000 + Math.floor(Math.random() * 1_000);
  start('api', { PORT: String(port) });
  const routing = [start('routing'), start('routing')];
  start('delivery');
  start('delivery');
  const base = `http://127.0.0.1:${port}`;
  await until(() => fetch(`${base}/healthz`).then((r) => r.ok, () => false), 20_000);

  const call = (method, p, { key, body } = {}) =>
    fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body && JSON.stringify(body) }).then((r) => r.json());
  const keys = {};
  for (const persona of PERSONAS) {
    const res = await call('POST', '/v1/agents', { body: { ...persona.profile, delivery: { webhook_url: hook(persona.key) } } });
    keys[persona.key] = res.credentials.api_key;
    await call('POST', '/v1/agents/me/verify', { key: keys[persona.key] });
  }
  const first = await call('POST', '/v1/posts', { key: keys.swiggy, body: POSTS.swiggyDiwali });
  await until(() => received.filter((r) => r.type === 'post.matched').length >= 2, 20_000);
  routing[0].kill(); // a routing worker crashes; the other one carries on
  await call('POST', '/v1/posts', { key: keys.flipkart, body: POSTS.flipkartSale });
  await call('POST', '/v1/posts', { key: keys.bajaj, body: POSTS.bajajLaunch });
  await until(() => received.filter((r) => r.type === 'post.matched').length >= 8, 30_000);
  await sleep(1_000);
  const perDelivery = {};
  for (const r of received.filter((x) => x.type === 'post.matched')) perDelivery[r.id] = (perDelivery[r.id] ?? 0) + 1;
  assert.ok(Object.values(perDelivery).every((c) => c === 1), 'no webhook was sent twice');
  assert.ok(received.some((r) => r.path === '/phonepe') && received.some((r) => r.path === '/hdfc'), `the brief's audience for ${first.id}`);
});
