// Notification delivery: budgets under concurrency, inbox pagination, acknowledgements, batched
// digests, and push / digest / pull delivery end to end over HTTP with signed webhooks.
// Runs on the in-memory repository, and on PostgreSQL with AGENTNET_TEST_REPO=pglite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { POSTS, PERSONAS } from '../demo/personas.js';
import { createPlatform } from '../src/platform.js';
import { startRuntime } from '../src/runtime.js';
import { verifyWebhookSignature } from '../src/security/auth.js';
import { DEV_CONFIG, publishAndRoute, reload, setup, silentLog } from './helpers.js';
import { openTestRepository } from './support/repositories.js';
import { deepMerge, seededRandom } from '../src/util.js';

const MINUTE = 60_000;
const variant = (post, k) => ({ ...post, body: `${post.body} Ref ${k}.` }); // distinct content, same meaning

/** Records webhook requests per URL; `fail` decides which ones get a 503. */
function webhooks() {
  const calls = [];
  let fail = () => false;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, raw: init.body, signature: init.headers['x-agentnet-signature'], delivery: init.headers['x-agentnet-delivery'] });
    return fail(url, body) ? new Response('busy', { status: 503 }) : new Response('ok', { status: 200 });
  };
  return { calls, fetch, failWhen: (fn) => (fail = fn) };
}

// ---- budgets ---------------------------------------------------------------------------------

/**
 * Makes concurrent routings interleave the way they do against a database: every routing reads
 * the agents' delivery counts, then yields, so all of them decide on the same (stale) counts before
 * any writes its notifications. Only enforcement at insert time can then keep the budget.
 */
function interleaveRoutings(platform) {
  const counts = platform.repo.deliveryCounts.bind(platform.repo);
  platform.repo.deliveryCounts = async (...args) => {
    const result = await counts(...args);
    await new Promise((r) => setTimeout(r, 25));
    return result;
  };
}

test('concurrent routing of many posts never takes an agent over its push budget', async () => {
  const { platform, agents } = await setup();
  interleaveRoutings(platform);
  await platform.updateAgent(agents.phonepe, { delivery: { max_push_per_hour: 2 } });
  const published = await Promise.all(Array.from({ length: 6 }, (_, k) => platform.publishPost(agents.swiggy, variant(POSTS.swiggyDiwali, k))));
  await platform.drain();

  const matches = [];
  for (const { post } of published) matches.push(await platform.repo.matchFor(post.id, agents.phonepe.id));
  assert.equal(matches.filter((n) => n.tier === 'push').length, 2, 'exactly the budget, however the routings interleaved');
  assert.equal(matches.filter((n) => n.tier === 'digest').length, 4, 'the rest arrive as digests');
  // The routing logs agree with what was stored, including tiers changed at insert time.
  for (const { post } of published) {
    const log = await platform.repo.getRoutingLog(post.id);
    const decision = log.decisions.find((d) => d.agent_id === agents.phonepe.id);
    const stored = await platform.repo.matchFor(post.id, agents.phonepe.id);
    assert.equal(decision.tier, stored.tier);
    if (stored.tier === 'digest') assert.equal(decision.capped, 'agent_push_budget');
    assert.equal(log.counts.push, log.decisions.filter((d) => d.tier === 'push').length);
  }
});

test('the daily digest budget holds under concurrency too, and a dropped digest is logged', async () => {
  const { platform, agents } = await setup();
  interleaveRoutings(platform);
  await platform.updateAgent(agents.makemytrip, { delivery: { max_digest_per_day: 3 } });
  await platform.subscribe(agents.makemytrip, { kind: 'agent', target: agents.swiggy.id });
  const published = await Promise.all(Array.from({ length: 6 }, (_, k) => platform.publishPost(agents.swiggy, variant(POSTS.swiggyNavratri, k))));
  await platform.drain();
  let delivered = 0;
  for (const { post } of published) {
    const n = await platform.repo.matchFor(post.id, agents.makemytrip.id);
    const d = (await platform.repo.getRoutingLog(post.id)).decisions.find((x) => x.agent_id === agents.makemytrip.id);
    if (n) delivered++;
    else assert.deepEqual([d.tier, d.capped], ['none', 'agent_digest_budget']);
  }
  assert.equal(delivered, 3);
});

