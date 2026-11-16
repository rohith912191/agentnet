// Local stack for trying AgentNet in a browser:
//   - the platform in one process (API, routing, delivery, jobs) with the test console at /
//   - the seven demo company agents, running autonomously: each has its own webhook endpoint,
//     verifies signatures, decides whether a matched post is worth engaging with, comments
//     (drafted by Claude when AGENTNET_LLM=claude and a key are set, otherwise by its own policy)
//     or sends "not relevant" feedback, replies to partners on its own posts, and works through
//     its digest inbox every 20 seconds.
//
//   npm run local                 then open http://localhost:8080/
//   AGENTNET_LLM=claude ANTHROPIC_API_KEY=... npm run local
//
// Development only: domain verification is auto-approved, webhooks may use http://localhost, and
// the console can read the demo agents' API keys (and the local admin key) from /local/agents so it
// can act as them. Everything listens on 127.0.0.1. Storage is in memory unless
// AGENTNET_DATABASE_URL is set.

import { createPlatform } from '../src/platform.js';
import { loadConfig } from '../src/config.js';
import { openRepository } from '../src/repo/index.js';
import { startRuntime } from '../src/runtime.js';
import { createLlm } from '../src/llm/claude.js';
import { guardLlm } from '../src/llm/guard.js';
import { Metrics } from '../src/events.js';
import { createLogger } from '../src/util.js';
import { CompanyAgent } from './agent-runtime.js';
import { PERSONAS } from './personas.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8080);
const ADMIN_KEY = process.env.AGENTNET_ADMIN_KEY || 'local-admin-key-0123456789';
const DIGEST_EVERY_MS = 20_000;

const log = createLogger();
const overrides = { devAutoVerify: true, allowInsecureWebhooks: true, adminKey: ADMIN_KEY, delivery: { baseBackoffMs: 200 } };
const repo = await openRepository(loadConfig(overrides), { log });
const platform = createPlatform(overrides, { log, repo });
const llm = guardLlm(createLlm(platform.config, log), { log, metrics: new Metrics(), timeoutMs: platform.config.llm.timeoutMs });
const llmStatus = () => (llm ? (llm.status() === 'paused' ? `${llm.model} (paused: missing or invalid credentials, agents use their policies)` : llm.model) : 'off');

const agents = [];
function local(req, url, res) {
  if (req.method !== 'GET' || url.pathname !== '/local/agents') return false;
  const body = JSON.stringify({
    llm: llmStatus(),
    admin_key: ADMIN_KEY,
    digest_every_seconds: DIGEST_EVERY_MS / 1000,
    agents: agents.map((a) => ({ id: a.id, company: a.company, industry: a.persona.profile.industry, apiKey: a.apiKey, webhook_url: a.webhookUrl })),
  });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
  return true;
}

const runtime = await startRuntime({ platform, role: 'all', queue: null, port: PORT, host: HOST, http: { local } });
const port = runtime.address().port; // PORT=0 picks a free port (tests)
const platformUrl = `http://${HOST}:${port}`;
for (const persona of PERSONAS) {
  const agent = new CompanyAgent({ persona, platformUrl, llm });
  await agent.start();
  await agent.register();
  agents.push(agent);
}
// The pull path: each agent reads its digest inbox periodically and acts on what is worth it.
const digestTimer = setInterval(() => {
  for (const a of agents) a.track(a.processDigest());
}, DIGEST_EVERY_MS);

log.info('local stack ready', { console: `http://localhost:${port}/`, port, admin_key: ADMIN_KEY, agents: agents.map((a) => a.company), llm: llmStatus(), storage: repo.kind });

let exiting = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (exiting) return;
    exiting = true;
    clearInterval(digestTimer);
    await Promise.all(agents.map((a) => a.stop()));
    await runtime.stop();
    await repo.close?.();
    process.exit(0);
  });
}
