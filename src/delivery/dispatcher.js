// Notification delivery.
//
// Every notification lands in the agent's inbox (pull API, the source of truth). Push-tier and
// thread notifications are also sent to the agent's webhook:
//   - signed (HMAC-SHA256 over timestamp + body) so agents can verify the platform sent them
//   - at-least-once, with a stable delivery id for receiver-side deduplication
//   - one attempt per scheduled task: failures are retried later with exponential backoff and
//     equal jitter, honouring Retry-After, never by sleeping in a worker
//   - each attempt is claimed with a conditional status update, so concurrent attempts (in one
//     process or across delivery workers) send a single request, and a notification retracted
//     while its request is in flight is never recorded as delivered
//   - guarded by a per-endpoint circuit breaker: while it is open, deliveries are deferred and
//     re-scheduled for when it may close; in half-open state a single probe goes out
//   - permanent failures (3xx, 4xx other than 408/429, blocked destinations), exhausted retries and
//     deliveries older than maxDeliveryAgeMs go to the dead-letter queue, from which operators
//     (or the agent fixing its endpoint) can redeliver
// All state lives in the repository; the scheduler only decides when to look again.

import { signWebhook } from '../security/auth.js';
import { clamp, isExpired, nowIso } from '../util.js';
import { createSafeFetch } from './safe-fetch.js';

const isTimeout = (err) => err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError';
const FINAL = new Set(['delivered', 'failed', 'cancelled', 'retracted', 'in_inbox']);