// ---- pull: pagination and acknowledgements -----------------------------------------------------

async function inboxWithEntries(count) {
  const { platform, agents } = await setup();
  await platform.subscribe(agents.makemytrip, { kind: 'agent', target: agents.swiggy.id }); // a digest per post at least
  const ids = [];
  for (let k = 0; k < count; k++) {
    const { post } = await publishAndRoute(platform, agents.swiggy, variant(POSTS.swiggyNavratri, k));
    ids.push((await platform.repo.matchFor(post.id, agents.makemytrip.id)).id);
  }
  return { platform, agents, ids: ids.reverse() }; // newest first, like the inbox
}

test('inbox pagination: cursor pages are complete, ordered, never repeat, and stable while new items arrive', async () => {
  const { platform, agents, ids } = await inboxWithEntries(7);
  const page1 = await platform.inbox(agents.makemytrip, { limit: 3 });
  assert.deepEqual(page1.notifications.map((n) => n.id), ids.slice(0, 3));
  assert.ok(page1.next_cursor);

  // A new notification arrives between page requests: it does not shift the following pages.
  const { post } = await publishAndRoute(platform, agents.swiggy, variant(POSTS.swiggyNavratri, 99));
  const newest = (await platform.repo.matchFor(post.id, agents.makemytrip.id)).id;

  const page2 = await platform.inbox(agents.makemytrip, { limit: 3, cursor: page1.next_cursor });
  const page3 = await platform.inbox(agents.makemytrip, { limit: 3, cursor: page2.next_cursor });
  assert.deepEqual(page2.notifications.map((n) => n.id), ids.slice(3, 6));
  assert.deepEqual(page3.notifications.map((n) => n.id), ids.slice(6));
  assert.equal(page3.next_cursor, null, 'the last page has no cursor');
  assert.equal((await platform.inbox(agents.makemytrip, { limit: 3 })).notifications[0].id, newest, 'a fresh first page shows it');

  await assert.rejects(platform.inbox(agents.makemytrip, { cursor: 'not-a-cursor' }), { status: 400 });
  await assert.rejects(platform.inbox(agents.makemytrip, { limit: 'lots' }), { status: 400 });
  await assert.rejects(platform.inbox(agents.makemytrip, { tier: 'everything' }), { status: 400 });
});

test('bulk acknowledgement: own notifications only, idempotent, reflected by unacked filtering', async () => {
  const { platform, agents, ids } = await inboxWithEntries(4);
  const someoneElses = (await platform.inbox(agents.phonepe)).notifications[0].id;
  const first = await platform.ackMany(agents.makemytrip, { ids: [ids[0], ids[1], someoneElses, 'ntf_does_not_exist'] });
  assert.deepEqual(first.acked.sort(), [ids[0], ids[1]].sort());
  assert.deepEqual(first.not_found.sort(), [someoneElses, 'ntf_does_not_exist'].sort(), 'another agent’s id looks exactly like a missing one');
  assert.equal((await platform.repo.getNotification(someoneElses)).acked_at, null, 'and is left untouched');

  const again = await platform.ackMany(agents.makemytrip, { ids: [ids[0], ids[2]] });
  assert.deepEqual([again.acked, again.already_acked], [[ids[2]], [ids[0]]]);
  const unacked = (await platform.inbox(agents.makemytrip, { unacked: 'true' })).notifications.map((n) => n.id);
  assert.deepEqual(unacked, [ids[3]]);

  await assert.rejects(platform.ackMany(agents.makemytrip, { ids: [] }), { status: 400 });
  await assert.rejects(platform.ackMany(agents.makemytrip, { ids: Array.from({ length: 501 }, (_, i) => `ntf_${i}`) }), { status: 400 });
});

