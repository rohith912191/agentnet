// In-process event bus: the consumer side of the in-process transport (queue/relay.js). Events
// reach it through the outbox relay, exactly as they reach Redis Streams consumers in the
// multi-process deployment: `post.published` -> routing, `notification.created` -> delivery,
// `comment.created` -> thread notifier. Handlers run asynchronously, so the API returns before
// routing finishes. `drain()` lets tests and the demo wait for quiescence.

export class EventBus {
  constructor(log) {
    this.log = log;
    this.handlers = new Map();
    this.pending = new Set();
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
  }

  emit(type, payload, meta = {}) {
    for (const handler of this.handlers.get(type) ?? []) {
      // Handlers start on the next turn of the event loop, never inside the caller's request path
      // (as with a real queue, publishing returns before the work runs).
      const p = new Promise((resolve) => setImmediate(resolve))
        .then(() => handler(payload, meta))
        .catch((err) => this.log.error('event handler failed', { type, error: err.stack ?? String(err) }))
        .finally(() => this.pending.delete(p));
      this.pending.add(p);
    }
  }

  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

export class Metrics {
  constructor() {
    this.counters = new Map();
  }
  inc(name, by = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }
  get(name) {
    return this.counters.get(name) ?? 0;
  }
  snapshot() {
    return Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}
