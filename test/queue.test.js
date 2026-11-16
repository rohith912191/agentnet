// P2 phase 2: durable events. Transactional outbox, restart survival, duplicate suppression, and
// Redis Streams consumer groups (takeover of a dead consumer, dead-lettering, graceful stop).
// Restart tests use PostgreSQL storage on disk (the embedded engine); Redis tests need a real
// server at AGENTNET_TEST_REDIS_URL and are reported as skipped without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POSTS, PERSONAS } from '../demo/personas.js';
import { createPlatform } from '../src/platform.js';
import { DEV_CONFIG, publishAndRoute, setup, silentLog } from './helpers.js';
import { deepMerge, newId, seededRandom, sleep } from '../src/util.js';

const hasPglite = await import('@electric-sql/pglite-pgvector').then(() => true, () => false);
const REDIS_URL = process.env.AGENTNET_TEST_REDIS_URL || 'redis://localhost:6379';

async function redisAvailable() {
  try {
    const { createClient } = await import('redis');
    const client = createClient({ url: REDIS_URL, socket: { connectTimeout: 1_000, reconnectStrategy: false } });
    client.on('error', () => {});
    await client.connect();
    await client.ping();
    await client.quit();
    return true;
  } catch {
    return false;
  }
}
const hasRedis = await redisAvailable();
const NO_REDIS = !hasRedis && `no Redis server at ${REDIS_URL} (run: docker compose up -d redis)`;

/** Records webhook calls; every endpoint answers 200. */
function webhookRecorder() {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, id: body.id, type: body.type, post: body.data?.post?.id });
    return new Response('ok', { status: 200 });
  };
  return { calls, fetch };
}

const hookFor = (key) => `http://agent.${key}.example/hook`;
const WEBHOOK_CONFIG = { allowInsecureWebhooks: true, delivery: { baseBackoffMs: 5, maxBackoffMs: 20 } };

async function registerPersonas(platform, withWebhooks) {
  const agents = {};
  for (const persona of PERSONAS) {
    const profile = withWebhooks ? { ...persona.profile, delivery: { webhook_url: hookFor(persona.key) } } : persona.profile;
    const { agent } = await platform.registerAgent(profile);
    await platform.verifyAgent(agent);
    agents[persona.key] = await platform.repo.getAgent(agent.id);
  }
  return agents;
}

// ---- duplicate events have no duplicate effects ---------------------------------------------

test('every event handler is idempotent: the same event delivered twice has one effect', async () => {
  const hooks = webhookRecorder();
  const { platform, agents } = await setup(WEBHOOK_CONFIG, { fetch: hooks.fetch });
  for (const key of ['phonepe', 'hdfc']) await platform.updateAgent(agents[key], { delivery: { webhook_url: hookFor(key) } });

  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const matched = (await platform.repo.notificationsForPost(post.id)).filter((n) => n.event === 'post.matched');
  assert.equal(matched.length, 2);
  const sentBefore = hooks.calls.length;

  // At-least-once delivery: replay every event, concurrently and again sequentially.
  await Promise.all([platform.handlers['post.published']({ postId: post.id }), platform.handlers['post.published']({ postId: post.id })]);
  for (const n of matched) {
    await Promise.all([platform.handlers['notification.created']({ notificationId: n.id }), platform.handlers['notification.created']({ notificationId: n.id })]);
  }
  const comment = await platform.addComment(agents.phonepe, post.id, { body: 'PhonePe can add ₹50 cashback.' });
  await platform.drain();
  const threadBefore = (await platform.repo.notificationsForPost(post.id)).filter((n) => n.event === 'comment.created').length;
  await Promise.all([platform.handlers['comment.created']({ commentId: comment.id }), platform.handlers['comment.created']({ commentId: comment.id })]);
  await platform.drain();

  const after = await platform.repo.notificationsForPost(post.id);
  assert.equal(after.filter((n) => n.event === 'post.matched').length, 2, 'routing replay created nothing new');
  assert.equal(after.filter((n) => n.event === 'comment.created').length, threadBefore, 'thread replay created nothing new');
  const matchedSends = hooks.calls.slice(sentBefore).filter((c) => c.type === 'post.matched');
  assert.equal(matchedSends.length, 0, 'delivery replay sent nothing again');
  assert.equal((await platform.repo.getPost(post.id)).routing.attempts, 1);
});

