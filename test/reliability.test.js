// P1 reliability regression tests: external-service failures, retries, recovery and fan-out bounds.
// Section headers name the P1 requirement each group covers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLlm } from '../src/llm/claude.js';
import { createHttpServer } from '../src/http/server.js';
import { Dispatcher } from '../src/delivery/dispatcher.js';
import { POSTS } from '../demo/personas.js';
import { TEST_ADMIN_KEY, publishAndRoute, reload, setup, silentLog, tierOf } from './helpers.js';

const FAST_RECOVERY = { recovery: { retryBaseMs: 5, retryMaxMs: 20, maxRoutingAttempts: 3 } };

/** Replaces router.route with a wrapper; `behaviour(call, original)` decides what each call does. */
function interceptRoute(platform, behaviour) {
  const original = platform.router.route.bind(platform.router);
  let calls = 0;
  platform.router.route = (...args) => behaviour(++calls, () => original(...args));
  return () => calls;
}

/** Notifications of one event type for a post, grouped by agent id -> count. */
async function notificationsPerAgent(platform, postId, event = 'post.matched') {
  const counts = {};
  for (const n of await platform.repo.notificationsForPost(postId)) {
    if (n.event === event) counts[n.agent_id] = (counts[n.agent_id] ?? 0) + 1;
  }
  return counts;
}

async function startAdminApi(platform) {
  const server = createHttpServer(platform);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'x-admin-key': TEST_ADMIN_KEY, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { admin, close: () => new Promise((r) => server.close(r)) };
}

// ---- P1.1 / P1.2  LLM timeouts, per-post deadlines, exception fallback -----------------------

for (const [label, json] of [
  ['async rejection', async () => { throw new Error('provider exploded'); }],
  ['synchronous throw', () => { throw new Error('client bug'); }],
]) {
  test(`LLM failure (${label}) falls back to the rules path and the post is still routed`, async () => {
    const { platform, agents } = await setup({}, { llm: { json } });
    const { post, routing } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
    const stored = await platform.repo.getPost(post.id);
    assert.equal(stored.status, 'routed');
    assert.equal(stored.enrichment.source, 'rules');
    assert.equal(tierOf(routing, agents.phonepe), 'push');
    assert.equal(tierOf(routing, agents.hdfc), 'push');
    assert.equal(platform.metrics.get('llm_errors'), 2, 'enrichment and judge both failed safely');
  });
}

test('a hanging LLM call is abandoned at the per-call timeout and told to abort', async () => {
  let aborted = 0;
  const json = ({ signal }) =>
    new Promise(() => {
      signal.addEventListener('abort', () => aborted++); // never settles, even after the abort
    });
  const { platform, agents } = await setup({ llm: { timeoutMs: 50, postBudgetMs: 5_000 } }, { llm: { json } });
  const started = performance.now();
  const { post, routing } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const elapsed = performance.now() - started;

  assert.equal((await platform.repo.getPost(post.id)).status, 'routed');
  assert.ok(elapsed < 1_000, `routed in ${Math.round(elapsed)} ms`);
  assert.equal(platform.metrics.get('llm_timeouts'), 2, 'enrichment and judge each timed out once');
  assert.equal(aborted, 2);
  assert.equal(tierOf(routing, agents.phonepe), 'push');
});

test('all LLM stages of a post share one deadline: a slow enrichment leaves no time for the judge', async () => {
  const json = ({ signal }) =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 300);
      signal.addEventListener('abort', () => clearTimeout(t));
    });
  const { platform, agents } = await setup({ llm: { timeoutMs: 5_000, postBudgetMs: 100 } }, { llm: { json } });
  const started = performance.now();
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const elapsed = performance.now() - started;

  assert.equal((await platform.repo.getPost(post.id)).status, 'routed');
  assert.ok(elapsed < 600, `routed in ${Math.round(elapsed)} ms despite a 5 s per-call timeout`);
  assert.equal(platform.metrics.get('llm_timeouts'), 1, 'enrichment was cut at the post deadline');
  assert.equal(platform.metrics.get('llm_skipped_deadline'), 1, 'the judge was skipped, not started');
});

test('malformed LLM output is ignored instead of crashing routing', async () => {
  const json = async ({ schema }) =>
    schema.properties.partner_industries
      ? { topics: 'payments', partner_industries: { industry: 'insurance' }, risk: 'yes', summary: 42 }
      : { verdicts: 'none' };
  const { platform, agents } = await setup({}, { llm: { json } });
  const { post, routing } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const stored = await platform.repo.getPost(post.id);
  assert.equal(stored.status, 'routed');
  assert.deepEqual(stored.enrichment.seeks.map((s) => s.industry), ['payments', 'banking'], 'nothing malformed was merged');
  assert.equal(tierOf(routing, agents.hdfc), 'push');

  const { platform: p2, agents: a2 } = await setup({}, { llm: { json: async () => ['not', 'an', 'object'] } });
  const second = await publishAndRoute(p2, a2.swiggy, POSTS.swiggyDiwali);
  assert.equal((await p2.repo.getPost(second.post.id)).status, 'routed');
  assert.equal(p2.metrics.get('llm_invalid_results'), 2);
});

