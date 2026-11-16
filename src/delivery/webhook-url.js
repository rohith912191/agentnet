// Webhook URL policy, checked when an agent registers or updates its webhook. This is the first of
// two SSRF checks: it rejects URLs that are obviously internal. The second check runs at send time
// on the resolved addresses (see safe-fetch.js), because a public-looking hostname can still
// resolve to a private address.

import net from 'node:net';
import { isPublicAddress } from '../security/ip.js';

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa', '.corp', '.private'];

/** Returns an error message, or null when the URL is acceptable. */
export function checkWebhookUrl(raw, { allowInsecure = false } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'must be a valid absolute URL';
  }
  if (url.username || url.password) return 'must not embed credentials';
  if (allowInsecure) return ['http:', 'https:'].includes(url.protocol) ? null : 'must use http or https';
  if (url.protocol !== 'https:') return 'must use https';

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (net.isIP(host)) return isPublicAddress(host) ? null : 'must point to a publicly routable address';
  if (host === 'localhost' || !host.includes('.') || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return 'must point to a publicly routable host';
  }
  return null;
}
