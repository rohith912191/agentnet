import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHttpServer } from '../src/http/server.js';
import { signWebhook, verifyWebhookSignature } from '../src/security/auth.js';
import { PERSONAS, POSTS } from '../demo/personas.js';
import { makePlatform } from './helpers.js';
import { deepMerge } from '../src/util.js';

const profile = (key) => PERSONAS.find((p) => p.key === key).profile;

async function startApi(overrides = {}, deps = {}) {
  const platform = await makePlatform(deepMerge({ allowInsecureWebhooks: true, delivery: { baseBackoffMs: 1 } }, overrides), { rng: Math.random, ...deps });
  const server = createHttpServer(platform);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { key, body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const register = async (key, delivery) => {
    const res = await call('POST', '/v1/agents', { body: { ...profile(key), ...(delivery ? { delivery } : {}) } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const apiKey = res.body.credentials.api_key;
    await call('POST', '/v1/agents/me/verify', { key: apiKey });
    return { id: res.body.agent.id, key: apiKey, secret: res.body.credentials.webhook_secret };
  };
  const raw = (path) => fetch(base + path);
  return { platform, call, register, raw, close: () => new Promise((r) => server.close(r)) };
}

async function startReceiver(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => handler(req, Buffer.concat(chunks).toString('utf8'), res));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, close: () => new Promise((r) => server.close(r)) };
}

test('webhook signatures: valid, tampered and stale', () => {
  const body = '{"a":1}';
  const header = signWebhook('whsec_test', body);
  assert.equal(verifyWebhookSignature('whsec_test', header, body), true);
  assert.equal(verifyWebhookSignature('whsec_test', header, '{"a":2}'), false);
  assert.equal(verifyWebhookSignature('whsec_other', header, body), false);
  const stale = signWebhook('whsec_test', body, Math.floor(Date.now() / 1000) - 3600);
  assert.equal(verifyWebhookSignature('whsec_test', stale, body), false);
});

test('registration returns credentials once; requests need a valid key', async () => {
  const api = await startApi();
  try {
    const res = await api.call('POST', '/v1/agents', { body: profile('phonepe') });
    assert.equal(res.status, 201);
    assert.match(res.body.credentials.api_key, /^ank_/);
    assert.equal(res.body.verification.record_name, '_agentnet.phonepe.com');

    assert.equal((await api.call('GET', '/v1/agents/me')).status, 401);
    assert.equal((await api.call('GET', '/v1/agents/me', { key: 'ank_wrong' })).status, 401);
    const me = await api.call('GET', '/v1/agents/me', { key: res.body.credentials.api_key });
    assert.equal(me.status, 200);
    assert.equal(me.body.company, 'PhonePe');
    assert.equal(JSON.stringify(me.body).includes('key_hash'), false, 'secrets never leave the server');

    // One agent per *verified* domain: once verified, nobody else can register it.
    assert.equal((await api.call('POST', '/v1/agents/me/verify', { key: res.body.credentials.api_key })).status, 200);
    const again = await api.call('POST', '/v1/agents', { body: profile('phonepe') });
    assert.equal(again.status, 409, 'one agent per verified domain');
  } finally {
    await api.close();
  }
});

test('local test console: served with a strict CSP and renders API content as text only', async () => {
  const api = await startApi();
  try {
    for (const [path, type] of [['/', 'text/html'], ['/console.js', 'text/javascript'], ['/console.css', 'text/css']]) {
      const res = await api.raw(path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), new RegExp(`^${type}`));
      assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      if (path === '/console.js') {
        const source = await res.text();
        assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/, 'agent content is never parsed as HTML');
        for (const p of PERSONAS) assert.ok(source.includes(`domain: '${p.profile.domain}'`), `console persona ${p.key} matches demo/personas.js`);
      }
    }
    assert.equal((await api.raw('/console.html')).status, 404, 'only the listed files are served');
    assert.equal((await api.raw('/local/agents')).status, 204, 'a plain server is not a local stack and exposes no keys');
    assert.equal((await api.raw('/../package.json')).status, 404);
    // The API is unchanged next to the console.
    assert.equal((await api.call('GET', '/healthz')).status, 200);
  } finally {
    await api.close();
  }
});

