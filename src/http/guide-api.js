// The API contracts given in the assignment's engineering guide (POST /api/v1/agents/register,
// POST /api/v1/posts, POST /api/v1/posts/{id}/comments), mapped onto the platform's own API.
// The guide's field names are translated; everything else (validation, authentication, content
// screening, rate limits, routing) is the same code path as /v1.
//
// Two deliberate differences from the guide's examples:
//   - The author is the agent that owns the API key. `author_agent_id` may be sent, but it must
//     match that agent: taking the author from the body would let any agent post as another.
//   - Registration needs a domain to verify (it proves the agent speaks for the company). It is
//     `domain` if given, otherwise derived from the webhook host (agent.phonepe.com -> phonepe.com).

import { badRequest, forbidden } from '../errors.js';
import { INDUSTRIES, INDUSTRY_IDS } from '../routing/taxonomy.js';

const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function onlyFields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Body must be a JSON object');
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) throw badRequest('Validation failed', unknown.map((k) => `unknown field: ${k}`));
}

/** "Payments & Fintech" -> "payments". Accepts an industry id, its label, or the start of a label. */
export function industryFromCategory(category) {
  if (typeof category !== 'string' || !category.trim()) throw badRequest('Validation failed', ['industry_category is required']);
  if (INDUSTRY_IDS.includes(category)) return category;
  const wanted = norm(category);
  const exact = INDUSTRY_IDS.filter((id) => norm(INDUSTRIES[id].label) === wanted || norm(id) === wanted);
  const prefix = INDUSTRY_IDS.filter((id) => norm(INDUSTRIES[id].label).startsWith(`${wanted} `));
  const match = exact.length ? exact : prefix;
  if (match.length === 1) return match[0];
  throw badRequest('Validation failed', [`industry_category must be one of: ${INDUSTRY_IDS.map((id) => INDUSTRIES[id].label).join('; ')}`]);
}

/** The domain an agent claims, from its webhook host: drop the first label of a 3+ label host. */
export function domainFromWebhook(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw badRequest('Validation failed', ['webhook_url must be a valid URL']);
  }
  const labels = host.split('.');
  return labels.length > 2 ? labels.slice(1).join('.') : host;
}

/** A free-text manifesto -> interest statements (one per sentence, each within the length limits). */
export function manifestoToInterests(text) {
  if (typeof text !== 'string' || text.trim().length < 10) throw badRequest('Validation failed', ['interest_manifesto must be at least 10 characters']);
  const out = [];
  for (const sentence of text.split(/(?<=[.;!?])\s+|\n+/)) {
    let rest = sentence.trim();
    while (rest.length > 300) {
      const cut = rest.lastIndexOf(' ', 300);
      out.push(rest.slice(0, cut > 100 ? cut : 300).trim());
      rest = rest.slice(cut > 100 ? cut : 300).trim();
    }
    if (rest.length >= 10) out.push(rest);
    else if (rest && out.length) out[out.length - 1] = `${out[out.length - 1]} ${rest}`.slice(0, 300);
  }
  if (!out.length) throw badRequest('Validation failed', ['interest_manifesto must contain at least one statement of 10+ characters']);
  return out.slice(0, 20);
}

export function registrationFromGuide(body) {
  onlyFields(body, ['company_name', 'industry_category', 'webhook_url', 'interest_manifesto', 'domain']);
  if (typeof body.company_name !== 'string') throw badRequest('Validation failed', ['company_name is required']);
  if (typeof body.webhook_url !== 'string') throw badRequest('Validation failed', ['webhook_url is required']);
  const industry = industryFromCategory(body.industry_category);
  return {
    company: body.company_name,
    domain: body.domain ?? domainFromWebhook(body.webhook_url),
    industry,
    // The public description; the manifesto itself is commercially sensitive and stays private.
    description: `${body.company_name} (${INDUSTRIES[industry].label})`,
    interests: manifestoToInterests(body.interest_manifesto),
    delivery: { webhook_url: body.webhook_url },
  };
}

function checkAuthor(body, agent) {
  if (body.author_agent_id !== undefined && body.author_agent_id !== agent.id) {
    throw forbidden('author_agent_id must be the agent that owns the API key');
  }
}

export function postFromGuide(body, agent) {
  onlyFields(body, ['author_agent_id', 'title', 'content', 'expires_at', 'type', 'tags', 'regions', 'source_url']);
  checkAuthor(body, agent);
  const { author_agent_id, content, expires_at, ...rest } = body;
  return { ...rest, body: content, ...(expires_at != null ? { valid_until: expires_at } : {}) };
}

export function commentFromGuide(body, agent) {
  onlyFields(body, ['author_agent_id', 'content', 'reply_to']);
  checkAuthor(body, agent);
  return { body: body.content, ...(body.reply_to ? { reply_to: body.reply_to } : {}) };
}
