import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POSTS } from '../demo/personas.js';
import { cosine, embed, tokenize } from '../src/routing/text.js';
import { publishAndRoute, reload, setup, tierOf } from './helpers.js';

test('text: tokenizer stems plurals and drops stopwords and bare numbers', () => {
  assert.deepEqual(tokenize('All the deliveries and offers in 2025'), ['delivery', 'offer']);
});

test('text: embedding similarity follows meaning, not just shared words', () => {
  const payments = embed('UPI cashback at checkout');
  assert.ok(cosine(payments, embed('wallet payment offers for merchants')) > cosine(payments, embed('warehouse capacity for parcels')));
});

test('the brief: Diwali offer reaches PhonePe and HDFC Bank, not Bajaj Auto', async () => {
  const { platform, agents } = await setup();
  const { routing } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);

  assert.equal(tierOf(routing, agents.phonepe), 'push');
  assert.equal(tierOf(routing, agents.hdfc), 'push');
  assert.ok(['not_candidate', 'none'].includes(tierOf(routing, agents.bajaj)));
  assert.ok(routing.decisions.every((d) => d.agent_id !== agents.swiggy.id), 'author is never notified');

  const phonepe = routing.decisions.find((d) => d.agent_id === agents.phonepe.id);
  assert.ok(phonepe.reasons.some((r) => r.startsWith('partner fit')), 'decision is explained');
});

test('one post can reach different kinds of partner (cards and logistics)', async () => {
  const { platform, agents } = await setup();
  const { routing } = await publishAndRoute(platform, agents.flipkart, POSTS.flipkartSale);
  assert.equal(tierOf(routing, agents.delhivery), 'push');
  assert.equal(tierOf(routing, agents.hdfc), 'push');
  assert.notEqual(tierOf(routing, agents.makemytrip), 'push');
});

test('opted-out topics suppress delivery even with semantic overlap', async () => {
  const { platform, agents } = await setup();
  const post = { title: 'Food delivery riders get EV loans', body: 'Swiggy food delivery riders can now get electric two-wheeler loans with low EMI.' };
  const { routing } = await publishAndRoute(platform, agents.swiggy, post);
  const bajaj = routing.decisions.find((d) => d.agent_id === agents.bajaj.id);
  assert.ok(bajaj, 'Bajaj Auto is a candidate (automotive + financing overlap)');
  assert.equal(bajaj.features.excluded, 1);
  assert.equal(bajaj.tier, 'none');
});

test('hard filters: an agent that blocks the author’s domain or industry never hears about the post', async () => {
  const { platform, agents } = await setup();
  // HDFC Bank blocks the whole food-delivery industry; PhonePe blocks Swiggy by domain.
  await platform.updateAgent(agents.hdfc, { blocked_industries: ['food_delivery'] });
  await platform.updateAgent(agents.phonepe, { blocked_agents: ['swiggy.com'] });
  assert.deepEqual((await platform.viewSelf(agents.hdfc)).blocked_industries, ['food_delivery']);

  const { routing } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  assert.equal(tierOf(routing, agents.hdfc), 'not_candidate');
  assert.equal(tierOf(routing, agents.phonepe), 'not_candidate');
  assert.equal(routing.filtered_out.blocked_industry, 1);
  assert.equal(routing.filtered_out.blocked_author, 1);

  // Other industries still reach HDFC Bank, and unknown industries are refused.
  const { routing: launch } = await publishAndRoute(platform, agents.bajaj, POSTS.bajajLaunch);
  assert.equal(tierOf(launch, agents.hdfc), 'push');
  await assert.rejects(platform.updateAgent(agents.hdfc, { blocked_industries: ['space'] }), { status: 400 });
});

test('unverified authors are limited to digest delivery', async () => {
  const { platform } = await setup();
  const { agent } = await platform.registerAgent({
    company: 'NewShop',
    domain: 'newshop.example',
    industry: 'retail',
    description: 'A new retailer that has not verified its domain yet.',
    interests: ['Card offers and payment partnerships for online shoppers'],
  });
  const { routing } = await publishAndRoute(platform, agent, { title: 'Festive sale: 20% off', body: 'NewShop festive sale with 20% off and room for card and UPI cashback offers.' });
  assert.equal(routing.reach_limited, true);
  assert.equal(routing.counts.push, 0);
  assert.ok(routing.counts.digest > 0);
});

test('prompt-injection posts are quarantined and never routed', async () => {
  const { platform, agents } = await setup();
  const { post } = await platform.publishPost(agents.flipkart, POSTS.injection);
  await platform.drain();
  assert.equal(post.status, 'quarantined');
  assert.ok(post.moderation.flags.includes('prompt_injection'));
  assert.equal(await platform.repo.getRoutingLog(post.id), null);
  assert.equal(await platform.repo.countNotifications(), 0);
  await assert.rejects(platform.getPost(post.id, agents.phonepe), /not found/);
});

test('third-party offer claims get reduced reach', async () => {
  const { platform, agents } = await setup();
  const { post, routing } = await publishAndRoute(platform, agents.makemytrip, {
    title: 'PhonePe cashback for everyone',
    body: 'PhonePe is giving ₹500 cashback on all payments this week.',
  });
  assert.ok(post.moderation.flags.includes('third_party_claim'));
  assert.equal(routing.counts.push, 0);
});

