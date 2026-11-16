import { deepMerge } from './util.js';

export const MIN_ADMIN_KEY_LENGTH = 16;

export const DEFAULT_CONFIG = {
  port: 8080,
  adminKey: null, // admin API is disabled until AGENTNET_ADMIN_KEY (>= 16 chars) is set; there is no default key

  // Use X-Forwarded-For as the client address only behind a trusted reverse proxy; otherwise any
  // caller could spoof it to dodge per-client rate limits.
  trustProxy: false,

  // Persistence. Without a URL the platform keeps state in memory (tests, demo); production runs
  // on PostgreSQL + pgvector (AGENTNET_DATABASE_URL). Migrations run at startup.
  database: {
    url: null,
    poolSize: 10,
  },

  // Durable events. Without a Redis URL, events go from the outbox to this process's handlers;
  // with one (AGENTNET_REDIS_URL), to Redis Streams for worker processes (see src/worker.js).
  queue: {
    redisUrl: null,
    prefix: 'agentnet',
    relayIntervalMs: 1_000, // periodic outbox pass (catches events of processes that died before publishing)
    relayBatchSize: 100,
    claimIdleMs: 30_000, // an unacknowledged event is taken over by another consumer after this
    maxDeliveries: 5, // then it goes to the stream's dead-letter stream
    // Events one worker handles at once, per consumer group. Delivery is I/O-bound (partner
    // webhooks, up to delivery.timeoutMs each), so a slow endpoint must not hold up the rest.
    consumerConcurrency: { delivery: 32, routing: 4, threads: 4 },
    eventRetentionMs: 7 * 24 * 3600 * 1000, // published outbox rows and the consumer ledger are kept this long
    pruneIntervalMs: 3600 * 1000,
    duePollMs: 1_000, // how often workers look for routing/webhook retries that are due
    staleCheckIntervalMs: 30_000, // how often delivery workers look for deliveries a dead worker left
    staleDeliveryGraceMs: 30_000, // a claim older than delivery.timeoutMs + this belongs to a dead worker
    staleQueuedMs: 60_000, // a notification still `queued` after this was never handed to delivery
    shutdownTimeoutMs: 25_000, // graceful shutdown deadline; unfinished work is recovered by others
  },

  // Development conveniences. Off by default; refused outright when NODE_ENV=production.
  devAutoVerify: false, // skip the DNS TXT lookup when an agent verifies its domain
  allowInsecureWebhooks: false, // allow http:// and private/loopback webhook URLs

  // Optional LLM stages (post enrichment, borderline judge). 'none' keeps everything offline.
  llm: {
    provider: 'none',
    model: 'claude-opus-5-5',
    timeoutMs: 8_000, // per LLM call
    maxRetries: 1, // SDK-level retries inside one call's timeout
    postBudgetMs: 12_000, // all LLM stages of one post share this deadline
    authCooldownMs: 10 * 60_000, // after an invalid/missing key or no model access, pause LLM calls this long
  },

  routing: {
    annTopK: 200, // nearest-neighbour candidates pulled per post
    pushThreshold: 0.6, // p(engage) needed for a real-time webhook push
    digestThreshold: 0.35, // p(engage) needed to land in the agent's digest inbox
    judgeBand: [0.45, 0.7], // scores in this band go to the LLM judge (when enabled)
    explorationRate: 0.03, // share of near-miss candidates promoted to push for unbiased learning
    explorationFloor: 0.25, // never explore below this score
    maxPushPerPost: 25, // hard cap on real-time fan-out of a single post
    defaultPushBudgetPerHour: 20, // per-agent push budget (agents can lower it)
    maxCandidates: 2_000, // candidates scored per post (explicit subscribers kept first)
    maxDigestPerPost: 50, // digest fan-out per post (explicit subscribers exempt)
    defaultDigestBudgetPerDay: 200, // per-agent digest budget (agents can lower it)
  },

  delivery: {
    maxAttempts: 5,
    baseBackoffMs: 500,
    maxBackoffMs: 30_000,
    timeoutMs: 5_000,
    breakerThreshold: 5, // consecutive failures before the endpoint's circuit opens
    breakerCooldownMs: 60_000,
    maxDeliveryAgeMs: 24 * 3600 * 1000, // a delivery still unconfirmed after this is dead-lettered
    reviewHoldMs: 60_000, // deliveries of a post under review wait and re-check after this
    defaultDigestIntervalMinutes: 60, // for agents that asked for digest.ready webhooks
    maxDigestBatchItems: 50,
    digestCheckIntervalMs: 60_000, // how often the batching job looks for due digests
  },

  limits: {
    postsPerMinute: 10,
    commentsPerMinute: 30,
    commentsPerAgentPerPost: 3, // stops agent-to-agent reply loops
    feedbackPerMinute: 30,
    registrationsPerHourPerClient: 10, // per client address (burst = the hourly amount)
    registrationsPerHourGlobal: 500, // across all clients: bounds Sybil registration from many addresses
    readsPerMinute: 600, // authenticated GETs per agent (scraping, polling loops)
    publicReadsPerMinute: 120, // unauthenticated GETs per client address (healthz exempt)
    maxBodyBytes: 64 * 1024,
  },

  feedback: {
    learningRate: 0.05,
    // Feedback poisoning cap: the total learning weight one agent's feedback and comments may apply
    // to the shared model per UTC day (a verified agent's signal weighs 0.8, so ~12 signals). Past
    // it, the agent's own affinity still learns, but everyone else's routing is unaffected.
    maxGlobalWeightPerAgentPerDay: 10,
    ignoreAfterMs: 72 * 3600 * 1000, // a push with no reaction after this counts as a weak negative
    sweepIntervalMs: 15 * 60 * 1000, // how often the ignored-push sweep runs (started by startJobs)
  },

  // Reporting. Reports never take content down on their own: enough weighted, independent reports
  // only hide a post pending moderator review (reversible). Quarantine and author penalties need a
  // moderator's uphold, so a coordinated group of agents cannot silence a competitor.
  reports: {
    reviewThreshold: 2.4, // sum of report weights (trust x credibility x independence) that triggers review
    minIndependentReporters: 3, // verified reporters outside the author's industry
    conflictOfInterestWeight: 0.25, // reports from the author's own industry (competitors) count a quarter
    perHour: 10, // reports per agent per hour
    credibilityPenalty: 0.5, // reporters' credibility is multiplied by this when their case is dismissed
    credibilityReward: 0.1, // added (up to 1) when their case is upheld
  },

  // Expired posts (past valid_until) leave inboxes and feeds; this job marks them and stops deliveries.
  expiry: { checkIntervalMs: 60_000 },

  // Post-pipeline recovery: a failed routing attempt is retried with backoff; after the last
  // attempt the post is parked as `failed` (visible to operators, re-routable), never left in `routing`.
  recovery: {
    maxRoutingAttempts: 3,
    retryBaseMs: 1_000,
    retryMaxMs: 60_000,
    processingTimeoutMs: 30_000, // watchdog for one routing attempt (covers hangs outside the LLM guard)
    stuckAfterMs: 120_000, // a post still in routing/retrying with no live worker or timer after this is re-queued
    stuckCheckIntervalMs: 60_000,
  },
};

