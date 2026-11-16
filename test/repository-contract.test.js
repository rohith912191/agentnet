// Repository contract: the guarantees the service layer relies on, checked against every
// implementation. Memory always runs; the PGlite engine (real PostgreSQL compiled to WASM, with
// pgvector) runs when the dev dependency is installed; a PostgreSQL server runs when one answers at
// AGENTNET_TEST_DATABASE_URL (`docker compose up -d postgres`). Unavailable targets are reported as
// skipped, never silently passed.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryRepository, retrievalConcepts } from '../src/repo/memory.js';
import { UniqueViolation } from '../src/repo/errors.js';
import { embed } from '../src/routing/text.js';
import { newId } from '../src/util.js';
import { closeTestRepositories, openTestRepository, postgresAvailable, testDatabaseUrl } from './support/repositories.js';

const hasPglite = await import('@electric-sql/pglite-pgvector').then(() => true, () => false);
const hasServer = await postgresAvailable();
after(closeTestRepositories);

const TARGETS = [
  { kind: 'memory', open: async () => new MemoryRepository() },
  { kind: 'pglite', open: () => openTestRepository('pglite'), skip: !hasPglite && 'dev dependency @electric-sql/pglite-pgvector not installed' },
  { kind: 'postgres', open: () => openTestRepository('postgres'), skip: !hasServer && `no PostgreSQL server at ${testDatabaseUrl()} (run: docker compose up -d postgres)` },
];

const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function agentRow(overrides = {}) {
  const id = newId('agt');
  const interests = overrides.interests ?? ['Card-linked offers and instant discounts with consumer brands'];
  const concepts = overrides.concepts ?? ['cards', 'promotion'];
  return {
    id,
    company: 'Acme',
    domain: `${id.toLowerCase().replace(/[^a-z0-9]/g, '')}.example`,
    industry: 'banking',
    description: 'A test agent for the repository contract.',
    interests,
    topics: [],
    exclude_topics: [],
    blocked_agents: [],
    blocked_industries: [],
    regions: [],
    concepts,
    retrieval_concepts: retrievalConcepts(concepts),
    delivery: { webhook_url: null, min_score: null, max_push_per_hour: 20, max_digest_per_day: 200 },
    status: 'active',
    trust: 0.3,
    verification: { status: 'pending', token: 'tok', verified_at: null },
    identity: { name_key: `acme${id}`, name_matches_domain: false, distinctive: true, name_conflict: false },
    calibration: { push_offset: 0 },
    report_credibility: 1,
    learning_budget: null,
    key_hash: `hash_${id}`,
    webhook_secret: 'whsec_x',
    created_at: at(),
    updated_at: at(),
    vectors: interests.map((text) => ({ text, vector: embed(text) })),
    ...overrides,
  };
}

function postRow(authorId, overrides = {}) {
  return {
    id: newId('pst'),
    author_id: authorId,
    type: 'offer',
    title: 'Diwali offer',
    body: 'Five percent off all deliveries during Diwali, partners welcome.',
    tags: [],
    regions: [],
    valid_until: null,
    source_url: null,
    status: 'routed',
    routing: { attempts: 1, last_error: null, started_at: null, next_attempt_at: null, attempt_id: null, lease_until: null },
    safety: { action: 'allow', flags: [] },
    enrichment: { concepts: ['festive', 'promotion'], seeks: [], summary: null, source: 'rules' },
    vector: embed('Five percent off all deliveries during Diwali'),
    review: null,
    content_hash: newId('h'),
    idempotency_key: null,
    created_at: at(),
    routed_at: null,
    ...overrides,
  };
}

