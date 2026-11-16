// Process roles. One codebase, deployed as separate, independently scaled processes:
//
//   api       HTTP API. Writes rows + outbox events; its relay publishes them to Redis Streams.
//   routing   consumes post.published (group "routing") and comment.created (group "threads");
//             runs routing retries, stuck-post recovery, expiry, the ignored-push sweep, pruning.
//   delivery  consumes notification.created (group "delivery"); runs webhook retries that are due
//             and recovers deliveries a dead worker left behind.
//   all       everything in one process (single node; the only role that works without Redis).
//
// Any number of instances of each role can run: consumer groups split the events, and the
// database arbitrates the rest (routing leases, delivery compare-and-set claims, SKIP LOCKED relays).
//
// Graceful shutdown (SIGTERM): stop accepting HTTP requests, stop reading events (the event in
// hand is finished), stop the jobs, wait for in-flight work, close connections. It is bounded by
// queue.shutdownTimeoutMs; whatever is unfinished then is recovered by the remaining instances
// (unacknowledged events are reclaimed, expired leases and stale claims are retried).

import { createHttpServer } from './http/server.js';
import { StreamConsumer } from './queue/redis-streams.js';
import { sleep } from './util.js';

const ALL_JOBS = ['outbox-relay', 'due-routing-retries', 'recover-stuck-posts', 'due-deliveries', 'stale-deliveries', 'digest-batches', 'sweep-ignored-pushes', 'expire-posts', 'prune-events'];

export const ROLES = {
  all: { http: true, consumes: ['post.published', 'comment.created', 'notification.created'], jobs: ALL_JOBS },
  api: { http: true, consumes: [], jobs: ['outbox-relay'] },
  routing: {
    http: false,
    consumes: ['post.published', 'comment.created'],
    jobs: ['outbox-relay', 'due-routing-retries', 'recover-stuck-posts', 'sweep-ignored-pushes', 'expire-posts', 'prune-events'],
  },
  delivery: { http: false, consumes: ['notification.created'], jobs: ['outbox-relay', 'due-deliveries', 'stale-deliveries', 'digest-batches'] },
};

export const CONSUMER_GROUP = { 'post.published': 'routing', 'comment.created': 'threads', 'notification.created': 'delivery' };

/**
 * Starts one role on `platform`. `queue` comes from openQueue() (null = single process).
 * Returns { role, stop(), address() }; stop() resolves to 'clean' or 'timeout'.
 */
export async function startRuntime({ platform, role, queue, port = platform.config.port, host, consumerName, shutdownTimeoutMs = platform.config.queue.shutdownTimeoutMs, http = {} }) {
  const spec = ROLES[role];
  if (!spec) throw new Error(`unknown role "${role}" (expected one of: ${Object.keys(ROLES).join(', ')})`);
  if (!queue && role !== 'all') throw new Error(`role "${role}" runs as a separate process and needs a queue: set AGENTNET_REDIS_URL`);
  const { log, metrics, config } = platform;
  const name = consumerName ?? `${role}-${process.pid}`;

  const consumers = [];
  if (queue) {
    for (const type of spec.consumes) {
      const consumer = new StreamConsumer({
        client: await queue.dedicated(),
        prefix: queue.prefix,
        type,
        group: CONSUMER_GROUP[type],
        consumer: name,
        handle: platform.handlers[type],
        ledger: platform.repo,
        log,
        metrics,
        maxDeliveries: config.queue.maxDeliveries,
        claimIdleMs: config.queue.claimIdleMs,
        concurrency: config.queue.consumerConcurrency?.[CONSUMER_GROUP[type]] ?? 1,
      });
      consumers.push(await consumer.start());
    }
  }

  platform.startJobs(spec.jobs);
  // Publish anything left in the outbox by a previous life of this (or another) process.
  platform.relay.kick();

  let server = null;
  if (spec.http) {
    server = createHttpServer(platform, http);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  }
  log.info('runtime started', { role, consumer: name, queue: queue?.kind ?? 'in-process', storage: platform.repo.kind, http: server ? server.address() : null });

  let stopping = null;
  async function stop() {
    stopping ??= (async () => {
      const started = Date.now();
      log.info('graceful shutdown started', { role });
      const graceful = (async () => {
        if (server) {
          const closed = new Promise((resolve) => server.close(resolve)); // no new connections
          server.closeIdleConnections?.(); // idle keep-alive sockets would hold close() open
          await closed; // requests in progress complete
        }
        await Promise.all(consumers.map((c) => c.stop())); // no new events; the one in hand finishes
        await platform.shutdown(); // jobs and timers stop (retries are persisted), in-flight work settles
        return 'clean';
      })();
      const outcome = await Promise.race([graceful, sleep(shutdownTimeoutMs).then(() => 'timeout')]);
      if (outcome === 'timeout') log.warn('shutdown deadline reached; remaining work will be recovered by other instances', { role });
      metrics.inc(`shutdowns_${outcome}`);
      log.info('shutdown complete', { role, outcome, ms: Date.now() - started });
      return outcome;
    })();
    return stopping;
  }

  return { role, consumers, server, stop, address: () => server?.address() ?? null };
}