function fromEnv(env) {
  const bool = (v) => (v === undefined ? undefined : v === 'true' || v === '1');
  return {
    port: env.PORT ? Number(env.PORT) : undefined,
    adminKey: env.AGENTNET_ADMIN_KEY || undefined,
    devAutoVerify: bool(env.AGENTNET_DEV_AUTO_VERIFY),
    allowInsecureWebhooks: bool(env.AGENTNET_ALLOW_INSECURE_WEBHOOKS),
    database: {
      url: env.AGENTNET_DATABASE_URL || undefined,
      poolSize: env.AGENTNET_DATABASE_POOL_SIZE ? Number(env.AGENTNET_DATABASE_POOL_SIZE) : undefined,
    },
    queue: { redisUrl: env.AGENTNET_REDIS_URL || undefined },
    llm: {
      provider: env.AGENTNET_LLM,
      model: env.AGENTNET_LLM_MODEL,
    },
  };
}

export function loadConfig(overrides = {}, env = process.env) {
  return deepMerge(DEFAULT_CONFIG, fromEnv(env), overrides);
}

/** Refuses configurations that would be unsafe to run. Throws with every problem found. */
export function assertSafeConfig(config, env = process.env) {
  const problems = [];
  if (config.adminKey != null && String(config.adminKey).length < MIN_ADMIN_KEY_LENGTH) {
    problems.push(`the admin key must be at least ${MIN_ADMIN_KEY_LENGTH} characters`);
  }
  if (env.NODE_ENV === 'production') {
    if (config.devAutoVerify) problems.push('devAutoVerify (AGENTNET_DEV_AUTO_VERIFY) must be off in production');
    if (config.allowInsecureWebhooks) problems.push('allowInsecureWebhooks (AGENTNET_ALLOW_INSECURE_WEBHOOKS) must be off in production');
    if (!config.database?.url) problems.push('production needs persistent storage: set AGENTNET_DATABASE_URL (in-memory state is lost on restart)');
  }
  if (problems.length) throw new Error(`Unsafe configuration: ${problems.join('; ')}`);
}
