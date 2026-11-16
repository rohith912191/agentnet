// Claude adapter, used for post enrichment, the borderline relevance judge and agents' replies.
// Enabled with AGENTNET_LLM=claude. Credentials come from the environment (ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile); they are never hard-coded or logged.
//
// Every caller treats this as best-effort: a refusal, a truncated or schema-invalid response, or
// any error returns null and the caller uses its deterministic path. On top of that:
//   - requests carry the SDK timeout and retry limit from config plus the caller's AbortSignal
//     (the platform also wraps this client in guardLlm(): per-call timeouts, per-post deadlines)
//   - responses use structured outputs (output_config.format json_schema) and are validated
//     against the schema again before use
//   - credential and configuration failures (invalid or missing key, no access to the model,
//     billing) pause all calls for llm.authCooldownMs and are logged once, instead of failing
//     (and logging) on every post; transient failures (timeouts, 429, 5xx, network) do not
//   - a policy decline is retried server-side on a fallback model (fallbacks: 'default')

import { validateSchema } from './schema.js';

/** Neutralises tag look-alikes so untrusted text cannot close the <untrusted> fence it sits in. */
export function fence(text) {
  return String(text).replace(/<\/?\s*untrusted[^>]*>/gi, '[removed-tag]');
}

const sdkClient = (options) => import('@anthropic-ai/sdk').then(({ default: Anthropic }) => new Anthropic(options));

// HTTP statuses that mean "this deployment cannot use the API right now": invalid key (401),
// billing (402), no permission (403), unknown model or beta (404).
const CONFIGURATION_STATUSES = new Set([401, 402, 403, 404]);
const TRANSIENT_ERRORS = new Set(['AbortError', 'APIUserAbortError', 'TimeoutError', 'APIConnectionError', 'APIConnectionTimeoutError']);

/** Configuration failure (pause the LLM) vs. a transient one (fall back for this call only). */
export function isConfigurationError(err) {
  if (typeof err?.status === 'number') return CONFIGURATION_STATUSES.has(err.status);
  const name = err?.name !== 'Error' ? err?.name : err?.constructor?.name;
  if (TRANSIENT_ERRORS.has(name) || TRANSIENT_ERRORS.has(err?.constructor?.name)) return false;
  // No HTTP status and not a network/abort error: the client itself could not be set up or could
  // not authenticate (e.g. no credentials at all, SDK missing).
  return true;
}

/**
 * @param clientFactory  optional `(options) => client` (tests inject a fake); defaults to the SDK.
 * @param now            clock (tests)
 */
export function createLlm(config, log, { clientFactory = sdkClient, metrics, now = () => Date.now() } = {}) {
  if (config.llm?.provider !== 'claude') return null;
  const { model, timeoutMs, maxRetries, authCooldownMs = 10 * 60_000 } = config.llm;
  let clientPromise = null;
  let pausedUntil = 0;
  const getClient = () => (clientPromise ??= Promise.resolve().then(() => clientFactory({ timeout: timeoutMs, maxRetries })));

  const pause = (err) => {
    clientPromise = null; // rebuild the client after the pause (credentials may have been fixed)
    pausedUntil = now() + authCooldownMs;
    metrics?.inc('llm_paused_configuration');
    log.error('LLM unavailable (credentials or configuration); using deterministic paths', {
      status: err?.status ?? null,
      type: err?.type ?? err?.constructor?.name ?? null,
      retry_after_ms: authCooldownMs,
    });
  };

  return {
    provider: 'claude',
    model,
    status: () => (now() < pausedUntil ? 'paused' : 'available'),

    /** Returns parsed JSON conforming to `schema`, or null on refusal/failure/timeout/invalid output. */
    async json({ system, prompt, schema, effort = 'low', signal, timeoutMs: callTimeoutMs = timeoutMs, maxTokens = 16000 }) {
      if (now() < pausedUntil) {
        metrics?.inc('llm_skipped_paused');
        return null;
      }
      let response;
      try {
        const client = await getClient();
        if (signal?.aborted) return null; // the caller gave up while the client was loading
        response = await client.beta.messages.create(
          {
            model,
            max_tokens: maxTokens,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default', // a policy decline is retried server-side on a fallback model
            output_config: { effort, format: { type: 'json_schema', schema } },
            system,
            messages: [{ role: 'user', content: prompt }],
          },
          { signal, timeout: callTimeoutMs, maxRetries },
        );
      } catch (err) {
        // Only failures of the request itself are classified here; bad responses are handled below.
        if (signal?.aborted) return null; // our own timeout or deadline: not the API's fault
        if (isConfigurationError(err)) {
          pause(err);
          return null;
        }
        metrics?.inc('llm_call_failures');
        log.warn('llm call failed; falling back to deterministic path', { status: err?.status ?? null, error: err?.message });
        return null;
      }
      return this.readResponse(response, schema, maxTokens);
    },

    /** Turns a response into a validated value, or null (refusal, truncation, malformed JSON, schema). */
    readResponse(response, schema, maxTokens) {
      if (response?.stop_reason === 'refusal') {
        metrics?.inc('llm_refusals');
        log.warn('llm refused', { category: response.stop_details?.category ?? null });
        return null;
      }
      if (response?.stop_reason === 'max_tokens') {
        metrics?.inc('llm_truncated');
        log.warn('llm output truncated; ignoring it', { max_tokens: maxTokens });
        return null;
      }
      let value;
      try {
        const text = (response?.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        value = JSON.parse(text);
      } catch {
        metrics?.inc('llm_invalid_json');
        log.warn('llm output is not valid JSON; ignoring it');
        return null;
      }
      const problems = validateSchema(value, schema);
      if (problems.length) {
        metrics?.inc('llm_schema_violations');
        log.warn('llm output does not match the schema; ignoring it', { problems: problems.slice(0, 5) });
        return null;
      }
      metrics?.inc('llm_calls_ok');
      return value;
    },
  };
}
