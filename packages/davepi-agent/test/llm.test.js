'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveModel, DEFAULT_MODELS } = require('../lib/llm');

function withEnv(overrides, fn) {
  const snapshot = {};
  for (const k of Object.keys(overrides)) {
    snapshot[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(snapshot)) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  }
}

test('resolveModel: ollama with LLM_MODEL resolves without any API key', () => {
  withEnv({
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    OLLAMA_API_KEY: undefined,
    OLLAMA_BASE_URL: undefined,
  }, () => {
    const r = resolveModel({ llm: { provider: 'ollama', model: 'llama3.1' } });
    assert.equal(r.provider, 'ollama');
    assert.equal(r.modelId, 'llama3.1');
    assert.ok(r.model, 'expected a model factory result');
  });
});

test('resolveModel: ollama without LLM_MODEL throws a clear error', () => {
  withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
    assert.throws(
      () => resolveModel({ llm: { provider: 'ollama' } }),
      /requires LLM_MODEL/
    );
  });
});

test('resolveModel: unknown provider lists ollama in the Supported set', () => {
  assert.throws(
    () => resolveModel({ llm: { provider: 'mistral-cloud' } }),
    /Supported: anthropic, openai, ollama/
  );
});

test('resolveModel: anthropic still requires ANTHROPIC_API_KEY', () => {
  withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
    assert.throws(
      () => resolveModel({ llm: { provider: 'anthropic' } }),
      /ANTHROPIC_API_KEY is not set/
    );
  });
});

test('resolveModel: openai still requires OPENAI_API_KEY', () => {
  withEnv({ OPENAI_API_KEY: undefined }, () => {
    assert.throws(
      () => resolveModel({ llm: { provider: 'openai' } }),
      /OPENAI_API_KEY is not set/
    );
  });
});

test('DEFAULT_MODELS: ollama present with null (no universal default)', () => {
  assert.ok('ollama' in DEFAULT_MODELS);
  assert.equal(DEFAULT_MODELS.ollama, null);
});
