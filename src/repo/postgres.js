// PostgreSQL + pgvector implementation of the repository contract (see repo/memory.js for the
// contract itself). Schema: migrations/001_initial_schema.sql.
//
// How the contract maps to PostgreSQL:
//   - mutateAgent / mutatePost        SELECT ... FOR UPDATE + UPDATE in one transaction
//   - saveDeliveryState               UPDATE ... WHERE status = $expected (compare-and-set)
//   - engagement updates              single conditional UPDATE ... RETURNING
//   - uniqueness                      unique constraints / indexes; 23505 -> UniqueViolation
//   - nearest neighbours              HNSW index on agent_interests.embedding (cosine)
//   - candidate discovery             GIN (topics) + btree (industry) + ANN hits, ranked in SQL
//   - learned model                   one row, updated under a row lock
//
// Numeric note: embeddings are stored as float4 (pgvector), so similarities can differ from the
// in-memory float64 computation in the 7th decimal place; routing decisions are unaffected
// except exactly at a threshold.

import { UniqueViolation } from './errors.js';
import { applyBudgets } from './budgets.js';
import { priorWeights } from '../routing/learner.js';
import { migrate } from './migrate.js';
import { connectPg, pgliteDb } from './db.js';

const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const num = (v) => (v == null ? null : Number(v));
// null/undefined become SQL NULL, never the jsonb value `null` (which IS NULL would not match).
const json = (v) => (v == null ? null : JSON.stringify(v));
const toVector = (v) => (v == null ? null : `[${Array.from(v).join(',')}]`);
const fromVector = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : Array.from(v));
const expiresAt = (validUntil) => {
  if (!validUntil) return null;
  const at = Date.parse(validUntil);
  if (!Number.isFinite(at)) throw new Error(`unparseable valid_until: ${validUntil}`);
  return new Date(at).toISOString();
};
const HIDDEN_POSTS = "('quarantined', 'under_review')";

function translate(err) {
  if (err?.code === '23505') return new UniqueViolation(err.constraint ?? 'unique', err.message);
  return err;
}

/** Runs `fn`, turning unique violations into the contract's UniqueViolation. */
async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    throw translate(err);
  }
}

/** Multi-row VALUES placeholders: rows of `width` params, with per-column casts. */
function values(rowCount, casts) {
  const width = casts.length;
  const out = [];
  for (let r = 0; r < rowCount; r++) out.push(`(${casts.map((cast, c) => `$${r * width + c + 1}${cast}`).join(', ')})`);
  return out.join(', ');
}

// ---- row mappers ------------------------------------------------------------------------------

const AGENT_COLUMNS = `id, company, domain, industry, description, interests, topics, exclude_topics, blocked_agents, regions,
  concepts, retrieval_concepts, delivery, status, trust, verification, identity, calibration, report_credibility, key_hash,
  webhook_secret, created_at, updated_at, learning_budget, blocked_industries`;
const AGENT_CASTS = ['', '', '', '', '', '::jsonb', '::text[]', '::text[]', '::text[]', '::text[]', '::text[]', '::text[]', '::jsonb', '', '', '::jsonb', '::jsonb', '::jsonb', '', '', '', '::timestamptz', '::timestamptz', '::jsonb', '::text[]'];

const agentParams = (a) => [
  a.id, a.company, a.domain, a.industry, a.description, json(a.interests), a.topics, a.exclude_topics, a.blocked_agents, a.regions,
  a.concepts ?? [], a.retrieval_concepts ?? [], json(a.delivery), a.status, a.trust, json(a.verification), json(a.identity), json(a.calibration),
  a.report_credibility, a.key_hash, a.webhook_secret, a.created_at, a.updated_at, json(a.learning_budget), a.blocked_industries ?? [],
];

const toAgent = (r) => ({
  id: r.id,
  company: r.company,
  domain: r.domain,
  industry: r.industry,
  description: r.description,
  interests: r.interests,
  topics: r.topics,
  exclude_topics: r.exclude_topics,
  blocked_agents: r.blocked_agents,
  blocked_industries: r.blocked_industries ?? [],
  regions: r.regions,
  delivery: r.delivery,
  status: r.status,
  trust: Number(r.trust),
  verification: r.verification,
  identity: r.identity,
  calibration: r.calibration,
  report_credibility: Number(r.report_credibility),
  key_hash: r.key_hash,
  webhook_secret: r.webhook_secret,
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
  concepts: r.concepts,
  retrieval_concepts: r.retrieval_concepts,
  learning_budget: r.learning_budget ?? null,
});

const toIdentityReview = (r) => ({
  id: r.id,
  agent_id: r.agent_id,
  kind: r.kind,
  status: r.status,
  details: r.details,
  created_at: iso(r.created_at),
  decided_at: iso(r.decided_at),
  decision_note: r.decision_note,
});

const POST_COLUMNS = `id, author_id, type, title, body, tags, regions, valid_until, expires_at, source_url, status, routing, safety,
  enrichment, topics, vector, review, content_hash, idempotency_key, created_at, routed_at`;
// List and batch reads skip the embedding: views never need it, and it is 1024 floats per post.
const POST_COLUMNS_NO_VECTOR = POST_COLUMNS.replace('vector,', 'NULL::text AS vector,');
const POST_CASTS = ['', '', '', '', '', '::text[]', '::text[]', '', '::timestamptz', '', '', '::jsonb', '::jsonb', '::jsonb', '::text[]', '::vector', '::jsonb', '', '', '::timestamptz', '::timestamptz'];

const postParams = (p) => [
  p.id, p.author_id, p.type, p.title, p.body, p.tags, p.regions, p.valid_until, expiresAt(p.valid_until), p.source_url, p.status,
  json(p.routing), json(p.safety), json(p.enrichment), p.enrichment?.concepts ?? [], toVector(p.vector), json(p.review),
  p.content_hash, p.idempotency_key ?? null, p.created_at, p.routed_at,
];

const toPost = (r) => ({
  id: r.id,
  author_id: r.author_id,
  type: r.type,
  title: r.title,
  body: r.body,
  tags: r.tags,
  regions: r.regions,
  valid_until: r.valid_until,
  source_url: r.source_url,
  status: r.status,
  routing: r.routing,
  safety: r.safety,
  enrichment: r.enrichment,
  vector: fromVector(r.vector),
  review: r.review,
  content_hash: r.content_hash,
  idempotency_key: r.idempotency_key,
  created_at: iso(r.created_at),
  routed_at: iso(r.routed_at),
});

