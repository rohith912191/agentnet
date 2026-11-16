// Regression test for the end-to-end demonstration: runs demo/run-demo.js exactly as a user would
// and checks the outcome the brief asks for, plus the delivery and safety summary. It runs on the
// in-memory repository and on PostgreSQL (the embedded engine; the Docker server too when
// AGENTNET_TEST_DATABASE_URL points at one).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresAvailable, testDatabaseUrl } from './support/repositories.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasPglite = await import('@electric-sql/pglite-pgvector').then(() => true, () => false);
const hasServer = await postgresAvailable();

function runDemo(env) {
  const run = spawnSync(process.execPath, ['demo/run-demo.js'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, AGENTNET_LLM: 'none', NODE_ENV: 'test', AGENTNET_DATABASE_URL: '', AGENTNET_DEMO_STORAGE: '', ...env },
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

function assertBrief(out) {
  const scenario1 = out.slice(out.indexOf('[1] Swiggy posts'), out.indexOf('[2] '));
  assert.match(scenario1, /PhonePe\s+0\.90\s+PUSH/);
  assert.match(scenario1, /HDFC Bank\s+0\.69\s+PUSH/);
  assert.match(scenario1, /Bajaj Auto: not a candidate/);
  const flat = scenario1.replace(/\s+/g, ' ');
  assert.ok(flat.includes('Extra ₹50 cashback when you pay for Swiggy orders with PhonePe UPI on Diwali'), 'PhonePe replies as in the brief');

  assert.match(out, /webhooks delivered \d+, failed 0/);
  assert.match(out, /Prompt-injection post from QuickDeals -> status "quarantined"/);
  assert.match(out, /Forged webhook sent straight to PhonePe's endpoint -> HTTP 401/);
  assert.match(out, /Suspended agent tries to post again -> HTTP 403/);
}

test('the end-to-end demo still reproduces the brief: Swiggy reaches PhonePe and HDFC Bank, not Bajaj Auto', () => {
  const out = runDemo({});
  assert.match(out, /storage: in memory/);
  assertBrief(out);
});

test('with the LLM switched on but no credentials, the demo still reproduces the brief and says the LLM was unavailable', () => {
  const env = { AGENTNET_LLM: 'claude' };
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const out = runDemo(env);
    assert.match(out, /LLM stages: on \(claude-opus-5-5\)/);
    assertBrief(out);
    assert.match(out, /LLM unavailable: invalid or missing credentials; deterministic policies used/);
  } finally {
    if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
  }
});

test('local stack (npm run local): the running agents respond to the brief’s post by themselves', async () => {
  const child = spawn(process.execPath, ['demo/local-stack.js'], {
    cwd: root,
    env: { ...process.env, PORT: '0', AGENTNET_LLM: 'none', NODE_ENV: 'test', AGENTNET_DATABASE_URL: '', AGENTNET_ADMIN_KEY: 'test-admin-key-0123456789' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let output = '';
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`local stack did not start:\n${output}`)), 30_000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const ready = output.split('\n').find((l) => l.includes('"local stack ready"'));
        if (ready) {
          clearTimeout(timer);
          resolve(JSON.parse(ready).port);
        }
      });
      child.once('exit', (code) => reject(new Error(`local stack exited (${code}):\n${output}`)));
    });
    const base = `http://127.0.0.1:${port}`;
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const local = await (await fetch(`${base}/local/agents`)).json();
    assert.equal(local.agents.length, 7);
    assert.equal(local.llm, 'off');
    const swiggy = local.agents.find((a) => a.company === 'Swiggy');
    const as = (agent) => ({ authorization: `Bearer ${agent.apiKey}`, 'content-type': 'application/json' });

    const posted = await fetch(`${base}/v1/posts`, {
      method: 'POST',
      headers: as(swiggy),
      body: JSON.stringify({ type: 'offer', title: 'Diwali offer: 5% off all deliveries', body: 'Swiggy is giving 5% off on all food delivery orders across India during Diwali week. Partners are welcome to stack extra offers on top.' }),
    });
    assert.equal(posted.status, 202);
    const post = await posted.json();

    // Nobody but the agents themselves acts from here: wait for their comments.
    let comments = [];
    for (let i = 0; i < 100 && comments.filter((c) => !c.reply_to).length < 2; i++) {
      await new Promise((r) => setTimeout(r, 100));
      comments = (await (await fetch(`${base}/v1/posts/${post.id}/comments`, { headers: as(swiggy) })).json()).comments;
    }
    const byCompany = (name) => comments.find((c) => c.author.company === name && !c.reply_to);
    assert.match(byCompany('PhonePe')?.body ?? '', /Extra ₹50 cashback when you pay for Swiggy orders with PhonePe UPI on Diwali/);
    assert.ok(byCompany('HDFC Bank'), 'HDFC Bank responds');
    assert.equal(byCompany('Bajaj Auto'), undefined, 'Bajaj Auto is not notified, so it does not respond');

    const routing = await (await fetch(`${base}/v1/admin/posts/${post.id}/routing`, { headers: { 'x-admin-key': 'test-admin-key-0123456789' } })).json();
    assert.equal(routing.decisions.find((d) => d.company === 'Bajaj Auto'), undefined);
  } finally {
    child.kill();
  }
});

test('the demo reproduces the brief on PostgreSQL + pgvector (embedded engine)', { skip: !hasPglite && 'PGlite not installed' }, () => {
  const out = runDemo({ AGENTNET_DEMO_STORAGE: 'pglite' });
  assert.match(out, /storage: PostgreSQL \(embedded PGlite engine\)/);
  assertBrief(out);
});

test('the demo reproduces the brief on a PostgreSQL server', { skip: !hasServer && `no PostgreSQL server at ${testDatabaseUrl()}` }, () => {
  const out = runDemo({ AGENTNET_DATABASE_URL: testDatabaseUrl() });
  assert.match(out, /storage: PostgreSQL\b/);
  assertBrief(out);
});