test('a write whose event cannot be published right away is still routed: the outbox keeps it', async () => {
  let down = true;
  const { InProcessTransport } = await import('../src/queue/relay.js');
  const flaky = {
    inner: null,
    async publish(events) {
      if (down) throw new Error('queue unavailable');
      return this.inner.publish(events);
    },
  };
  const { platform, agents } = await setup({}, { transport: flaky });
  flaky.inner = new InProcessTransport(platform.bus);
  const { post } = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await platform.drain();
  assert.equal((await platform.repo.getPost(post.id)).status, 'routing', 'not routed while the queue is down');
  assert.equal((await platform.repo.outboxBacklog()).pending, 1);
  assert.ok(platform.metrics.get('outbox_publish_errors') >= 1);

  down = false; // the queue recovers; the periodic relay pass publishes the backlog
  await platform.relay.kick();
  await platform.drain();
  assert.equal((await platform.repo.getPost(post.id)).status, 'routed');
  assert.equal((await platform.repo.outboxBacklog()).pending, 0);
});

// ---- consumer scheduling --------------------------------------------------------------------
// A unit test of the consumer's own scheduling, with an in-memory stand-in for the five stream
// commands it uses. It is not a Redis test: the Redis Streams tests below need a real server.

function memoryStream(eventIds) {
  const queue = eventIds.map((id, i) => ({ id: `${i + 1}-0`, message: { event_id: id, type: 'notification.created', payload: JSON.stringify({ id }) } }));
  const acked = [];
  return {
    acked,
    async xGroupCreate() {},
    async xAutoClaim() {
      return { messages: [] };
    },
    async xPendingRange() {
      return [];
    },
    async xAdd() {},
    async xAck(_stream, _group, id) {
      acked.push(id);
    },
    async xReadGroup(_group, _consumer, _key, { COUNT, BLOCK }) {
      if (!queue.length) {
        await sleep(Math.min(BLOCK, 10));
        return null;
      }
      return [{ name: 'stream', messages: queue.splice(0, COUNT) }];
    },
  };
}

async function waitUntil(check, ms = 2_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(5);
  }
}

test('a worker handles queued events concurrently: one slow webhook does not hold up the others, and stop waits for it', async () => {
  const { StreamConsumer } = await import('../src/queue/redis-streams.js');
  const start = async (concurrency) => {
    const client = memoryStream(['slow', 'a', 'b', 'c', 'd']);
    const done = [];
    let release;
    const gate = new Promise((r) => (release = r));
    const processed = new Set();
    const consumer = new StreamConsumer({
      client,
      type: 'notification.created',
      group: 'delivery',
      consumer: 'worker-1',
      concurrency,
      blockMs: 10,
      ledger: { isProcessed: async (_g, id) => processed.has(id), markProcessed: async (_g, id) => void processed.add(id) },
      log: silentLog,
      metrics: { inc() {} },
      handle: async ({ id }) => {
        if (id === 'slow') await gate; // a partner endpoint that takes its full timeout
        done.push(id);
      },
    });
    await consumer.start();
    return { consumer, client, done, release };
  };

  // One at a time (the old behaviour): everything queues behind the slow event.
  const one = await start(1);
  await sleep(100);
  assert.deepEqual(one.done, []);
  one.release();
  await waitUntil(() => one.done.length === 5);
  await one.consumer.stop();

  // Bounded concurrency: the other four are handled while the slow one is still running.
  const many = await start(4);
  await waitUntil(() => many.done.length === 4);
  assert.deepEqual([...many.done].sort(), ['a', 'b', 'c', 'd']);
  // Graceful stop: it waits for the event still in hand, which is then acknowledged.
  let stopped = false;
  const stopping = many.consumer.stop().then(() => (stopped = true));
  await sleep(50);
  assert.equal(stopped, false, 'stop waits for the slow event');
  many.release();
  await stopping;
  assert.deepEqual([...many.done].sort(), ['a', 'b', 'c', 'd', 'slow']);
  assert.equal(many.client.acked.length, 5, 'every event acknowledged once');
  assert.equal(many.consumer.inFlight.size, 0);
});

// ---- restart survival (PostgreSQL on disk) --------------------------------------------------

