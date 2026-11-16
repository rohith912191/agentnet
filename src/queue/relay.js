// Outbox relay and the in-process transport.
//
// Events are written to the outbox in the same transaction as the rows that caused them (see the
// repositories). The relay moves them from the outbox to a transport:
//   - InProcessTransport: straight to this process's handlers (tests, demo, single-process mode)
//   - RedisStreamsTransport (queue/redis-streams.js): to Redis Streams, consumed by worker processes
// Publication is at-least-once: an event is marked published only after the transport accepted it,
// so a crash or a transport outage means it is offered again, never lost. Consumers deduplicate.

export class InProcessTransport {
  constructor(bus) {
    this.bus = bus;
    this.kind = 'in-process';
  }

  async publish(events) {
    for (const e of events) this.bus.emit(e.type, e.payload, { eventId: e.id, type: e.type });
  }
}

export class OutboxRelay {
  constructor({ repo, transport, log, metrics, batchSize = 100 }) {
    this.repo = repo;
    this.transport = transport;
    this.log = log;
    this.metrics = metrics;
    this.batchSize = batchSize;
    this.running = null; // promise of the drain loop in progress
    this.again = false;
  }

  /** Publishes pending events now. Calls made while a pass is running coalesce into one more pass. */
  kick() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          while ((await this.publishBatch()) === this.batchSize);
        } while (this.again);
      } catch (err) {
        // The transport (e.g. Redis) is unavailable: events stay in the outbox; the periodic pass retries.
        this.metrics.inc('outbox_publish_errors');
        this.log.warn('outbox relay could not publish; will retry', { error: err?.message ?? String(err) });
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async publishBatch() {
    const n = await this.repo.publishOutbox(this.batchSize, (events) => this.transport.publish(events));
    if (n) this.metrics.inc('events_published', n);
    return n;
  }

  /** Periodic pass: picks up events written by processes that died before publishing them. */
  start(scheduler, intervalMs) {
    scheduler.every('outbox-relay', intervalMs, () => this.kick());
  }

  idle() {
    return !this.running;
  }

  async settle() {
    while (this.running) await this.running;
  }
}
