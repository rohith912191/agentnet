// Regression tests for the pre-P2 fixes: report brigading, interest-profile privacy, valid_until
// enforcement, and subscribers versus the candidate cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/http/server.js';
import { PERSONAS, POSTS } from '../demo/personas.js';
import { TEST_ADMIN_KEY, publishAndRoute, reload, setup, tierOf } from './helpers.js';

const later = (ms) => new Date(Date.now() + ms).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function registerVerified(platform, profile) {
  const { agent, credentials } = await platform.registerAgent(profile);
  await platform.verifyAgent(agent);
  return { agent: await reload(platform, agent), key: credentials.api_key };
}

function interceptRoute(platform, behaviour) {
  const original = platform.router.route.bind(platform.router);
  let calls = 0;
  platform.router.route = (...args) => behaviour(++calls, () => original(...args));
}

const inboxHas = async (platform, agent, postId) => (await platform.inbox(agent)).notifications.some((n) => n.post.id === postId);

// ---- 1. Report brigading -------------------------------------------------------------------

test('reports from competitors and unverified agents cannot hide a post', async () => {
  const { platform, agents } = await setup();
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  for (const name of ['Tastyeats', 'Quickbite', 'Mealdash']) {
    const { agent } = await registerVerified(platform, {
      company: name,
      domain: `${name.toLowerCase()}.example`,
      industry: 'food_delivery', // Swiggy's competitors
      description: 'A competing food delivery platform.',
      interests: ['Food delivery offers and restaurant partnerships'],
    });
    await platform.report(agent, post.id, { reason: 'false_claim' });
  }
  for (let i = 0; i < 5; i++) {
    const { agent } = await platform.registerAgent({
      company: `Throwaway ${i}`,
      domain: `throwaway${i}.example`,
      industry: 'other',
      description: 'Unverified account created to report.',
      interests: ['Nothing in particular, just reporting'],
    });
    await platform.report(agent, post.id, { reason: 'spam' });
  }
  assert.equal((await platform.repo.getPost(post.id)).status, 'routed');
  const weights = (await platform.repo.reportsFor(post.id)).map((r) => Math.round(r.weight * 100) / 100);
  assert.deepEqual(weights, [0.2, 0.2, 0.2, 0, 0, 0, 0, 0], 'competitors count a quarter, unverified agents nothing');
  assert.ok(await inboxHas(platform, agents.phonepe, post.id), 'still delivered');
});

test('reports alone never take a post down; a dismissed brigade loses credibility and cannot repeat it', async () => {
  const { platform, agents } = await setup();
  const brigade = [agents.flipkart, agents.delhivery, agents.makemytrip]; // verified, independent of Swiggy's industry
  const first = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  for (const r of brigade) await platform.report(r, first.post.id, { reason: 'false_claim' });

  const post = await platform.repo.getPost(first.post.id);
  assert.equal(post.status, 'under_review');
  assert.equal((await reload(platform, agents.swiggy)).trust, 0.8, 'no penalty without a moderator');
  assert.equal(await inboxHas(platform, agents.phonepe, post.id), false, 'hidden from inboxes while under review');
  await assert.rejects(platform.getPost(post.id, agents.phonepe), /not found/);
  await assert.rejects(platform.addComment(agents.phonepe, post.id, { body: 'PhonePe can add cashback.' }), /not found/);
  assert.deepEqual((await platform.reviewQueue()).posts.map((p) => p.id), [post.id]);

  const decision = await platform.reviewPost(post.id, { decision: 'dismiss', note: 'Offer is genuine' });
  assert.equal(decision.status, 'routed');
  assert.ok(await inboxHas(platform, agents.phonepe, post.id), 'restored to inboxes');
  for (const r of brigade) assert.equal((await reload(platform, r)).report_credibility, 0.5);

  // The same group tries again on the next post: their reports now weigh half as much.
  const second = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyNavratri);
  for (const r of brigade) await platform.report(r, second.post.id, { reason: 'false_claim' });
  assert.equal((await platform.repo.getPost(second.post.id)).status, 'routed');
});

