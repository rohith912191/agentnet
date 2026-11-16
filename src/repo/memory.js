// In-memory repository: the reference implementation of the repository contract, used by the
// unit tests and the zero-infrastructure demo. PostgresRepository (repo/postgres.js) implements
// the same contract against PostgreSQL + pgvector, and the shared contract suite
// (test/repository-contract.test.js) runs against both.
//
// Contract rules that both implementations follow:
//   - Value semantics: reads return copies, writes are explicit. Code that mutates an object and
//     forgets to save it fails here too, not only in production.
//   - mutateAgent / mutatePost are atomic read-modify-write (PostgreSQL: SELECT ... FOR UPDATE in a
//     transaction). The mutator must be synchronous; returning false aborts without writing.
//   - Notifications have two owners. The delivery pipeline writes status/delivery/retracted_at,
//     always with compare-and-set on status (it can't hold a lock across an HTTP request). Agent
//     actions write acked_at/outcome/feedback through conditional single-purpose updates. Neither
//     can overwrite the other's fields.
//   - Uniqueness is enforced by the store, not by check-then-insert in the service layer:
//     notification dedupe keys (one match per post and agent, one retraction notice, one thread
//     notification per comment and agent), one report per post and reporter, one identical
//     subscription, one idempotency key per author, one verified owner per domain.

import { RETRIEVAL_MIN_WEIGHT, CONCEPTS } from '../routing/taxonomy.js';
import { cosine } from '../routing/text.js';
import { isExpired } from '../util.js';
import { priorWeights } from '../routing/learner.js';
import { UniqueViolation } from './errors.js';
import { applyBudgets } from './budgets.js';

const copy = (v) => (v == null ? null : structuredClone(v));
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HIDDEN_NOTIFICATIONS = new Set(['retracted', 'cancelled']);
const HIDDEN_POSTS = new Set(['quarantined', 'under_review']);
const DELIVERY_FIELDS = ['status', 'delivery', 'retracted_at'];

export const retrievalConcepts = (concepts) => concepts.filter((c) => (CONCEPTS[c]?.weight ?? 0) >= RETRIEVAL_MIN_WEIGHT);

export class MemoryRepository {
  constructor() {
    this.kind = 'memory';
    this.agents = new Map();
    this.vectors = new Map(); // agentId -> [{ text, vector: Float32Array }] (float4, as in pgvector)
    this.keyIndex = new Map(); // key_hash -> agentId
    this.byDomain = new Map(); // domain -> Set(agentId)        (PostgreSQL: agents_domain)
    this.byNameKey = new Map(); // name_key -> Set(agentId)     (PostgreSQL: agents_name_key)
    this.brandIds = new Set(); // agents that are brands        (PostgreSQL: agents_brands)
    this.posts = new Map();
    this.postOrder = [];
    this.comments = new Map();
    this.commentsByPost = new Map();
    this.notifications = new Map();
    this.nseq = 0; // insertion order of notifications (PostgreSQL: notifications.seq), used by inbox cursors
    this.inboxes = new Map(); // agentId -> [notificationId] (oldest first)
    this.byPost = new Map(); // postId -> [notificationId]
    this.dedupe = new Map(); // dedupe_key -> notificationId
    this.subscriptions = new Map();
    this.reports = new Map(); // postId -> [report]
    this.routingLogs = new Map();
    this.model = null;
    this.affinity = new Map(); // agentId -> Map(topic -> { pos, neg })
    this.organic = new Set();
    this.outbox = []; // unpublished events, commit order: { id, type, payload, created_at }
    this.eventIds = new Set();
    this.claimedEvents = new Set(); // events a relay is publishing right now (SKIP LOCKED)
    this.processed = new Set(); // `${consumer}:${eventId}`
    this.identityReviewRows = new Map();
  }