test('acknowledging a notification stops its pending webhook retries: the agent already has it', async () => {
  const hooks = webhooks();
  hooks.failWhen(() => true); // PhonePe's endpoint is down
  const { platform, agents } = await setup({ allowInsecureWebhooks: true, delivery: { baseBackoffMs: 100, maxBackoffMs: 100, maxAttempts: 10 } }, { fetch: hooks.fetch });
  await platform.updateAgent(agents.phonepe, { delivery: { webhook_url: 'http://agent.phonepe.example/hook' } });
  const { post } = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await platform.bus.drain();
  const n = await platform.repo.matchFor(post.id, agents.phonepe.id);
  assert.equal(n.status, 'retry_scheduled');

  // PhonePe falls back to pulling its inbox and acknowledges what it read.
  const pulled = (await platform.inbox(agents.phonepe, { unacked: 'true' })).notifications.map((x) => x.id);
  assert.ok(pulled.includes(n.id));
  await platform.ack(agents.phonepe, n.id);
  await platform.drain();
  await new Promise((r) => setTimeout(r, 250));

  const after = await platform.repo.getNotification(n.id);
  assert.deepEqual([after.status, after.delivery.cancel_reason, after.delivery.next_attempt_at], ['in_inbox', 'acknowledged', null]);
  assert.equal(hooks.calls.filter((c) => c.delivery === n.id).length, 1, 'no retry after the ack');
  assert.equal((await platform.repo.deadLetters()).some((d) => d.id === n.id), false);
  assert.ok((await platform.inbox(agents.phonepe)).notifications.some((x) => x.id === n.id && x.acked_at), 'still listed, as acknowledged');
});

test('a notification acknowledged while its push is in flight is not pushed again when that attempt fails', async () => {
  let release;
  let calls = 0;
  const fetch = async () => {
    calls++;
    if (calls === 1) return new Promise((resolve) => (release = () => resolve(new Response('busy', { status: 503 }))));
    return new Response('ok', { status: 200 });
  };
  const { platform, agents } = await setup({ allowInsecureWebhooks: true, delivery: { baseBackoffMs: 30, maxBackoffMs: 30 } }, { fetch });
  await platform.updateAgent(agents.phonepe, { delivery: { webhook_url: 'http://agent.phonepe.example/hook' } });
  const { post } = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  const deadline = Date.now() + 10_000;
  while ((await platform.repo.matchFor(post.id, agents.phonepe.id))?.status !== 'delivering') {
    if (Date.now() > deadline) throw new Error('delivery never started');
    await new Promise((r) => setTimeout(r, 10));
  }
  const n = await platform.repo.matchFor(post.id, agents.phonepe.id);
  await platform.ack(agents.phonepe, n.id); // PhonePe pulled it from its inbox meanwhile
  release(); // the in-flight attempt fails and would schedule a retry
  await platform.drain();
  assert.equal(calls, 1, 'no retry is sent for an acknowledged notification');
  const after = await platform.repo.getNotification(n.id);
  assert.deepEqual([after.status, after.delivery.cancel_reason], ['in_inbox', 'acknowledged']);
});

// ---- batched digests -----------------------------------------------------------------------------

async function digestSubscriber(hooks, overrides = {}) {
  const { platform, agents } = await setup({ allowInsecureWebhooks: true, ...overrides }, { fetch: hooks.fetch });
  const { agent: reader, credentials } = await platform.registerAgent({
    ...PERSONAS.find((p) => p.key === 'makemytrip').profile,
    company: 'Holiday Digest',
    domain: 'holidaydigest.example',
    delivery: { webhook_url: 'http://agent.holiday.example/hook', digest_webhook: true, digest_interval_minutes: 30 },
  });
  await platform.verifyAgent(reader);
  await platform.subscribe(reader, { kind: 'agent', target: agents.swiggy.id });
  return { platform, agents, reader, secret: credentials.webhook_secret };
}

