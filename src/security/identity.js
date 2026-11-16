// Company identity. The verified domain is an agent's identity; the company name is a label the
// agent chooses. These helpers decide when that label can be trusted:
//
//   nameKey()            canonical form for comparing names (case, accents, punctuation, look-alike
//                        Cyrillic/Greek letters and corporate suffixes are folded away)
//   nameMatchesDomain()  the name is the brand of the agent's own registrable domain
//                        ("HDFC Bank" <-> hdfcbank.com), so the domain vouches for the name
//   isDistinctiveName()  the name is specific enough to recognise as a brand in post text; common
//                        words ("Diwali", "Weekend") are not, whoever registers them
//
// The registrable-domain logic uses a small built-in subset of the Public Suffix List; production
// should use the full list.

import { CONCEPTS } from '../routing/taxonomy.js';

const CORPORATE_SUFFIXES = new Set([
  'ltd', 'limited', 'pvt', 'private', 'inc', 'incorporated', 'llc', 'llp', 'corp', 'corporation',
  'co', 'company', 'plc', 'gmbh', 'technologies', 'group', 'holdings',
]);

// Public suffixes with two labels (country second-level domains and shared-hosting platforms where
// each customer gets a subdomain). Agents on these share the suffix but not an identity.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'edu.in', 'gov.in', 'res.in',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'com.br', 'com.sg',
  'com.cn', 'co.nz', 'co.za', 'com.mx', 'com.my', 'com.ph',
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com',
  'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'blogspot.com',
  'onrender.com', 'fly.dev', 'glitch.me',
]);

// Latin look-alikes from Cyrillic and Greek, after lower-casing ("HDFC Bаnk" with a Cyrillic а).
const CONFUSABLES = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  ѕ: 's', і: 'i', ї: 'i', ј: 'j', ԁ: 'd', ӏ: 'l', ɡ: 'g', ı: 'i',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
};

// Words too common to identify a company when they appear in a post.
const GENERIC_WORDS = new Set([
  'weekend', 'week', 'today', 'tomorrow', 'daily', 'mega', 'super', 'big', 'best', 'great', 'grand', 'flash',
  'special', 'exclusive', 'limited', 'top', 'smart', 'easy', 'quick', 'fast', 'first', 'prime', 'plus', 'pro',
  'one', 'all', 'more', 'extra', 'store', 'shop', 'mart', 'bazaar', 'india', 'indian', 'online', 'global',
  'digital', 'cash', 'money', 'value', 'save', 'saving', 'price', 'happy', 'season', 'summer', 'winter',
  'monsoon', 'now', 'free', 'gift', 'family', 'home', 'city', 'local', 'express', 'direct', 'select',
  'premium', 'gold', 'silver', 'platinum', 'star', 'max', 'mini', 'hub', 'zone', 'world', 'club', 'point',
  'center', 'centre', 'service', 'solution', 'network', 'agent', 'platform', 'app', 'the', 'and', 'company',
]);
const LEXICON = new Set(Object.values(CONCEPTS).flatMap((c) => c.terms));

function fold(text) {
  const base = String(text).normalize('NFKD').replace(/\p{M}+/gu, '').normalize('NFKC').toLowerCase();
  return [...base].map((ch) => CONFUSABLES[ch] ?? ch).join('');
}

const tokensOf = (text) => fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Folded name tokens without trailing corporate suffixes: "Swiggy Limited" -> ["swiggy"]. */
export function brandTokens(name) {
  const tokens = tokensOf(name);
  while (tokens.length > 1 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens;
}

/** Folded tokens of free text, comparable with brandTokens(). */
export const textTokens = (text) => tokensOf(text);

/** Canonical key for comparing company names: "H.D.F.C. Bank Ltd" and "ＨＤＦＣ Bаnk" both give "hdfcbank". */
export function nameKey(name) {
  return brandTokens(name).join('');
}

/** The registrable domain (eTLD+1), approximated with the built-in suffix subset. */
export function registrableDomain(domain) {
  const labels = String(domain).toLowerCase().replace(/\.$/, '').split('.');
  const suffixLabels = MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 2 : 1;
  return labels.slice(-(suffixLabels + 1)).join('.');
}

/** True when the company name is the brand of the agent's own registrable domain. Subdomains don't count. */
export function nameMatchesDomain(company, domain) {
  const d = String(domain).toLowerCase();
  const registrable = registrableDomain(d);
  if (registrable !== d) return false;
  const key = nameKey(company);
  return key.length >= 2 && key === nameKey(registrable.split('.')[0]);
}

/** True when the name contains at least one token that is not a common word or taxonomy term. */
export function isDistinctiveName(company) {
  if (nameKey(company).length < 4) return false;
  return tokensOf(company).some((t) => {
    const singular = t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t;
    return t.length >= 3 && !GENERIC_WORDS.has(t) && !GENERIC_WORDS.has(singular) && !LEXICON.has(t) && !LEXICON.has(singular);
  });
}

// ---- look-alike domains -------------------------------------------------------------------------

const DIGIT_LOOKALIKES = { 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b' };

/** The brand label of a domain: "offers.hdfcbank.co.in" -> "hdfcbank". */
const brandLabel = (domain) => registrableDomain(domain).split('.')[0];

function editDistance(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Why `domain` might be imitating `brandDomain` (another company's verified domain), or null:
 *   embeds_brand   the brand label plus extra words: hdfcbank-rewards, hdfcbankoffers, myphonepe
 *   typo           one or two edits away (phonepay, hdfcbnak): typosquatting
 *   digit_swap     letters replaced by look-alike digits (ph0nepe, hdfcb4nk)
 * Distinct companies in a numbered series (acme1 / acme2) are not look-alikes.
 */
export function lookalikeReason(domain, brandDomain) {
  const label = fold(brandLabel(domain)).replace(/[^a-z0-9-]/g, '');
  const brand = fold(brandLabel(brandDomain)).replace(/[^a-z0-9-]/g, '');
  if (!label || !brand || label === brand || brand.length < 5) return null;
  const compact = label.replace(/-/g, '');
  const brandCompact = brand.replace(/-/g, '');
  if (compact === brandCompact) return 'embeds_brand'; // hdfc-bank vs hdfcbank
  const letters = (s) => s.replace(/[0-9]/g, '');
  if (/[0-9]/.test(compact) && /[0-9]/.test(brandCompact) && letters(compact) === letters(brandCompact)) return null; // numbered series
  if (compact.replace(/[0-9]/g, (d) => DIGIT_LOOKALIKES[d] ?? d) === brandCompact) return 'digit_swap';
  if (compact.length - brandCompact.length <= 15 && compact.includes(brandCompact)) return 'embeds_brand';
  const cap = brandCompact.length >= 7 ? 2 : 1;
  if (editDistance(compact, brandCompact, cap) <= cap) return 'typo';
  return null;
}

export function describeIdentity(company, domain) {
  return {
    name_key: nameKey(company),
    name_matches_domain: nameMatchesDomain(company, domain),
    distinctive: isDistinctiveName(company),
    name_conflict: false,
  };
}