test('Claude adapter: passes SDK timeout and retry limits, honours abort signals, and returns null on refusals, bad JSON and SDK failures', async () => {
  const calls = [];
  let factoryOptions;
  let reply;
  const client = { beta: { messages: { create: (params, options) => (calls.push({ params, options }), reply(options)) } } };
  const config = { llm: { provider: 'claude', model: 'claude-opus-5-5', timeoutMs: 1234, maxRetries: 1 } };
  const llm = createLlm(config, silentLog, {
    clientFactory: (options) => {
      factoryOptions = options;
      return client;
    },
  });
  const ask = (extra = {}) => llm.json({ system: 's', prompt: 'p', schema: { type: 'object' }, ...extra });

  reply = async () => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"ok":true}' }] });
  assert.deepEqual(await ask(), { ok: true });
  assert.deepEqual(factoryOptions, { timeout: 1234, maxRetries: 1 });
  assert.equal(calls[0].options.timeout, 1234);
  assert.equal(calls[0].params.output_config.format.type, 'json_schema');

  reply = async () => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] });
  assert.equal(await ask(), null);
  reply = async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] });
  assert.equal(await ask(), null);

  // A request in flight is aborted through the signal the adapter forwards to the SDK.
  reply = (options) =>
    new Promise((_, reject) => {
      if (options.signal.aborted) reject(new Error('aborted'));
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const controller = new AbortController();
  const callsBefore = calls.length;
  const pending = ask({ signal: controller.signal, timeoutMs: 50 });
  await new Promise((r) => setImmediate(r)); // let the request reach the SDK
  assert.equal(calls.length, callsBefore + 1, 'request was sent');
  assert.equal(calls.at(-1).options.timeout, 50, 'the per-call budget is forwarded to the SDK');
  controller.abort();
  assert.equal(await pending, null);

  // A request whose signal is already aborted is never sent.
  const before = calls.length;
  assert.equal(await ask({ signal: AbortSignal.abort() }), null);
  assert.equal(calls.length, before);

  const broken = createLlm(config, silentLog, {
    clientFactory: () => {
      throw new Error('cannot load @anthropic-ai/sdk');
    },
  });
  assert.equal(await broken.json({ system: 's', prompt: 'p', schema: {} }), null);
});

// ---- P1.3 / P1.4  No post stays in `routing`: bounded retries and recovery -------------------

test('a transient routing failure is retried with backoff and the post is routed exactly once', async () => {
  const { platform, agents } = await setup(FAST_RECOVERY);
  const calls = interceptRoute(platform, (n, original) => (n === 1 ? Promise.reject(new Error('vector index unavailable')) : original()));
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);

  const stored = await platform.repo.getPost(post.id);
  assert.equal(stored.status, 'routed');
  assert.equal(stored.routing.attempts, 2);
  assert.equal(calls(), 2);
  assert.equal(platform.metrics.get('post_routing_retries'), 1);
  assert.deepEqual(await notificationsPerAgent(platform, post.id), { [agents.phonepe.id]: 1, [agents.hdfc.id]: 1 });
});

test('retries are bounded: a persistently failing post is parked as failed, then an operator reroute recovers it', async () => {
  const { platform, agents } = await setup(FAST_RECOVERY);
  let broken = true;
  interceptRoute(platform, (n, original) => (broken ? Promise.reject(new Error('router bug')) : original()));
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);

  const stored = await platform.repo.getPost(post.id);
  assert.equal(stored.status, 'failed', 'not left in routing');
  assert.equal(stored.routing.attempts, 3);
  assert.equal(stored.routing.last_error, 'router bug');
  assert.deepEqual(await notificationsPerAgent(platform, post.id), {});

  const api = await startAdminApi(platform);
  try {
    const failed = await api.admin('GET', '/v1/admin/posts/failed');
    assert.deepEqual(failed.body.posts.map((p) => [p.id, p.status]), [[post.id, 'failed']]);

    broken = false; // the underlying problem is fixed
    const rerouted = await api.admin('POST', `/v1/admin/posts/${post.id}/reroute`);
    assert.equal(rerouted.status, 200);
    assert.equal(rerouted.body.status, 'routed');
    await platform.drain();
    assert.deepEqual(await notificationsPerAgent(platform, post.id), { [agents.phonepe.id]: 1, [agents.hdfc.id]: 1 });
    assert.equal((await api.admin('POST', `/v1/admin/posts/${post.id}/reroute`)).status, 409, 'a routed post cannot be rerouted');
  } finally {
    await api.close();
  }
});

test('a failure part-way through notifying does not duplicate notifications on retry', async () => {
  const { platform, agents } = await setup(FAST_RECOVERY);
  const insert = platform.repo.insertMatchedNotifications.bind(platform.repo);
  let failed = false;
  platform.repo.insertMatchedNotifications = async (list, options) => {
    if (!failed && list.length > 1) {
      // The first attempt writes one notification, then the store fails (or the worker dies).
      failed = true;
      await insert(list.slice(0, 1), options);
      throw new Error('store write failed');
    }
    return insert(list, options);
  };
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);

  const stored = await platform.repo.getPost(post.id);
  assert.equal(stored.status, 'routed');
  assert.equal(stored.routing.attempts, 2);
  assert.deepEqual(await notificationsPerAgent(platform, post.id), { [agents.phonepe.id]: 1, [agents.hdfc.id]: 1 });
  assert.equal((await platform.repo.getRoutingLog(post.id)).filtered_out.already_notified, 1, 'the agent notified before the failure was skipped');
});