test('digest batches: one signed digest.ready webhook per interval, every item in exactly one batch', async () => {
  const hooks = webhooks();
  const { platform, agents, reader, secret } = await digestSubscriber(hooks);
  const items = [];
  for (let k = 0; k < 3; k++) {
    const { post } = await publishAndRoute(platform, agents.swiggy, variant(POSTS.swiggyNavratri, k));
    items.push((await platform.repo.matchFor(post.id, reader.id)).id);
  }
  assert.equal(hooks.calls.filter((c) => c.url.includes('holiday')).length, 0, 'digest items are not pushed one by one');

  const t0 = Date.now();
  const counts = ({ batches, items: n }) => ({ batches, items: n });
  assert.deepEqual(counts(await platform.runDigestBatches(t0)), { batches: 1, items: 3 });
  await platform.drain();
  const [sent] = hooks.calls.filter((c) => c.body.type === 'digest.ready');
  assert.ok(verifyWebhookSignature(secret, sent.signature, sent.raw), 'signed like every webhook');
  assert.deepEqual(sent.body.data.items.map((i) => i.notification_id).sort(), [...items].sort());
  assert.ok(sent.body.content_policy.untrusted_fields.includes('data.items[].post.body'));

  // Within the interval nothing more is sent; new items wait for the next batch.
  const { post } = await publishAndRoute(platform, agents.swiggy, variant(POSTS.swiggyNavratri, 9));
  const late = (await platform.repo.matchFor(post.id, reader.id)).id;
  assert.deepEqual(counts(await platform.runDigestBatches(t0 + 5 * MINUTE)), { batches: 0, items: 0 });
  assert.deepEqual(counts(await platform.runDigestBatches(t0 + 31 * MINUTE)), { batches: 1, items: 1 });
  await platform.drain();
  const batches = hooks.calls.filter((c) => c.body.type === 'digest.ready');
  assert.deepEqual(batches[1].body.data.items.map((i) => i.notification_id), [late], 'only the new item: nothing is sent twice');

  // Acknowledging a batch acknowledges its items.
  await platform.ack(reader, sent.body.id);
  for (const id of items) assert.ok((await platform.repo.getNotification(id)).acked_at, `${id} acknowledged through its batch`);
  assert.equal((await platform.repo.getNotification(late)).acked_at, null);
  const listed = (await platform.inbox(reader, { tier: 'digest_batch' })).notifications;
  assert.equal(listed.length, 2);
  assert.equal((await platform.inbox(reader)).notifications.some((n) => n.event === 'digest.ready'), false, 'batches are envelopes, not inbox items');
});

test('digest batches leave out items retracted before delivery, and are cancelled when nothing is left', async () => {
  const hooks = webhooks();
  hooks.failWhen((url, body) => body.type === 'digest.ready' && hooks.calls.filter((c) => c.body.type === 'digest.ready').length === 1); // first send fails
  const { platform, agents, reader } = await digestSubscriber(hooks, { delivery: { baseBackoffMs: 50, maxBackoffMs: 50 } });
  const posts = [];
  for (let k = 0; k < 2; k++) posts.push((await publishAndRoute(platform, agents.swiggy, variant(POSTS.swiggyNavratri, k))).post);
  await platform.runDigestBatches(Date.now());
  await platform.bus.drain(); // the first delivery attempt failed; a retry is scheduled
  // One of the two posts is taken down before the retry.
  await platform.repo.mutatePost(posts[0].id, (p) => void (p.status = 'quarantined'));
  await platform.drain();
  const [, retried] = hooks.calls.filter((c) => c.body.type === 'digest.ready');
  assert.deepEqual(retried.body.data.items.map((i) => i.post.id), [posts[1].id], 'the taken-down post is not in the digest');

  // A batch whose items are all gone by send time is cancelled, not sent empty.
  const more = (await publishAndRoute(platform, agents.swiggy, variant(POSTS.swiggyNavratri, 7))).post;
  hooks.failWhen(() => true);
  const { batch_ids: [second] } = await platform.runDigestBatches(Date.now() + 31 * MINUTE);
  await platform.bus.drain(); // first attempt failed; retry scheduled
  await platform.repo.mutatePost(more.id, (p) => void (p.status = 'quarantined'));
  hooks.failWhen(() => false);
  await platform.drain();
  const cancelled = await platform.repo.getNotification(second);
  assert.deepEqual([cancelled.status, cancelled.delivery.cancel_reason], ['cancelled', 'nothing_to_deliver']);
  assert.equal(hooks.calls.filter((c) => c.delivery === second).length, 1, 'only the failed first attempt: nothing was sent empty');
  assert.equal((await platform.repo.inbox(reader.id, { tier: 'digest_batch', limit: 10 })).length, 1, 'the cancelled batch is not listed');
});