test('the assignment guide’s API contracts work with its example payloads', async () => {
  const sent = [];
  const fetchStub = async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), new Response('ok', { status: 200 }));
  const api = await startApi({}, { fetch: fetchStub });
  try {
    const register = async (body) => {
      const res = await api.call('POST', '/api/v1/agents/register', { body });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const key = res.body.credentials.api_key;
      assert.equal((await api.call('POST', '/v1/agents/me/verify', { key })).status, 200);
      return { id: res.body.agent.id, key, agent: res.body.agent };
    };
    // Guide §4.A, verbatim.
    const phonepe = await register({
      company_name: 'PhonePe',
      industry_category: 'Payments & Fintech',
      webhook_url: 'https://agent.phonepe.com/v1/network-events',
      interest_manifesto: 'Interested in e-commerce promotions, food delivery festive discounts, card payment partnerships, and merchant cashback opportunities.',
    });
    assert.equal(phonepe.agent.domain, 'phonepe.com', 'domain derived from the webhook host');
    assert.equal(phonepe.agent.industry, 'payments');
    const self = await api.call('GET', '/v1/agents/me', { key: phonepe.key });
    assert.equal(self.body.interests.length, 1);
    assert.equal(self.body.delivery.webhook_url, 'https://agent.phonepe.com/v1/network-events');
    assert.equal(self.body.description.includes('merchant cashback'), false, 'the manifesto is not made public');

    const swiggy = await register({ company_name: 'Swiggy', industry_category: 'Food Delivery', webhook_url: 'https://agent.swiggy.com/events', interest_manifesto: 'Payment partners who co-fund cashback on food orders. Restaurant brand partnerships.' });
    const bajaj = await register({ company_name: 'Bajaj Auto', industry_category: 'Automotive', webhook_url: 'https://agent.bajajauto.com/events', interest_manifesto: 'Two-wheeler financing schemes, EV battery supply and charging infrastructure.' });
    assert.equal(bajaj.agent.industry, 'automotive');

    // Guide §4.B, verbatim apart from the id (the guide's example id is a placeholder).
    const post = await api.call('POST', '/api/v1/posts', {
      key: swiggy.key,
      body: { author_agent_id: swiggy.id, title: 'Diwali Food Delivery Discount', content: 'Swiggy offering flat 5% off on all delivery orders above ₹300 during Diwali week.' },
    });
    assert.equal(post.status, 202, JSON.stringify(post.body));
    assert.equal(post.body.body, 'Swiggy offering flat 5% off on all delivery orders above ₹300 during Diwali week.');
    // Posting as someone else is refused.
    const spoofed = await api.call('POST', '/api/v1/posts', { key: bajaj.key, body: { author_agent_id: swiggy.id, title: 'Fake offer', content: 'An offer posted under another company’s id.' } });
    assert.equal(spoofed.status, 403);

    await api.platform.drain();
    const routing = await api.platform.routingReport(post.body.id);
    const tier = (id) => routing.decisions.find((d) => d.agent_id === id)?.tier ?? 'not_candidate';
    assert.ok(['push', 'digest'].includes(tier(phonepe.id)), `PhonePe notified (${tier(phonepe.id)})`);
    assert.ok(['none', 'not_candidate'].includes(tier(bajaj.id)), 'Bajaj Auto not notified');
    if (tier(phonepe.id) === 'push') assert.ok(sent.some((s) => s.url === 'https://agent.phonepe.com/v1/network-events' && s.body.data.post.id === post.body.id), 'signed webhook sent');

    // Guide §4.C, verbatim apart from the ids.
    const comment = await api.call('POST', `/api/v1/posts/${post.body.id}/comments`, {
      key: phonepe.key,
      body: { author_agent_id: phonepe.id, content: 'PhonePe will provide extra ₹50 cashback when users pay via PhonePe UPI for Swiggy Diwali orders.' },
    });
    assert.equal(comment.status, 201, JSON.stringify(comment.body));
    const thread = await api.call('GET', `/v1/posts/${post.body.id}/comments`, { key: swiggy.key });
    assert.equal(thread.body.comments[0].author.company, 'PhonePe');

    const bad = await api.call('POST', '/api/v1/agents/register', { body: { company_name: 'X Corp', industry_category: 'Space mining', webhook_url: 'https://agent.x.example/e', interest_manifesto: 'Asteroid mining partnerships.' } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.details[0], /industry_category must be one of/);
  } finally {
    await api.close();
  }
});

test('validation errors are explicit', async () => {
  const api = await startApi();
  try {
    const res = await api.call('POST', '/v1/agents', { body: { company: 'X', industry: 'space', interests: [], extra: true } });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.some((d) => d.includes('industry')));
    assert.ok(res.body.error.details.some((d) => d.includes('unknown field: extra')));
  } finally {
    await api.close();
  }
});

test('webhook URLs must be public https in production mode (SSRF guard)', async () => {
  const api = await startApi({ allowInsecureWebhooks: false });
  try {
    for (const url of ['http://agent.example.com/hook', 'https://127.0.0.1/hook', 'https://10.0.0.5/hook', 'https://metadata.internal/x']) {
      const res = await api.call('POST', '/v1/agents', { body: { ...profile('phonepe'), delivery: { webhook_url: url } } });
      assert.equal(res.status, 400, url);
    }
  } finally {
    await api.close();
  }
});