test('events survive a crash: after a restart, unpublished events are routed and delivered exactly once', { skip: !hasPglite && 'PGlite not installed' }, async () => {
  const [{ PGlite }, { vector }, { PostgresRepository }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite-pgvector'),
    import('../src/repo/postgres.js'),
  ]);
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'agentnet-restart-'));
  const config = deepMerge(DEV_CONFIG, WEBHOOK_CONFIG);
  const deadQueue = { publish: async () => { throw new Error('process is dying'); } };
  try {
    // Life 1: the queue is unreachable, then the process dies mid-pipeline. The post is routed by a
    // consumer that got the event, but none of the notification events were published.
    let engine = await PGlite.create({ dataDir, extensions: { vector } });
    let repo = await PostgresRepository.onPglite(engine);
    const hooks1 = webhookRecorder();
    const life1 = createPlatform(config, { repo, llm: null, log: silentLog, rng: seededRandom(1), fetch: hooks1.fetch, transport: deadQueue });
    const agents = await registerPersonas(life1, true);
    const { post } = await life1.publishPost(agents.swiggy, POSTS.swiggyDiwali);
    await life1.handlers['post.published']({ postId: post.id }); // the routing consumer had the event
    await life1.drain();
    assert.equal((await repo.getPost(post.id)).status, 'routed');
    assert.equal(hooks1.calls.length, 0, 'no webhook went out: the delivery events never left the outbox');
    const backlog = await repo.outboxBacklog();
    assert.equal(backlog.pending, 3, 'post.published (never acknowledged) + 2 notification.created');
    await life1.shutdown();
    await engine.close(); // crash

    // Life 2: same database, healthy queue. The relay's first pass publishes the backlog.
    engine = await PGlite.create({ dataDir, extensions: { vector } });
    repo = await PostgresRepository.onPglite(engine);
    const hooks2 = webhookRecorder();
    const life2 = createPlatform(config, { repo, llm: null, log: silentLog, rng: seededRandom(1), fetch: hooks2.fetch });
    await life2.relay.kick();
    await life2.drain();
    const sends = hooks2.calls.filter((c) => c.type === 'post.matched' && c.post === post.id);
    assert.deepEqual(sends.map((c) => c.url).sort(), [hookFor('hdfc'), hookFor('phonepe')], 'PhonePe and HDFC Bank, once each');
    assert.equal((await repo.outboxBacklog()).pending, 0);
    assert.equal((await repo.getPost(post.id)).routing.attempts, 1, 'the replayed post.published did not route the post again');
    await life2.shutdown();
    await engine.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---- Redis Streams ---------------------------------------------------------------------------

async function redisRig(t) {
  const { connectRedis, RedisStreamsTransport } = await import('../src/queue/redis-streams.js');
  const prefix = `agentnet_test_${newId('q').slice(2).toLowerCase()}`;
  const clients = [];
  const client = async () => {
    const c = await connectRedis(REDIS_URL, { log: silentLog });
    clients.push(c);
    return c;
  };
  const publisher = await client();
  t.after(async () => {
    const keys = await publisher.keys(`${prefix}:*`);
    if (keys.length) await publisher.del(keys);
    for (const c of clients) await c.quit().catch(() => {});
  });
  return { prefix, client, publisher, transport: new RedisStreamsTransport({ client: publisher, prefix }) };
}

function memoryLedger() {
  const done = new Set();
  return {
    isProcessed: async (g, id) => done.has(`${g}:${id}`),
    markProcessed: async (g, id) => (done.has(`${g}:${id}`) ? false : (done.add(`${g}:${id}`), true)),
  };
}

const metricsStub = () => {
  const counts = new Map();
  return { inc: (k, n = 1) => counts.set(k, (counts.get(k) ?? 0) + n), get: (k) => counts.get(k) ?? 0 };
};

async function until(predicate, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await sleep(20);
  }
}

test('Redis Streams: the full pipeline runs across the queue (outbox -> stream -> consumer groups)', { skip: NO_REDIS }, async (t) => {
  const { StreamConsumer } = await import('../src/queue/redis-streams.js');
  const rig = await redisRig(t);
  const hooks = webhookRecorder();
  const { platform, agents } = await setup(WEBHOOK_CONFIG, { fetch: hooks.fetch, transport: rig.transport });
  for (const key of ['phonepe', 'hdfc']) await platform.updateAgent(agents[key], { delivery: { webhook_url: hookFor(key) } });
  const consumers = [];
  for (const [type, group] of [['post.published', 'routing'], ['notification.created', 'delivery'], ['comment.created', 'threads']]) {
    consumers.push(
      await new StreamConsumer({ client: await rig.client(), prefix: rig.prefix, type, group, consumer: `${group}-1`, handle: platform.handlers[type], ledger: platform.repo, log: silentLog, metrics: platform.metrics, blockMs: 100 }).start(),
    );
  }
  t.after(() => Promise.all(consumers.map((c) => c.stop())));

  const { post } = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await until(async () => hooks.calls.filter((c) => c.type === 'post.matched').length === 2);
  assert.deepEqual(hooks.calls.filter((c) => c.type === 'post.matched').map((c) => c.url).sort(), [hookFor('hdfc'), hookFor('phonepe')]);
  assert.equal((await platform.repo.getPost(post.id)).status, 'routed');
  assert.equal(platform.metrics.get('stream_events_processed'), 3);
});

