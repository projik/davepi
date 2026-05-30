'use strict';

/**
 * The default extraction agent — a **fresh** LLM instance per job.
 *
 * This mirrors the Hermes "cron job = fresh instance" discipline and
 * the shape of `eval/lib/agent.js`: a single, stateless model call with
 * a standing system brief. No tools, no davepi/MCP access — the worker
 * only needs the model to read a transcript and emit a JSON verdict, and
 * keeping it tool-free means it can't take any action on the tenant's
 * data. The skill it proposes is persisted by the worker as a `draft`,
 * which a human still has to approve (#131 state machine).
 *
 * The model call is isolated here behind `createDefaultExtraction` so
 * the rest of the plugin stays testable without an API key or the AI
 * SDK installed — tests inject their own `runExtraction`.
 */

const DEFAULT_MODEL = 'claude-sonnet-4-5';

/**
 * Build the default `runExtraction({ system, transcript })` using the
 * Vercel AI SDK + Anthropic provider (the same stack the agent's
 * orchestrator uses). Lazy-required so a project that injects its own
 * extraction call — or leaves the plugin dormant — never pays the
 * import cost.
 *
 * `opts`:
 *   - modelId: override the model (default `claude-sonnet-4-5`).
 *   - generateText / model: injectable seams for tests.
 */
function createDefaultExtraction(opts = {}) {
  const modelId = opts.modelId || process.env.SKILL_EXTRACT_MODEL || DEFAULT_MODEL;
  return async function runExtraction({ system, transcript }) {
    if (!process.env.ANTHROPIC_API_KEY && !opts.model) {
      throw new Error(
        'davepi-plugin-skill-extractor: ANTHROPIC_API_KEY is not set and no model ' +
          'was injected — cannot run the default extraction agent.'
      );
    }
    let generateText = opts.generateText;
    if (!generateText) {
      try {
        ({ generateText } = require('ai'));
      } catch (err) {
        throw new Error(
          "davepi-plugin-skill-extractor: could not require 'ai' for the default " +
            'extraction agent (is it installed?). Inject a `runExtraction` to use ' +
            'a different LLM stack.'
        );
      }
    }
    let model = opts.model;
    if (!model) {
      let anthropic;
      try {
        ({ anthropic } = require('@ai-sdk/anthropic'));
      } catch (err) {
        throw new Error(
          "davepi-plugin-skill-extractor: could not require '@ai-sdk/anthropic' " +
            'for the default extraction agent (is it installed?).'
        );
      }
      model = anthropic(modelId);
    }
    const result = await generateText({
      model,
      system,
      prompt: transcript,
      // Extraction is a one-shot judgement; keep it cheap and decisive.
      temperature: 0,
      maxTokens: 1024,
    });
    return result && typeof result.text === 'string' ? result.text : '';
  };
}

module.exports = { createDefaultExtraction, DEFAULT_MODEL };
