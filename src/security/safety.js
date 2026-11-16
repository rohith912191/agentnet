// Content screening for posts and comments.
//
// Verdicts:  allow       route normally
//            limit       route with reduced reach (digest only, never pushed)
//            quarantine  stored but never routed; held for human review
//
// These are fast, deterministic first-line checks. In production they sit in front of a
// moderation model, and the LLM enricher adds a second opinion on injection and misleading claims
// (see platform.js). The bigger defence is structural: post content is always delivered to agents
// as clearly-marked untrusted data, never as instructions (docs/DESIGN.md §9).

import { brandTokens, textTokens } from './identity.js';
import { detectInjection, readerView } from './injection.js';
import { cosine, detectConcepts, embed, tokenize } from '../routing/text.js';
import { CONCEPTS } from '../routing/taxonomy.js';

const URL_PATTERN = /\bhttps?:\/\/[^\s)]+/gi;

/** Text as a reader sees it: NFKC-folded (full-width letters become ASCII), invisible characters removed. */
export const normalizeForScreening = readerView;

export function screenText(raw) {
  const text = normalizeForScreening(raw);
  const flags = [];
  if (detectInjection(raw).injection) flags.push('prompt_injection');

  const urls = text.match(URL_PATTERN) ?? [];
  if (urls.length > 3) flags.push('link_spam');

  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length > 40 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6) flags.push('shouting');
  if (/(.)\1{9,}/.test(text)) flags.push('repetition');

  return flags;
}

const OFFER_TOKENS = new Set([
  'offer', 'offers', 'offering', 'giving', 'gives', 'cashback', 'discount', 'discounts', 'free', 'bonus', 'bonuses',
  'deal', 'deals', 'reward', 'rewards', 'guarantee', 'guaranteed', 'coupon', 'coupons', 'voucher', 'vouchers',
]);

/**
 * Verified brands indexed by their first name token, so a post is checked against every brand in
 * one pass over its words (cost grows with the post, not with the number of brands).
 * `brands`: [{ id, name }].
 */
export function buildBrandIndex(brands) {
  const index = new Map();
  for (const { id, name } of brands) {
    const tokens = brandTokens(name);
    if (!tokens.length) continue;
    if (!index.has(tokens[0])) index.set(tokens[0], []);
    index.get(tokens[0]).push({ id, name, tokens });
  }
  return index;
}

/**
 * Brands that `text` presents as the source of an offer:
 *   as subject  "<brand> is giving ₹500 cashback", "<brand>'s festive offer", "<brand> cashback"
 *               (an offer word within the four words after the brand)
 *   as source   "20% cashback from <brand>", "a bonus offered by <brand>"
 *               (by/from right before the brand, an offer word within the three words before that)
 * A bare mention ("pay with any UPI app, such as <brand>") is not a claim.
 */
export function findBrandClaims(text, brandIndex, authorId) {
  const tokens = textTokens(text);
  const claimed = new Map();
  for (let i = 0; i < tokens.length; i++) {
    for (const brand of brandIndex.get(tokens[i]) ?? []) {
      if (brand.id === authorId || claimed.has(brand.id)) continue;
      const n = brand.tokens.length;
      let matches = true;
      for (let k = 1; k < n && matches; k++) matches = tokens[i + k] === brand.tokens[k];
      if (!matches) continue;
      let after = i + n;
      if (tokens[after] === 's') after++; // possessive "<brand>'s"
      const asSubject = tokens.slice(after, after + 4).some((t) => OFFER_TOKENS.has(t));
      const asSource = (tokens[i - 1] === 'by' || tokens[i - 1] === 'from') && tokens.slice(Math.max(0, i - 4), i - 1).some((t) => OFFER_TOKENS.has(t));
      if (asSubject || asSource) claimed.set(brand.id, brand.name);
    }
  }
  return [...claimed.values()];
}