function notificationRow(agentId, postId, overrides = {}) {
  const n = {
    id: newId('ntf'),
    created_at: at(),
    status: 'queued',
    outcome: null,
    feedback: null,
    acked_at: null,
    retracted_at: null,
    exploration: false,
    score: 0.8,
    reasons: ['partner fit'],
    features: { sem: 0.3 },
    comment_id: null,
    reason: null,
    delivery: { attempts: 0, last_error: null, delivered_at: null, next_attempt_at: null, dead_letter: null },
    event: 'post.matched',
    agent_id: agentId,
    post_id: postId,
    tier: 'push',
    ...overrides,
  };
  n.dedupe_key ??= n.event === 'post.matched' ? `match:${postId}:${agentId}` : null;
  return n;
}

async function seed(repo) {
  const a = agentRow();
  const b = agentRow({ industry: 'payments' });
  await repo.insertAgent(a);
  await repo.insertAgent(b);
  const post = postRow(a.id);
  await repo.insertPost(post);
  return { a, b, post };
}

for (const target of TARGETS) {
  describe(`repository contract: ${target.kind}`, { skip: target.skip }, () => {
    test('agents round-trip without loss, and reads return copies', async () => {
      const repo = await target.open();
      const a = agentRow();
      await repo.insertAgent(a);
      const { vectors, ...expected } = a;
      const stored = await repo.getAgent(a.id);
      assert.deepEqual(stored, expected);
      stored.company = 'mutated';
      assert.equal((await repo.getAgent(a.id)).company, 'Acme', 'mutating a read does not write');
      assert.deepEqual(await repo.getAgentByKeyHash(a.key_hash), expected);
      assert.deepEqual([...(await repo.getAgents([a.id, 'agt_missing'])).keys()], [a.id]);
    });

    test('mutateAgent writes atomically, aborts on false, and replaces interest vectors', async () => {
      const repo = await target.open();
      const a = agentRow();
      await repo.insertAgent(a);
      assert.equal(await repo.mutateAgent(a.id, () => false), null);
      assert.equal(await repo.mutateAgent('agt_missing', () => {}), null);
      const text = 'Warehousing and fulfilment capacity partnerships';
      const updated = await repo.mutateAgent(a.id, (x) => {
        x.trust = 0.8;
        x.interests = [text];
        x.vectors = [{ text, vector: embed(text) }];
      });
      assert.equal(updated.trust, 0.8);
      assert.equal('vectors' in updated, false);
      const hits = await repo.annSearch(embed('fulfilment capacity for warehousing'), 5);
      assert.equal(hits[0].agentId, a.id);
      const matches = await repo.interestMatches(embed('fulfilment capacity for warehousing'), [a.id]);
      assert.equal(matches.get(a.id).bestInterest, text);
    });

    test('concurrent read-modify-writes of one agent are not lost', async () => {
      const repo = await target.open();
      const a = agentRow({ report_credibility: 0 });
      await repo.insertAgent(a);
      await Promise.all(Array.from({ length: 10 }, () => repo.mutateAgent(a.id, (x) => void (x.report_credibility += 0.05))));
      assert.ok(Math.abs((await repo.getAgent(a.id)).report_credibility - 0.5) < 1e-9);
    });

    test('a domain can have one verified owner only', async () => {
      const repo = await target.open();
      const a = agentRow();
      const b = agentRow({ domain: a.domain });
      await repo.insertAgent(a);
      await repo.insertAgent(b);
      assert.deepEqual((await repo.pendingClaimIds(a.domain)).sort(), [a.id, b.id].sort());
      await repo.mutateAgent(a.id, (x) => void (x.verification = { ...x.verification, status: 'verified' }));
      assert.equal(await repo.domainOwner(a.domain), a.id);
      await assert.rejects(
        repo.mutateAgent(b.id, (x) => void (x.verification = { ...x.verification, status: 'verified' })),
        (err) => err instanceof UniqueViolation && err.constraint === 'agents_verified_domain',
      );
      assert.equal((await repo.getAgent(b.id)).verification.status, 'pending', 'the failed write left no trace');
    });

    test('posts: idempotency keys are unique per author; feed hides taken-down, under-review and expired posts', async () => {
      const repo = await target.open();
      const { a, post } = await seed(repo);
      const keyed = postRow(a.id, { idempotency_key: 'k1' });
      await repo.insertPost(keyed);
      await assert.rejects(repo.insertPost(postRow(a.id, { idempotency_key: 'k1' })), (err) => err instanceof UniqueViolation && err.constraint === 'posts_idempotency');
      assert.equal((await repo.findPostByIdempotencyKey(a.id, 'k1')).id, keyed.id);

      const hidden = postRow(a.id, { status: 'under_review' });
      const expired = postRow(a.id, { valid_until: at(-1000) });
      const later = postRow(a.id, { valid_until: at(3_600_000) });
      for (const p of [hidden, expired, later]) await repo.insertPost(p);
      const feed = (await repo.listPosts({ limit: 10 })).map((p) => p.id);
      assert.deepEqual(feed, [later.id, keyed.id, post.id], 'newest first, hidden and expired left out');
      assert.deepEqual((await repo.postsToExpire()).map((p) => p.id), [expired.id]);
      assert.equal((await repo.findRecentDuplicate(a.id, post.content_hash, at(-60_000))).id, post.id);
      assert.equal(await repo.findRecentDuplicate(a.id, post.content_hash, at(60_000)), null);
      const roundTrip = await repo.getPost(post.id);
      assert.deepEqual({ ...roundTrip, vector: null }, { ...post, vector: null });
      assert.ok(Math.abs(roundTrip.vector[0] - post.vector[0]) < 1e-6, 'embedding survives (float4 precision)');
    });

    test('mutatePost aborts on false and serialises concurrent transitions', async () => {
      const repo = await target.open();
      const { post } = await seed(repo);
      const claims = await Promise.all(
        Array.from({ length: 5 }, () =>
          repo.mutatePost(post.id, (p) => {
            if (p.status !== 'routed') return false;
            p.status = 'under_review';
          }),
        ),
      );
      assert.equal(claims.filter(Boolean).length, 1, 'exactly one transition wins');
    });

    test('notifications: dedupe keys refuse duplicates; delivery compare-and-set never clobbers engagement', async () => {
      const repo = await target.open();
      const { a, b, post } = await seed(repo);
      const n = notificationRow(b.id, post.id);
      assert.deepEqual(await repo.insertNotifications([n, notificationRow(b.id, post.id)]), [n.id], 'same (post, agent) twice in one batch');
      assert.deepEqual(await repo.insertNotifications([notificationRow(b.id, post.id)]), [], 'and across batches');
      assert.equal((await repo.matchFor(post.id, b.id)).id, n.id);
      assert.deepEqual([...(await repo.notifiedAgentIds(post.id))], [b.id]);

      // The agent acks while a delivery attempt is in flight; the attempt then records its result.
      const claimed = { ...(await repo.getNotification(n.id)), status: 'delivering' };
      assert.equal(await repo.saveDeliveryState(claimed, { expectStatus: 'queued' }), true);
      assert.equal(await repo.saveDeliveryState(claimed, { expectStatus: 'queued' }), false, 'a second claim fails');
      await repo.ackNotification(n.id, at());
      await repo.markEngaged(n.id);
      claimed.status = 'delivered';
      claimed.delivery = { ...claimed.delivery, attempts: 1, delivered_at: at() };
      assert.equal(await repo.saveDeliveryState(claimed, { expectStatus: 'delivering' }), true);
      const after = await repo.getNotification(n.id);
      assert.equal(after.status, 'delivered');
      assert.ok(after.acked_at, 'ack survived the delivery write');
      assert.equal(after.outcome, 'engaged', 'engagement survived the delivery write');
      assert.equal(after.delivery.attempts, 1);
      assert.equal(a.id !== b.id, true);
    });

    test('engagement updates are conditional: feedback once, engaged once, ignored only when untouched', async () => {
      const repo = await target.open();
      const { b, post } = await seed(repo);
      const n = notificationRow(b.id, post.id);
      await repo.insertNotifications([n]);
      const results = await Promise.all([repo.recordFeedback(n.id, { relevant: true }, 'relevant'), repo.recordFeedback(n.id, { relevant: false }, 'not_relevant')]);
      assert.equal(results.filter(Boolean).length, 1, 'one of two concurrent feedbacks is recorded');
      assert.equal(await repo.markIgnored(n.id), false, 'feedback exists');
      assert.ok(await repo.markEngaged(n.id));
      assert.equal(await repo.markEngaged(n.id), null, 'already engaged');
      const m = notificationRow(b.id, postRow(b.id).id);
      await repo.insertPost({ ...postRow(b.id), id: m.post_id });
      await repo.insertNotifications([m]);
      assert.equal(await repo.markIgnored(m.id), true);
      assert.equal(await repo.markIgnored(m.id), false);
    });

    test('inbox visibility, dead letters, due retries and delivery budgets', async () => {
      const repo = await target.open();
      const { a, b, post } = await seed(repo);
      const hiddenPost = postRow(a.id, { status: 'quarantined' });
      const expiredPost = postRow(a.id, { valid_until: at(-1000) });
      await repo.insertPost(hiddenPost);
      await repo.insertPost(expiredPost);
      const visible = notificationRow(b.id, post.id, { tier: 'digest', status: 'in_inbox' });
      const ofHidden = notificationRow(b.id, hiddenPost.id);
      const ofExpired = notificationRow(b.id, expiredPost.id);
      const notice = notificationRow(b.id, hiddenPost.id, { event: 'post.retracted', tier: 'system', dedupe_key: `retract:${hiddenPost.id}:${b.id}` });
      const dead = notificationRow(a.id, post.id, {
        status: 'failed',
        delivery: { attempts: 3, last_error: 'HTTP 503', delivered_at: null, next_attempt_at: null, dead_letter: { reason: 'retries_exhausted', at: at() } },
      });
      const due = notificationRow(a.id, hiddenPost.id, { status: 'retry_scheduled', delivery: { attempts: 1, last_error: null, delivered_at: null, next_attempt_at: at(-10), dead_letter: null } });
      await repo.insertNotifications([visible, ofHidden, ofExpired, notice, dead, due]);
      assert.deepEqual((await repo.inbox(b.id, { limit: 10 })).map((n) => n.id), [notice.id, visible.id]);
      assert.deepEqual((await repo.inbox(b.id, { limit: 10, tier: 'digest' })).map((n) => n.id), [visible.id]);
      await repo.ackNotification(visible.id, at());
      assert.deepEqual((await repo.inbox(b.id, { limit: 10, unacked: true })).map((n) => n.id), [notice.id]);
      assert.deepEqual((await repo.deadLetters(a.id)).map((n) => [n.id, n.delivery.dead_letter.reason]), [[dead.id, 'retries_exhausted']]);
      assert.deepEqual((await repo.dueNotifications(at())).map((n) => n.id), [due.id]);
      const counts = await repo.deliveryCounts([a.id, b.id]);
      assert.deepEqual(counts.get(b.id), { push: 2, digest: 1 });
    });

    test('reports and subscriptions are unique; reports close once', async () => {
      const repo = await target.open();
      const { a, b, post } = await seed(repo);
      const report = { id: newId('rpt'), post_id: post.id, agent_id: b.id, reason: 'spam', details: null, weight: 0.8, independent: true, status: 'open', created_at: at() };
      assert.equal(await repo.insertReport(report), true);
      assert.equal(await repo.insertReport({ ...report, id: newId('rpt') }), false);
      assert.deepEqual(await Promise.all([repo.closeReport(report.id, post.id, 'upheld'), repo.closeReport(report.id, post.id, 'dismissed')]).then((r) => r.filter(Boolean).length), 1);
      const sub = { id: newId('sub'), agent_id: b.id, kind: 'agent', target: a.id, created_at: at() };
      assert.equal(await repo.insertSubscription(sub), true);
      assert.equal(await repo.insertSubscription({ ...sub, id: newId('sub') }), false);
      await repo.insertSubscription({ id: newId('sub'), agent_id: a.id, kind: 'topic', target: 'festive', created_at: at() });
      const explicit = await repo.explicitSubscribers({ authorId: a.id, concepts: ['festive'] });
      assert.deepEqual([...explicit.get(b.id)], ['follows_author']);
      assert.deepEqual([...explicit.get(a.id)], ['topic_subscription']);
    });

    test('learned state: model updates and affinity increments are not lost under concurrency', async () => {
      const repo = await target.open();
      const { a, post } = await seed(repo);
      await Promise.all(Array.from({ length: 20 }, () => repo.updateModel((m) => ({ weights: { ...m.weights, bias: m.weights.bias + 0.01 }, updates: m.updates + 1 }))));
      const model = await repo.getModel();
      assert.equal(model.updates, 20);
      assert.ok(Math.abs(model.weights.bias - (-4.2 + 0.2)) < 1e-9);
      await Promise.all(Array.from({ length: 10 }, () => repo.incrementAffinity(a.id, ['festive', 'promotion'], 1)));
      await repo.incrementAffinity(a.id, ['festive'], 0, 0.3);
      assert.deepEqual(Object.fromEntries((await repo.affinityStats([a.id], ['festive', 'promotion', 'cards'])).get(a.id)), {
        festive: { pos: 10, neg: 0.3 },
        promotion: { pos: 10, neg: 0 },
      });
      assert.deepEqual(await Promise.all([repo.markOrganic(post.id, a.id), repo.markOrganic(post.id, a.id)]).then((r) => r.filter(Boolean).length), 1);
      await repo.saveRoutingLog(post.id, { post_id: post.id, routed_at: at(), counts: { push: 1 } });
      assert.deepEqual((await repo.getRoutingLog(post.id)).counts, { push: 1 });
    });

    test('outbox: an event is written atomically with its row, or not at all', async () => {
      const repo = await target.open();
      const { a, b } = await seed(repo);
      const event = (type, payload) => ({ id: newId('evt'), type, payload, created_at: at() });
      const e1 = event('post.published', { postId: 'p1' });
      const p1 = postRow(a.id);
      await repo.insertPost(p1, { events: [e1] });
      // A failing event write (duplicate event id) must take the post down with it.
      const p2 = postRow(a.id);
      await assert.rejects(repo.insertPost(p2, { events: [{ ...e1 }] }), (err) => err instanceof UniqueViolation && err.constraint === 'outbox_event_id');
      assert.equal(await repo.getPost(p2.id), null, 'no post without its event');

      // Notifications: one event per notification actually inserted (duplicates by key get none).
      const fresh = notificationRow(b.id, p1.id);
      const duplicate = notificationRow(b.id, p1.id);
      const ids = await repo.insertNotifications([fresh, duplicate], { event: (n) => event('notification.created', { notificationId: n.id }) });
      assert.deepEqual(ids, [fresh.id]);
      const published = [];
      await repo.publishOutbox(100, async (events) => void published.push(...events));
      assert.deepEqual(published.map((e) => e.type), ['post.published', 'notification.created']);
      assert.deepEqual(published[1].payload, { notificationId: fresh.id });
      assert.deepEqual(await repo.outboxBacklog().then((x) => x.pending), 0);
    });

    test('outbox: publishing is at-least-once and concurrent relays never publish an event twice', async () => {
      const repo = await target.open();
      const { a } = await seed(repo);
      const events = Array.from({ length: 30 }, (_, i) => ({ id: newId('evt'), type: 'post.published', payload: { i }, created_at: at() }));
      for (const e of events) await repo.insertPost(postRow(a.id), { events: [e] });

      // A relay whose transport fails publishes nothing and loses nothing.
      await assert.rejects(repo.publishOutbox(10, async () => { throw new Error('redis down'); }), /redis down/);
      assert.equal((await repo.outboxBacklog()).pending, 30);

      // Three relays drain the outbox concurrently; every event is published exactly once, in order per relay.
      const seen = [];
      const relay = async () => {
        while ((await repo.publishOutbox(4, async (batch) => {
          await new Promise((r) => setTimeout(r, 5));
          seen.push(...batch.map((e) => e.payload.i));
        })) > 0);
      };
      await Promise.all([relay(), relay(), relay()]);
      assert.deepEqual([...seen].sort((x, y) => x - y), events.map((_, i) => i));
      assert.equal((await repo.outboxBacklog()).pending, 0);
    });

    test('consumer ledger records an event once per consumer group', async () => {
      const repo = await target.open();
      assert.equal(await repo.isProcessed('routing', 'evt_1'), false);
      assert.deepEqual(await Promise.all([repo.markProcessed('routing', 'evt_1'), repo.markProcessed('routing', 'evt_1')]).then((r) => r.filter(Boolean).length), 1);
      assert.equal(await repo.isProcessed('routing', 'evt_1'), true);
      assert.equal(await repo.isProcessed('delivery', 'evt_1'), false, 'groups are independent');
    });

    test('brand candidates are exactly the verified, name-confirmed, distinctive agents not under review', async () => {
      const repo = await target.open();
      const brand = agentRow({ identity: { name_key: 'acmebrand', name_matches_domain: true, distinctive: true, name_conflict: false } });
      const plain = agentRow();
      await repo.insertAgent(brand);
      await repo.insertAgent(plain);
      assert.deepEqual(await repo.brandCandidates(), [], 'not verified yet');
      await repo.mutateAgent(brand.id, (a) => void (a.verification = { ...a.verification, status: 'verified' }));
      await repo.mutateAgent(plain.id, (a) => void (a.verification = { ...a.verification, status: 'verified' }));
      assert.deepEqual((await repo.brandCandidates()).map((b) => b.id), [brand.id]);
      await repo.mutateAgent(brand.id, (a) => void (a.identity = { ...a.identity, review: 'pending' }));
      assert.deepEqual(await repo.brandCandidates(), [], 'not while its identity is under review');
      await repo.mutateAgent(brand.id, (a) => void (a.identity = { ...a.identity, review: 'approved' }));
      assert.equal((await repo.brandCandidates()).length, 1);
    });

    test('candidate discovery keeps the best discovered agents under the cap and reports the total', async () => {
      const repo = await target.open();
      const partners = [];
      // Pre-scores: partners[1] = 1 (partner industry) + 1 (topic overlap) = 2, partners[2] = 1,
      // travel agents 0 (found through the topic index only). No ties at the cut.
      for (let i = 0; i < 6; i++) {
        const agent = agentRow({ industry: i < 3 ? 'payments' : 'travel', concepts: i === 1 ? ['festive'] : ['cards'] });
        partners.push(agent);
        await repo.insertAgent(agent);
      }
      const { ids, total } = await repo.discoverCandidates({
        specificConcepts: retrievalConcepts(['festive', 'cards']),
        seekIndustries: ['payments'],
        annSims: new Map(),
        postConcepts: ['festive'],
        excludeIds: new Set([partners[0].id]),
        max: 2,
      });
      assert.equal(ids.length, 2);
      assert.ok(total >= 2 && total <= 5);
      assert.equal(ids.includes(partners[0].id), false, 'explicit subscribers are excluded from discovery');
      assert.deepEqual(ids, [partners[1].id, partners[2].id], 'ranked by partner fit + topic overlap');
    });
  });
}

