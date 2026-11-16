// Redis Streams transport and consumer.
//
// One stream per event type (agentnet:events:post.published, ...), one consumer group per worker
// role (routing, delivery, threads). Workers of the same role share a group, so each event is
// handled by one of them; several roles could consume the same stream independently.
//
// Delivery guarantees:
//   - an event is XACKed only after its handler succeeded and the consumer ledger recorded it
//   - a consumer that dies mid-event leaves it pending; after claimIdleMs any live consumer of the
//     group takes it over with XAUTOCLAIM (which counts deliveries)
//   - an event that keeps failing (maxDeliveries) is moved to a dead-letter stream and acknowledged
//   - an event delivered twice (relay retry, takeover of a slow consumer) is skipped via the ledger;
//     the handlers are idempotent as well, so even a concurrent duplicate has no duplicate effect
//   - on shutdown the consumer stops reading, finishes the events in hand, and returns; whatever it
//     had not acknowledged is reclaimed by the group
//
// Concurrency: a consumer handles up to `concurrency` events at once and reads more as soon as a
// slot frees up, so one slow event (a partner webhook that takes its full timeout) does not hold
// up the events behind it. Delivery consumers use a high limit; see config.queue.consumerConcurrency.

import { sleep } from '../util.js';

export const streamKey = (prefix, type) => `${prefix}:events:${type}`;
export const deadLetterKey = (prefix, type) => `${prefix}:dead:${type}`;

const fieldsOf = (message) => (message instanceof Map ? Object.fromEntries(message) : { ...message });

export async function connectRedis(url, { log } = {}) {
  const { createClient } = await import('redis');
  const client = createClient({ url });
  client.on('error', (err) => log?.warn('redis connection error', { error: err?.message ?? String(err) }));
  await client.connect();
  return client;
}

export class RedisStreamsTransport {
  constructor({ client, prefix = 'agentnet', maxLen = 1_000_000 }) {
    this.client = client;
    this.prefix = prefix;
    this.maxLen = maxLen;
    this.kind = 'redis-streams';
  }

  /** XADDs every event (pipelined); resolves once Redis has accepted all of them. */
  async publish(events) {
    await Promise.all(
      events.map((e) =>
        this.client.xAdd(
          streamKey(this.prefix, e.type),
          '*',
          { event_id: e.id, type: e.type, payload: JSON.stringify(e.payload), created_at: e.created_at ?? new Date().toISOString() },
          // Approximate trimming bounds memory; consumers that fall this far behind lose the oldest
          // entries, which the outbox still holds (published_at tells what was handed over).
          { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: this.maxLen } },
        ),
      ),
    );
  }
}

export class StreamConsumer {
  /**
   * @param client  a dedicated connection (blocking reads hold it)
   * @param handle  async (payload, meta) => void; throwing leaves the event pending for a retry
   * @param ledger  { isProcessed(group, eventId), markProcessed(group, eventId) } (the repository)
   */
  constructor({ client, prefix = 'agentnet', type, group, consumer, handle, ledger, log, metrics, maxDeliveries = 5, claimIdleMs = 30_000, blockMs = 1_000, count = 10, concurrency = 1 }) {
    Object.assign(this, { client, prefix, type, group, consumer, handle, ledger, log, metrics, maxDeliveries, claimIdleMs, blockMs, count });
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.stream = streamKey(prefix, type);
    this.stopping = false;
    this.loop = null;
    this.inFlight = new Map(); // stream message id -> promise of its processing
  }

  async ensureGroup() {
    try {
      await this.client.xGroupCreate(this.stream, this.group, '0', { MKSTREAM: true });
    } catch (err) {
      if (!String(err?.message).includes('BUSYGROUP')) throw err;
    }
  }

  async start() {
    await this.ensureGroup();
    this.loop = this.#run();
    return this;
  }

  /** Graceful stop: no new reads; the events in hand are finished first. */
  async stop() {
    this.stopping = true;
    await this.loop;
  }

