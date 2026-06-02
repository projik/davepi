'use strict';

/**
 * Provider switch. Vercel AI SDK gives us a single `streamText` API
 * that works across providers — we just hand it a `LanguageModel`
 * factory. New providers slot in by adding a case here.
 *
 * Defaults pick the strongest tool-using model in each family. The
 * model id can be overridden via LLM_MODEL. The `ollama` provider has
 * no default — operators pull their own model (e.g. `ollama pull
 * llama3.1`) so requiring an explicit LLM_MODEL is the honest contract.
 */

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
  ollama: null,
};

function resolveModel(config) {
  const provider = (config.llm?.provider || 'anthropic').toLowerCase();
  if (!(provider in DEFAULT_MODELS)) {
    throw new Error(
      `Unknown LLM provider: ${provider}. Supported: ${Object.keys(DEFAULT_MODELS).join(', ')}.`
    );
  }
  const modelId = config.llm?.model || DEFAULT_MODELS[provider];
  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.');
    }
    const { anthropic } = require('@ai-sdk/anthropic');
    return { provider, modelId, model: anthropic(modelId) };
  }
  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('LLM_PROVIDER=openai but OPENAI_API_KEY is not set.');
    }
    const { openai } = require('@ai-sdk/openai');
    return { provider, modelId, model: openai(modelId) };
  }
  if (provider === 'ollama') {
    if (!modelId) {
      throw new Error(
        'LLM_PROVIDER=ollama requires LLM_MODEL (e.g. llama3.1). ' +
          'Ollama has no default model — run `ollama pull <model>` and set LLM_MODEL.'
      );
    }
    // Ollama exposes an OpenAI-compatible API at /v1, so we reuse the
    // already-bundled @ai-sdk/openai provider pointed at OLLAMA_BASE_URL.
    // `.chat(modelId)` forces /v1/chat/completions (Ollama has no /v1/responses).
    // `compatibility: 'compatible'` keeps strict OpenAI-only params and JSON-schema
    // tool envelopes off the wire, which some Ollama models reject.
    const baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
    const { createOpenAI } = require('@ai-sdk/openai');
    const ollama = createOpenAI({
      baseURL,
      // Ollama ignores the key but @ai-sdk/openai throws when it's missing.
      apiKey: process.env.OLLAMA_API_KEY || 'ollama',
      compatibility: 'compatible',
      name: 'ollama',
    });
    return { provider, modelId, model: ollama.chat(modelId) };
  }
  throw new Error(
    `Unknown LLM provider: ${provider}. Supported: ${Object.keys(DEFAULT_MODELS).join(', ')}.`
  );
}

module.exports = { resolveModel, DEFAULT_MODELS };