const toComment = (r) => ({
  id: r.id,
  post_id: r.post_id,
  author_id: r.author_id,
  body: r.body,
  reply_to: r.reply_to,
  flags: r.flags,
  created_at: iso(r.created_at),
});

const NOTIFICATION_COLUMNS = `id, agent_id, post_id, comment_id, event, tier, dedupe_key, score, reasons, features, exploration, reason,
  outcome, feedback, acked_at, status, attempts, last_error, delivered_at, next_attempt_at, cycle_started_at, claimed_at,
  dead_letter_reason, dead_lettered_at, cancel_reason, redeliveries, retracted_at, created_at, batch_id`;
const NOTIFICATION_CASTS = ['', '', '', '', '', '', '', '::float8', '::jsonb', '::jsonb', '::boolean', '', '', '::jsonb', '::timestamptz', '', '::int', '', '::timestamptz', '::timestamptz', '::timestamptz', '::timestamptz', '', '::timestamptz', '', '::int', '::timestamptz', '::timestamptz', ''];

/** The delivery-owned fields of a notification, as column values. */
const deliveryColumns = (n) => {
  const d = n.delivery ?? {};
  return [
    n.status, d.attempts ?? 0, d.last_error ?? null, d.delivered_at ?? null, d.next_attempt_at ?? null, d.cycle_started_at ?? null,
    d.claimed_at ?? null, d.dead_letter?.reason ?? null, d.dead_letter?.at ?? null, d.cancel_reason ?? null, d.redeliveries ?? 0,
    n.retracted_at ?? null,
  ];
};

const notificationParams = (n) => {
  const [status, attempts, lastError, deliveredAt, nextAttemptAt, cycleStartedAt, claimedAt, dlReason, dlAt, cancelReason, redeliveries, retractedAt] = deliveryColumns(n);
  return [
    n.id, n.agent_id, n.post_id, n.comment_id ?? null, n.event, n.tier, n.dedupe_key ?? null, n.score ?? null, json(n.reasons ?? []),
    json(n.features ?? null), Boolean(n.exploration), n.reason ?? null, n.outcome ?? null, json(n.feedback ?? null), n.acked_at ?? null,
    status, attempts, lastError, deliveredAt, nextAttemptAt, cycleStartedAt, claimedAt, dlReason, dlAt, cancelReason, redeliveries,
    retractedAt, n.created_at, n.batch_id ?? null,
  ];
};

const toNotification = (r) => ({
  id: r.id,
  created_at: iso(r.created_at),
  status: r.status,
  outcome: r.outcome,
  feedback: r.feedback,
  acked_at: iso(r.acked_at),
  retracted_at: iso(r.retracted_at),
  exploration: r.exploration,
  score: num(r.score),
  reasons: r.reasons,
  features: r.features,
  comment_id: r.comment_id,
  reason: r.reason,
  delivery: {
    attempts: Number(r.attempts),
    last_error: r.last_error,
    delivered_at: iso(r.delivered_at),
    next_attempt_at: iso(r.next_attempt_at),
    dead_letter: r.dead_letter_reason ? { reason: r.dead_letter_reason, at: iso(r.dead_lettered_at) } : null,
    cycle_started_at: iso(r.cycle_started_at),
    claimed_at: iso(r.claimed_at),
    cancel_reason: r.cancel_reason,
    redeliveries: Number(r.redeliveries),
  },
  event: r.event,
  agent_id: r.agent_id,
  post_id: r.post_id,
  tier: r.tier,
  dedupe_key: r.dedupe_key,
  batch_id: r.batch_id ?? null,
  seq: Number(r.seq),
});

const toReport = (r) => ({
  id: r.id,
  post_id: r.post_id,
  agent_id: r.agent_id,
  reason: r.reason,
  details: r.details,
  weight: Number(r.weight),
  independent: r.independent,
  status: r.status,
  created_at: iso(r.created_at),
});

const toSubscription = (r) => ({ id: r.id, agent_id: r.agent_id, kind: r.kind, target: r.target, created_at: iso(r.created_at) });

const one = (rows, map) => (rows.length ? map(rows[0]) : null);

// ---- repository -------------------------------------------------------------------------------

export class PostgresRepository {
  /** @param db  a connection from repo/db.js */
  constructor(db, { schema } = {}) {
    this.kind = 'postgres';
    this.db = db;
    this.schema = schema;
  }

  /** Connects to a PostgreSQL server and applies pending migrations. */
  static async connect({ url, schema, max, log, migrate: runMigrations = true }) {
    const db = await connectPg({ url, schema, max });
    const repo = new PostgresRepository(db, { schema });
    if (runMigrations) await migrate(db, { schema, log });
    return repo;
  }

  /** Uses an existing PGlite engine (tests), optionally in its own schema. */
  static async onPglite(engine, { schema, log } = {}) {
    const db = pgliteDb(engine, { schema });
    await migrate(db, { schema, log });
    return new PostgresRepository(db, { schema });
  }

  async init() {}

  async close() {
    await this.db.close();
  }

  q(text, params) {
    return guarded(() => this.db.query(text, params));
  }

  tx(fn) {
    return guarded(() => this.db.transaction(fn));
  }

  // ---- agents ------------------------------------------------------------------------------

