// Delayed and periodic work: post-routing retries, webhook retries and maintenance jobs.
// Stands in for a delay queue (e.g. Redis sorted sets or SQS delay messages) in production.
//
// Timers are unref'd so they never keep a process alive on their own (the HTTP server does that);
// `settle()`/`idle()` let callers wait for in-flight tasks, and the platform's drain() also waits
// for scheduled timers to fire.

export class Scheduler {
  constructor({ log } = {}) {
    this.log = log;
    this.timers = new Map(); // id -> { name, handle, due_at }
    this.running = new Set(); // promises of tasks currently executing
    this.intervals = new Map(); // name -> handle
    this.seq = 0;
    this.stopped = false;
  }

  /** Runs `task` once after `delayMs`. Returns a timer id for cancel(), or null when stopped. */
  schedule(name, delayMs, task) {
    if (this.stopped) return null;
    const id = ++this.seq;
    const delay = Math.max(0, delayMs);
    const handle = setTimeout(() => {
      this.timers.delete(id);
      this.run(name, task);
    }, delay);
    handle.unref?.();
    this.timers.set(id, { name, handle, due_at: Date.now() + delay });
    return id;
  }

  /** Runs `task` every `intervalMs` (replacing any job with the same name). */
  every(name, intervalMs, task) {
    if (this.stopped) return;
    this.cancelEvery(name);
    const handle = setInterval(() => this.run(name, task), intervalMs);
    handle.unref?.();
    this.intervals.set(name, handle);
  }

  cancelEvery(name) {
    const handle = this.intervals.get(name);
    if (handle) clearInterval(handle);
    this.intervals.delete(name);
  }

  run(name, task) {
    const p = Promise.resolve()
      .then(task)
      .catch((err) => this.log?.error('scheduled task failed', { name, error: err?.stack ?? String(err) }))
      .finally(() => this.running.delete(p));
    this.running.add(p);
    return p;
  }

  cancel(id) {
    const timer = id == null ? null : this.timers.get(id);
    if (!timer) return false;
    clearTimeout(timer.handle);
    this.timers.delete(id);
    return true;
  }

  has(id) {
    return id != null && this.timers.has(id);
  }

  /** True when no one-shot timers are pending and no task is running (periodic jobs don't count). */
  idle() {
    return this.timers.size === 0 && this.running.size === 0;
  }

  async settle() {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  pending() {
    return [...this.timers.values()].map(({ name, due_at }) => ({ name, due_at: new Date(due_at).toISOString() }));
  }

  stopJobs() {
    for (const name of [...this.intervals.keys()]) this.cancelEvery(name);
  }

  /** Cancels everything (used at shutdown). Pending one-shot work is dropped and logged. */
  stop() {
    if (this.timers.size) this.log?.warn('scheduler stopped with pending work', { pending: this.pending() });
    this.stopped = true;
    for (const { handle } of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    this.stopJobs();
  }
}