test('"not relevant" feedback lowers that agent\'s future scores and raises its push threshold', async () => {
  const { platform, agents } = await setup();
  const { post } = await publishAndRoute(platform, agents.hdfc, POSTS.hdfcRates);
  const n = await platform.repo.matchFor(post.id, agents.swiggy.id);
  assert.equal(n.tier, 'push');

  const stored = await platform.repo.getPost(post.id);
  const before = (await platform.router.score(stored, agents.hdfc, agents.swiggy)).p;
  const thresholdBefore = platform.router.pushThreshold(await reload(platform, agents.swiggy));
  await platform.feedback(agents.swiggy, n.id, { relevant: false, reason: 'not our business' });
  const after = (await platform.router.score(stored, agents.hdfc, agents.swiggy)).p;

  assert.ok(after < before, `${after} < ${before}`);
  assert.ok(platform.router.pushThreshold(await reload(platform, agents.swiggy)) > thresholdBefore);
  await assert.rejects(platform.feedback(agents.swiggy, n.id, { relevant: true }), /already recorded/);
});

test('engagement raises scores for similar future posts', async () => {
  const { platform, agents } = await setup();
  const first = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const stored = await platform.repo.getPost(first.post.id);
  const hdfcBefore = (await platform.router.score(stored, agents.swiggy, agents.hdfc)).p;
  await platform.addComment(agents.hdfc, first.post.id, { body: 'HDFC Bank can add a 10% instant discount on card payments.' });
  const hdfcAfter = (await platform.router.score(stored, agents.swiggy, agents.hdfc)).p;
  assert.ok(hdfcAfter > hdfcBefore);
  assert.equal((await platform.repo.matchFor(first.post.id, agents.hdfc.id)).outcome, 'engaged');
});

test('organic engagement by an agent that was not notified is learned as a missed match', async () => {
  const { platform, agents } = await setup();
  const { post, routing } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  assert.notEqual(tierOf(routing, agents.flipkart), 'push');
  await platform.addComment(agents.flipkart, post.id, { body: 'Flipkart could cross-promote this to Plus members.' });
  assert.equal(platform.metrics.get('engagements_organic_missed_match'), 1);
  assert.ok((await platform.learner.affinity(agents.flipkart.id, ['festive', 'promotion'])) > 0);
});

test('per-agent push budget downgrades extra pushes to digest', async () => {
  const { platform, agents } = await setup();
  await platform.updateAgent(agents.phonepe, { delivery: { max_push_per_hour: 1 } });
  const a = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  const b = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyNavratri);
  assert.equal(tierOf(a.routing, agents.phonepe), 'push');
  const second = b.routing.decisions.find((d) => d.agent_id === agents.phonepe.id);
  assert.equal(second.tier, 'digest');
  assert.equal(second.capped, 'agent_push_budget');
});

test('explicit subscriptions guarantee at least digest delivery', async () => {
  const { platform, agents } = await setup();
  await platform.subscribe(agents.makemytrip, { kind: 'agent', target: agents.bajaj.id });
  const { routing } = await publishAndRoute(platform, agents.bajaj, POSTS.bajajLaunch);
  const mmt = routing.decisions.find((d) => d.agent_id === agents.makemytrip.id);
  assert.ok(mmt.sources.includes('follows_author'));
  assert.notEqual(mmt.tier, 'none');
});

test('comment caps bound agent-to-agent reply loops', async () => {
  const { platform, agents } = await setup();
  const { post } = await publishAndRoute(platform, agents.swiggy, POSTS.swiggyDiwali);
  for (let i = 0; i < platform.config.limits.commentsPerAgentPerPost; i++) {
    await platform.addComment(agents.phonepe, post.id, { body: `Follow-up number ${i + 1} from PhonePe.` });
  }
  await assert.rejects(platform.addComment(agents.phonepe, post.id, { body: 'One more follow-up.' }), /comment limit/i);
});

test('idempotency keys and duplicate detection prevent double posting', async () => {
  const { platform, agents } = await setup();
  const first = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali, 'key-1');
  const replay = await platform.publishPost(agents.swiggy, POSTS.swiggyDiwali, 'key-1');
  assert.equal(replay.replayed, true);
  assert.equal(replay.post.id, first.post.id);
  await assert.rejects(platform.publishPost(agents.swiggy, POSTS.swiggyDiwali), /Duplicate/);
  await platform.drain();
});

test('three independent verified reports hide a post for review; a moderator’s uphold quarantines it and penalises the author', async () => {
  const { platform, agents } = await setup();
  const { post } = await publishAndRoute(platform, agents.makemytrip, { title: 'Holiday sale', body: 'MakeMyTrip holiday sale: 30% off hotels this weekend.' });
  for (const reporter of [agents.hdfc, agents.phonepe, agents.flipkart]) await platform.report(reporter, post.id, { reason: 'false_claim' });
  assert.equal((await platform.repo.getPost(post.id)).status, 'under_review', 'hidden, not taken down');
  assert.equal((await reload(platform, agents.makemytrip)).trust, 0.8, 'no penalty before a moderator decides');
  await platform.reviewPost(post.id, { decision: 'uphold' });
  assert.equal((await platform.repo.getPost(post.id)).status, 'quarantined');
  assert.ok((await reload(platform, agents.makemytrip)).trust < 0.8);
});
