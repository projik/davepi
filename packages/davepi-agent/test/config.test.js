'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildConfig } = require('../lib/config');

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

test('buildConfig defaults', () => {
  withEnv({
    DAVEPI_URL: undefined,
    DAVEPI_BEARER: undefined,
    DAVEPI_CLIENT_ID: undefined,
    AGENT_AUTH_MODE: undefined,
    LLM_PROVIDER: undefined,
    AGENT_TOOL_LIMIT: undefined,
    SLACK_BOT_TOKEN: undefined,
    SLACK_ENABLED: undefined,
  }, () => {
    const c = buildConfig();
    assert.equal(c.davepiUrl, 'http://localhost:5050');
    assert.equal(c.auth.mode, 'service');
    assert.equal(c.llm.provider, 'anthropic');
    assert.equal(c.tools.limit, 40);
    assert.equal(c.slack.enabled, false);
    assert.equal(c.http.enabled, true);
  });
});

test('buildConfig honors env overrides', () => {
  withEnv({
    DAVEPI_URL: 'https://api.example.com',
    AGENT_AUTH_MODE: 'per-user',
    LLM_PROVIDER: 'openai',
    AGENT_TOOL_LIMIT: '15',
    SLACK_BOT_TOKEN: 'xoxb-stub',
    SLACK_SIGNING_SECRET: 'sec',
    AGENT_CORS_ORIGINS: 'http://localhost:3000,https://app.example.com',
  }, () => {
    const c = buildConfig();
    assert.equal(c.davepiUrl, 'https://api.example.com');
    assert.equal(c.auth.mode, 'per-user');
    assert.equal(c.llm.provider, 'openai');
    assert.equal(c.tools.limit, 15);
    assert.equal(c.slack.enabled, true);
    assert.deepEqual(c.http.corsOrigins, ['http://localhost:3000', 'https://app.example.com']);
  });
});

test('buildConfig accepts programmatic overrides on top of env', () => {
  withEnv({ LLM_PROVIDER: 'anthropic' }, () => {
    const c = buildConfig({ llm: { provider: 'openai', model: 'gpt-4o-mini' } });
    assert.equal(c.llm.provider, 'openai');
    assert.equal(c.llm.model, 'gpt-4o-mini');
  });
});