test('an upheld review quarantines the post and only then penalises the author; reporters gain credibility', async () => {
  const { platform, agents } = await setup();
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const reporters = [agents.flipkart, agents.delhivery, agents.makemytrip];
  for (const r of reporters) await platform.report(r, post.id, { reason: 'false_claim' });
  for (const r of reporters) {
    await platform.repo.mutateAgent(r.id, (a) => {
      a.report_credibility = 0.8; // below the cap, so the reward is visible
    });
  }
  await platform.reviewPost(post.id, { decision: 'uphold' });
  assert.equal((await platform.repo.getPost(post.id)).status, 'quarantined');
  assert.ok(Math.abs((await reload(platform, agents.swiggy)).trust - 0.6) < 1e-9);
  assert.ok(Math.abs((await reload(platform, agents.flipkart)).report_credibility - 0.9) < 1e-9);
  await assert.rejects(platform.reviewPost(post.id, { decision: 'dismiss' }), { status: 409 });
});

test('reporting is rate limited per agent', async () => {
  const { platform, agents } = await setup({ reports: { perHour: 2 } });
  const ids = [];
  for (const p of [POSTS.swiggyDiwali, POSTS.swiggyNavratri]) ids.push((await publishAndRoute(platform, agents.swiggy, p)).post.id);
  ids.push((await publishAndRoute(platform, agents.hdfc, POSTS.hdfcRates)).post.id);
  await platform.report(agents.makemytrip, ids[0], { reason: 'spam' });
  await platform.report(agents.makemytrip, ids[1], { reason: 'spam' });
  await assert.rejects(platform.report(agents.makemytrip, ids[2], { reason: 'spam' }), { status: 429, code: 'rate_limited' });
});

test('webhook deliveries of a post under review are held without using attempts, then sent after dismissal', async () => {
  let down = true;
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body).id);
    return new Response(down ? 'busy' : 'ok', { status: down ? 503 : 200 });
  };
  const { platform, agents } = await setup({ allowInsecureWebhooks: true, delivery: { baseBackoffMs: 40, maxBackoffMs: 40, reviewHoldMs: 30 } }, { fetch });
  await platform.updateAgent(agents.phonepe, { delivery: { webhook_url: 'http://agent.phonepe.example/hook' } });
  const { post } = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali);
  await platform.bus.drain();
  const { id } = await platform.repo.matchFor(post.id, agents.phonepe.id);
  const state = () => platform.repo.getNotification(id);
  assert.equal((await state()).status, 'retry_scheduled');

  for (const r of [agents.flipkart, agents.delhivery, agents.makemytrip]) await platform.report(r, post.id, { reason: 'false_claim' });
  down = false;
  await wait(120); // the retry comes due while the post is under review
  assert.equal((await state()).status, 'deferred');
  assert.equal(calls.filter((x) => x === id).length, 1, 'nothing sent while under review');

  await platform.reviewPost(post.id, { decision: 'dismiss' });
  await platform.drain();
  const n = await state();
  assert.equal(n.status, 'delivered');
  assert.equal(n.delivery.attempts, 2, 'the hold did not consume attempts');
  assert.ok(platform.metrics.get('webhook_deferred_under_review') >= 1);
});

// ---- 2. Interest-profile privacy -----------------------------------------------------------