test('a hung routing attempt is cut off by the watchdog and retried', async () => {
  const warnings = [];
  const log = { ...silentLog, warn: (msg, fields) => warnings.push({ msg, ...fields }) };
  const { platform, agents } = await setup({ ...FAST_RECOVERY, recovery: { ...FAST_RECOVERY.recovery, processingTimeoutMs: 50 } }, { log });
  interceptRoute(platform, (n, original) => (n === 1 ? new Promise(() => {}) : original()));
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const stored = await platform.repo.getPost(post.id);
  assert.equal(stored.status, 'routed');
  assert.equal(stored.routing.attempts, 2);
  const retry = warnings.find((w) => w.msg === 'post routing failed; retry scheduled');
  assert.equal(retry?.error, 'routing attempt exceeded 50 ms');
});

// ---- P1.5 / P1.6  Scheduled webhook retries, dead-letter queue, redelivery -------------------

/** A controllable fake webhook endpoint keyed by URL. */
function fakeEndpoints() {
  const log = [];
  const behaviour = new Map(); // url -> (call) => Response | Promise
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url, init) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const call = { url, event: JSON.parse(init.body), delivery: init.headers['x-agentnet-delivery'], attempt: Number(init.headers['x-agentnet-attempt']) };
      log.push(call);
      const respond = behaviour.get(url) ?? (() => new Response('ok', { status: 200 }));
      return await respond(call, init);
    } finally {
      inFlight--;
    }
  };
  return {
    fetch,
    log,
    behaviour,
    maxInFlight: () => maxInFlight,
    resetMaxInFlight: () => {
      maxInFlight = inFlight;
    },
  };
}

const HOOK = 'http://agent.phonepe.example/hook';

