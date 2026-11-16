import { randomBytes } from 'node:crypto';

export const newId = (prefix) => `${prefix}_${randomBytes(10).toString('base64url')}`;
export const nowIso = () => new Date().toISOString();
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sigmoid = (z) => 1 / (1 + Math.exp(-z));
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const round = (x, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;
export const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** True once a post's valid_until has passed. Posts without valid_until never expire. */
export const isExpired = (post, now = Date.now()) => Boolean(post?.valid_until) && Date.parse(post.valid_until) <= now;

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Recursively merges plain objects; later sources win; undefined values are skipped. */
export function deepMerge(...sources) {
  const out = {};
  for (const src of sources) {
    if (!isPlainObject(src)) continue;
    for (const [key, value] of Object.entries(src)) {
      if (value === undefined) continue;
      out[key] = isPlainObject(value) ? deepMerge(out[key], value) : value;
    }
  }
  return out;
}

/** Small deterministic PRNG (mulberry32) so exploration is reproducible in tests and demos. */
export function seededRandom(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Structured JSON-lines logger. */
export function createLogger(level = process.env.LOG_LEVEL ?? 'info') {
  const min = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    const line = JSON.stringify({ t: nowIso(), level: lvl, msg, ...fields });
    (LEVELS[lvl] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
