// Wraps any LLM client so routing can never hang on, or crash because of, the LLM.
//
//   - per-call timeout: the call is abandoned (and its AbortSignal fired) after `timeoutMs`
//   - per-post deadline: callers pass `deadline` (epoch ms) shared by all LLM stages of one post;
//     a call gets min(timeoutMs, time left), and is skipped when no time is left
//   - exceptions and invalid results become `null`, which every caller treats as "use the
//     deterministic path"
//
// This sits in front of the Claude adapter (which has its own SDK timeout) and of any injected
// client, so the guarantee does not depend on the client behaving well.

import { validateSchema } from './schema.js';

export function guardLlm(llm, { log, metrics, timeoutMs }) {
  if (!llm) return null;

  return {
    ...llm,
    async json(request) {
      const left = (request.deadline ?? Infinity) - Date.now();
      const budget = Math.min(timeoutMs, left);
      if (!(budget > 0)) {
        metrics.inc('llm_skipped_deadline');
        return null;
      }

      const controller = new AbortController();
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new Error(`LLM call exceeded ${Math.round(budget)} ms`));
          metrics.inc('llm_timeouts');
          log.warn('llm call timed out; using deterministic fallback', { budget_ms: Math.round(budget) });
          resolve(null);
        }, budget);
      });

      try {
        const call = Promise.resolve().then(() => llm.json({ ...request, signal: controller.signal, timeoutMs: budget }));
        const result = await Promise.race([call, timeout]);
        call.catch(() => {}); // a call that loses the race may still reject later; that's expected
        if (result !== null && (typeof result !== 'object' || Array.isArray(result))) {
          metrics.inc('llm_invalid_results');
          return null;
        }
        // Whatever the client, nothing that does not match the requested schema reaches a caller.
        if (result !== null && request.schema && validateSchema(result, request.schema).length) {
          metrics.inc('llm_invalid_results');
          log.warn('llm result does not match the schema; using deterministic fallback');
          return null;
        }
        return result;
      } catch (err) {
        metrics.inc('llm_errors');
        log.warn('llm call failed; using deterministic fallback', { error: err?.message ?? String(err) });
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