test('other agents cannot see an agent’s interest profile; the agent itself and operators can', async () => {
  const { platform } = await setup();
  const server = createHttpServer(platform);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const swiggy = await registerVerified(platform, { ...PERSONAS[0].profile, company: 'Swiggy Two', domain: 'swiggy-two.example' });
  const phonepe = await registerVerified(platform, { ...PERSONAS[1].profile, company: 'Phonepe Two', domain: 'phonepe-two.example' });
  const get = (path, headers) => fetch(base + path, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const SENSITIVE = ['interests', 'topics', 'regions', 'exclude_topics', 'derived_topics', 'delivery', 'blocked_agents', 'calibration', 'identity'];
  try {
    const seenByOther = await get(`/v1/agents/${phonepe.agent.id}`, { authorization: `Bearer ${swiggy.key}` });
    assert.equal(seenByOther.status, 200);
    for (const field of SENSITIVE) assert.equal(field in seenByOther.body, false, `public profile must not include ${field}`);
    assert.equal(seenByOther.body.company, 'Phonepe Two');

    const self = await get('/v1/agents/me', { authorization: `Bearer ${phonepe.key}` });
    assert.deepEqual(self.body.interests, phonepe.agent.interests);

    const operator = await get(`/v1/admin/agents/${phonepe.agent.id}`, { 'x-admin-key': TEST_ADMIN_KEY });
    assert.deepEqual(operator.body.interests, phonepe.agent.interests);
    assert.equal(JSON.stringify(operator.body).includes('webhook_secret'), false);
    assert.equal((await get(`/v1/admin/agents/${phonepe.agent.id}`, { authorization: `Bearer ${swiggy.key}` })).status, 401);
  } finally {
    server.close();
  }
});

test('no agent-facing endpoint leaks another agent’s interest statements', async () => {
  const { platform, agents } = await setup();
  const server = createHttpServer(platform);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const swiggy = await registerVerified(platform, { ...PERSONAS[0].profile, company: 'Swiggy Three', domain: 'swiggy-three.example' });
    const { post } = await publishAndRoute(platform, swiggy.agent, POSTS.swiggyDiwali);
    await platform.addComment(agents.phonepe, post.id, { body: 'PhonePe can add ₹50 cashback.' });
    await platform.subscribe(swiggy.agent, { kind: 'agent', target: agents.hdfc.id });
    await publishAndRoute(platform, agents.hdfc, POSTS.hdfcRates); // Swiggy Three gets a notification
    await platform.drain();

    const auth = { authorization: `Bearer ${swiggy.key}` };
    const paths = ['/v1/posts', `/v1/posts/${post.id}`, `/v1/posts/${post.id}/comments`, '/v1/inbox', '/v1/subscriptions'];
    for (const a of Object.values(agents)) paths.push(`/v1/agents/${a.id}`);
    const others = Object.values(agents).flatMap((a) => a.interests);
    for (const path of paths) {
      const text = await (await fetch(base + path, { headers: auth })).text();
      for (const interest of others) assert.equal(text.includes(interest), false, `${path} leaks "${interest}"`);
    }
  } finally {
    server.close();
  }
});

// ---- 3. valid_until enforcement ------------------------------------------------------------

test('an expired post leaves inboxes and the feed and stops accepting comments', async () => {
  const { platform, agents } = await setup();
  // Valid long enough to be routed and commented on with any repository, then wait it out.
  const validUntil = later(1_500);
  const { post } = await publishAndRoute(platform, agents.swiggy, { ...POSTS.swiggyDiwali, valid_until: validUntil });
  assert.ok(await inboxHas(platform, agents.phonepe, post.id), 'delivered while valid');
  await platform.addComment(agents.hdfc, post.id, { body: 'HDFC Bank can add a card discount.' });
  await platform.drain();

  await wait(Math.max(0, Date.parse(validUntil) - Date.now()) + 50);
  for (const agent of [agents.phonepe, agents.hdfc, agents.swiggy]) {
    assert.equal(await inboxHas(platform, agent, post.id), false, `${agent.company} inbox`);
  }
  assert.equal((await platform.listPosts({}, agents.phonepe)).posts.some((p) => p.id === post.id), false);
  await assert.rejects(platform.addComment(agents.phonepe, post.id, { body: 'Late reply after expiry.' }), { status: 410, code: 'post_expired' });
  assert.equal((await platform.getPost(post.id, agents.phonepe)).expired, true);
});

test('pending webhook retries of an expired post are cancelled instead of sent', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body).id);
    return new Response('busy', { status: 503 });
  };
  // The offer is valid long enough for routing and the first attempt (on any repository), and
  // expires before the retry comes due.
  const { platform, agents } = await setup({ allowInsecureWebhooks: true, delivery: { baseBackoffMs: 1_500, maxBackoffMs: 1_500 } }, { fetch });
  await platform.updateAgent(agents.phonepe, { delivery: { webhook_url: 'http://agent.phonepe.example/hook' } });
  const { post } = await publishAndRoute(platform, agents.swiggy, { ...POSTS.swiggyDiwali, valid_until: later(600) });
  const n = await platform.repo.matchFor(post.id, agents.phonepe.id);
  assert.equal(n.status, 'cancelled');
  assert.equal(n.delivery.cancel_reason, 'post_expired');
  assert.equal(calls.filter((id) => id === n.id).length, 1, 'only the attempt made while the offer was valid');
  assert.equal((await platform.repo.deadLetters()).some((d) => d.id === n.id), false);
});

