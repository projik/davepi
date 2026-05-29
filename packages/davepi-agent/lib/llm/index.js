'use strict';

/**
 * Provider switch. Vercel AI SDK gives us a single `streamText` API
 * that works across providers — we just hand it a `LanguageModel`
 * factory. New providers slot in by adding a case here.
 *
 * Defaults pick the strongest tool-using model in each family. The
 * model id can be overridden via LLM_MODEL.
 */

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
};

function resolveModel(config) {
  const provider = (config.llm?.provider || 'anthropic').toLowerCase();
  const modelId = config.llm?.model || DEFAULT_MODELS[provider];
  if (!modelId) {
    throw new Error(
      `Unknown LLM provider: ${provider}. Supported: ${Object.keys(DEFAULT_MODELS).join(', ')}.`
    );
  }
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
  throw new Error(
    `Unknown LLM provider: ${provider}. Supported: ${Object.keys(DEFAULT_MODELS).join(', ')}.`
  );
}

module.exports = { resolveModel, DEFAULT_MODELS };
