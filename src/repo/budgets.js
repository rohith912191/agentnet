// Delivery-budget enforcement at notification insert time, shared by both repositories. The
// repository runs it under its own atomicity (memory: one synchronous step; PostgreSQL: a
// transaction holding per-agent advisory locks), so the counts it sees cannot be changed by a
// concurrent routing of another post before the rows are written.
//
// Rows are processed in the router's order (best match first). Each row carries, not stored:
//   budget     { push, digest }  the agent's hourly push and daily digest budgets
//   requested  true for explicit subscribers (exempt from the post's digest cap, not from budgets)
// A push over the hourly push budget becomes a digest; a digest over the daily digest budget, or
// an unrequested digest over the post's digest cap, is dropped.

export function applyBudgets(rows, usedFor, { maxDigestPerPost = Infinity, isDuplicate = () => false } = {}) {
  const keep = [];
  const adjusted = [];
  let unrequestedDigests = 0;
  for (const { budget, requested, ...n } of rows) {
    if (isDuplicate(n)) continue; // already notified: no budget used
    const used = usedFor(n.agent_id);
    const from = n.tier;
    if (n.tier === 'push' && used.push >= budget.push) n.tier = 'digest';
    if (n.tier === 'digest') {
      const overBudget = used.digest >= budget.digest;
      if (overBudget || (!requested && unrequestedDigests >= maxDigestPerPost)) {
        adjusted.push({ id: n.id, agent_id: n.agent_id, from, to: 'none', capped: overBudget ? 'agent_digest_budget' : 'post_digest_cap' });
        continue;
      }
    }
    if (n.tier !== from) {
      n.exploration = false; // an exploration push that didn't happen isn't one
      adjusted.push({ id: n.id, agent_id: n.agent_id, from, to: n.tier, capped: 'agent_push_budget' });
    }
    used[n.tier]++;
    if (n.tier === 'digest' && !requested) unrequestedDigests++;
    keep.push(n);
  }
  return { keep, adjusted };
}