test('Redis Streams: an event left unacknowledged by a dead consumer is taken over and handled once', { skip: NO_REDIS }, async (t) => {
  const { StreamConsumer } = await import('../src/queue/redis-streams.js');
  const rig = await redisRig(t);
  const ledger = memoryLedger();
  const metrics = metricsStub();
  const handled = [];
  let dieOnFirst = true;
  const common = { prefix: rig.prefix, type: 'post.published', group: 'routing', ledger, log: silentLog, metrics, claimIdleMs: 200, blockMs: 50 };
  const doomed = new StreamConsumer({
    ...common,
    client: await rig.client(),
    consumer: 'routing-doomed',
    handle: async (payload) => {
      if (dieOnFirst) {
        dieOnFirst = false;
        throw new Error('process killed mid-event'); // never acknowledged
      }
      handled.push(payload.n);
    },
  });
  await doomed.start();
  await rig.transport.publish([{ id: 'evt_a', type: 'post.published', payload: { n: 1 } }]);
  await until(() => metrics.get('stream_events_failed') === 1);
  await doomed.stop(); // the consumer is gone; its pending event stays in the group

  const survivor = await new StreamConsumer({ ...common, client: await rig.client(), consumer: 'routing-survivor', handle: async (p) => handled.push(p.n) }).start();
  t.after(() => survivor.stop());
  await until(() => handled.length === 1);
  await sleep(400);
  assert.deepEqual(handled, [1], 'handled once, by the survivor');
  assert.equal(metrics.get('stream_events_reclaimed'), 1);
  const pending = await rig.publisher.xPending(`${rig.prefix}:events:post.published`, 'routing');
  assert.equal(Number(pending.pending), 0, 'nothing left unacknowledged');
});

test('Redis Streams: a poison event is dead-lettered after maxDeliveries; duplicates are skipped by the ledger', { skip: NO_REDIS }, async (t) => {
  const { StreamConsumer, deadLetterKey } = await import('../src/queue/redis-streams.js');
  const rig = await redisRig(t);
  const metrics = metricsStub();
  const handled = [];
  const consumer = await new StreamConsumer({
    client: await rig.client(),
    prefix: rig.prefix,
    type: 'comment.created',
    group: 'threads',
    consumer: 'threads-1',
    ledger: memoryLedger(),
    log: silentLog,
    metrics,
    maxDeliveries: 3,
    claimIdleMs: 50,
    blockMs: 30,
    handle: async (p) => {
      if (p.poison) throw new Error('cannot handle this event');
      handled.push(p.n);
    },
  }).start();
  t.after(() => consumer.stop());
  await rig.transport.publish([
    { id: 'evt_poison', type: 'comment.created', payload: { poison: true } },
    { id: 'evt_ok', type: 'comment.created', payload: { n: 1 } },
    { id: 'evt_ok', type: 'comment.created', payload: { n: 1 } }, // the relay published it twice
  ]);
  await until(() => metrics.get('stream_events_dead_lettered') === 1, 10_000);
  assert.deepEqual(handled, [1], 'the duplicate was skipped');
  assert.equal(metrics.get('stream_events_duplicates_skipped'), 1);
  const dead = await rig.publisher.xRange(deadLetterKey(rig.prefix, 'comment.created'), '-', '+');
  assert.equal(dead.length, 1);
  assert.equal(dead[0].message.event_id, 'evt_poison');
});

test('Redis Streams: events published while no consumer runs are processed when one starts (and stop is graceful)', { skip: NO_REDIS }, async (t) => {
  const { StreamConsumer } = await import('../src/queue/redis-streams.js');
  const rig = await redisRig(t);
  const handled = [];
  const make = async (name) =>
    new StreamConsumer({
      client: await rig.client(),
      prefix: rig.prefix,
      type: 'notification.created',
      group: 'delivery',
      consumer: name,
      ledger: memoryLedger(),
      log: silentLog,
      metrics: metricsStub(),
      blockMs: 50,
      handle: async (p) => {
        await sleep(30);
        handled.push(p.n);
      },
    }).start();
  const first = await make('delivery-1');
  await first.stop(); // the group exists; nobody is consuming
  await rig.transport.publish(Array.from({ length: 5 }, (_, i) => ({ id: `evt_${i}`, type: 'notification.created', payload: { n: i } })));
  const second = await make('delivery-2'); // e.g. after a deploy
  await until(() => handled.length === 5);
  const stopping = second.stop();
  await stopping;
  assert.deepEqual(handled, [0, 1, 2, 3, 4], 'in order, each once');
});