/** Retry-After header (seconds or HTTP date) in ms, or 0. */
function retryAfterMs(res) {
  const value = res?.headers?.get?.('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

class CircuitBreaker {
  constructor({ threshold, cooldownMs }) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
    this.probing = false;
  }

  /** May a request go out now? After the cooldown exactly one probe is let through at a time. */
  allow(now) {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (now - this.openedAt < this.cooldownMs) return false;
      this.state = 'half_open';
    }
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  /** When a deferred delivery should come back. */
  waitMs(now) {
    if (this.state === 'open') return Math.max(1, this.cooldownMs - (now - this.openedAt));
    return Math.max(1, Math.min(this.cooldownMs, 1_000)); // a probe is in flight
  }

  success() {
    this.state = 'closed';
    this.failures = 0;
    this.probing = false;
  }

  failure(now) {
    this.failures++;
    this.probing = false;
    if (this.state === 'half_open' || this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = now;
    }
  }
}

export class Dispatcher {
  constructor({ repo, config, metrics, log, scheduler, envelope, fetchImpl = createSafeFetch(), rng = Math.random }) {
    this.repo = repo;
    this.cfg = config.delivery;
    this.metrics = metrics;
    this.log = log;
    this.scheduler = scheduler;
    this.envelope = envelope; // async (notification) -> JSON-serialisable event body
    this.fetch = fetchImpl;
    this.rng = rng;
    this.breakers = new Map();
    this.timers = new Map(); // notification id -> scheduler timer id
  }

  breaker(agentId) {
    if (!this.breakers.has(agentId)) {
      // Bounded memory: a closed breaker with no failures behaves exactly like a new one.
      if (this.breakers.size >= (this.cfg.maxBreakers ?? 50_000)) {
        for (const [id, b] of this.breakers) if (b.state === 'closed' && b.failures === 0 && !b.probing) this.breakers.delete(id);
      }
      this.breakers.set(agentId, new CircuitBreaker({ threshold: this.cfg.breakerThreshold, cooldownMs: this.cfg.breakerCooldownMs }));
    }
    return this.breakers.get(agentId);
  }

  resetBreaker(agentId) {
    this.breakers.delete(agentId);
  }

  /** Exponential backoff with equal jitter, at least the endpoint's Retry-After, capped. */
  backoff(attempt, minimumMs = 0) {
    const exp = Math.min(this.cfg.maxBackoffMs, this.cfg.baseBackoffMs * 2 ** (attempt - 1));
    const jittered = exp / 2 + this.rng() * (exp / 2);
    return clamp(Math.max(jittered, minimumMs), 0, this.cfg.maxBackoffMs);
  }

  /** Persists delivery state, compare-and-set on the status this worker last saw. */
  async save(n, expectStatus) {
    return this.repo.saveDeliveryState(n, expectStatus ? { expectStatus } : {});
  }

  /** First delivery of a new notification: inbox only for digests and agents without a webhook. */
  async dispatch(notificationId) {
    const n = await this.repo.getNotification(notificationId);
    if (!n || n.status !== 'queued') return;
    const agent = await this.repo.getAgent(n.agent_id);
    if (n.tier === 'digest' || !agent?.delivery.webhook_url) {
      n.status = 'in_inbox';
      await this.save(n, 'queued');
      this.metrics.inc(`notifications_${n.tier}_inbox_only`);
      return;
    }
    n.delivery.cycle_started_at ??= n.created_at;
    await this.save(n, 'queued');
    await this.attempt(n.id);
  }

  /** One delivery attempt. Never throws; schedules its own retry or dead-letters the notification. */
  async attempt(notificationId) {
    this.scheduler.cancel(this.timers.get(notificationId));
    this.timers.delete(notificationId);
    const n = await this.repo.getNotification(notificationId);
    if (!n || FINAL.has(n.status) || n.status === 'delivering') return; // idempotent: no duplicate sends
    // Every write below is conditional on this status: if a retraction (or another worker) changes
    // the notification meanwhile, our write is refused instead of undoing theirs.
    const seen = n.status;
    if (n.acked_at) return this.settleAcknowledged(n); // the agent already has it (e.g. pulled it from the inbox)

    const agent = await this.repo.getAgent(n.agent_id);
    if (!agent || agent.status !== 'active') return this.cancel(n, 'cancelled', 'agent_inactive', seen);
    if (!agent.delivery.webhook_url) {
      n.status = 'in_inbox'; // the agent removed its webhook: pull only
      return this.save(n, seen);
    }
    const now = Date.now();
    if (now - Date.parse(n.delivery.cycle_started_at ?? n.created_at) > this.cfg.maxDeliveryAgeMs) return this.deadLetter(n, 'expired', seen);
    if (n.post_id && n.event !== 'post.retracted') {
      const post = await this.repo.getPost(n.post_id);
      // Retraction normally cancels these first; this check is the backstop.
      if (!post || post.status === 'quarantined') return this.cancel(n, 'retracted', 'post_quarantined', seen);
      if (isExpired(post, now)) return this.cancel(n, 'cancelled', 'post_expired', seen); // the offer is over: don't send it
      if (post.status === 'under_review') {
        // Hidden pending moderator review: hold the delivery (no attempt used) and check again later.
        n.status = 'deferred';
        n.delivery.last_error = 'post_under_review';
        this.metrics.inc('webhook_deferred_under_review');
        return this.scheduleRetry(n, this.cfg.reviewHoldMs, seen);
      }
    }

    // The event body reflects the state at send time; null means nothing is left to deliver
    // (e.g. every item of a digest batch was retracted or expired meanwhile).
    let event;
    try {
      event = await this.envelope(n);
    } catch (err) {
      // Could not build the event (e.g. the database is briefly unavailable): try again later.
      n.delivery.last_error = `envelope: ${err?.message ?? err}`;
      return this.scheduleRetry(n, this.backoff(n.delivery.attempts + 1), seen);
    }
    if (event == null) return this.cancel(n, 'cancelled', 'nothing_to_deliver', seen);

    const breaker = this.breaker(agent.id);
    if (!breaker.allow(now)) {
      n.status = 'deferred';
      n.delivery.last_error = 'circuit_open';
      this.metrics.inc('webhook_deferred_circuit_open');
      return this.scheduleRetry(n, breaker.waitMs(now), seen);
    }

    // Claim the attempt: only one caller can move this notification into `delivering`.
    n.status = 'delivering';
    n.delivery.attempts += 1;
    n.delivery.claimed_at = nowIso();
    if (!(await this.save(n, seen))) {
      breaker.probing = false;
      return;
    }

    let res;
    let error;
    try {
      const body = JSON.stringify(event);
      res = await this.fetch(agent.delivery.webhook_url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'AgentNet-Webhooks/0.1',
          'x-agentnet-event': n.event,
          'x-agentnet-delivery': n.id,
          'x-agentnet-attempt': String(n.delivery.attempts),
          'x-agentnet-signature': signWebhook(agent.webhook_secret, body),
        },
        body,
        redirect: 'manual', // never follow redirects, whatever transport is plugged in
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      error = err;
    }

    if (res?.ok) {
      breaker.success();
      n.status = 'delivered';
      n.delivery.delivered_at = nowIso();
      n.delivery.next_attempt_at = null;
      // Conditional: a notification retracted while its request was in flight stays retracted.
      if (await this.save(n, 'delivering')) this.metrics.inc('webhook_delivered');
      return;
    }

    if (error?.code === 'EBLOCKED') {
      // The destination resolved to a non-public address: a policy decision, so don't retry.
      breaker.probing = false;
      n.delivery.last_error = `blocked: ${error.message}`;
      this.metrics.inc('webhook_blocked_destination');
      this.log.warn('webhook destination blocked', { notification: n.id, agent: agent.id, reason: error.message });
      return this.deadLetter(n, 'blocked_destination', 'delivering');
    }

    if (res) {
      n.delivery.last_error = `HTTP ${res.status}`;
      if (res.status >= 300 && res.status < 400) {
        // A redirect could point into a private network. It is a permanent failure, not followed.
        n.delivery.last_error += ' (redirects are not followed)';
        this.metrics.inc('webhook_redirect_refused');
        breaker.success();
        return this.deadLetter(n, 'redirect_refused', 'delivering');
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        breaker.success(); // the endpoint is up and rejected this event; retrying won't help
        return this.deadLetter(n, 'rejected_by_endpoint', 'delivering');
      }
    } else {
      n.delivery.last_error = isTimeout(error) ? 'timeout' : (error?.message ?? 'unknown error');
    }

    breaker.failure(Date.now());
    if (n.delivery.attempts >= this.cfg.maxAttempts) return this.deadLetter(n, 'retries_exhausted', 'delivering');
    return this.scheduleRetry(n, this.backoff(n.delivery.attempts, retryAfterMs(res)), 'delivering');
  }

  async deadLetter(n, reason, expectStatus) {
    n.status = 'failed'; // still in the inbox; the dead-letter entry allows redelivery
    n.delivery.next_attempt_at = null;
    n.delivery.dead_letter = { reason, at: nowIso() };
    if (!(await this.save(n, expectStatus))) return;
    this.metrics.inc('webhook_failed');
    this.metrics.inc('webhook_dead_lettered');
    this.log.warn('webhook delivery dead-lettered', { notification: n.id, agent: n.agent_id, reason, error: n.delivery.last_error });
  }

  /**
   * Stops all further delivery of a notification (scheduled retries and dead-letter entry included).
   * Without `expectStatus` it is unconditional: a retraction always wins, even against an attempt
   * in flight, whose final write then fails its compare-and-set.
   */
  async cancel(n, status = 'cancelled', reason = null, expectStatus) {
    this.scheduler.cancel(this.timers.get(n.id));
    this.timers.delete(n.id);
    n.status = status;
    n.delivery.next_attempt_at = null;
    n.delivery.dead_letter = null;
    if (reason) n.delivery.cancel_reason = reason;
    if (status === 'retracted') n.retracted_at = nowIso();
    return this.save(n, expectStatus);
  }

  /** An acknowledged notification needs no (further) push: it stays in the inbox, retries stop. */
  async settleAcknowledged(n) {
    const seen = n.status;
    this.scheduler.cancel(this.timers.get(n.id));
    this.timers.delete(n.id);
    n.status = 'in_inbox';
    n.delivery.next_attempt_at = null;
    n.delivery.dead_letter = null;
    n.delivery.cancel_reason = 'acknowledged';
    const saved = await this.save(n, seen);
    if (saved) this.metrics.inc('deliveries_settled_by_ack');
    return saved;
  }

  /** A delivery whose worker died mid-request goes back to the retry schedule (at-least-once). */
  async recoverStale(n) {
    n.status = 'retry_scheduled';
    n.delivery.last_error = 'worker_lost_during_delivery';
    return this.scheduleRetry(n, 0, 'delivering');
  }

  /** Persists the next attempt time; false if the notification changed meanwhile (e.g. retracted). */
  async scheduleRetry(n, delayMs, expectStatus) {
    if (n.status !== 'deferred') n.status = 'retry_scheduled';
    n.delivery.next_attempt_at = new Date(Date.now() + delayMs).toISOString();
    if (!(await this.save(n, expectStatus))) return false; // retracted meanwhile
    // The retry time is persisted: if this process stops, any delivery worker's due-retry poller
    // runs it. The local timer is the fast path.
    const id = this.scheduler.schedule(`webhook:${n.id}`, delayMs, () => this.attempt(n.id));
    if (id != null) this.timers.set(n.id, id);
    this.metrics.inc('webhook_retries_scheduled');
    return true;
  }

  /** Takes a notification out of the dead-letter queue and starts a fresh delivery cycle. */
  async redeliver(notificationId) {
    const n = await this.repo.getNotification(notificationId);
    if (!n || n.status !== 'failed' || !n.delivery.dead_letter) return false;
    n.status = 'queued';
    n.delivery.attempts = 0;
    n.delivery.dead_letter = null;
    n.delivery.cycle_started_at = nowIso();
    n.delivery.redeliveries = (n.delivery.redeliveries ?? 0) + 1;
    if (!(await this.save(n, 'failed'))) return false;
    this.metrics.inc('webhook_redeliveries');
    await this.attempt(n.id);
    return true;
  }
}
