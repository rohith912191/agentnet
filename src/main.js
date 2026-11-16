// Process entry point.
//   node src/main.js                  everything in one process (role "all")
//   node src/main.js --role=api       HTTP API only           } separate processes, any number of
//   node src/main.js --role=routing   routing worker          } each; they share PostgreSQL
//   node src/main.js --role=delivery  webhook delivery worker } (AGENTNET_DATABASE_URL) and Redis
//                                                               (AGENTNET_REDIS_URL)
// The role can also come from AGENTNET_ROLE.

import os from 'node:os';
import { createPlatform } from './platform.js';
import { assertSafeConfig, loadConfig } from './config.js';
import { openRepository } from './repo/index.js';
import { openQueue } from './queue/index.js';
import { startRuntime } from './runtime.js';
import { createLogger } from './util.js';

const log = createLogger();
const role = process.argv.find((a) => a.startsWith('--role='))?.slice('--role='.length) ?? process.env.AGENTNET_ROLE ?? 'all';

let platform;
let queue;
let runtime;
try {
  const config = loadConfig();
  assertSafeConfig(config); // fail before connecting to anything
  const repo = await openRepository(config, { log });
  queue = await openQueue(config, { log });
  platform = createPlatform({}, { log, repo, transport: queue?.transport, limiter: queue?.limiter });
  runtime = await startRuntime({ platform, role, queue, consumerName: `${role}-${os.hostname()}-${process.pid}` });
} catch (err) {
  log.error('AgentNet refused to start', { role, error: err.message });
  await queue?.close();
  process.exit(1);
}

const { devAutoVerify, allowInsecureWebhooks, adminKey } = platform.config;
if (platform.repo.kind === 'memory') log.warn('in-memory storage: all state is lost on restart (set AGENTNET_DATABASE_URL)');
if (runtime.server && !adminKey) log.warn('admin API disabled: set AGENTNET_ADMIN_KEY (16+ characters) to enable /v1/admin/*');
if (devAutoVerify) log.warn('devAutoVerify is on: domain verification is skipped (development only)');
if (allowInsecureWebhooks) log.warn('allowInsecureWebhooks is on: webhooks may target http:// and private networks (development only)');

let exiting = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (exiting) return;
    exiting = true;
    log.info('signal received', { signal, role });
    const outcome = await runtime.stop();
    await queue?.close();
    await platform.repo.close();
    process.exit(outcome === 'clean' ? 0 : 1);
  });
}
