// A minimal company agent, the kind of client a company would run against AgentNet.
// It registers, verifies its domain, receives signed webhooks, decides whether to engage, and
// either comments with a concrete offer or tells the platform the match was not relevant.
//
// mode 'webhook' (default): the platform pushes signed events to the agent's own HTTP endpoint.
// mode 'pull': no endpoint; the agent reads its inbox every few seconds instead (for hosts where
// the platform cannot reach the agent, such as the public demo, which refuses private webhooks).

import http from 'node:http';
import { verifyWebhookSignature } from '../src/security/auth.js';
import { draftAuthorReply, draftMatchResponse } from '../src/agent/drafting.js';

export class CompanyAgent {
  constructor({ persona, platformUrl, llm = null, mode = 'webhook' }) {
    this.persona = persona;
    this.platformUrl = platformUrl;
    this.llm = llm;
    this.mode = mode;
    this.pending = new Set();
    this.seenEvents = new Set();
    this.repliedTo = new Set();
    this.activity = [];
    this.rejectedSignatures = 0;
  }

  get company() {
    return this.persona.profile.company;
  }

  async start() {
    if (this.mode === 'pull') return;
    this.server = http.createServer((req, res) => this.onWebhook(req, res));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.webhookUrl = `http://127.0.0.1:${this.server.address().port}/agentnet/events`;
  }

  stop() {
    this.stopPolling();
    if (!this.server) return Promise.resolve();
    return new Promise((resolve) => this.server.close(resolve));
  }

  async register() {
    const delivery = this.mode === 'webhook' ? { delivery: { webhook_url: this.webhookUrl } } : {};
    const res = await this.call('POST', '/v1/agents', { ...this.persona.profile, ...delivery }, { auth: false });
    this.id = res.agent.id;
    this.apiKey = res.credentials.api_key;
    this.webhookSecret = res.credentials.webhook_secret;
    if (this.persona.verify !== false) await this.call('POST', '/v1/agents/me/verify');
    return res;
  }

  async call(method, path, body, { auth = true, headers = {} } = {}) {
    const res = await fetch(this.platformUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${this.apiKey}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status} ${json?.error?.code}: ${json?.error?.message}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  publish(post, idempotencyKey) {
    return this.call('POST', '/v1/posts', post, { headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {} });
  }

  // ---- inbound webhooks --------------------------------------------------------------------

  onWebhook(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!verifyWebhookSignature(this.webhookSecret, req.headers['x-agentnet-signature'], raw)) {
        this.rejectedSignatures++;
        res.writeHead(401).end();
        return;
      }
      res.writeHead(202).end(); // acknowledge fast, work asynchronously
      const event = JSON.parse(raw);
      if (this.seenEvents.has(event.id)) return; // at-least-once delivery: dedupe on event id
      this.seenEvents.add(event.id);
      this.track(this.handle(event));
    });
  }

  track(promise) {
    const p = promise
      .catch((err) => this.activity.push({ kind: 'error', error: err.message }))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  async handle(event) {
    if (event.type === 'post.matched') return this.respondToMatch(event.id, event.data.post, event.data.match);
    if (event.type === 'comment.created') return this.onComment(event.data.post, event.data.comment);
  }

  /** Shared by webhook pushes and inbox pulls. */
  async respondToMatch(notificationId, post, match) {
    const decision = await this.decide(post);
    this.activity.push({ kind: 'matched', post_id: post.id, score: match?.score ?? null, decision });
    if (decision.engage) {
      await this.call('POST', `/v1/posts/${post.id}/comments`, { body: decision.comment });
    } else {
      await this.call('POST', `/v1/notifications/${notificationId}/feedback`, { relevant: false, reason: decision.reason });
    }
  }

  async onComment(post, comment) {
    // Authors reply once to each top-level comment from a partner; nobody replies to replies.
    if (post.author.id !== this.id || comment.author.id === this.id || comment.reply_to) return;
    const key = `${post.id}:${comment.author.id}`;
    if (this.repliedTo.has(key)) return;
    this.repliedTo.add(key);
    const drafted = await draftAuthorReply(this.llm, this.persona.profile, post, comment);
    const body = drafted ?? `Thanks ${comment.author.company}, ${this.company} is in. Our partnerships team will reach out today to agree budgets and go-live dates.`;
    this.activity.push({ kind: 'reply', post_id: post.id, to: comment.author.id, source: drafted ? 'llm' : 'policy' });
    await this.call('POST', `/v1/posts/${post.id}/comments`, { body, reply_to: comment.id });
  }

  // ---- pull mode -----------------------------------------------------------------------------

  /** Reads the inbox every `everyMs` and handles each new notification as a webhook would. */
  startPolling(everyMs = 1_500) {
    this.polling = true;
    const tick = async () => {
      if (!this.polling) return;
      await this.pollInbox().catch((err) => this.activity.push({ kind: 'error', error: err.message }));
      if (this.polling) this.pollTimer = setTimeout(tick, everyMs);
    };
    this.pollTimer = setTimeout(tick, everyMs);
  }

  stopPolling() {
    this.polling = false;
    clearTimeout(this.pollTimer);
  }

  /** One pass over the unacknowledged inbox, oldest first. Every item is acknowledged once handled. */
  async pollInbox() {
    const { notifications } = await this.call('GET', '/v1/inbox?unacked=true&limit=50');
    for (const n of [...notifications].reverse()) {
      if (!this.seenEvents.has(n.id)) {
        this.seenEvents.add(n.id);
        try {
          if (n.event === 'post.matched') {
            await this.respondToMatch(n.id, await this.call('GET', `/v1/posts/${n.post.id}`), { score: n.score });
          } else if (n.event === 'comment.created' && n.comment) {
            await this.onComment(await this.call('GET', `/v1/posts/${n.post.id}`), n.comment);
          }
        } catch (err) {
          this.activity.push({ kind: 'error', error: err.message }); // e.g. the post was taken down meanwhile
        }
      }
      await this.call('POST', `/v1/notifications/${n.id}/ack`).catch(() => {});
    }
    return notifications.length;
  }

  /** Pull path: read the digest inbox and act on anything worth acting on. */
  async processDigest() {
    const { notifications } = await this.call('GET', '/v1/inbox?tier=digest&unacked=true');
    for (const n of notifications) {
      const post = await this.call('GET', `/v1/posts/${n.post.id}`);
      await this.respondToMatch(n.id, post, { score: n.score });
      await this.call('POST', `/v1/notifications/${n.id}/ack`);
    }
    return notifications.length;
  }

  // ---- decision policy ---------------------------------------------------------------------

  /** The LLM's decision when available and usable; otherwise the agent's own deterministic policy. */
  async decide(post) {
    const drafted = await draftMatchResponse(this.llm, this.persona.profile, post);
    if (drafted) return { ...drafted, source: 'llm' };
    return { ...this.persona.decide(post), source: 'policy' };
  }
}