  /** Validates, then appends events. Called in the same synchronous step as the entity write. */
  #checkEvents(events) {
    const ids = new Set();
    for (const e of events) {
      if (this.eventIds.has(e.id) || ids.has(e.id)) throw new UniqueViolation('outbox_event_id');
      ids.add(e.id);
    }
  }

  #appendEvents(events) {
    for (const e of events) {
      this.eventIds.add(e.id);
      this.outbox.push(copy({ id: e.id, type: e.type, payload: e.payload, created_at: e.created_at ?? new Date().toISOString() }));
    }
  }

  async init() {}
  async close() {}

  // ---- agents ------------------------------------------------------------------------------

  #checkAgentConstraints(row) {
    const owner = this.keyIndex.get(row.key_hash);
    if (owner && owner !== row.id) throw new UniqueViolation('agents_key_hash');
    if (row.verification.status === 'verified') {
      for (const id of this.byDomain.get(row.domain) ?? []) {
        if (id !== row.id && this.agents.get(id).verification.status === 'verified') throw new UniqueViolation('agents_verified_domain');
      }
    }
  }

  static #index(map, key, id) {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(id);
  }

  static #float4(vectors) {
    return (vectors ?? []).map(({ text, vector }) => ({ text, vector: Float32Array.from(vector) }));
  }

  async insertAgent(agent) {
    const { vectors, ...row } = agent;
    if (this.agents.has(row.id)) throw new UniqueViolation('agents_pkey');
    this.#checkAgentConstraints(row);
    this.agents.set(row.id, copy(row));
    this.vectors.set(row.id, MemoryRepository.#float4(vectors));
    this.keyIndex.set(row.key_hash, row.id);
    MemoryRepository.#index(this.byDomain, row.domain, row.id);
    MemoryRepository.#index(this.byNameKey, row.identity.name_key, row.id);
    this.#indexBrand(row);
  }

  /** Bulk insert (seeding and load tests). */
  async insertAgents(list) {
    for (const agent of list) await this.insertAgent(agent);
  }

  async getAgent(id) {
    return copy(this.agents.get(id));
  }

  async getAgents(ids) {
    const out = new Map();
    for (const id of ids) {
      const a = this.agents.get(id);
      if (a) out.set(id, copy(a));
    }
    return out;
  }

  async getAgentByKeyHash(hash) {
    const id = this.keyIndex.get(hash);
    return id ? this.getAgent(id) : null;
  }

  /** Atomic read-modify-write. A mutator that sets `vectors` replaces the interest vectors. */
  async mutateAgent(id, mutator) {
    const stored = this.agents.get(id);
    if (!stored) return null;
    const draft = copy(stored);
    if (mutator(draft) === false) return null;
    const { vectors, ...row } = draft;
    row.id = id;
    // Domain and company name (hence name_key) are fixed at registration, so their indexes stand.
    row.domain = stored.domain;
    row.identity = { ...row.identity, name_key: stored.identity.name_key };
    this.#checkAgentConstraints(row);
    this.agents.set(id, copy(row));
    this.#indexBrand(row);
    if (vectors) this.vectors.set(id, MemoryRepository.#float4(vectors));
    return copy(row);
  }

  #agentsIn(index, key) {
    return [...(index.get(key) ?? [])].map((id) => this.agents.get(id));
  }

  async domainOwner(domain) {
    return this.#agentsIn(this.byDomain, domain).find((a) => a.verification.status === 'verified')?.id ?? null;
  }

  /** Registrations still waiting to verify this domain. */
  async pendingClaimIds(domain) {
    return this.#agentsIn(this.byDomain, domain)
      .filter((a) => a.verification.status === 'pending' && a.status !== 'revoked')
      .map((a) => a.id);
  }

  async agentsWithNameKey(nameKey) {
    return this.#agentsIn(this.byNameKey, nameKey).map(copy);
  }

  /** Verified, active agents whose own domain confirms a distinctive company name (and not under identity review). */
  async brandCandidates() {
    return [...this.brandIds].map((id) => this.agents.get(id)).map((a) => ({ id: a.id, name: a.company, domain: a.domain }));
  }

  static #isBrand(a) {
    return (
      a.status === 'active' &&
      a.verification.status === 'verified' &&
      a.identity.name_matches_domain === true &&
      a.identity.name_conflict !== true &&
      !['pending', 'rejected'].includes(a.identity.review) &&
      a.identity.distinctive === true
    );
  }

  /** Keeps the brand set current (PostgreSQL: the agents_brands partial index). */
  #indexBrand(row) {
    if (MemoryRepository.#isBrand(row)) this.brandIds.add(row.id);
    else this.brandIds.delete(row.id);
  }

  /** Active verified agents' domains (for look-alike checks when a brand verifies). */
  async verifiedAgentDomains() {
    return [...this.agents.values()].filter((a) => a.status === 'active' && a.verification.status === 'verified').map((a) => ({ id: a.id, domain: a.domain }));
  }

  // ---- identity reviews --------------------------------------------------------------------

  /** Opens a review; false if one of the same kind is already open for the agent. */
  async insertIdentityReview(r) {
    for (const x of this.identityReviewRows.values()) if (x.agent_id === r.agent_id && x.kind === r.kind && x.status === 'pending') return false;
    this.identityReviewRows.set(r.id, copy({ ...r, status: 'pending', decided_at: null, decision_note: null }));
    return true;
  }

  async identityReviews({ status, limit = 100 } = {}) {
    return [...this.identityReviewRows.values()].filter((r) => !status || r.status === status).slice(0, limit).map(copy);
  }

  async getIdentityReview(id) {
    return copy(this.identityReviewRows.get(id));
  }

  /** Decides a pending review (compare-and-set); null if it was already decided. */
  async decideIdentityReview(id, { status, note, decidedAt }) {
    const r = this.identityReviewRows.get(id);
    if (!r || r.status !== 'pending') return null;
    Object.assign(r, { status, decision_note: note ?? null, decided_at: decidedAt });
    return copy(r);
  }

  async countAgents() {
    return this.agents.size;
  }

  // ---- routing data ------------------------------------------------------------------------

  /** Nearest agents to `vector` by their best interest statement. PostgreSQL: HNSW index. */
  async annSearch(vector, k, minSim = 0.05) {
    const best = [];
    for (const [agentId, vectors] of this.vectors) {
      let sim = 0;
      for (const v of vectors) sim = Math.max(sim, cosine(vector, v.vector));
      if (sim >= minSim) best.push({ agentId, sim });
    }
    return best.sort((a, b) => b.sim - a.sim).slice(0, k);
  }

  /**
   * Discovered candidates (not explicit subscribers): agents whose retrieval topics overlap the
   * post's specific topics, agents in a partner industry, and the ANN hits. When there are more
   * than `max`, keeps the best by partner fit + vector similarity + topic overlap.
   * Returns { ids, total }.
   */
  async discoverCandidates({ specificConcepts, seekIndustries, annSims, postConcepts, excludeIds, max }) {
    const specific = new Set(specificConcepts);
    const seeks = new Set(seekIndustries);
    const found = [];
    for (const [id, a] of this.agents) {
      if (excludeIds.has(id)) continue;
      if (a.retrieval_concepts.some((c) => specific.has(c)) || seeks.has(a.industry) || annSims.has(id)) found.push(a);
    }
    if (found.length <= max) return { ids: found.map((a) => a.id), total: found.length };
    const concepts = new Set(postConcepts);
    const preScore = (a) => {
      let overlap = 0;
      for (const c of a.concepts) if (concepts.has(c)) overlap++;
      return (seeks.has(a.industry) ? 1 : 0) + (annSims.get(a.id) ?? 0) + overlap / Math.max(1, concepts.size);
    };
    const ranked = found.map((a) => ({ id: a.id, score: preScore(a) })).sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
    return { ids: ranked.slice(0, max).map((r) => r.id), total: found.length };
  }

  /** Followers of the author and subscribers to any of the topics: Map(agentId -> Set(source)). */
  async explicitSubscribers({ authorId, concepts }) {
    const out = new Map();
    const topics = new Set(concepts);
    for (const s of this.subscriptions.values()) {
      let source = null;
      if (s.kind === 'agent' && s.target === authorId) source = 'follows_author';
      else if (s.kind === 'topic' && topics.has(s.target)) source = 'topic_subscription';
      if (!source) continue;
      if (!out.has(s.agent_id)) out.set(s.agent_id, new Set());
      out.get(s.agent_id).add(source);
    }
    return out;
  }

  /** Best-matching interest per agent: Map(agentId -> { sem, bestInterest }). */
  async interestMatches(vector, agentIds) {
    const out = new Map();
    for (const id of agentIds) {
      let sem = 0;
      let bestInterest = null;
      for (const { text, vector: v } of this.vectors.get(id) ?? []) {
        const s = cosine(vector, v);
        if (s > sem) {
          sem = s;
          bestInterest = text;
        }
      }
      out.set(id, { sem, bestInterest });
    }
    return out;
  }

  /** Map(agentId -> Map(topic -> { pos, neg })) restricted to the given topics. */
  async affinityStats(agentIds, concepts) {
    const out = new Map();
    for (const id of agentIds) {
      const stats = this.affinity.get(id);
      if (!stats) continue;
      const subset = new Map();
      for (const c of concepts) if (stats.has(c)) subset.set(c, { ...stats.get(c) });
      out.set(id, subset);
    }
    return out;
  }

  /** Pushes in the last hour and digests in the last day, per agent (for delivery budgets). */
  async deliveryCounts(agentIds, now = Date.now()) {
    const out = new Map();
    for (const id of agentIds) {
      let push = 0;
      let digest = 0;
      for (const nid of this.inboxes.get(id) ?? []) {
        const n = this.notifications.get(nid);
        if (n.event !== 'post.matched') continue;
        const age = now - Date.parse(n.created_at);
        if (n.tier === 'push' && age < HOUR_MS) push++;
        if (n.tier === 'digest' && age < DAY_MS) digest++;
      }
      out.set(id, { push, digest });
    }
    return out;
  }

  async notifiedAgentIds(postId) {
    const out = new Set();
    for (const nid of this.byPost.get(postId) ?? []) {
      const n = this.notifications.get(nid);
      if (n.event === 'post.matched') out.add(n.agent_id);
    }
    return out;
  }

  // ---- posts -------------------------------------------------------------------------------

  /** Inserts a post and its events atomically. */
  async insertPost(post, { events = [] } = {}) {
    if (this.posts.has(post.id)) throw new UniqueViolation('posts_pkey');
    if (post.idempotency_key) {
      for (const p of this.posts.values()) {
        if (p.author_id === post.author_id && p.idempotency_key === post.idempotency_key) throw new UniqueViolation('posts_idempotency');
      }
    }
    this.#checkEvents(events);
    this.posts.set(post.id, copy(post));
    this.postOrder.push(post.id);
    this.#appendEvents(events);
  }

  async getPost(id) {
    return copy(this.posts.get(id));
  }

  async getPosts(ids) {
    const out = new Map();
    for (const id of ids) {
      const p = this.posts.get(id);
      if (p) out.set(id, copy(p));
    }
    return out;
  }

  /** Atomic read-modify-write; returning false from the mutator aborts. */
  async mutatePost(id, mutator) {
    const stored = this.posts.get(id);
    if (!stored) return null;
    const draft = copy(stored);
    if (mutator(draft) === false) return null;
    draft.id = id;
    this.posts.set(id, copy(draft));
    return draft;
  }

  async findPostByIdempotencyKey(authorId, key) {
    for (const p of this.posts.values()) if (p.author_id === authorId && p.idempotency_key === key) return copy(p);
    return null;
  }

  async findRecentDuplicate(authorId, contentHash, sinceIso) {
    const since = Date.parse(sinceIso);
    for (let i = this.postOrder.length - 1; i >= 0; i--) {
      const p = this.posts.get(this.postOrder[i]);
      if (Date.parse(p.created_at) < since) break;
      if (p.author_id === authorId && p.content_hash === contentHash) return copy(p);
    }
    return null;
  }

  /** The public feed: visible, unexpired posts, newest first. */
  async listPosts({ authorId, topic, limit, now = Date.now() }) {
    const out = [];
    for (let i = this.postOrder.length - 1; i >= 0 && out.length < limit; i--) {
      const p = this.posts.get(this.postOrder[i]);
      if (HIDDEN_POSTS.has(p.status) || isExpired(p, now)) continue;
      if (authorId && p.author_id !== authorId) continue;
      if (topic && !(p.enrichment?.concepts ?? []).includes(topic)) continue;
      out.push(copy(p));
    }
    return out;
  }

  async postIdsByAuthor(authorId) {
    return this.postOrder.filter((id) => this.posts.get(id).author_id === authorId);
  }

  /** Posts in any of the given statuses, oldest first. */
  async postsWithStatus(statuses, { limit = 1000 } = {}) {
    const wanted = new Set(statuses);
    const out = [];
    for (const id of this.postOrder) {
      const p = this.posts.get(id);
      if (wanted.has(p.status)) out.push(copy(p));
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Posts waiting for a routing retry whose time has come. */
  async dueRoutingRetries(nowIso, { limit = 100 } = {}) {
    const now = Date.parse(nowIso);
    const out = [];
    for (const id of this.postOrder) {
      const p = this.posts.get(id);
      if (p.status === 'retrying' && p.routing.next_attempt_at && Date.parse(p.routing.next_attempt_at) <= now) out.push(copy(p));
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Posts past valid_until that are still marked as live. */
  async postsToExpire(now = Date.now(), { limit = 1000 } = {}) {
    const out = [];
    for (const id of this.postOrder) {
      const p = this.posts.get(id);
      if (p.status !== 'expired' && !HIDDEN_POSTS.has(p.status) && isExpired(p, now)) out.push(copy(p));
      if (out.length >= limit) break;
    }
    return out;
  }

  async countPosts() {
    return this.posts.size;
  }

  // ---- comments ----------------------------------------------------------------------------

  /** Inserts a comment and its events atomically. */
  async insertComment(comment, { events = [] } = {}) {
    if (this.comments.has(comment.id)) throw new UniqueViolation('comments_pkey');
    this.#checkEvents(events);
    this.#appendEvents(events);
    this.comments.set(comment.id, copy(comment));
    if (!this.commentsByPost.has(comment.post_id)) this.commentsByPost.set(comment.post_id, []);
    this.commentsByPost.get(comment.post_id).push(comment.id);
  }

  async getComment(id) {
    return copy(this.comments.get(id));
  }

  async getComments(ids) {
    const out = new Map();
    for (const id of ids) if (this.comments.has(id)) out.set(id, copy(this.comments.get(id)));
    return out;
  }

  /** A post's comments, oldest first. */
  async commentsOn(postId) {
    return (this.commentsByPost.get(postId) ?? []).map((id) => copy(this.comments.get(id)));
  }

  async commentCounts(postIds) {
    const out = new Map();
    for (const id of postIds) out.set(id, (this.commentsByPost.get(id) ?? []).length);
    return out;
  }

  // ---- notifications -----------------------------------------------------------------------

  /**
   * Inserts notifications; ones whose dedupe_key already exists are skipped. `event(n)` gives the
   * outbox event for each inserted notification (written atomically with it). Returns inserted ids.
   */
  async insertNotifications(list, { event } = {}) {
    for (const n of list) if (this.notifications.has(n.id)) throw new UniqueViolation('notifications_pkey');
    const seen = new Set();
    const fresh = list.filter((n) => {
      if (!n.dedupe_key) return true;
      if (this.dedupe.has(n.dedupe_key) || seen.has(n.dedupe_key)) return false;
      seen.add(n.dedupe_key);
      return true;
    });
    const events = event ? fresh.map(event) : [];
    this.#checkEvents(events);
    this.#appendEvents(events);
    return this.#storeNotifications(fresh);
  }

  #storeNotifications(rows) {
    const inserted = [];
    for (const n of rows) {
      this.notifications.set(n.id, copy({ batch_id: null, ...n, seq: ++this.nseq }));
      if (!this.inboxes.has(n.agent_id)) this.inboxes.set(n.agent_id, []);
      this.inboxes.get(n.agent_id).push(n.id);
      if (n.post_id) {
        if (!this.byPost.has(n.post_id)) this.byPost.set(n.post_id, []);
        this.byPost.get(n.post_id).push(n.id);
      }
      if (n.dedupe_key) this.dedupe.set(n.dedupe_key, n.id);
      inserted.push(n.id);
    }
    return inserted;
  }

  /** Push notifications in the last hour and digests in the last day for one agent. */
  #recentMatches(agentId, now) {
    let push = 0;
    let digest = 0;
    for (const nid of this.inboxes.get(agentId) ?? []) {
      const n = this.notifications.get(nid);
      if (n.event !== 'post.matched') continue;
      const age = now - Date.parse(n.created_at);
      if (n.tier === 'push' && age < HOUR_MS) push++;
      if (n.tier === 'digest' && age < DAY_MS) digest++;
    }
    return { push, digest };
  }

  /**
   * Inserts a post's match notifications and enforces every agent's delivery budget atomically
   * with the insert, so concurrent routing of different posts cannot overshoot a budget.
   * Each row carries (not stored) `budget: { push, digest }` and `requested` (explicit subscriber).
   * In order, a push over the agent's hourly push budget becomes a digest; a digest over the daily
   * digest budget, or over the post's cap for unrequested digests, is dropped. Rows whose dedupe
   * key exists are skipped without using budget. Returns { inserted, adjusted }.
   */
  async insertMatchedNotifications(rows, { event, now = Date.now(), maxDigestPerPost = Infinity } = {}) {
    for (const n of rows) if (this.notifications.has(n.id)) throw new UniqueViolation('notifications_pkey');
    const counts = new Map();
    const usedFor = (agentId) => {
      if (!counts.has(agentId)) counts.set(agentId, this.#recentMatches(agentId, now));
      return counts.get(agentId);
    };
    const { keep, adjusted } = applyBudgets(rows, usedFor, { maxDigestPerPost, isDuplicate: (n) => Boolean(n.dedupe_key && this.dedupe.has(n.dedupe_key)) });
    const events = event ? keep.map(event) : [];
    this.#checkEvents(events);
    this.#appendEvents(events);
    return { inserted: this.#storeNotifications(keep), adjusted };
  }

  async getNotification(id) {
    return copy(this.notifications.get(id));
  }

  /**
   * Acknowledges notifications owned by `agentId` (others are reported missing, never touched).
   * Acknowledging a digest batch acknowledges its items. Returns { acked, already, missing }.
   */
  async ackNotifications(agentId, ids, atIso) {
    const out = { acked: [], already: [], missing: [] };
    for (const id of new Set(ids)) {
      const n = this.notifications.get(id);
      if (!n || n.agent_id !== agentId) {
        out.missing.push(id);
        continue;
      }
      if (n.acked_at) out.already.push(id);
      else {
        n.acked_at = atIso;
        out.acked.push(id);
      }
      if (n.event === 'digest.ready') {
        for (const item of this.notifications.values()) if (item.batch_id === id && !item.acked_at) item.acked_at = atIso;
      }
    }
    return out;
  }

  // ---- digest batches ----------------------------------------------------------------------

  #batchable(n, now) {
    if (n.event !== 'post.matched' || n.tier !== 'digest' || n.batch_id || n.acked_at || n.status !== 'in_inbox') return false;
    const p = this.posts.get(n.post_id);
    return Boolean(p) && !HIDDEN_POSTS.has(p.status) && !isExpired(p, now);
  }

  /** Agents that asked for digest webhooks, have unbatched items, and whose interval has passed. */
  async agentsWithDueDigests(nowIso, { limit = 500 } = {}) {
    const now = Date.parse(nowIso);
    const due = [];
    for (const a of this.agents.values()) {
      const d = a.delivery;
      if (a.status !== 'active' || !d.digest_webhook || !d.webhook_url) continue;
      const ids = this.inboxes.get(a.id) ?? [];
      let lastBatch = -Infinity;
      let pending = false;
      for (const id of ids) {
        const n = this.notifications.get(id);
        if (n.event === 'digest.ready') lastBatch = Math.max(lastBatch, Date.parse(n.created_at));
        else if (!pending && this.#batchable(n, now)) pending = true;
      }
      if (pending && now - lastBatch >= (d.digest_interval_minutes ?? 60) * 60_000) due.push(a.id);
      if (due.length >= limit) break;
    }
    return due;
  }

  /**
   * Atomically gathers up to `maxItems` of the agent's unbatched digest items into `batch` (a
   * digest.ready notification row) and writes its delivery event. Each item joins one batch only.
   * Returns { batch_id, items } or null when there is nothing to send.
   */
  async createDigestBatch(agentId, batch, { maxItems = 50, now = Date.now(), intervalMs = 0, event } = {}) {
    // Re-checked under the same atomicity as the batch write: one batch per interval per agent.
    const last = (this.inboxes.get(agentId) ?? []).map((id) => this.notifications.get(id)).filter((n) => n.event === 'digest.ready').at(-1);
    if (last && now - Date.parse(last.created_at) < intervalMs) return null;
    const items = (this.inboxes.get(agentId) ?? [])
      .map((id) => this.notifications.get(id))
      .filter((n) => this.#batchable(n, now))
      .slice(0, maxItems);
    if (!items.length) return null;
    const events = event ? [event(batch)] : [];
    this.#checkEvents(events);
    this.#appendEvents(events);
    this.#storeNotifications([batch]);
    for (const n of items) n.batch_id = batch.id;
    return { batch_id: batch.id, items: items.map((n) => n.id) };
  }

  async batchItems(batchId) {
    return [...this.notifications.values()].filter((n) => n.batch_id === batchId).map(copy);
  }

  /** Writes the delivery-owned fields; with `expectStatus`, only if the stored status still matches. */
  async saveDeliveryState(n, { expectStatus } = {}) {
    const stored = this.notifications.get(n.id);
    if (!stored) return false;
    if (expectStatus && stored.status !== expectStatus) return false;
    for (const f of DELIVERY_FIELDS) stored[f] = copy(n[f] ?? null);
    return true;
  }

  /** Sets acked_at once (a digest batch also acknowledges its items); returns the notification. */
  async ackNotification(id, atIso) {
    const stored = this.notifications.get(id);
    if (!stored) return null;
    await this.ackNotifications(stored.agent_id, [id], atIso);
    return copy(stored);
  }

  /** Records feedback if there is none yet; an `engaged` outcome is kept. Returns the row or null. */
  async recordFeedback(id, feedback, outcome) {
    const stored = this.notifications.get(id);
    if (!stored || stored.feedback) return null;
    stored.feedback = copy(feedback);
    if (stored.outcome !== 'engaged') stored.outcome = outcome;
    return copy(stored);
  }

  /** Marks the notification engaged unless it already is. Returns the row or null. */
  async markEngaged(id) {
    const stored = this.notifications.get(id);
    if (!stored || stored.outcome === 'engaged') return null;
    stored.outcome = 'engaged';
    return copy(stored);
  }

  /** Marks a push nobody reacted to as ignored, if it still has no outcome and no feedback. */
  async markIgnored(id) {
    const stored = this.notifications.get(id);
    if (!stored || stored.outcome || stored.feedback) return false;
    stored.outcome = 'ignored';
    return true;
  }

  async matchFor(postId, agentId) {
    const id = this.dedupe.get(`match:${postId}:${agentId}`);
    return id ? this.getNotification(id) : null;
  }

  /**
   * An agent's inbox, newest first, optionally only entries older than the cursor `before` (a seq):
   * hides retracted/cancelled entries, and entries for posts that are taken down, under review, or
   * past valid_until (retraction notices stay visible). Digest batches (delivery envelopes) are
   * listed only when asked for with tier=digest_batch.
   */
  async inbox(agentId, { tier, unacked, limit, now = Date.now(), before }) {
    const out = [];
    const ids = this.inboxes.get(agentId) ?? [];
    for (let i = ids.length - 1; i >= 0 && out.length < limit; i--) {
      const n = this.notifications.get(ids[i]);
      if (before != null && n.seq >= before) continue;
      if (HIDDEN_NOTIFICATIONS.has(n.status)) continue;
      if (n.event === 'digest.ready' && tier !== 'digest_batch') continue;
      if (n.event !== 'post.retracted' && n.event !== 'digest.ready') {
        const p = this.posts.get(n.post_id);
        if (!p || HIDDEN_POSTS.has(p.status) || isExpired(p, now)) continue;
      }
      if (unacked && n.acked_at) continue;
      if (tier && n.tier !== tier) continue;
      out.push(copy(n));
    }
    return out;
  }

  async notificationsForPost(postId) {
    return (this.byPost.get(postId) ?? []).map((id) => copy(this.notifications.get(id)));
  }

  /** Dead-lettered webhook deliveries (optionally for one agent), oldest first. */
  async deadLetters(agentId, { limit = 1000 } = {}) {
    return [...this.notifications.values()]
      .filter((n) => n.status === 'failed' && n.delivery.dead_letter && (!agentId || n.agent_id === agentId))
      .slice(0, limit)
      .map(copy);
  }

  /** Push notifications with no reaction, created at or before `cutoffIso`. */
  async ignoredPushCandidates(cutoffIso, { limit = 1000 } = {}) {
    const cutoff = Date.parse(cutoffIso);
    return [...this.notifications.values()]
      .filter((n) => n.event === 'post.matched' && n.tier === 'push' && !n.outcome && !n.feedback && !HIDDEN_NOTIFICATIONS.has(n.status) && Date.parse(n.created_at) <= cutoff)
      .slice(0, limit)
      .map(copy);
  }

  /** Deliveries whose scheduled retry is due. */
  async dueNotifications(nowIso, { limit = 1000 } = {}) {
    const now = Date.parse(nowIso);
    return [...this.notifications.values()]
      .filter((n) => (n.status === 'retry_scheduled' || n.status === 'deferred') && n.delivery.next_attempt_at && Date.parse(n.delivery.next_attempt_at) <= now)
      .slice(0, limit)
      .map(copy);
  }

  /** Deliveries claimed before `beforeIso` and never finished (the worker died mid-request). */
  async staleDeliveries(beforeIso, { limit = 1000 } = {}) {
    const before = Date.parse(beforeIso);
    return [...this.notifications.values()]
      .filter((n) => n.status === 'delivering' && Date.parse(n.delivery.claimed_at ?? n.created_at) < before)
      .slice(0, limit)
      .map(copy);
  }

  /** Notifications never handed to delivery (still `queued`) since before `beforeIso`. */
  async staleQueued(beforeIso, { limit = 1000 } = {}) {
    const before = Date.parse(beforeIso);
    return [...this.notifications.values()]
      .filter((n) => n.status === 'queued' && Date.parse(n.created_at) < before)
      .slice(0, limit)
      .map(copy);
  }

  async countNotifications() {
    return this.notifications.size;
  }

  // ---- reports -----------------------------------------------------------------------------

  /** Returns false if the agent already reported the post. */
  async insertReport(report) {
    const list = this.reports.get(report.post_id) ?? [];
    if (list.some((r) => r.agent_id === report.agent_id)) return false;
    list.push(copy(report));
    this.reports.set(report.post_id, list);
    return true;
  }

  async reportsFor(postId) {
    return (this.reports.get(postId) ?? []).map(copy);
  }

  /** Closes an open report; returns false if it was already closed. */
  async closeReport(reportId, postId, status) {
    const r = (this.reports.get(postId) ?? []).find((x) => x.id === reportId);
    if (!r || r.status !== 'open') return false;
    r.status = status;
    return true;
  }

  // ---- subscriptions -----------------------------------------------------------------------

  /** Returns false if an identical subscription exists. */
  async insertSubscription(sub) {
    if (this.#findSubscription(sub.agent_id, sub.kind, sub.target)) return false;
    this.subscriptions.set(sub.id, copy(sub));
    return true;
  }

  #findSubscription(agentId, kind, target) {
    for (const s of this.subscriptions.values()) if (s.agent_id === agentId && s.kind === kind && s.target === target) return s;
    return null;
  }

  async findSubscription(agentId, kind, target) {
    return copy(this.#findSubscription(agentId, kind, target));
  }

  async getSubscription(id) {
    return copy(this.subscriptions.get(id));
  }

  async listSubscriptions(agentId) {
    return [...this.subscriptions.values()].filter((s) => s.agent_id === agentId).map(copy);
  }

  async deleteSubscription(id) {
    this.subscriptions.delete(id);
  }

  // ---- routing logs ------------------------------------------------------------------------

  async saveRoutingLog(postId, log) {
    this.routingLogs.set(postId, copy(log));
  }

  async getRoutingLog(postId) {
    return copy(this.routingLogs.get(postId));
  }

  // ---- learned model -----------------------------------------------------------------------

  async getModel() {
    if (!this.model) this.model = { weights: priorWeights(), updates: 0 };
    return copy(this.model);
  }

  /** Atomic read-modify-write of the global model (no await between the read and the write). */
  async updateModel(mutator) {
    if (!this.model) this.model = { weights: priorWeights(), updates: 0 };
    this.model = copy(mutator(copy(this.model)));
    return copy(this.model);
  }

  async incrementAffinity(agentId, concepts, label, weight = 1) {
    if (!this.affinity.has(agentId)) this.affinity.set(agentId, new Map());
    const stats = this.affinity.get(agentId);
    for (const c of concepts) {
      const s = stats.get(c) ?? { pos: 0, neg: 0 };
      if (label) s.pos += weight;
      else s.neg += weight;
      stats.set(c, s);
    }
  }

  /** Records that (post, agent) was learned from as a missed match; false if it already was. */
  async markOrganic(postId, agentId) {
    const key = `${postId}:${agentId}`;
    if (this.organic.has(key)) return false;
    this.organic.add(key);
    return true;
  }

  // ---- outbox and consumer ledger -----------------------------------------------------------

  /**
   * Hands up to `limit` unpublished events (commit order) to `publish`, then marks them published.
   * Events another relay is publishing are skipped (SKIP LOCKED). If `publish` throws, nothing is
   * marked and the events are offered again: delivery is at-least-once. Returns the count published.
   */
  async publishOutbox(limit, publish) {
    const batch = this.outbox.filter((e) => !this.claimedEvents.has(e.id)).slice(0, limit);
    if (!batch.length) return 0;
    for (const e of batch) this.claimedEvents.add(e.id);
    try {
      await publish(batch.map(copy));
      const done = new Set(batch.map((e) => e.id));
      this.outbox = this.outbox.filter((e) => !done.has(e.id)); // published events are not kept in memory
      return batch.length;
    } finally {
      for (const e of batch) this.claimedEvents.delete(e.id);
    }
  }

  async outboxBacklog() {
    return { pending: this.outbox.length, oldest_at: this.outbox[0]?.created_at ?? null };
  }

  async pruneEvents() {
    return { outbox: 0, processed: 0 }; // published events are dropped at once; the ledger is per process
  }

  async isProcessed(consumer, eventId) {
    return this.processed.has(`${consumer}:${eventId}`);
  }

  /** Records a processed event; false if it was already recorded. */
  async markProcessed(consumer, eventId) {
    const key = `${consumer}:${eventId}`;
    if (this.processed.has(key)) return false;
    this.processed.add(key);
    return true;
  }
}
