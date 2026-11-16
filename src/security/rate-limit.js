// Token-bucket rate limiter keyed by (subject, action).
//   RateLimiter       in-process buckets (single instance, tests, demo)
//   RedisRateLimiter  the same algorithm as one Lua script per check, on Redis server time, so a
//                     limit holds across all API replicas instead of multiplying by their number
// Both return { ok, retryAfterSec } (the Redis one asynchronously; callers await either).

export class RateLimiter {
  /**
   * Memory is bounded: buckets that have refilled completely (indistinguishable from new ones) are
   * pruned regularly, and beyond `maxKeys` the least recently used buckets are dropped.
   */
  constructor(now = () => Date.now(), { maxKeys = 100_000 } = {}) {
    this.now = now;
    this.buckets = new Map(); // key -> { tokens, at, refill, capacity }, least recently used first
    this.maxKeys = maxKeys;
    this.calls = 0;
  }

  /**
   * Takes one token. Tokens refill at `perMinute`; the bucket holds at most `capacity` (the burst),
   * which defaults to one minute's worth. Returns { ok, retryAfterSec }.
   */
  take(key, perMinute, capacity = perMinute) {
    const t = this.now();
    const refillPerMs = perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: capacity, at: t };
    b.tokens = Math.min(capacity, b.tokens + (t - b.at) * refillPerMs);
    b.at = t;
    b.refill = refillPerMs;
    b.capacity = capacity;
    this.buckets.delete(key); // re-insert: Map order is recency order
    this.buckets.set(key, b);
    if (++this.calls % 1_000 === 0 || this.buckets.size > this.maxKeys) this.prune(t);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfterSec: 0 };
    }
    return { ok: false, retryAfterSec: Math.ceil((1 - b.tokens) / refillPerMs / 1000) };
  }

  prune(t = this.now()) {
    for (const [key, b] of this.buckets) {
      if (b.tokens + (t - b.at) * b.refill >= b.capacity) this.buckets.delete(key);
    }
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) break;
      this.buckets.delete(key);
    }
  }
}

// KEYS[1] bucket; ARGV: refill tokens per ms, capacity. Uses the server clock, so replicas with
// skewed clocks still share one consistent bucket. Idle buckets expire once they would be full.
const TAKE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local refill = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local b = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(b[1]) or capacity
local at = tonumber(b[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - at) * refill)
local ok = 0
if tokens >= 1 then
  tokens = tokens - 1
  ok = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / refill) + 1000)
return { ok, tostring(tokens) }`;

export class RedisRateLimiter {
  constructor({ client, prefix = 'agentnet' }) {
    this.client = client;
    this.prefix = prefix;
  }

  async take(key, perMinute, capacity = perMinute) {
    const refillPerMs = perMinute / 60_000;
    const [ok, tokens] = await this.client.eval(TAKE_SCRIPT, {
      keys: [`${this.prefix}:ratelimit:${key}`],
      arguments: [String(refillPerMs), String(capacity)],
    });
    if (Number(ok) === 1) return { ok: true, retryAfterSec: 0 };
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - Number(tokens)) / refillPerMs / 1000)) };
  }
}