test('the digest interval holds even when two batching runs race and new items arrive in between', async () => {
  const hooks = webhooks();
  const { platform, agents, reader } = await digestSubscriber(hooks);
  await publishAndRoute(platform, agents.swiggy, variant(POSTS.swiggyNavratri, 1));
  const now = Date.now();
  const batchRow = (id, at) => ({
    id, created_at: new Date(at).toISOString(), status: 'queued', outcome: null, feedback: null, acked_at: null, retracted_at: null,
    exploration: false, score: null, reasons: [], features: null, comment_id: null, batch_id: null, reason: null,
    delivery: { attempts: 0, last_error: null, delivered_at: null, next_attempt_at: null, dead_letter: null },
    event: 'digest.ready', agent_id: reader.id, post_id: null, tier: 'digest_batch', dedupe_key: null,
  });
  // Both runs decided the agent was due before either wrote its batch.
  const first = await platform.repo.createDigestBatch(reader.id, batchRow('ntf_batch_a', now), { now, intervalMs: 30 * MINUTE });
  assert.ok(first);
  await publishAndRoute(platform, agents.swiggy, variant(POSTS.swiggyNavratri, 2)); // a new item arrives
  const second = await platform.repo.createDigestBatch(reader.id, batchRow('ntf_batch_b', now + MINUTE), { now: now + MINUTE, intervalMs: 30 * MINUTE });
  assert.equal(second, null, 'one batch per interval, enforced where the batch is written');
  await platform.drain();
});

test('two instances running the digest job at once create one batch', async () => {
  const hooks = webhooks();
  const repo = await openTestRepository();
  const config = deepMerge(DEV_CONFIG, { allowInsecureWebhooks: true });
  const [a, b] = [1, 2].map((i) => createPlatform(config, { repo, llm: null, log: silentLog, rng: seededRandom(i), fetch: hooks.fetch }));
  const swiggy = (await a.registerAgent(PERSONAS[0].profile)).agent;
  await a.verifyAgent(swiggy);
  const reader = (await a.registerAgent({ ...PERSONAS[6].profile, delivery: { webhook_url: 'http://agent.mmt.example/hook', digest_webhook: true } })).agent;
  await a.verifyAgent(reader);
  await a.subscribe(reader, { kind: 'agent', target: swiggy.id });
  for (let k = 0; k < 3; k++) await publishAndRoute(a, swiggy, variant(POSTS.swiggyNavratri, k));
  const now = Date.now();
  const results = await Promise.all([a.runDigestBatches(now), b.runDigestBatches(now)]);
  assert.equal(results[0].batches + results[1].batches, 1);
  assert.equal(results[0].items + results[1].items, 3);
  await Promise.all([a.drain(), b.drain()]);
});

test('digest preferences are validated', async () => {
  const { platform, agents } = await setup();
  await assert.rejects(platform.updateAgent(agents.makemytrip, { delivery: { digest_interval_minutes: 1 } }), { status: 400 });
  await assert.rejects(platform.updateAgent(agents.makemytrip, { delivery: { digest_webhook: 'yes' } }), { status: 400 });
  const updated = await platform.updateAgent(agents.makemytrip, { delivery: { digest_webhook: true, digest_interval_minutes: 120 } });
  assert.deepEqual([updated.delivery.digest_webhook, updated.delivery.digest_interval_minutes], [true, 120]);
  assert.equal((await reload(platform, agents.phonepe)).delivery.digest_webhook, false, 'pull-only by default');
});

// ---- all three delivery methods, end to end over HTTP -------------------------------------------

