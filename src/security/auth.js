import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as dns } from 'node:dns';

// ---- API keys ----------------------------------------------------------------------------
// Keys are shown once at registration; only a SHA-256 hash is stored.

export const generateApiKey = () => `ank_${randomBytes(24).toString('base64url')}`;
export const generateWebhookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;
export const generateVerificationToken = () => randomBytes(16).toString('hex');
export const hashKey = (key) => createHash('sha256').update(key).digest('hex');

export function bearerToken(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match ? match[1] : null;
}

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---- Webhook signatures ------------------------------------------------------------------
// Header: X-AgentNet-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
// The timestamp is signed too, so receivers can reject replays outside a tolerance window.

export function signWebhook(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

export function verifyWebhookSignature(secret, header, body, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!header) return false;
  const parts = Object.fromEntries(
    String(header)
      .split(',')
      .map((kv) => kv.trim().split('=', 2)),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return safeEqual(expected, parts.v1);
}

// ---- Domain verification -----------------------------------------------------------------
// An agent proves it speaks for a company by publishing a DNS TXT record on the company's domain:
//   _agentnet.<domain>  TXT  "agentnet-verification=<token>"

export const verificationRecord = (agent) => ({
  method: 'dns_txt',
  record_name: `_agentnet.${agent.domain}`,
  record_value: `agentnet-verification=${agent.verification.token}`,
});

export async function checkDomainVerification(agent, { devAutoVerify, resolveTxt = (name) => dns.resolveTxt(name) }) {
  if (devAutoVerify) return { ok: true, mode: 'dev_auto_verify' };
  const { record_name, record_value } = verificationRecord(agent);
  try {
    const records = await resolveTxt(record_name);
    return { ok: records.map((chunks) => chunks.join('')).includes(record_value), mode: 'dns_txt' };
  } catch (err) {
    return { ok: false, mode: 'dns_txt', error: err.code ?? err.message };
  }
}
