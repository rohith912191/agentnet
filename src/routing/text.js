// Text processing and a dependency-free embedding.
//
// `embed()` is a stand-in for a sentence-embedding model (e.g. a hosted embedding API or a local
// bge/e5 model). It hashes words and taxonomy concepts into a fixed-size, L2-normalised vector, so
// cosine similarity rewards both shared vocabulary and shared meaning ("UPI" and "checkout" both
// light up the `payments` concept). Swapping in a real model only changes this file. The
// router depends on `embed(text) -> unit vector` and `cosine(a, b)`.

import { CONCEPTS } from './taxonomy.js';

export const EMBEDDING_DIM = 1024;
const CONCEPT_FEATURE_WEIGHT = 2.0;

const STOPWORDS = new Set(
  `a an the and or but if of for to in on at by with from into onto over under about across
   is are was were be been being am do does did done has have had having this that these those
   it its it's we our ours you your yours they their them he she his her i me my
   as all any each every some such no nor not only own same so than too very just also
   can could will would shall should may might must who whom whose which what when where why how
   up down out per via vs etc here there then once more most other others want wants who're
   during before after above below between both few further again against while until
   get gets got make makes made using use used like within without upon`.split(/\s+/),
);

const TERM_TO_CONCEPTS = new Map();
for (const [id, { terms }] of Object.entries(CONCEPTS)) {
  for (const term of terms) {
    if (!TERM_TO_CONCEPTS.has(term)) TERM_TO_CONCEPTS.set(term, []);
    TERM_TO_CONCEPTS.get(term).push(id);
  }
}

function stem(token) {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length >= 3 && token.endsWith('s') && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

export function tokenize(text) {
  const raw = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = [];
  for (const t of raw) {
    if (/^\d+$/.test(t)) continue; // bare numbers carry no topical signal
    const s = stem(t);
    if (s.length < 2 || STOPWORDS.has(s) || STOPWORDS.has(t)) continue;
    out.push(s);
  }
  return out;
}

/** Map<conceptId, count> for the given tokens. */
export function detectConcepts(tokens) {
  const counts = new Map();
  for (const t of tokens) {
    for (const c of TERM_TO_CONCEPTS.get(t) ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return counts;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function addFeature(vec, key, weight) {
  const h = fnv1a(key);
  vec[h % EMBEDDING_DIM] += (h & 0x80000000 ? -1 : 1) * weight;
}

export function embed(text) {
  const vec = new Float64Array(EMBEDDING_DIM);
  const tokens = tokenize(text);
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const [t, c] of counts) addFeature(vec, `w:${t}`, 1 + Math.log(c));
  for (const [concept, c] of detectConcepts(tokens)) {
    addFeature(vec, `c:${concept}`, CONCEPT_FEATURE_WEIGHT * CONCEPTS[concept].weight * (1 + Math.log(c)));
  }
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** Cosine similarity of two unit vectors, clamped to [0, 1]. */
export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}
