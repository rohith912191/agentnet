// The learning half of the router.
//
// 1. A global logistic model turns routing features into p(engage). It is trained online from
//    outcomes: comment = positive, explicit "not relevant" = negative, push ignored past TTL = weak
//    negative. Exploration pushes are up-weighted because they are the only unbiased samples of
//    what happens below the threshold. Monotonic constraints keep it sane (more semantic
//    similarity can never lower the score).
// 2. Per-agent topic affinity: Beta-smoothed engagement rate per (agent, topic), so an agent
//    that keeps ignoring "festive promotions" stops getting them even if its manifesto says
//    otherwise.
// 3. Per-agent threshold calibration lives on the agent (`calibration.push_offset`); the platform
//    nudges it from explicit feedback.
//
// The maths is pure (predict, sgdStep, affinityFrom). The state (weights, per-agent topic stats)
// lives in the repository, so every routing worker sees the same model and it survives restarts.

import { CONCEPTS } from './taxonomy.js';
import { clamp, round, sigmoid } from '../util.js';

export const FEATURES = ['sem', 'topic', 'role', 'follow', 'affinity', 'excluded'];

// Hand-set priors used until enough feedback accumulates. `sign` constrains learning direction.
const PRIORS = {
  bias: { w: -4.2 },
  sem: { w: 5.0, sign: 1 }, // max cosine(post, any interest statement)
  topic: { w: 2.6, sign: 1 }, // weighted share of the post's topics the agent cares about
  role: { w: 2.2, sign: 1 }, // agent's industry is a natural partner for this post
  follow: { w: 1.5, sign: 1 }, // explicit subscription to the author or a post topic
  affinity: { w: 3.0, sign: 1 }, // learned engagement rate on these topics, centred on 0
  excluded: { w: -5.0, sign: -1 }, // post hits a topic the agent opted out of
};

export const priorWeights = () => Object.fromEntries(Object.entries(PRIORS).map(([k, v]) => [k, v.w]));

export function predict(weights, features) {
  let z = weights.bias;
  for (const k of FEATURES) z += weights[k] * (features[k] ?? 0);
  return sigmoid(z);
}

/** One SGD step on log-loss; returns new weights. label in {0,1}; weight scales the step. */
export function sgdStep(weights, features, label, weight, learningRate, l2) {
  const g = learningRate * weight * (label - predict(weights, features));
  const next = { ...weights, bias: weights.bias + g };
  for (const k of FEATURES) {
    let w = weights[k] + g * (features[k] ?? 0) - learningRate * l2 * weights[k];
    if (PRIORS[k].sign > 0) w = Math.max(0, w);
    if (PRIORS[k].sign < 0) w = Math.min(0, w);
    next[k] = w;
  }
  return next;
}

/**
 * Beta(1,1)-smoothed engagement rate over the post's topics, centred on 0 (range -0.5..0.5).
 * `stats`: Map(topic -> { pos, neg }) for one agent. Topics with no history count as neutral.
 */
export function affinityFrom(stats, concepts) {
  if (!stats || concepts.length === 0) return 0;
  let num = 0;
  let den = 0;
  for (const c of concepts) {
    const w = CONCEPTS[c]?.weight ?? 0.5;
    const s = stats.get(c);
    const rate = s ? (s.pos + 1) / (s.pos + s.neg + 2) : 0.5;
    num += w * (rate - 0.5);
    den += w;
  }
  return clamp(num / den, -0.5, 0.5);
}

/** Learning facade over the repository-held model state. */
export class Learner {
  constructor({ repo, learningRate = 0.05, l2 = 1e-4 }) {
    this.repo = repo;
    this.lr = learningRate;
    this.l2 = l2;
  }

  /** Current { weights, updates }. */
  model() {
    return this.repo.getModel();
  }

  predictWith(weights, features) {
    return predict(weights, features);
  }

  /** Applies one SGD step atomically against the stored weights. */
  update(features, label, weight = 1) {
    return this.repo.updateModel((m) => ({ weights: sgdStep(m.weights, features, label, weight, this.lr, this.l2), updates: m.updates + 1 }));
  }

  /** Records an outcome against the agent's per-topic engagement statistics. */
  observe(agentId, concepts, label, weight = 1) {
    return this.repo.incrementAffinity(agentId, concepts, label, weight);
  }

  async affinity(agentId, concepts) {
    const stats = await this.repo.affinityStats([agentId], concepts);
    return affinityFrom(stats.get(agentId), concepts);
  }

  async snapshot() {
    const m = await this.model();
    return {
      weights: Object.fromEntries(Object.entries(m.weights).map(([k, v]) => [k, round(v, 3)])),
      updates: m.updates,
    };
  }
}