/** Waits (keeping the event loop alive) until the agent's match for the post is being delivered. */
async function untilInFlight(platform, postId, agentId, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while ((await platform.repo.matchFor(postId, agentId))?.status !== 'delivering') {
    if (Date.now() > end) throw new Error('delivery never started');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const FAST_DELIVERY = { allowInsecureWebhooks: true, delivery: { baseBackoffMs: 2, maxBackoffMs: 20, maxAttempts: 3, breakerThreshold: 100 } };

async function phonepeWithWebhook(overrides, endpoints) {
  const { platform, agents } = await setup({ ...FAST_DELIVERY, ...overrides, delivery: { ...FAST_DELIVERY.delivery, ...overrides?.delivery } }, { fetch: endpoints.fetch });
  await platform.updateAgent(agents.phonepe, { delivery: { webhook_url: HOOK } });
  return { platform, agents };
}

test('webhook backoff is exponential with equal jitter, honours Retry-After and is capped', () => {
  const make = (rng) => new Dispatcher({ repo: {}, config: { delivery: { baseBackoffMs: 100, maxBackoffMs: 1_000 } }, metrics: {}, log: silentLog, scheduler: {}, envelope: () => ({}), rng });
  const low = make(() => 0);
  const high = make(() => 0.999999);
  assert.deepEqual([1, 2, 3].map((a) => low.backoff(a)), [50, 100, 200], 'lower bound is half the exponential delay');
  assert.deepEqual([1, 2, 3].map((a) => Math.round(high.backoff(a))), [100, 200, 400], 'upper bound is the full delay');
  assert.ok(high.backoff(10) <= 1_000 && low.backoff(10) === 500, 'the exponential part is capped at maxBackoffMs');
  assert.equal(low.backoff(1, 700), 700, 'Retry-After raises the delay');
  assert.equal(low.backoff(1, 60_000), 1_000, 'Retry-After is capped too');
});

test('a failed webhook is retried later by the scheduler, with the same delivery id, and delivered once', async () => {
  const endpoints = fakeEndpoints();
  let failures = 2;
  endpoints.behaviour.set(HOOK, () => (failures-- > 0 ? new Response('busy', { status: 503 }) : new Response('ok', { status: 200 })));
  const { platform, agents } = await phonepeWithWebhook({}, endpoints);

  const { post } = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await platform.bus.drain(); // routing and the first attempt are done; no worker is sleeping
  let n = await platform.repo.matchFor(post.id, agents.phonepe.id);
  assert.equal(n.status, 'retry_scheduled');
  assert.ok(n.delivery.next_attempt_at, 'next attempt is scheduled, and persisted');
  assert.equal(platform.bus.pending.size, 0);

  await platform.drain();
  n = await platform.repo.getNotification(n.id);
  assert.equal(n.status, 'delivered');
  assert.equal(n.delivery.attempts, 3);
  const calls = endpoints.log.filter((c) => c.delivery === n.id);
  assert.deepEqual(calls.map((c) => c.attempt), [1, 2, 3]);
  assert.equal(new Set(calls.map((c) => c.delivery)).size, 1, 'one stable delivery id across retries');

  await platform.dispatcher.attempt(n.id); // a stray extra attempt after delivery sends nothing
  assert.equal(endpoints.log.filter((c) => c.delivery === n.id).length, 3);
});

test('retry exhaustion dead-letters the delivery; redelivery after the endpoint recovers delivers it exactly once', async () => {
  const endpoints = fakeEndpoints();
  let down = true;
  endpoints.behaviour.set(HOOK, () => new Response(down ? 'down' : 'ok', { status: down ? 503 : 200 }));
  const { platform, agents } = await phonepeWithWebhook({}, endpoints);
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const n = await platform.repo.matchFor(post.id, agents.phonepe.id);
  assert.equal(n.status, 'failed');
  assert.equal(n.delivery.attempts, 3);

  const api = await startAdminApi(platform);
  try {
    const dlq = await api.admin('GET', `/v1/admin/dead-letters?agent_id=${agents.phonepe.id}`);
    assert.deepEqual(dlq.body.dead_letters.map((d) => [d.notification_id, d.reason, d.attempts]), [[n.id, 'retries_exhausted', 3]]);
    assert.ok((await platform.inbox(agents.phonepe)).notifications.some((x) => x.id === n.id), 'still available through the inbox');

    down = false;
    const redelivered = await api.admin('POST', `/v1/admin/dead-letters/${n.id}/redeliver`);
    assert.deepEqual([redelivered.status, redelivered.body.status], [200, 'delivered']);
    assert.equal((await platform.repo.deadLetters()).length, 0);
    const successes = endpoints.log.filter((c) => c.delivery === n.id && c.attempt === 1).length;
    assert.equal(successes, 2, 'first cycle attempt 1 and the redelivery attempt 1');
    assert.equal((await api.admin('POST', `/v1/admin/dead-letters/${n.id}/redeliver`)).status, 409, 'a delivered notification cannot be redelivered');
  } finally {
    await api.close();
  }
});

test('bulk redelivery and endpoint changes drain an agent’s dead-letter queue', async () => {
  const endpoints = fakeEndpoints();
  endpoints.behaviour.set(HOOK, () => new Response('gone', { status: 404 })); // permanent: dead-lettered at once
  const { platform, agents } = await phonepeWithWebhook({}, endpoints);
  await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  await publishAndRoute(platform, agents.swiggy, POSTS.swiggyNavratri);
  assert.deepEqual((await platform.deadLetters()).dead_letters.map((d) => d.reason), ['rejected_by_endpoint', 'rejected_by_endpoint']);

  // The agent moves to a working endpoint: its dead letters are redelivered there automatically.
  await platform.updateAgent(agents.phonepe, { delivery: { webhook_url: 'http://agent.phonepe.example/v2' } });
  await platform.drain();
  assert.equal((await platform.repo.deadLetters()).length, 0);
  const v2 = endpoints.log.filter((c) => c.url.endsWith('/v2'));
  assert.equal(v2.length, 2);
  const phonepeItems = await platform.repo.inbox(agents.phonepe.id, { limit: 100 });
  assert.ok(phonepeItems.length === 2 && phonepeItems.every((x) => x.status === 'delivered'));

  // Bulk redelivery through the admin API.
  endpoints.behaviour.set('http://agent.phonepe.example/v2', () => new Response('gone', { status: 410 }));
  await publishAndRoute(platform, agents.flipkart, POSTS.flipkartSale); // PhonePe gets a digest here, HDFC a push
  await platform.updateAgent(agents.hdfc, { delivery: { webhook_url: HOOK } });
  await publishAndRoute(platform, agents.bajaj, POSTS.bajajLaunch); // HDFC push -> 404 on HOOK
  assert.equal((await platform.repo.deadLetters()).length, 1);
  endpoints.behaviour.set(HOOK, () => new Response('ok', { status: 200 }));
  const api = await startAdminApi(platform);
  try {
    const res = await api.admin('POST', '/v1/admin/dead-letters/redeliver', { agent_id: agents.hdfc.id });
    assert.deepEqual(res.body, { requeued: 1, delivered_immediately: 1 });
  } finally {
    await api.close();
  }
});

test('circuit-breaker deferrals are re-scheduled and delivered when the endpoint recovers, one probe at a time', async () => {
  const endpoints = fakeEndpoints();
  let down = true;
  endpoints.behaviour.set(HOOK, async () => {
    await new Promise((r) => setTimeout(r, 10));
    return new Response(down ? 'down' : 'ok', { status: down ? 503 : 200 });
  });
  const { platform, agents } = await phonepeWithWebhook({ delivery: { breakerThreshold: 1, breakerCooldownMs: 40, maxAttempts: 10 } }, endpoints);

  await Promise.all([platform.publishPost(agents.swiggy, POSTS.swiggyDiwali), platform.publishPost(agents.swiggy, POSTS.swiggyNavratri)]);
  await platform.bus.drain(); // both first attempts failed (concurrently, the circuit was still closed); it is now open
  endpoints.resetMaxInFlight();
  setTimeout(() => (down = false), 60);
  await platform.drain();

  const mine = await platform.repo.inbox(agents.phonepe.id, { limit: 100 });
  assert.equal(mine.length, 2);
  assert.ok(mine.every((x) => x.status === 'delivered'), mine.map((x) => x.status).join(','));
  assert.ok(platform.metrics.get('webhook_deferred_circuit_open') >= 1, 'deliveries were deferred while the circuit was open');
  assert.equal(endpoints.maxInFlight(), 1, 'once the circuit opened, only single probes reached the struggling endpoint');
});

test('external failures: timeouts and refused connections are retried, then dead-lettered with the cause', async () => {
  const endpoints = fakeEndpoints();
  endpoints.behaviour.set(HOOK, (call, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
  const { platform, agents } = await phonepeWithWebhook({ delivery: { timeoutMs: 20, maxAttempts: 2 } }, endpoints);
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const n = await platform.repo.matchFor(post.id, agents.phonepe.id);
  assert.deepEqual([n.status, n.delivery.attempts, n.delivery.last_error], ['failed', 2, 'timeout']);

  // Real transport against a port where nothing listens.
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const real = await setup({ ...FAST_DELIVERY, delivery: { ...FAST_DELIVERY.delivery, maxAttempts: 2 } });
  await real.platform.updateAgent(real.agents.phonepe, { delivery: { webhook_url: `http://127.0.0.1:${port}/hook` } });
  const routed = await publishAndRoute(real.platform, real.agents.swiggy, POSTS.swiggyDiwali);
  const refused = await real.platform.repo.matchFor(routed.post.id, real.agents.phonepe.id);
  assert.equal(refused.status, 'failed');
  assert.equal(refused.delivery.attempts, 2);
  assert.match(refused.delivery.last_error, /ECONNREFUSED/);
  assert.equal(refused.delivery.dead_letter.reason, 'retries_exhausted');
});

test('deliveries that cannot complete within maxDeliveryAgeMs are dead-lettered as expired', async () => {
  const endpoints = fakeEndpoints();
  endpoints.behaviour.set(HOOK, () => new Response('down', { status: 503 }));
  const { platform, agents } = await phonepeWithWebhook({ delivery: { maxAttempts: 1_000, baseBackoffMs: 5, maxBackoffMs: 5, maxDeliveryAgeMs: 40 } }, endpoints);
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const n = await platform.repo.matchFor(post.id, agents.phonepe.id);
  assert.equal(n.status, 'failed');
  assert.equal(n.delivery.dead_letter.reason, 'expired');
});

test('concurrent attempts for the same notification send a single request', async () => {
  const endpoints = fakeEndpoints();
  let release;
  endpoints.behaviour.set(HOOK, () => new Promise((resolve) => (release = () => resolve(new Response('ok', { status: 200 })))));
  const { platform, agents } = await phonepeWithWebhook({}, endpoints);
  const { post } = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await untilInFlight(platform, post.id, agents.phonepe.id); // the first attempt is now in flight
  const { id } = await platform.repo.matchFor(post.id, agents.phonepe.id);
  await Promise.all([platform.dispatcher.attempt(id), platform.dispatcher.attempt(id)]);
  release();
  await platform.drain();
  assert.equal(endpoints.log.filter((c) => c.delivery === id).length, 1);
  assert.equal((await platform.repo.getNotification(id)).status, 'delivered');
});

test('two attempts that both pass their checks race for the claim; exactly one sends', async () => {
  // Models two delivery workers picking up the same due retry: neither holds the other's lock.
  const endpoints = fakeEndpoints();
  let failures = 1;
  endpoints.behaviour.set(HOOK, () => (failures-- > 0 ? new Response('busy', { status: 503 }) : new Response('ok', { status: 200 })));
  const { platform, agents } = await phonepeWithWebhook({ delivery: { baseBackoffMs: 60_000, maxBackoffMs: 60_000 } }, endpoints);
  const { post } = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await platform.bus.drain();
  const { id, status } = await platform.repo.matchFor(post.id, agents.phonepe.id);
  assert.equal(status, 'retry_scheduled');
  const workerB = new Dispatcher({
    repo: platform.repo,
    config: platform.config,
    metrics: platform.metrics,
    log: silentLog,
    scheduler: platform.scheduler,
    envelope: platform.dispatcher.envelope,
    fetchImpl: endpoints.fetch,
  });
  await Promise.all([platform.dispatcher.attempt(id), workerB.attempt(id)]);
  assert.equal(endpoints.log.filter((c) => c.delivery === id).length, 2, 'first attempt + exactly one of the two racing retries');
  assert.equal((await platform.repo.getNotification(id)).status, 'delivered');
  platform.scheduler.stop();
});

// ---- P1.7  Quarantine retracts the post everywhere ------------------------------------------

/** Independent verified reports put the post under review; a moderator upholds them (quarantine). */
async function reportAndUphold(platform, agents, postId) {
  for (const reporter of [agents.flipkart, agents.delhivery, agents.makemytrip]) await platform.report(reporter, postId, { reason: 'false_claim' });
  assert.equal((await platform.repo.getPost(postId)).status, 'under_review');
  await platform.reviewPost(postId, { decision: 'uphold' });
}

async function quarantineByReports(platform, agents, postId) {
  await reportAndUphold(platform, agents, postId);
  await platform.drain();
  assert.equal((await platform.repo.getPost(postId)).status, 'quarantined');
}

const inboxFor = async (platform, agent) => (await platform.inbox(agent)).notifications;

test('a quarantined post disappears from every inbox; each notified agent gets one content-free retraction', async () => {
  const endpoints = fakeEndpoints();
  const { platform, agents } = await phonepeWithWebhook({}, endpoints); // PhonePe: webhook; HDFC: inbox only
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  await platform.addComment(agents.phonepe, post.id, { body: 'PhonePe can add ₹50 cashback.' });
  await platform.addComment(agents.hdfc, post.id, { body: 'HDFC Bank can add a card discount.' }); // PhonePe now also has a thread notification
  await platform.drain();
  assert.ok((await inboxFor(platform, agents.phonepe)).some((x) => x.post.id === post.id && x.event === 'post.matched'));

  await quarantineByReports(platform, agents, post.id);

  for (const agent of [agents.phonepe, agents.hdfc, agents.swiggy]) {
    const items = (await inboxFor(platform, agent)).filter((x) => x.post.id === post.id);
    assert.deepEqual(items.map((x) => x.event), ['post.retracted'], `${agent.company}: only the retraction remains`);
    assert.equal(JSON.stringify(items).includes(POSTS.swiggyDiwali.title), false, 'no post content in the inbox');
  }
  const pushed = endpoints.log.filter((c) => c.event.type === 'post.retracted');
  assert.equal(pushed.length, 1, 'PhonePe was told once, by webhook, although it held two notifications');
  assert.deepEqual(Object.keys(pushed[0].event.data.post), ['id', 'status']);
  for (const n of await platform.repo.notificationsForPost(post.id)) {
    if (n.event !== 'post.retracted') assert.equal(n.status, 'retracted');
  }
  await assert.rejects(platform.getPost(post.id, agents.phonepe), /not found/);
});

test('retraction cancels scheduled webhook retries and removes dead letters for the post', async () => {
  const endpoints = fakeEndpoints();
  endpoints.behaviour.set(HOOK, (call) => new Response(call.event.type === 'post.retracted' ? 'ok' : 'down', { status: call.event.type === 'post.retracted' ? 200 : 503 }));
  const { platform, agents } = await phonepeWithWebhook({ delivery: { baseBackoffMs: 200, maxBackoffMs: 200, maxAttempts: 5 } }, endpoints);
  await platform.updateAgent(agents.hdfc, { delivery: { webhook_url: 'http://agent.hdfc.example/hook' } });
  endpoints.behaviour.set('http://agent.hdfc.example/hook', () => new Response('gone', { status: 410 }));

  const { post } = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await platform.bus.drain();
  const phonepe = await platform.repo.matchFor(post.id, agents.phonepe.id);
  const hdfc = await platform.repo.matchFor(post.id, agents.hdfc.id);
  assert.equal(phonepe.status, 'retry_scheduled');
  assert.equal(hdfc.status, 'failed');
  const deadLettered = async (id) => (await platform.repo.deadLetters()).some((d) => d.id === id);
  assert.ok(await deadLettered(hdfc.id));

  await quarantineByReports(platform, agents, post.id); // drain returns quickly: the 200 ms retry was cancelled
  await new Promise((r) => setTimeout(r, 300));
  const attemptsOnOriginal = endpoints.log.filter((c) => c.delivery === phonepe.id).length;
  assert.equal(attemptsOnOriginal, 1, 'the scheduled retry never ran');
  assert.equal((await platform.repo.getNotification(phonepe.id)).status, 'retracted');
  assert.equal(await deadLettered(hdfc.id), false);
  await assert.rejects(platform.redeliverDeadLetter(hdfc.id), { status: 409 });
});

test('a delivery in flight when its post is retracted is not recorded as delivered', async () => {
  const endpoints = fakeEndpoints();
  let release;
  endpoints.behaviour.set(HOOK, (call) =>
    call.event.type === 'post.matched' ? new Promise((resolve) => (release = () => resolve(new Response('ok', { status: 200 })))) : new Response('ok', { status: 200 }),
  );
  const { platform, agents } = await phonepeWithWebhook({}, endpoints);
  const { post } = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await untilInFlight(platform, post.id, agents.phonepe.id);
  const n = await platform.repo.matchFor(post.id, agents.phonepe.id);
  assert.equal(n.status, 'delivering');

  await reportAndUphold(platform, agents, post.id);
  release();
  await platform.drain();
  assert.equal((await platform.repo.getNotification(n.id)).status, 'retracted');
  assert.equal(endpoints.log.filter((c) => c.event.type === 'post.retracted').length, 1, 'PhonePe is told to discard what it received');
});

test('a retraction landing between a delivery attempt’s read and its write is never undone', async () => {
  const endpoints = fakeEndpoints();
  const { platform, agents } = await phonepeWithWebhook({ delivery: { reviewHoldMs: 60_000 } }, endpoints);
  const { post } = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await platform.drain();
  const n = await platform.repo.matchFor(post.id, agents.phonepe.id);
  // Put the notification back in the retry queue and the post under review, then retract the
  // notification exactly while the next attempt is looking the post up.
  await platform.repo.saveDeliveryState({ ...n, status: 'retry_scheduled' });
  await platform.repo.mutatePost(post.id, (p) => void (p.status = 'under_review'));
  const getPost = platform.repo.getPost.bind(platform.repo);
  platform.repo.getPost = async (id) => {
    const p = await getPost(id);
    await platform.dispatcher.cancel(await platform.repo.getNotification(n.id), 'retracted', 'post_quarantined');
    return p;
  };
  await platform.dispatcher.attempt(n.id); // would defer the delivery for review...
  platform.repo.getPost = getPost;
  const after = await platform.repo.getNotification(n.id);
  assert.equal(after.status, 'retracted', '...but the retraction that happened meanwhile wins');
  assert.equal(after.delivery.next_attempt_at, null);
  platform.scheduler.stop();
});

test('a post taken down while its routing attempt is notifying is retracted from the notifications just created', async () => {
  const { platform, agents } = await setup();
  const insert = platform.repo.insertMatchedNotifications.bind(platform.repo);
  platform.repo.insertMatchedNotifications = async (list, options) => {
    const result = await insert(list, options);
    // Another process takes the post down between the notification writes and the routed
    // transition; its retraction ran before these notifications existed.
    await platform.repo.mutatePost(list[0].post_id, (p) => {
      p.status = 'quarantined';
      p.safety = { ...p.safety, action: 'quarantine', quarantine_reason: 'reports_upheld' };
    });
    return result;
  };
  const { post } = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await platform.drain();
  const stored = await platform.repo.getPost(post.id);
  assert.equal(stored.status, 'quarantined', 'the routed transition did not overwrite the takedown');
  const notifications = await platform.repo.notificationsForPost(post.id);
  assert.ok(notifications.length > 0);
  for (const n of notifications) {
    if (n.event === 'post.matched') assert.equal(n.status, 'retracted', `${n.agent_id}: no live notification of a taken-down post`);
  }
  assert.deepEqual(
    notifications.filter((n) => n.event === 'post.retracted').map((n) => n.agent_id).sort(),
    notifications.filter((n) => n.event === 'post.matched').map((n) => n.agent_id).sort(),
    'every notified agent is told once',
  );
});

// ---- P1.8  Candidate and digest fan-out limits ------------------------------------------------

test('candidate generation and digest fan-out are capped on a large, broadly-interested population', async () => {
  const { platform, agents } = await setup({ routing: { maxCandidates: 60, maxDigestPerPost: 10 } });
  for (let i = 0; i < 300; i++) {
    await platform.registerAgent({
      company: `Broad Interest ${i}`,
      domain: `broad${i}.example`,
      industry: 'other',
      description: 'Synthetic agent that is interested in almost everything.',
      interests: ['Festive food delivery offers, payment cashback partnerships and card discounts', 'Logistics capacity and e-commerce sale volumes'],
    });
  }
  const { routing } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  assert.equal(routing.counts.candidates, 60);
  assert.ok(routing.counts.candidates_trimmed >= 240, `trimmed ${routing.counts.candidates_trimmed}`);
  assert.ok(routing.counts.push <= 25);
  assert.equal(routing.counts.digest, 10);
  assert.ok(routing.decisions.filter((d) => d.capped === 'post_digest_cap').length > 0);
  assert.ok(routing.decisions.some((d) => d.agent_id === agents.phonepe.id), 'partner-fit agents survive the candidate cut');
  const created = (await platform.repo.notificationsForPost(routing.post_id)).length;
  assert.equal(created, routing.counts.push + routing.counts.digest, 'notifications created match the bounded decisions');
});

test('explicit subscribers still get their digest when the per-post digest cap is reached', async () => {
  const { platform, agents } = await setup({ routing: { maxDigestPerPost: 0 } });
  await platform.subscribe(agents.makemytrip, { kind: 'agent', target: agents.flipkart.id });
  const { routing } = await publishAndRoute(platform, agents.flipkart, POSTS.flipkartSale);
  const decision = (agent) => routing.decisions.find((d) => d.agent_id === agent.id);
  assert.equal(decision(agents.makemytrip).tier, 'digest', 'requested by subscription');
  assert.deepEqual([decision(agents.phonepe).tier, decision(agents.phonepe).capped], ['none', 'post_digest_cap']);
});

test('each agent’s daily digest budget is enforced', async () => {
  const { platform, agents } = await setup();
  await platform.updateAgent(agents.makemytrip, { delivery: { max_digest_per_day: 1 } });
  await platform.subscribe(agents.makemytrip, { kind: 'agent', target: agents.swiggy.id });
  const first = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const second = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyNavratri);
  assert.equal(tierOf(first.routing, agents.makemytrip), 'digest');
  const d = second.routing.decisions.find((x) => x.agent_id === agents.makemytrip.id);
  assert.deepEqual([d.tier, d.capped], ['none', 'agent_digest_budget']);
});

// ---- P1.9 / P1.10 / P1.11  Learning safeguards ------------------------------------------------

test('an agent that comments repeatedly without being notified counts as one missed match', async () => {
  const { platform, agents } = await setup();
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const updates = async () => (await platform.learner.model()).updates;
  const before = await updates();
  for (let i = 1; i <= 3; i++) await platform.addComment(agents.flipkart, post.id, { body: `Flipkart follow-up number ${i}.` });
  assert.equal(platform.metrics.get('engagements_organic_missed_match'), 1);
  assert.equal((await updates()) - before, 1);
});

test('concurrent comments by an un-notified agent still count as one missed match', async () => {
  const { platform, agents } = await setup();
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const before = (await platform.learner.model()).updates;
  await Promise.all([1, 2, 3].map((i) => platform.addComment(agents.flipkart, post.id, { body: `Flipkart parallel follow-up ${i}.` })));
  assert.equal(platform.metrics.get('engagements_organic_missed_match'), 1);
  assert.equal((await platform.learner.model()).updates - before, 1);
});

test('feedback moves the shared model in proportion to the giver’s trust; its own affinity still learns fully', async () => {
  const { platform, agents } = await setup();
  const weights = [];
  const update = platform.learner.update.bind(platform.learner);
  platform.learner.update = (features, label, weight) => {
    weights.push(weight);
    return update(features, label, weight);
  };
  const { agent: unverified } = await platform.registerAgent({
    company: 'Unverified Travels',
    domain: 'unverified-travels.example',
    industry: 'travel',
    description: 'An agent that has not verified its domain yet.',
    interests: ['Festive holiday offers and travel deals'],
  });
  await platform.subscribe(unverified, { kind: 'agent', target: agents.swiggy.id });
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);

  await platform.feedback(agents.phonepe, (await platform.repo.matchFor(post.id, agents.phonepe.id)).id, { relevant: false });
  await platform.feedback(unverified, (await platform.repo.matchFor(post.id, unverified.id)).id, { relevant: false });
  assert.deepEqual(weights, [0.8, 0.3], 'verified 0.8, unverified 0.3');
  assert.ok((await platform.learner.affinity(unverified.id, ['festive', 'promotion'])) < 0, 'per-agent preferences are not discounted');
});

test('feedback is rate limited per agent, and rejected feedback is not recorded', async () => {
  const { platform, agents } = await setup({ limits: { feedbackPerMinute: 2 } });
  const ids = [];
  for (const [author, post] of [[agents.swiggy, POSTS.swiggyDiwali], [agents.swiggy, POSTS.swiggyNavratri], [agents.flipkart, POSTS.flipkartSale]]) {
    const routed = await publishAndRoute(platform, author, post);
    ids.push((await platform.repo.matchFor(routed.post.id, agents.phonepe.id)).id);
  }
  await platform.feedback(agents.phonepe, ids[0], { relevant: true });
  await platform.feedback(agents.phonepe, ids[1], { relevant: true });
  await assert.rejects(platform.feedback(agents.phonepe, ids[2], { relevant: false }), { status: 429, code: 'rate_limited' });
  assert.equal((await platform.repo.getNotification(ids[2])).feedback, null);
});

test('double-submitted feedback is recorded and learned from once', async () => {
  const { platform, agents } = await setup();
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const { id } = await platform.repo.matchFor(post.id, agents.phonepe.id);
  const before = (await platform.learner.model()).updates;
  const results = await Promise.allSettled([platform.feedback(agents.phonepe, id, { relevant: true }), platform.feedback(agents.phonepe, id, { relevant: false })]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  assert.equal((await platform.learner.model()).updates - before, 1);
});

test('the ignored-push sweep runs on a schedule once jobs are started', async () => {
  const { platform, agents } = await setup({ feedback: { ignoreAfterMs: 20, sweepIntervalMs: 10 } });
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const { id, outcome } = await platform.repo.matchFor(post.id, agents.phonepe.id);
  assert.equal(outcome, null);
  platform.startJobs();
  try {
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    platform.stopJobs();
  }
  assert.equal((await platform.repo.getNotification(id)).outcome, 'ignored');
  assert.equal(platform.metrics.get('notifications_ignored'), 2, 'both pushes, once each');
});

test('posts whose retry timers were lost (e.g. after a restart) are recovered by the stuck-post job', async () => {
  const { platform, agents } = await setup({ ...FAST_RECOVERY, recovery: { ...FAST_RECOVERY.recovery, retryBaseMs: 60_000, retryMaxMs: 60_000 } });
  interceptRoute(platform, (n, original) => (n === 1 ? Promise.reject(new Error('transient')) : original()));
  const { post } = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await platform.bus.drain();
  const pending = await platform.repo.getPost(post.id);
  assert.equal(pending.status, 'retrying');
  assert.ok(pending.routing.next_attempt_at, 'the retry time is persisted with the post');

  platform.scheduler.stop(); // the retry timer is gone, as after a crash or restart
  const { recovered } = await platform.recoverStuckPosts(Date.now() + platform.config.recovery.stuckAfterMs + 1);
  await platform.scheduler.settle();
  assert.equal(recovered, 1);
  assert.equal((await platform.repo.getPost(post.id)).status, 'routed');
  assert.deepEqual(await notificationsPerAgent(platform, post.id), { [agents.phonepe.id]: 1, [agents.hdfc.id]: 1 });
});

test('a post whose routing worker died mid-attempt is recovered once its lease expires, not before', async () => {
  const { platform, agents } = await setup({ recovery: { processingTimeoutMs: 60_000, stuckAfterMs: 0 } });
  const { post } = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await platform.drain();
  // Simulate a worker that claimed the post and crashed: status routing, a lease, no process.
  await platform.repo.mutatePost(post.id, (p) => {
    p.status = 'routing';
    p.routing.attempt_id = 'rta_dead_worker';
    p.routing.lease_until = new Date(Date.now() + 60_000).toISOString();
  });
  assert.deepEqual(await platform.recoverStuckPosts(), { recovered: 0 }, 'a live lease means a worker may still be routing it');
  const { recovered } = await platform.recoverStuckPosts(Date.now() + 61_000);
  await platform.scheduler.settle();
  assert.equal(recovered, 1);
  // The post was already routed once, so the recovery attempt notifies nobody twice.
  assert.deepEqual(await notificationsPerAgent(platform, post.id), { [agents.phonepe.id]: 1, [agents.hdfc.id]: 1 });
});