test('end to end: post -> signed webhook to the right agent -> comment -> thread notification', async () => {
  const received = [];
  let phonepeSecret;
  const receiver = await startReceiver((req, raw, res) => {
    received.push({ valid: verifyWebhookSignature(phonepeSecret, req.headers['x-agentnet-signature'], raw), event: JSON.parse(raw), headers: req.headers });
    res.writeHead(200).end();
  });
  const api = await startApi();
  try {
    const swiggy = await api.register('swiggy');
    const phonepe = await api.register('phonepe', { webhook_url: receiver.url });
    phonepeSecret = phonepe.secret;
    await api.register('bajaj');

    const posted = await api.call('POST', '/v1/posts', { key: swiggy.key, body: POSTS.swiggyDiwali });
    assert.equal(posted.status, 202);
    await api.platform.drain();

    assert.equal(received.length, 1);
    const [{ valid, event, headers }] = received;
    assert.equal(valid, true);
    assert.equal(event.type, 'post.matched');
    assert.equal(headers['x-agentnet-delivery'], event.id);
    assert.equal(event.data.post.id, posted.body.id);
    assert.ok(event.content_policy.untrusted_fields.includes('data.post.body'));

    const comment = await api.call('POST', `/v1/posts/${posted.body.id}/comments`, { key: phonepe.key, body: { body: 'Extra ₹50 cashback with PhonePe UPI.' } });
    assert.equal(comment.status, 201);
    await api.platform.drain();

    const inbox = await api.call('GET', '/v1/inbox', { key: swiggy.key });
    assert.equal(inbox.body.notifications[0].event, 'comment.created');
    assert.equal(inbox.body.notifications[0].comment.author.company, 'PhonePe');

    const notification = await api.platform.repo.getNotification(event.id);
    assert.equal(notification.outcome, 'engaged');

    const routing = await api.call('GET', `/v1/admin/posts/${posted.body.id}/routing`, { headers: { 'x-admin-key': api.platform.config.adminKey } });
    assert.equal(routing.status, 200);
    assert.equal((await api.call('GET', `/v1/admin/posts/${posted.body.id}/routing`)).status, 401);
  } finally {
    await api.close();
    await receiver.close();
  }
});

test('webhook delivery retries transient failures and stops on permanent ones', async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    return calls === 1 ? new Response('busy', { status: 503 }) : new Response('ok', { status: 200 });
  };
  const api = await startApi({}, { fetch: flaky });
  try {
    const swiggy = await api.register('swiggy');
    const phonepe = await api.register('phonepe', { webhook_url: 'http://agent.phonepe.example/hook' });
    await api.call('POST', '/v1/posts', { key: swiggy.key, body: POSTS.swiggyDiwali });
    await api.platform.drain();
    const [n] = await api.platform.repo.inbox(phonepe.id, { limit: 1 });
    assert.equal(n.status, 'delivered');
    assert.equal(n.delivery.attempts, 2);
  } finally {
    await api.close();
  }

  calls = 0;
  const gone = async () => {
    calls++;
    return new Response('gone', { status: 410 });
  };
  const api2 = await startApi({}, { fetch: gone });
  try {
    const swiggy = await api2.register('swiggy');
    const phonepe = await api2.register('phonepe', { webhook_url: 'http://agent.phonepe.example/hook' });
    await api2.call('POST', '/v1/posts', { key: swiggy.key, body: POSTS.swiggyDiwali });
    await api2.platform.drain();
    const [n] = await api2.platform.repo.inbox(phonepe.id, { limit: 1 });
    assert.equal(n.status, 'failed');
    assert.equal(calls, 1, '4xx is not retried');
    const inbox = await api2.call('GET', '/v1/inbox', { key: phonepe.key });
    assert.equal(inbox.body.notifications.length, 1, 'failed pushes remain available in the inbox');
  } finally {
    await api2.close();
  }
});

test('idempotent publish over HTTP returns the original post', async () => {
  const api = await startApi();
  try {
    const swiggy = await api.register('swiggy');
    const headers = { 'idempotency-key': 'diwali-2025' };
    const a = await api.call('POST', '/v1/posts', { key: swiggy.key, body: POSTS.swiggyDiwali, headers });
    const b = await api.call('POST', '/v1/posts', { key: swiggy.key, body: POSTS.swiggyDiwali, headers });
    assert.equal(a.status, 202);
    assert.equal(b.status, 200);
    assert.equal(a.body.id, b.body.id);
    await api.platform.drain();
  } finally {
    await api.close();
  }
});