describe('PostgreSQL durability and migrations', () => {
  test('state written through the repository survives an engine restart (PGlite, on-disk data directory)', { skip: !hasPglite && 'PGlite not installed' }, async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite-pgvector');
    const { PostgresRepository } = await import('../src/repo/postgres.js');
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'agentnet-pg-'));
    try {
      let engine = await PGlite.create({ dataDir, extensions: { vector } });
      let repo = await PostgresRepository.onPglite(engine);
      const { a, b, post } = await seed(repo);
      const n = notificationRow(b.id, post.id, { status: 'retry_scheduled', delivery: { attempts: 1, last_error: 'HTTP 503', delivered_at: null, next_attempt_at: at(5000), dead_letter: null } });
      await repo.insertNotifications([n]);
      await repo.updateModel((m) => ({ weights: { ...m.weights, sem: 4.5 }, updates: m.updates + 1 }));
      await engine.close(); // the process stops

      engine = await PGlite.create({ dataDir, extensions: { vector } });
      repo = await PostgresRepository.onPglite(engine); // migrations: already applied, nothing to do
      assert.equal((await repo.getAgent(a.id)).company, 'Acme');
      assert.equal((await repo.getPost(post.id)).status, 'routed');
      const restored = await repo.getNotification(n.id);
      assert.deepEqual([restored.status, restored.delivery.next_attempt_at], ['retry_scheduled', n.delivery.next_attempt_at], 'scheduled retries are persisted');
      assert.deepEqual(await repo.getModel().then((m) => [m.weights.sem, m.updates]), [4.5, 1], 'the learned model is persisted');
      await engine.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('migrations apply once, are recorded, and refuse edited history', { skip: !hasPglite && 'PGlite not installed' }, async () => {
    const { migrate, loadMigrations } = await import('../src/repo/migrate.js');
    const { pgliteDb } = await import('../src/repo/db.js');
    const { sharedPglite } = await import('./support/repositories.js');
    const schema = `m_${Date.now().toString(36)}`;
    const db = pgliteDb(await sharedPglite(), { schema });
    const first = await migrate(db, { schema });
    assert.deepEqual(first, loadMigrations().map((m) => m.name));
    assert.deepEqual(await migrate(db, { schema }), [], 'second run is a no-op');
    const edited = loadMigrations().map((m) => ({ ...m, checksum: 'different' }));
    await assert.rejects(migrate(db, { schema, migrations: edited }), /modified after it was applied/);
    const { rows } = await db.query('SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname', [schema]);
    const indexes = rows.map((r) => r.indexname);
    for (const name of ['agent_interests_embedding_hnsw', 'agents_verified_domain', 'agents_retrieval_concepts', 'agents_brands', 'notifications_dedupe', 'notifications_due', 'posts_idempotency']) {
      assert.ok(indexes.includes(name), `index ${name}`);
    }
    const hnsw = await db.query("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'agent_interests_embedding_hnsw'", [schema]);
    assert.match(hnsw.rows[0].indexdef, /USING hnsw \(embedding vector_cosine_ops\)/);

    // The brand query (run on every domain verification) can use its partial index: the query's
    // predicate matches the index's, so its cost follows the number of brands, not of agents.
    const { PostgresRepository } = await import('../src/repo/postgres.js');
    const repo = new PostgresRepository(db, { schema });
    const captured = [];
    const query = db.query.bind(db);
    db.query = (text, params) => (captured.push(text), query(text, params));
    await repo.brandCandidates();
    db.query = query;
    const plan = await db.transaction(async (tx) => {
      await tx.query('SET LOCAL enable_seqscan = off');
      return (await tx.query(`EXPLAIN ${captured[0]}`)).rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    assert.match(plan, /agents_brands/, plan);
  });

  test('concurrent migration runners on a PostgreSQL server apply each migration exactly once', { skip: !hasServer && `no PostgreSQL server at ${testDatabaseUrl()}` }, async () => {
    const { connectPg } = await import('../src/repo/db.js');
    const { migrate } = await import('../src/repo/migrate.js');
    const schema = `m_${Date.now().toString(36)}`;
    const dbs = await Promise.all([1, 2, 3].map(() => connectPg({ url: testDatabaseUrl(), schema, max: 2 })));
    try {
      const results = await Promise.all(dbs.map((db) => migrate(db, { schema })));
      assert.equal(results.flat().length, results.find((r) => r.length).length, 'each migration applied by exactly one runner');
    } finally {
      await dbs[0].query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await Promise.all(dbs.map((db) => db.close()));
    }
  });
});