  /** Starts processing one message without waiting for it; at most `concurrency` run at once. */
  #dispatch(m, deliveries) {
    const p = this.process(m, deliveries)
      .catch((err) => {
        // Ack or ledger write failed: the event stays pending and is reclaimed later.
        this.metrics.inc('stream_consumer_errors');
        this.log.warn('stream event processing failed', { stream: this.stream, event: m.id, error: err?.message ?? String(err) });
      })
      .finally(() => this.inFlight.delete(m.id));
    this.inFlight.set(m.id, p);
  }

  async #run() {
    let failures = 0;
    while (!this.stopping) {
      try {
        if (this.inFlight.size >= this.concurrency) {
          await Promise.race(this.inFlight.values()); // wait for a free slot
          continue;
        }
        await this.reclaimStale();
        if (this.stopping) break;
        const free = this.concurrency - this.inFlight.size;
        if (free <= 0) continue;
        const res = await this.client.xReadGroup(this.group, this.consumer, { key: this.stream, id: '>' }, { COUNT: Math.min(this.count, free), BLOCK: this.blockMs });
        for (const stream of res ?? []) {
          for (const m of stream.messages) this.#dispatch(m, 1);
        }
        failures = 0;
      } catch (err) {
        if (this.stopping) break;
        failures++;
        this.metrics.inc('stream_consumer_errors');
        this.log.warn('stream consumer error; backing off', { stream: this.stream, consumer: this.consumer, error: err?.message ?? String(err) });
        await sleep(Math.min(5_000, 100 * 2 ** Math.min(failures, 6)));
      }
    }
    await Promise.allSettled([...this.inFlight.values()]);
  }

  /** Takes over events other consumers (or a previous life of this one) left unacknowledged. */
  async reclaimStale() {
    const free = this.concurrency - this.inFlight.size;
    if (free <= 0) return 0;
    const { messages } = await this.client.xAutoClaim(this.stream, this.group, this.consumer, this.claimIdleMs, '0-0', { COUNT: Math.min(this.count, free) });
    // An event this consumer is still working on can look idle to XAUTOCLAIM: never run it twice here.
    const live = messages.filter((m) => m && !this.inFlight.has(m.id));
    if (!live.length) return 0;
    const pending = await this.client.xPendingRange(this.stream, this.group, '-', '+', 1_000, { consumer: this.consumer });
    const deliveries = new Map(pending.map((p) => [p.id, Number(p.deliveriesCounter)]));
    this.metrics.inc('stream_events_reclaimed', live.length);
    for (const m of live) this.#dispatch(m, deliveries.get(m.id) ?? 2);
    return live.length;
  }

  async process(m, deliveries) {
    const fields = fieldsOf(m.message);
    const eventId = fields.event_id;
    if (deliveries > this.maxDeliveries) {
      await this.client.xAdd(deadLetterKey(this.prefix, this.type), '*', { ...fields, stream_id: m.id, group: this.group, deliveries: String(deliveries) });
      await this.client.xAck(this.stream, this.group, m.id);
      this.metrics.inc('stream_events_dead_lettered');
      this.log.error('event dead-lettered after repeated failures', { stream: this.stream, event: eventId, deliveries });
      return;
    }
    if (await this.ledger.isProcessed(this.group, eventId)) {
      await this.client.xAck(this.stream, this.group, m.id);
      this.metrics.inc('stream_events_duplicates_skipped');
      return;
    }
    try {
      await this.handle(JSON.parse(fields.payload), { eventId, type: fields.type, deliveries });
    } catch (err) {
      this.metrics.inc('stream_events_failed');
      this.log.warn('event handler failed; it will be retried', { stream: this.stream, event: eventId, deliveries, error: err?.message ?? String(err) });
      return; // not acknowledged: reclaimed after claimIdleMs
    }
    await this.ledger.markProcessed(this.group, eventId);
    await this.client.xAck(this.stream, this.group, m.id);
    this.metrics.inc('stream_events_processed');
  }
}