test('a post that expires before routing completes is never sent to anyone', async () => {
  const { platform, agents } = await setup({ recovery: { retryBaseMs: 300, retryMaxMs: 300 } });
  interceptRoute(platform, (n, original) => (n === 1 ? Promise.reject(new Error('transient')) : original()));
  const { post } = await publishAndRoute(platform, agents.swiggy, { ...POSTS.swiggyDiwali, valid_until: later(80) });
  assert.equal((await platform.repo.getPost(post.id)).status, 'expired');
  assert.equal((await platform.repo.notificationsForPost(post.id)).length, 0);
});

test('the expiry job marks expired posts on a schedule', async () => {
  const { platform, agents } = await setup({ expiry: { checkIntervalMs: 20 } });
  // Long enough to be routed first even on a slow, loaded storage engine; then wait for the job.
  const { post } = await publishAndRoute(platform, agents.swiggy, { ...POSTS.swiggyDiwali, valid_until: later(1_500) });
  assert.equal((await platform.repo.getPost(post.id)).status, 'routed');
  platform.startJobs(['expire-posts']);
  try {
    const deadline = Date.now() + 15_000;
    while ((await platform.repo.getPost(post.id)).status !== 'expired' && Date.now() < deadline) await wait(25);
  } finally {
    platform.stopJobs();
  }
  assert.equal((await platform.repo.getPost(post.id)).status, 'expired');
});

// ---- 4. Subscribers and the candidate cap ---------------------------------------------------

test('followers and topic subscribers are never trimmed by the candidate cap', async () => {
  const { platform, agents } = await setup({ routing: { maxCandidates: 20 } });
  for (let i = 0; i < 300; i++) {
    await platform.registerAgent({
      company: `Broad Interest ${i}`,
      domain: `broad${i}.example`,
      industry: 'other',
      description: 'Synthetic agent that is interested in almost everything.',
      interests: ['Festive food delivery offers, payment cashback partnerships and card discounts'],
    });
  }
  const subscribers = [];
  for (let i = 0; i < 55; i++) {
    const { agent } = await platform.registerAgent({
      company: `Subscriber ${i}`,
      domain: `subscriber${i}.example`,
      industry: 'other',
      description: 'An agent with unrelated interests that explicitly subscribed.',
      interests: ['Industrial machinery maintenance and spare parts'],
    });
    await platform.subscribe(agent, i < 40 ? { kind: 'agent', target: agents.swiggy.id } : { kind: 'topic', target: 'festive' });
    subscribers.push(agent);
  }

  const { routing } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  assert.ok(routing.counts.candidates_trimmed > 0, 'the cap is active');
  assert.equal(routing.counts.subscribers, 55);
  assert.equal(routing.counts.candidates, 20 + 55);
  for (const s of subscribers) assert.notEqual(tierOf(routing, s), 'none', `${s.company} must be notified`);
});

test('when a subscriber’s own digest budget withholds a post, the routing log says so', async () => {
  const { platform, agents } = await setup();
  const { agent: follower } = await platform.registerAgent({
    company: 'Budgeted Subscriber',
    domain: 'budgeted.example',
    industry: 'other',
    description: 'Subscribed, but asked for no digests today.',
    interests: ['Industrial machinery maintenance and spare parts'],
    delivery: { max_digest_per_day: 0 },
  });
  await platform.subscribe(follower, { kind: 'agent', target: agents.swiggy.id });
  const { routing } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const decision = routing.decisions.find((d) => d.agent_id === follower.id);
  assert.deepEqual([decision.tier, decision.capped, decision.sources.includes('follows_author')], ['none', 'agent_digest_budget', true]);
});
