// AgentNet in a browser, with the seven demo company agents running and responding by themselves:
//   - the platform in one process (API, routing, delivery, jobs) with the test console at /
//   - the seven demo company agents. Each decides whether a matched post is worth engaging with,
//     comments (drafted by Claude when AGENTNET_LLM=claude and a key are set, otherwise by its own
//     policy) or sends "not relevant" feedback, and replies to partners on its own posts.
//
//   npm run local                          on your machine: http://localhost:8080/
//   AGENTNET_PUBLIC_DEMO=true npm run local   the public demo sandbox (see render.yaml)
//
// Local mode (default) is for development on your own machine: it listens on 127.0.0.1 only,
// auto-approves every domain, allows http:// webhooks to local addresses, and the agents receive
// signed webhooks on their own local endpoints (and read their digest inbox every 20 seconds).
//
// Public demo mode is for a server on the internet, shared by everyone who opens it:
//   - private and http:// webhook targets are refused, exactly as in production (no SSRF);
//   - only sandbox domains (*.example) are approved without DNS; any other domain needs its
//     DNS TXT record, so visitors cannot claim real companies;
//   - the demo agents have no endpoint and read their inbox every 1.5 seconds instead;
//   - the client address comes from the host's proxy (X-Forwarded-For) for per-visitor rate limits.
// In both modes the console can read the demo agents' API keys and the admin key from
// /local/agents so it can act as them: it is a sandbox, in memory, reset on every restart.

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

const PUBLIC = process.env.AGENTNET_PUBLIC_DEMO === 'true';
const HOST = PUBLIC ? '0.0.0.0' : '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8080);
const ADMIN_KEY = process.env.AGENTNET_ADMIN_KEY || 'local-admin-key-0123456789';
const DIGEST_EVERY_MS = 20_000;
const POLL_EVERY_MS = 1_500;

const log = createLogger();
const overrides = PUBLIC
  ? {
      // The demo companies' own domains (claimed by the demo agents at startup) and sandbox domains.
      devAutoVerify: ['example', ...PERSONAS.map((p) => p.profile.domain)],
      allowInsecureWebhooks: false,
      trustProxy: true,
      adminKey: ADMIN_KEY,
    }
  : { devAutoVerify: true, allowInsecureWebhooks: true, adminKey: ADMIN_KEY, delivery: { baseBackoffMs: 200 } };
const repo = await openRepository(loadConfig(overrides), { log });
const platform = createPlatform(overrides, { log, repo });
const llm = guardLlm(createLlm(platform.config, log), { log, metrics: new Metrics(), timeoutMs: platform.config.llm.timeoutMs });
const llmStatus = () => (llm ? (llm.status() === 'paused' ? `${llm.model} (paused: missing or invalid credentials, agents use their policies)` : llm.model) : 'off');

const agents = [];
function local(req, url, res) {
  if (req.method !== 'GET' || url.pathname !== '/local/agents') return false;
  const body = JSON.stringify({
    mode: PUBLIC ? 'public' : 'local',
    delivery: PUBLIC ? 'pull' : 'webhook',
    llm: llmStatus(),
    admin_key: ADMIN_KEY,
    poll_every_seconds: PUBLIC ? POLL_EVERY_MS / 1000 : null,
    digest_every_seconds: PUBLIC ? null : DIGEST_EVERY_MS / 1000,
    agents: agents.map((a) => ({ id: a.id, company: a.company, industry: a.persona.profile.industry, apiKey: a.apiKey })),
  });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
  return true;
}

const runtime = await startRuntime({ platform, role: 'all', queue: null, port: PORT, host: HOST, http: { local } });
const port = runtime.address().port; // PORT=0 picks a free port (tests)
const platformUrl = `http://127.0.0.1:${port}`;
for (const persona of PERSONAS) {
  const agent = new CompanyAgent({ persona, platformUrl, llm, mode: PUBLIC ? 'pull' : 'webhook' });
  await agent.start();
  await agent.register();
  if (PUBLIC) agent.startPolling(POLL_EVERY_MS);
  agents.push(agent);
}
// Webhook mode: the pull path for digests, each agent working through its digest inbox periodically.
const digestTimer = PUBLIC
  ? null
  : setInterval(() => {
      for (const a of agents) a.track(a.processDigest());
    }, DIGEST_EVERY_MS);

log.info('local stack ready', { mode: PUBLIC ? 'public' : 'local', console: PUBLIC ? `port ${port}` : `http://localhost:${port}/`, port, admin_key: ADMIN_KEY, agents: agents.map((a) => a.company), llm: llmStatus(), storage: repo.kind });

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