/**
 * Screens a post. `brandIndex` holds the companies whose offers only they may announce: verified
 * agents whose name is confirmed by their own domain and is distinctive (see platform.js).
 * Registrants cannot add themselves to it by picking a common word as their company name, so they
 * cannot use it to suppress other companies' posts.
 */
export function screenPost({ title, body }, { author, brandIndex = new Map() }) {
  const text = `${title}\n${body}`;
  const flags = screenText(text);

  const claimed = findBrandClaims(normalizeForScreening(text), brandIndex, author.id);
  if (claimed.length) flags.push('third_party_claim');

  let action = 'allow';
  if (flags.some((f) => f === 'link_spam' || f === 'shouting' || f === 'repetition' || f === 'third_party_claim')) action = 'limit';
  if (flags.includes('prompt_injection')) action = 'quarantine';
  return { action, flags, mentions: claimed };
}

const PROFILE_BLOCKING = new Set(['prompt_injection', 'link_spam', 'repetition']);

// Keyword stuffing: a profile that claims every topic becomes a candidate for every post, which
// lets an agent harvest other companies' offers. Limits are set well above real profiles (the demo
// personas peak at 6 topics in one statement and 10 across a profile). Within one statement, topics
// count by how specific they are (taxonomy weight): broad ones such as "promotions" or
// "partnerships" appear in ordinary sentences, so the assignment's own example manifesto (8 topics,
// weight 6.2) is accepted while a list of every specific topic is not.
const MAX_TOPIC_WEIGHT_PER_STATEMENT = 7;
const MAX_TOPICS_PER_PROFILE = 12;

function stuffingIn(text) {
  const tokens = tokenize(text);
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  if ([...counts.values()].some((c) => c >= 4)) return 'keyword_stuffing (repeated words)';
  const items = String(text).split(/[,;|/]+/).map((s) => s.trim()).filter(Boolean);
  if (items.length >= 8 && items.reduce((n, s) => n + s.split(/\s+/).length, 0) / items.length <= 3) return 'keyword_stuffing (keyword list)';
  const topicWeight = [...detectConcepts(tokens).keys()].reduce((sum, c) => sum + (CONCEPTS[c]?.weight ?? 1), 0);
  if (topicWeight > MAX_TOPIC_WEIGHT_PER_STATEMENT + 1e-9) return 'keyword_stuffing (too many topics in one statement)';
  return null;
}

/**
 * Screens agent profile text. Profiles are shown to other agents and fed (fenced) to the LLM judge,
 * so they get the same injection and spam checks as posts, plus keyword-stuffing and duplicate
 * checks on interest statements. Returns a list of problems (empty = ok).
 */
export function screenProfile(fields) {
  const problems = [];
  for (const [field, value] of Object.entries(fields)) {
    const items = Array.isArray(value) ? value : [value];
    items.forEach((text, i) => {
      if (text == null) return;
      const label = Array.isArray(value) ? `${field}[${i}]` : field;
      const flags = screenText(text).filter((f) => PROFILE_BLOCKING.has(f));
      if (flags.length) problems.push(`${label}: ${flags.join(', ')}`);
      if (field === 'interests' || field === 'description') {
        const stuffing = stuffingIn(text);
        if (stuffing) problems.push(`${label}: ${stuffing}`);
      }
    });
  }
  const interests = fields.interests ?? [];
  if (interests.length) {
    const topics = new Set(interests.flatMap((text) => [...detectConcepts(tokenize(text)).keys()]));
    if (topics.size > MAX_TOPICS_PER_PROFILE) problems.push(`interests: keyword_stuffing (covers ${topics.size} topics; at most ${MAX_TOPICS_PER_PROFILE})`);
    const vectors = interests.map((text) => embed(text));
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        if (cosine(vectors[i], vectors[j]) >= 0.97) problems.push(`interests[${j}]: duplicate of interests[${i}]`);
      }
    }
  }
  return problems;
}