  async #writeInterests(tx, agentId, vectors) {
    await tx.query('DELETE FROM agent_interests WHERE agent_id = $1', [agentId]);
    if (!vectors.length) return;
    const params = vectors.flatMap((v, i) => [agentId, i, v.text, toVector(v.vector)]);
    await tx.query(`INSERT INTO agent_interests (agent_id, ordinal, statement, embedding) VALUES ${values(vectors.length, ['', '::smallint', '', '::vector'])}`, params);
  }

  async insertAgent(agent) {
    await this.tx(async (tx) => {
      await tx.query(`INSERT INTO agents (${AGENT_COLUMNS}) VALUES ${values(1, AGENT_CASTS)}`, agentParams(agent));
      await this.#writeInterests(tx, agent.id, agent.vectors ?? []);
    });
  }

  /** Bulk insert (seeding and load tests): multi-row inserts in one transaction per call. */
  async insertAgents(list) {
    if (!list.length) return;
    await this.tx(async (tx) => {
      const AGENTS_PER_STATEMENT = 400; // 24 parameters each, well under the 65535 limit
      for (let i = 0; i < list.length; i += AGENTS_PER_STATEMENT) {
        const chunk = list.slice(i, i + AGENTS_PER_STATEMENT);
        await tx.query(`INSERT INTO agents (${AGENT_COLUMNS}) VALUES ${values(chunk.length, AGENT_CASTS)}`, chunk.flatMap(agentParams));
      }
      const interests = list.flatMap((a) => (a.vectors ?? []).map((v, ordinal) => [a.id, ordinal, v.text, toVector(v.vector)]));
      const ROWS = 500;
      for (let i = 0; i < interests.length; i += ROWS) {
        const chunk = interests.slice(i, i + ROWS);
        await tx.query(`INSERT INTO agent_interests (agent_id, ordinal, statement, embedding) VALUES ${values(chunk.length, ['', '::smallint', '', '::vector'])}`, chunk.flat());
      }
    });
  }

  async getAgent(id) {
    return one((await this.q(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`, [id])).rows, toAgent);
  }

  async getAgents(ids) {
    const { rows } = await this.q(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ANY($1::text[])`, [[...ids]]);
    return new Map(rows.map((r) => [r.id, toAgent(r)]));
  }

  async getAgentByKeyHash(hash) {
    return one((await this.q(`SELECT ${AGENT_COLUMNS} FROM agents WHERE key_hash = $1`, [hash])).rows, toAgent);
  }

  async mutateAgent(id, mutator) {
    return this.tx(async (tx) => {
      const { rows } = await tx.query(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows.length) return null;
      const draft = toAgent(rows[0]);
      if (mutator(draft) === false) return null;
      const { vectors, ...agent } = draft;
      agent.id = id;
      const params = agentParams(agent);
      const sets = AGENT_COLUMNS.split(',')
        .map((c) => c.trim())
        .map((c, i) => `${c} = $${i + 1}${AGENT_CASTS[i]}`)
        .slice(1);
      await tx.query(`UPDATE agents SET ${sets.join(', ')} WHERE id = $1`, params);
      if (vectors) await this.#writeInterests(tx, id, vectors);
      return agent;
    });
  }

  async domainOwner(domain) {
    const { rows } = await this.q("SELECT id FROM agents WHERE domain = $1 AND verification_status = 'verified'", [domain]);
    return rows[0]?.id ?? null;
  }

  async pendingClaimIds(domain) {
    const { rows } = await this.q("SELECT id FROM agents WHERE domain = $1 AND verification_status = 'pending' AND status <> 'revoked' ORDER BY created_at, id", [domain]);
    return rows.map((r) => r.id);
  }

  async agentsWithNameKey(nameKey) {
    const { rows } = await this.q(`SELECT ${AGENT_COLUMNS} FROM agents WHERE name_key = $1 ORDER BY created_at, id`, [nameKey]);
    return rows.map(toAgent);
  }

  async brandCandidates() {
    const { rows } = await this.q(
      // Same predicate as the agents_brands partial index (migration 005), so it is an index scan.
      `SELECT id, company AS name, domain FROM agents
        WHERE status = 'active'
          AND verification_status = 'verified'
          AND (identity ->> 'name_matches_domain') = 'true'
          AND COALESCE(identity ->> 'name_conflict', 'false') <> 'true'
          AND COALESCE(identity ->> 'review', '') NOT IN ('pending', 'rejected')
          AND (identity ->> 'distinctive') = 'true'`,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, domain: r.domain }));
  }

  /** Active verified agents' domains (for look-alike checks when a brand verifies). */
  async verifiedAgentDomains() {
    const { rows } = await this.q("SELECT id, domain FROM agents WHERE status = 'active' AND verification_status = 'verified'");
    return rows.map((r) => ({ id: r.id, domain: r.domain }));
  }

  // ---- identity reviews --------------------------------------------------------------------

  /** Opens a review; false if one of the same kind is already open for the agent. */
  async insertIdentityReview(r) {
    const { rowCount } = await this.q(
      `INSERT INTO identity_reviews (id, agent_id, kind, status, details, created_at) VALUES ($1, $2, $3, 'pending', $4::jsonb, $5::timestamptz)
       ON CONFLICT (agent_id, kind) WHERE status = 'pending' DO NOTHING`,
      [r.id, r.agent_id, r.kind, json(r.details), r.created_at],
    );
    return rowCount === 1;
  }

  async identityReviews({ status, limit = 100 } = {}) {
    const { rows } = await this.q('SELECT * FROM identity_reviews WHERE ($1::text IS NULL OR status = $1) ORDER BY seq LIMIT $2', [status ?? null, limit]);
    return rows.map(toIdentityReview);
  }

  async getIdentityReview(id) {
    return one((await this.q('SELECT * FROM identity_reviews WHERE id = $1', [id])).rows, toIdentityReview);
  }

  /** Decides a pending review (compare-and-set); null if it was already decided. */
  async decideIdentityReview(id, { status, note, decidedAt }) {
    const { rows } = await this.q(
      "UPDATE identity_reviews SET status = $2, decision_note = $3, decided_at = $4::timestamptz WHERE id = $1 AND status = 'pending' RETURNING *",
      [id, status, note ?? null, decidedAt],
    );
    return one(rows, toIdentityReview);
  }

  async countAgents() {
    return Number((await this.q('SELECT count(*)::int AS n FROM agents')).rows[0].n);
  }

  // ---- routing data ------------------------------------------------------------------------

  /** Nearest agents by their best interest statement, through the HNSW index. */
  async annSearch(vector, k, minSim = 0.05) {
    const rowsWanted = Math.min(1000, Math.max(40, k * 3)); // agents have several statements each
    const { rows } = await this.tx(async (tx) => {
      // HNSW returns at most ef_search rows; raise it to cover the rows we ask for. Iterative
      // scanning (pgvector >= 0.8) lets the search continue past early termination; order is
      // re-established below, so relaxed order is enough. Known limit: with thousands of exactly
      // identical vectors (the benchmark's templated interests) the graph still yields fewer rows
      // than asked (323 of 600 at 10K agents); other candidate sources cover those agents.
      await tx.query(`SET LOCAL hnsw.ef_search = ${rowsWanted}`);
      await tx.query('SET LOCAL hnsw.iterative_scan = relaxed_order');
      return tx.query(
        `SELECT agent_id, max(1 - distance) FILTER (WHERE distance <> 'NaN') AS sim
           FROM (SELECT agent_id, embedding <=> $1::vector AS distance
                   FROM agent_interests ORDER BY embedding <=> $1::vector LIMIT $2) nearest
          GROUP BY agent_id`,
        [toVector(vector), rowsWanted],
      );
    });
    return rows
      .map((r) => ({ agentId: r.agent_id, sim: Math.max(0, Math.min(1, Number(r.sim))) }))
      .filter((r) => Number.isFinite(r.sim) && r.sim >= minSim)
      .sort((a, b) => b.sim - a.sim || (a.agentId < b.agentId ? -1 : 1))
      .slice(0, k);
  }

  async discoverCandidates({ specificConcepts, seekIndustries, annSims, postConcepts, excludeIds, max }) {
    const annIds = [...annSims.keys()];
    const { rows } = await this.q(
      `WITH ann AS (SELECT * FROM unnest($3::text[], $4::float8[]) AS t(id, sim))
       SELECT a.id,
              (CASE WHEN a.industry = ANY($2::text[]) THEN 1 ELSE 0 END)
              + COALESCE(ann.sim, 0)
              + (SELECT count(*) FROM unnest(a.concepts) c WHERE c = ANY($5::text[]))::float8 / GREATEST(1, cardinality($5::text[])) AS score,
              count(*) OVER () AS total
         FROM agents a LEFT JOIN ann ON ann.id = a.id
        WHERE (a.retrieval_concepts && $1::text[] OR a.industry = ANY($2::text[]) OR ann.id IS NOT NULL)
          AND NOT (a.id = ANY($6::text[]))
        ORDER BY score DESC, a.id COLLATE "C"
        LIMIT $7`,
      [specificConcepts, seekIndustries, annIds, annIds.map((id) => annSims.get(id)), postConcepts, [...excludeIds], max],
    );
    return { ids: rows.map((r) => r.id), total: rows.length ? Number(rows[0].total) : 0 };
  }

  async explicitSubscribers({ authorId, concepts }) {
    const { rows } = await this.q(
      `SELECT agent_id, kind FROM subscriptions
        WHERE (kind = 'agent' AND target = $1) OR (kind = 'topic' AND target = ANY($2::text[]))
        ORDER BY seq`,
      [authorId, concepts],
    );
    const out = new Map();
    for (const r of rows) {
      if (!out.has(r.agent_id)) out.set(r.agent_id, new Set());
      out.get(r.agent_id).add(r.kind === 'agent' ? 'follows_author' : 'topic_subscription');
    }
    return out;
  }

  async interestMatches(vector, agentIds) {
    const { rows } = await this.q(
      `SELECT agent_id, statement, 1 - (embedding <=> $1::vector) AS sim
         FROM agent_interests WHERE agent_id = ANY($2::text[]) ORDER BY agent_id, ordinal`,
      [toVector(vector), [...agentIds]],
    );
    const out = new Map();
    for (const id of agentIds) out.set(id, { sem: 0, bestInterest: null });
    for (const r of rows) {
      const s = Math.min(1, Number(r.sim));
      const best = out.get(r.agent_id);
      if (s > best.sem) out.set(r.agent_id, { sem: s, bestInterest: r.statement });
    }
    return out;
  }

  async affinityStats(agentIds, concepts) {
    const { rows } = await this.q('SELECT agent_id, topic, pos, neg FROM agent_topic_stats WHERE agent_id = ANY($1::text[]) AND topic = ANY($2::text[])', [
      [...agentIds],
      concepts,
    ]);
    const out = new Map();
    for (const r of rows) {
      if (!out.has(r.agent_id)) out.set(r.agent_id, new Map());
      out.get(r.agent_id).set(r.topic, { pos: Number(r.pos), neg: Number(r.neg) });
    }
    return out;
  }

  async deliveryCounts(agentIds, now = Date.now()) {
    const { rows } = await this.q(
      `SELECT agent_id,
              count(*) FILTER (WHERE tier = 'push' AND created_at > $2::timestamptz - interval '1 hour')::int AS push,
              count(*) FILTER (WHERE tier = 'digest')::int AS digest
         FROM notifications
        WHERE agent_id = ANY($1::text[]) AND event = 'post.matched' AND created_at > $2::timestamptz - interval '1 day'
        GROUP BY agent_id`,
      [[...agentIds], new Date(now).toISOString()],
    );
    const out = new Map();
    for (const id of agentIds) out.set(id, { push: 0, digest: 0 });
    for (const r of rows) out.set(r.agent_id, { push: Number(r.push), digest: Number(r.digest) });
    return out;
  }

  async notifiedAgentIds(postId) {
    const { rows } = await this.q("SELECT agent_id FROM notifications WHERE post_id = $1 AND event = 'post.matched'", [postId]);
    return new Set(rows.map((r) => r.agent_id));
  }

  // ---- posts -------------------------------------------------------------------------------

  /** Appends outbox events inside the caller's transaction. */
  async #appendEvents(tx, events) {
    if (!events.length) return;
    const params = events.flatMap((e) => [e.id, e.type, json(e.payload), e.created_at ?? new Date().toISOString()]);
    await tx.query(`INSERT INTO outbox (event_id, type, payload, created_at) VALUES ${values(events.length, ['', '', '::jsonb', '::timestamptz'])}`, params);
  }

  /** Inserts a post and its events in one transaction. */
  async insertPost(post, { events = [] } = {}) {
    await this.tx(async (tx) => {
      await tx.query(`INSERT INTO posts (${POST_COLUMNS}) VALUES ${values(1, POST_CASTS)}`, postParams(post));
      await this.#appendEvents(tx, events);
    });
  }

  async getPost(id) {
    return one((await this.q(`SELECT ${POST_COLUMNS} FROM posts WHERE id = $1`, [id])).rows, toPost);
  }

  async getPosts(ids) {
    const { rows } = await this.q(`SELECT ${POST_COLUMNS_NO_VECTOR} FROM posts WHERE id = ANY($1::text[])`, [[...ids]]);
    return new Map(rows.map((r) => [r.id, toPost(r)]));
  }

  async mutatePost(id, mutator) {
    return this.tx(async (tx) => {
      const { rows } = await tx.query(`SELECT ${POST_COLUMNS} FROM posts WHERE id = $1 FOR UPDATE`, [id]);
      if (!rows.length) return null;
      const draft = toPost(rows[0]);
      if (mutator(draft) === false) return null;
      draft.id = id;
      const sets = POST_COLUMNS.split(',')
        .map((c) => c.trim())
        .map((c, i) => `${c} = $${i + 1}${POST_CASTS[i]}`)
        .slice(1);
      await tx.query(`UPDATE posts SET ${sets.join(', ')} WHERE id = $1`, postParams(draft));
      return draft;
    });
  }

  async findPostByIdempotencyKey(authorId, key) {
    return one((await this.q(`SELECT ${POST_COLUMNS} FROM posts WHERE author_id = $1 AND idempotency_key = $2`, [authorId, key])).rows, toPost);
  }

  async findRecentDuplicate(authorId, contentHash, sinceIso) {
    const { rows } = await this.q(
      `SELECT ${POST_COLUMNS_NO_VECTOR} FROM posts WHERE author_id = $1 AND content_hash = $2 AND created_at >= $3::timestamptz ORDER BY seq DESC LIMIT 1`,
      [authorId, contentHash, sinceIso],
    );
    return one(rows, toPost);
  }

  async listPosts({ authorId, topic, limit, now = Date.now() }) {
    const { rows } = await this.q(
      `SELECT ${POST_COLUMNS_NO_VECTOR} FROM posts
        WHERE status NOT IN ${HIDDEN_POSTS} AND (expires_at IS NULL OR expires_at > $1::timestamptz)
          AND ($2::text IS NULL OR author_id = $2) AND ($3::text IS NULL OR topics @> ARRAY[$3::text])
        ORDER BY seq DESC LIMIT $4`,
      [new Date(now).toISOString(), authorId ?? null, topic ?? null, limit],
    );
    return rows.map(toPost);
  }

  async postIdsByAuthor(authorId) {
    return (await this.q('SELECT id FROM posts WHERE author_id = $1 ORDER BY seq', [authorId])).rows.map((r) => r.id);
  }

  async postsWithStatus(statuses, { limit = 1000 } = {}) {
    const { rows } = await this.q(`SELECT ${POST_COLUMNS_NO_VECTOR} FROM posts WHERE status = ANY($1::text[]) ORDER BY seq LIMIT $2`, [statuses, limit]);
    return rows.map(toPost);
  }

  async dueRoutingRetries(nowIso, { limit = 100 } = {}) {
    const { rows } = await this.q(
      `SELECT ${POST_COLUMNS_NO_VECTOR} FROM posts
        WHERE status = 'retrying' AND (routing ->> 'next_attempt_at')::timestamptz <= $1::timestamptz
        ORDER BY seq LIMIT $2`,
      [nowIso, limit],
    );
    return rows.map(toPost);
  }

  async postsToExpire(now = Date.now(), { limit = 1000 } = {}) {
    const { rows } = await this.q(
      `SELECT ${POST_COLUMNS_NO_VECTOR} FROM posts
        WHERE expires_at IS NOT NULL AND expires_at <= $1::timestamptz AND status NOT IN ('expired', 'quarantined', 'under_review')
        ORDER BY seq LIMIT $2`,
      [new Date(now).toISOString(), limit],
    );
    return rows.map(toPost);
  }

  async countPosts() {
    return Number((await this.q('SELECT count(*)::int AS n FROM posts')).rows[0].n);
  }

  // ---- comments ----------------------------------------------------------------------------

  /** Inserts a comment and its events in one transaction. */
  async insertComment(c, { events = [] } = {}) {
    await this.tx(async (tx) => {
      await tx.query('INSERT INTO comments (id, post_id, author_id, body, reply_to, flags, created_at) VALUES ($1, $2, $3, $4, $5, $6::text[], $7::timestamptz)', [
        c.id, c.post_id, c.author_id, c.body, c.reply_to ?? null, c.flags ?? [], c.created_at,
      ]);
      await this.#appendEvents(tx, events);
    });
  }

  async getComment(id) {
    return one((await this.q('SELECT * FROM comments WHERE id = $1', [id])).rows, toComment);
  }

  async getComments(ids) {
    const { rows } = await this.q('SELECT * FROM comments WHERE id = ANY($1::text[])', [[...ids]]);
    return new Map(rows.map((r) => [r.id, toComment(r)]));
  }

  async commentsOn(postId) {
    return (await this.q('SELECT * FROM comments WHERE post_id = $1 ORDER BY seq', [postId])).rows.map(toComment);
  }

  async commentCounts(postIds) {
    const { rows } = await this.q('SELECT post_id, count(*)::int AS n FROM comments WHERE post_id = ANY($1::text[]) GROUP BY post_id', [[...postIds]]);
    const out = new Map(postIds.map((id) => [id, 0]));
    for (const r of rows) out.set(r.post_id, Number(r.n));
    return out;
  }

  // ---- notifications -----------------------------------------------------------------------

  /**
   * Inserts notifications (duplicates by dedupe key skipped) and, in the same transaction, one
   * outbox event per inserted notification. Returns the inserted ids in input order.
   */
  async insertNotifications(list, { event } = {}) {
    if (!list.length) return [];
    const inserted = new Set();
    const CHUNK = 200;
    await this.tx(async (tx) => {
      for (let i = 0; i < list.length; i += CHUNK) {
        const chunk = list.slice(i, i + CHUNK);
        const { rows } = await tx.query(
          `INSERT INTO notifications (${NOTIFICATION_COLUMNS}) VALUES ${values(chunk.length, NOTIFICATION_CASTS)}
           ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
          chunk.flatMap(notificationParams),
        );
        for (const r of rows) inserted.add(r.id);
      }
      if (event) await this.#appendEvents(tx, list.filter((n) => inserted.has(n.id)).map(event));
    });
    return list.filter((n) => inserted.has(n.id)).map((n) => n.id);
  }

  async #insertRows(tx, rows) {
    const inserted = new Set();
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const { rows: out } = await tx.query(
        `INSERT INTO notifications (${NOTIFICATION_COLUMNS}) VALUES ${values(chunk.length, NOTIFICATION_CASTS)}
         ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        chunk.flatMap(notificationParams),
      );
      for (const r of out) inserted.add(r.id);
    }
    return inserted;
  }

  /**
   * A post's match notifications with every agent's delivery budget enforced atomically with the
   * insert (see repo/budgets.js). Per-agent advisory locks, taken in a fixed order, serialise only
   * concurrent routings that touch the same agents. Returns { inserted, adjusted }.
   */
  async insertMatchedNotifications(rows, { event, now = Date.now(), maxDigestPerPost = Infinity } = {}) {
    if (!rows.length) return { inserted: [], adjusted: [] };
    const nowIso = new Date(now).toISOString();
    const agentIds = [...new Set(rows.map((r) => r.agent_id))].sort();
    return this.tx(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('agentnet:budget:' || id, 0)) FROM unnest($1::text[]) WITH ORDINALITY AS t(id, n) ORDER BY n", [agentIds]);
      const keys = rows.map((r) => r.dedupe_key).filter(Boolean);
      const existing = new Set((await tx.query('SELECT dedupe_key FROM notifications WHERE dedupe_key = ANY($1::text[])', [keys])).rows.map((r) => r.dedupe_key));
      const { rows: countRows } = await tx.query(
        `SELECT agent_id,
                count(*) FILTER (WHERE tier = 'push' AND created_at > $2::timestamptz - interval '1 hour')::int AS push,
                count(*) FILTER (WHERE tier = 'digest')::int AS digest
           FROM notifications
          WHERE agent_id = ANY($1::text[]) AND event = 'post.matched' AND created_at > $2::timestamptz - interval '1 day'
          GROUP BY agent_id`,
        [agentIds, nowIso],
      );
      const counts = new Map(agentIds.map((id) => [id, { push: 0, digest: 0 }]));
      for (const r of countRows) counts.set(r.agent_id, { push: Number(r.push), digest: Number(r.digest) });
      const { keep, adjusted } = applyBudgets(rows, (id) => counts.get(id), { maxDigestPerPost, isDuplicate: (n) => existing.has(n.dedupe_key) });
      const inserted = await this.#insertRows(tx, keep);
      if (event) await this.#appendEvents(tx, keep.filter((n) => inserted.has(n.id)).map(event));
      return { inserted: keep.filter((n) => inserted.has(n.id)).map((n) => n.id), adjusted };
    });
  }

  async getNotification(id) {
    return one((await this.q('SELECT * FROM notifications WHERE id = $1', [id])).rows, toNotification);
  }

  async ackNotifications(agentId, ids, atIso) {
    const unique = [...new Set(ids)];
    return this.tx(async (tx) => {
      const { rows } = await tx.query('SELECT id, acked_at, event FROM notifications WHERE id = ANY($2::text[]) AND agent_id = $1 FOR UPDATE', [agentId, unique]);
      const owned = new Set(rows.map((r) => r.id));
      const fresh = rows.filter((r) => !r.acked_at).map((r) => r.id);
      if (fresh.length) await tx.query('UPDATE notifications SET acked_at = $2::timestamptz WHERE id = ANY($1::text[])', [fresh, atIso]);
      const batches = rows.filter((r) => r.event === 'digest.ready').map((r) => r.id);
      if (batches.length) await tx.query('UPDATE notifications SET acked_at = $2::timestamptz WHERE batch_id = ANY($1::text[]) AND acked_at IS NULL', [batches, atIso]);
      return {
        acked: unique.filter((id) => fresh.includes(id)),
        already: unique.filter((id) => owned.has(id) && !fresh.includes(id)),
        missing: unique.filter((id) => !owned.has(id)),
      };
    });
  }

  // ---- digest batches ----------------------------------------------------------------------

  async agentsWithDueDigests(nowIso, { limit = 500 } = {}) {
    const { rows } = await this.q(
      `SELECT a.id FROM agents a
        WHERE (a.delivery ->> 'digest_webhook') = 'true' AND a.status = 'active' AND a.delivery ->> 'webhook_url' IS NOT NULL
          AND EXISTS (SELECT 1 FROM notifications n JOIN posts p ON p.id = n.post_id
                       WHERE n.agent_id = a.id AND n.event = 'post.matched' AND n.tier = 'digest' AND n.batch_id IS NULL
                         AND n.acked_at IS NULL AND n.status = 'in_inbox'
                         AND p.status NOT IN ${HIDDEN_POSTS} AND (p.expires_at IS NULL OR p.expires_at > $1::timestamptz))
          AND NOT EXISTS (SELECT 1 FROM notifications b
                           WHERE b.agent_id = a.id AND b.event = 'digest.ready'
                             AND b.created_at > $1::timestamptz - COALESCE((a.delivery ->> 'digest_interval_minutes')::numeric, 60) * interval '1 minute')
        LIMIT $2`,
      [nowIso, limit],
    );
    return rows.map((r) => r.id);
  }

  async createDigestBatch(agentId, batch, { maxItems = 50, now = Date.now(), intervalMs = 0, event } = {}) {
    const nowIso = new Date(now).toISOString();
    return this.tx(async (tx) => {
      // One batch per agent per interval, even with several workers running the job.
      await tx.query('SELECT 1 FROM agents WHERE id = $1 FOR UPDATE', [agentId]);
      const last = await tx.query("SELECT max(created_at) AS at FROM notifications WHERE agent_id = $1 AND event = 'digest.ready'", [agentId]);
      if (last.rows[0].at && now - new Date(last.rows[0].at).getTime() < intervalMs) return null;
      const { rows } = await tx.query(
        `SELECT n.id FROM notifications n JOIN posts p ON p.id = n.post_id
          WHERE n.agent_id = $1 AND n.event = 'post.matched' AND n.tier = 'digest' AND n.batch_id IS NULL AND n.acked_at IS NULL
            AND n.status = 'in_inbox' AND p.status NOT IN ${HIDDEN_POSTS} AND (p.expires_at IS NULL OR p.expires_at > $2::timestamptz)
          ORDER BY n.seq LIMIT $3 FOR UPDATE OF n SKIP LOCKED`,
        [agentId, nowIso, maxItems],
      );
      if (!rows.length) return null;
      await this.#insertRows(tx, [batch]);
      if (event) await this.#appendEvents(tx, [event(batch)]);
      const items = rows.map((r) => r.id);
      await tx.query('UPDATE notifications SET batch_id = $1 WHERE id = ANY($2::text[])', [batch.id, items]);
      return { batch_id: batch.id, items };
    });
  }

  async batchItems(batchId) {
    return (await this.q('SELECT * FROM notifications WHERE batch_id = $1 ORDER BY seq', [batchId])).rows.map(toNotification);
  }

  async saveDeliveryState(n, { expectStatus } = {}) {
    const { rowCount } = await this.q(
      `UPDATE notifications
          SET status = $2, attempts = $3, last_error = $4, delivered_at = $5::timestamptz, next_attempt_at = $6::timestamptz,
              cycle_started_at = $7::timestamptz, claimed_at = $8::timestamptz, dead_letter_reason = $9, dead_lettered_at = $10::timestamptz,
              cancel_reason = $11, redeliveries = $12, retracted_at = $13::timestamptz
        WHERE id = $1 AND ($14::text IS NULL OR status = $14)`,
      [n.id, ...deliveryColumns(n), expectStatus ?? null],
    );
    return rowCount === 1;
  }

  async ackNotification(id, atIso) {
    const n = await this.getNotification(id);
    if (!n) return null;
    await this.ackNotifications(n.agent_id, [id], atIso);
    return this.getNotification(id);
  }

  async recordFeedback(id, feedback, outcome) {
    const { rows } = await this.q(
      `UPDATE notifications SET feedback = $2::jsonb, outcome = CASE WHEN outcome = 'engaged' THEN outcome ELSE $3 END
        WHERE id = $1 AND feedback IS NULL RETURNING *`,
      [id, json(feedback), outcome],
    );
    return one(rows, toNotification);
  }

  async markEngaged(id) {
    const { rows } = await this.q("UPDATE notifications SET outcome = 'engaged' WHERE id = $1 AND outcome IS DISTINCT FROM 'engaged' RETURNING *", [id]);
    return one(rows, toNotification);
  }

  async markIgnored(id) {
    const { rowCount } = await this.q("UPDATE notifications SET outcome = 'ignored' WHERE id = $1 AND outcome IS NULL AND feedback IS NULL", [id]);
    return rowCount === 1;
  }

  async matchFor(postId, agentId) {
    return one((await this.q('SELECT * FROM notifications WHERE dedupe_key = $1', [`match:${postId}:${agentId}`])).rows, toNotification);
  }

  async inbox(agentId, { tier, unacked, limit, now = Date.now(), before }) {
    const { rows } = await this.q(
      `SELECT n.* FROM notifications n LEFT JOIN posts p ON p.id = n.post_id
        WHERE n.agent_id = $1 AND n.status NOT IN ('retracted', 'cancelled')
          AND ($6::bigint IS NULL OR n.seq < $6::bigint)
          AND (CASE WHEN n.event = 'digest.ready' THEN $3::text = 'digest_batch'
                    WHEN n.event = 'post.retracted' THEN true
                    ELSE p.status NOT IN ${HIDDEN_POSTS} AND (p.expires_at IS NULL OR p.expires_at > $2::timestamptz) END)
          AND ($3::text IS NULL OR n.tier = $3)
          AND (NOT $4::boolean OR n.acked_at IS NULL)
        ORDER BY n.seq DESC LIMIT $5`,
      [agentId, new Date(now).toISOString(), tier ?? null, Boolean(unacked), limit, before ?? null],
    );
    return rows.map(toNotification);
  }

  async notificationsForPost(postId) {
    return (await this.q('SELECT * FROM notifications WHERE post_id = $1 ORDER BY seq', [postId])).rows.map(toNotification);
  }

  async deadLetters(agentId, { limit = 1000 } = {}) {
    const { rows } = await this.q(
      `SELECT * FROM notifications WHERE status = 'failed' AND dead_letter_reason IS NOT NULL AND ($1::text IS NULL OR agent_id = $1)
        ORDER BY seq LIMIT $2`,
      [agentId ?? null, limit],
    );
    return rows.map(toNotification);
  }

  async ignoredPushCandidates(cutoffIso, { limit = 1000 } = {}) {
    const { rows } = await this.q(
      `SELECT * FROM notifications
        WHERE event = 'post.matched' AND tier = 'push' AND outcome IS NULL AND feedback IS NULL
          AND status NOT IN ('retracted', 'cancelled') AND created_at <= $1::timestamptz
        ORDER BY seq LIMIT $2`,
      [cutoffIso, limit],
    );
    return rows.map(toNotification);
  }

  async dueNotifications(nowIso, { limit = 1000 } = {}) {
    const { rows } = await this.q(
      `SELECT * FROM notifications WHERE status IN ('retry_scheduled', 'deferred') AND next_attempt_at <= $1::timestamptz
        ORDER BY next_attempt_at LIMIT $2`,
      [nowIso, limit],
    );
    return rows.map(toNotification);
  }

  async staleDeliveries(beforeIso, { limit = 1000 } = {}) {
    const { rows } = await this.q(
      `SELECT * FROM notifications WHERE status = 'delivering' AND COALESCE(claimed_at, created_at) < $1::timestamptz ORDER BY seq LIMIT $2`,
      [beforeIso, limit],
    );
    return rows.map(toNotification);
  }

  async staleQueued(beforeIso, { limit = 1000 } = {}) {
    const { rows } = await this.q("SELECT * FROM notifications WHERE status = 'queued' AND created_at < $1::timestamptz ORDER BY created_at LIMIT $2", [beforeIso, limit]);
    return rows.map(toNotification);
  }

  async countNotifications() {
    return Number((await this.q('SELECT count(*)::int AS n FROM notifications')).rows[0].n);
  }

  // ---- reports -----------------------------------------------------------------------------

  async insertReport(r) {
    const { rowCount } = await this.q(
      `INSERT INTO reports (id, post_id, agent_id, reason, details, weight, independent, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz) ON CONFLICT ON CONSTRAINT reports_one_per_reporter DO NOTHING`,
      [r.id, r.post_id, r.agent_id, r.reason, r.details ?? null, r.weight, r.independent, r.status, r.created_at],
    );
    return rowCount === 1;
  }

  async reportsFor(postId) {
    return (await this.q('SELECT * FROM reports WHERE post_id = $1 ORDER BY seq', [postId])).rows.map(toReport);
  }

  async closeReport(reportId, postId, status) {
    const { rowCount } = await this.q("UPDATE reports SET status = $3 WHERE id = $1 AND post_id = $2 AND status = 'open'", [reportId, postId, status]);
    return rowCount === 1;
  }

  // ---- subscriptions -----------------------------------------------------------------------

  async insertSubscription(s) {
    const { rowCount } = await this.q(
      'INSERT INTO subscriptions (id, agent_id, kind, target, created_at) VALUES ($1, $2, $3, $4, $5::timestamptz) ON CONFLICT ON CONSTRAINT subscriptions_unique DO NOTHING',
      [s.id, s.agent_id, s.kind, s.target, s.created_at],
    );
    return rowCount === 1;
  }

  async findSubscription(agentId, kind, target) {
    return one((await this.q('SELECT * FROM subscriptions WHERE agent_id = $1 AND kind = $2 AND target = $3', [agentId, kind, target])).rows, toSubscription);
  }

  async getSubscription(id) {
    return one((await this.q('SELECT * FROM subscriptions WHERE id = $1', [id])).rows, toSubscription);
  }

  async listSubscriptions(agentId) {
    return (await this.q('SELECT * FROM subscriptions WHERE agent_id = $1 ORDER BY seq', [agentId])).rows.map(toSubscription);
  }

  async deleteSubscription(id) {
    await this.q('DELETE FROM subscriptions WHERE id = $1', [id]);
  }

  // ---- routing decisions -------------------------------------------------------------------

  async saveRoutingLog(postId, log) {
    await this.q(
      `INSERT INTO routing_decisions (post_id, log, routed_at) VALUES ($1, $2::jsonb, $3::timestamptz)
       ON CONFLICT (post_id) DO UPDATE SET log = EXCLUDED.log, routed_at = EXCLUDED.routed_at`,
      [postId, json(log), log.routed_at ?? new Date().toISOString()],
    );
  }

  async getRoutingLog(postId) {
    const { rows } = await this.q('SELECT log FROM routing_decisions WHERE post_id = $1', [postId]);
    return rows[0]?.log ?? null;
  }

  // ---- learned model -----------------------------------------------------------------------

  async getModel() {
    const { rows } = await this.q('SELECT weights, updates FROM model_state WHERE id = 1');
    return rows.length ? { weights: rows[0].weights, updates: Number(rows[0].updates) } : { weights: priorWeights(), updates: 0 };
  }

  async updateModel(mutator) {
    return this.tx(async (tx) => {
      await tx.query('INSERT INTO model_state (id, weights, updates) VALUES (1, $1::jsonb, 0) ON CONFLICT (id) DO NOTHING', [json(priorWeights())]);
      const { rows } = await tx.query('SELECT weights, updates FROM model_state WHERE id = 1 FOR UPDATE');
      const next = mutator({ weights: rows[0].weights, updates: Number(rows[0].updates) });
      await tx.query('UPDATE model_state SET weights = $1::jsonb, updates = $2, updated_at = now() WHERE id = 1', [json(next.weights), next.updates]);
      return next;
    });
  }

  async incrementAffinity(agentId, concepts, label, weight = 1) {
    if (!concepts.length) return;
    await this.q(
      `INSERT INTO agent_topic_stats (agent_id, topic, pos, neg)
       SELECT $1, t, $3::float8, $4::float8 FROM (SELECT DISTINCT unnest($2::text[]) AS t) topics
       ON CONFLICT (agent_id, topic) DO UPDATE SET pos = agent_topic_stats.pos + EXCLUDED.pos, neg = agent_topic_stats.neg + EXCLUDED.neg`,
      [agentId, concepts, label ? weight : 0, label ? 0 : weight],
    );
  }

  async markOrganic(postId, agentId) {
    const { rowCount } = await this.q('INSERT INTO organic_engagements (post_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [postId, agentId]);
    return rowCount === 1;
  }

  // ---- outbox and consumer ledger -----------------------------------------------------------

  /**
   * Locks up to `limit` unpublished events (commit order, SKIP LOCKED so concurrent relays split
   * the work), hands them to `publish`, and marks them published in the same transaction. If
   * `publish` throws or the process dies, the transaction rolls back and the events are offered
   * again: at-least-once.
   */
  async publishOutbox(limit, publish) {
    return this.tx(async (tx) => {
      const { rows } = await tx.query(
        'SELECT id, event_id, type, payload, created_at FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',
        [limit],
      );
      if (!rows.length) return 0;
      await publish(rows.map((r) => ({ id: r.event_id, type: r.type, payload: r.payload, created_at: iso(r.created_at) })));
      await tx.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
      return rows.length;
    });
  }

  async outboxBacklog() {
    const { rows } = await this.q('SELECT count(*)::int AS pending, min(created_at) AS oldest_at FROM outbox WHERE published_at IS NULL');
    return { pending: Number(rows[0].pending), oldest_at: iso(rows[0].oldest_at) };
  }

  /** Deletes published events and consumer-ledger entries older than the retention window. */
  async pruneEvents(beforeIso) {
    const outbox = await this.q('DELETE FROM outbox WHERE published_at < $1::timestamptz', [beforeIso]);
    const ledger = await this.q('DELETE FROM processed_events WHERE processed_at < $1::timestamptz', [beforeIso]);
    return { outbox: outbox.rowCount, processed: ledger.rowCount };
  }

  async isProcessed(consumer, eventId) {
    return (await this.q('SELECT 1 FROM processed_events WHERE consumer = $1 AND event_id = $2', [consumer, eventId])).rows.length > 0;
  }

  async markProcessed(consumer, eventId) {
    const { rowCount } = await this.q('INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [consumer, eventId]);
    return rowCount === 1;
  }
}
