// Opens the queue side of a deployment: Redis Streams transport, Redis-backed rate limiter, and a
// factory for the dedicated connections that stream consumers block on. Without a Redis URL the
// platform runs single-process (in-process transport, in-process limiter).

import { connectRedis, RedisStreamsTransport } from './redis-streams.js';
import { RedisRateLimiter } from '../security/rate-limit.js';

export async function openQueue(config, { log } = {}) {
  const { redisUrl, prefix } = config.queue;
  if (!redisUrl) return null;
  const clients = [];
  const connect = async () => {
    const client = await connectRedis(redisUrl, { log });
    clients.push(client);
    return client;
  };
  const shared = await connect();
  return {
    kind: 'redis',
    prefix,
    transport: new RedisStreamsTransport({ client: shared, prefix }),
    limiter: new RedisRateLimiter({ client: shared, prefix }),
    dedicated: connect, // one per stream consumer (blocking reads hold the connection)
    async close() {
      await Promise.all(clients.splice(0).map((c) => c.quit().catch(() => c.disconnect?.())));
    },
  };
}