test('push, batched digest and pull delivery work end to end over HTTP with signed webhooks', async (t) => {
  const received = [];
  const receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ path: req.url, raw, signature: req.headers['x-agentnet-signature'], body: JSON.parse(raw) });
      res.writeHead(200).end();
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => receiver.close(r)));
  const hook = (name) => `http://127.0.0.1:${receiver.address().port}/${name}`;

  const repo = await openTestRepository();
  const platform = createPlatform(deepMerge(DEV_CONFIG, { allowInsecureWebhooks: true }), { repo, llm: null, log: silentLog, rng: seededRandom(1) });
  const runtime = await startRuntime({ platform, role: 'all', queue: null, port: 0, host: '127.0.0.1' });
  t.after(() => runtime.stop());
  const base = `http://127.0.0.1:${runtime.address().port}`;
  const call = async (method, p, { key, body } = {}) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const join = async (key, delivery) => {
    const res = await call('POST', '/v1/agents', { body: { ...PERSONAS.find((p) => p.key === key).profile, ...(delivery ? { delivery } : {}) } });
    await call('POST', '/v1/agents/me/verify', { key: res.body.credentials.api_key });
    return { id: res.body.agent.id, key: res.body.credentials.api_key, secret: res.body.credentials.webhook_secret };
  };
  const swiggy = await join('swiggy');
  const phonepe = await join('phonepe', { webhook_url: hook('phonepe') }); // push
  const mmt = await join('makemytrip', { webhook_url: hook('mmt'), digest_webhook: true, digest_interval_minutes: 5 }); // digest batches
  const hdfc = await join('hdfc'); // pull only
  await call('POST', '/v1/subscriptions', { key: mmt.key, body: { kind: 'agent', target: swiggy.id } });

  const posted = [];
  for (let k = 0; k < 3; k++) posted.push((await call('POST', '/v1/posts', { key: swiggy.key, body: variant(POSTS.swiggyDiwali, k) })).body.id);
  await platform.drain();
  await platform.runDigestBatches(Date.now());
  await platform.drain();

  // Push: one signed post.matched per post to PhonePe.
  const pushes = received.filter((r) => r.path === '/phonepe' && r.body.type === 'post.matched');
  assert.deepEqual(pushes.map((r) => r.body.data.post.id).sort(), [...posted].sort());
  assert.ok(pushes.every((r) => verifyWebhookSignature(phonepe.secret, r.signature, r.raw)));
  // Digest: one signed digest.ready batch with all three to MakeMyTrip.
  const digests = received.filter((r) => r.path === '/mmt');
  assert.equal(digests.length, 1);
  assert.equal(digests[0].body.type, 'digest.ready');
  assert.deepEqual(digests[0].body.data.items.map((i) => i.post.id).sort(), [...posted].sort());
  assert.ok(verifyWebhookSignature(mmt.secret, digests[0].signature, digests[0].raw));
  // Pull: HDFC pages through its inbox and acknowledges everything it read.
  const seen = [];
  let cursor = null;
  do {
    const page = await call('GET', `/v1/inbox?limit=2${cursor ? `&cursor=${cursor}` : ''}`, { key: hdfc.key });
    assert.equal(page.status, 200);
    seen.push(...page.body.notifications.map((n) => n.id));
    cursor = page.body.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 3);
  const acked = await call('POST', '/v1/notifications/ack', { key: hdfc.key, body: { ids: seen } });
  assert.deepEqual([acked.status, acked.body.acked.length], [200, 3]);
  const left = await call('GET', '/v1/inbox?unacked=true', { key: hdfc.key });
  assert.equal(left.body.notifications.length, 0);
  // The batch was acknowledged by MakeMyTrip in one call.
  const ackBatch = await call('POST', `/v1/notifications/${digests[0].body.id}/ack`, { key: mmt.key });
  assert.equal(ackBatch.status, 200);
  assert.equal((await call('GET', '/v1/inbox?unacked=true&tier=digest', { key: mmt.key })).body.notifications.length, 0);
});
