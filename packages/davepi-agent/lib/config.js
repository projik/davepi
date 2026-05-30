'use strict';

const path = require('node:path');
const fs = require('node:fs');

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function asBool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  return TRUE_VALUES.has(String(v).toLowerCase());
}

function asInt(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function loadFileConfig(configPath) {
  if (!configPath) return {};
  const abs = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(abs)) return {};
  return require(abs);
}

function buildConfig(overrides = {}) {
  const env = process.env;
  const fileConfig = loadFileConfig(env.DAVEPI_AGENT_CONFIG);

  const cfg = {
    davepiUrl: env.DAVEPI_URL || fileConfig.davepiUrl || 'http://localhost:5050',
    mcpPath: env.DAVEPI_MCP_PATH || fileConfig.mcpPath || '/mcp',

    // Which agent this process is. Keys the persona (and, in later
    // tickets, memory/skills) row this agent reads as prompt slot #1.
    // Unset → no persona lookup, default prompt (zero-config).
    agent: {
      key: env.AGENT_KEY || fileConfig.agent?.key || null,
      // Per-process persona cache TTL. Personas are near-static, so the
      // lookup is cached per agentKey to avoid an MCP round-trip every
      // turn. Set 0 to disable and fetch on every turn (strict immediacy).
      personaCacheTtlSeconds: asInt(
        env.AGENT_PERSONA_CACHE_TTL_SECONDS,
        fileConfig.agent?.personaCacheTtlSeconds ?? 60
      ),
    },

    auth: {
      mode: env.AGENT_AUTH_MODE || fileConfig.auth?.mode || 'service',
      bearer: env.DAVEPI_BEARER || fileConfig.auth?.bearer || null,
      clientId: env.DAVEPI_CLIENT_ID || fileConfig.auth?.clientId || null,
      accessTtlSeconds: asInt(env.AGENT_ACCESS_TTL_SECONDS, fileConfig.auth?.accessTtlSeconds ?? 15 * 60),
      refreshSkewSeconds: asInt(env.AGENT_REFRESH_SKEW_SECONDS, fileConfig.auth?.refreshSkewSeconds ?? 60),
      linkBaseUrl: env.AGENT_LINK_BASE_URL || fileConfig.auth?.linkBaseUrl || null,
    },

    llm: {
      provider: env.LLM_PROVIDER || fileConfig.llm?.provider || 'anthropic',
      model: env.LLM_MODEL || fileConfig.llm?.model || null,
      systemPrompt: env.LLM_SYSTEM_PROMPT || fileConfig.llm?.systemPrompt || null,
      maxSteps: asInt(env.LLM_MAX_STEPS, fileConfig.llm?.maxSteps ?? 8),
      temperature:
        env.LLM_TEMPERATURE !== undefined
          ? Number.parseFloat(env.LLM_TEMPERATURE)
          : fileConfig.llm?.temperature ?? undefined,
    },

    tools: {
      limit: asInt(env.AGENT_TOOL_LIMIT, fileConfig.tools?.limit ?? 40),
      includeRender: asBool(env.AGENT_INCLUDE_RENDER, fileConfig.tools?.includeRender ?? true),
    },

    http: {
      enabled: asBool(env.AGENT_HTTP_ENABLED, fileConfig.http?.enabled ?? true),
      port: asInt(env.PORT || env.AGENT_HTTP_PORT, fileConfig.http?.port ?? 5060),
      corsOrigins: (env.AGENT_CORS_ORIGINS || fileConfig.http?.corsOrigins || '')
        .toString()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      sessionSecret: env.AGENT_SESSION_SECRET || fileConfig.http?.sessionSecret || null,
      cookieSecure: asBool(env.AGENT_COOKIE_SECURE, fileConfig.http?.cookieSecure ?? true),
    },

    slack: {
      enabled: asBool(env.SLACK_ENABLED, fileConfig.slack?.enabled ?? !!env.SLACK_BOT_TOKEN),
      botToken: env.SLACK_BOT_TOKEN || fileConfig.slack?.botToken || null,
      signingSecret: env.SLACK_SIGNING_SECRET || fileConfig.slack?.signingSecret || null,
      appToken: env.SLACK_APP_TOKEN || fileConfig.slack?.appToken || null,
      socketMode: asBool(env.SLACK_SOCKET_MODE, fileConfig.slack?.socketMode ?? false),
      port: asInt(env.SLACK_PORT, fileConfig.slack?.port ?? 5061),
    },

    store: {
      url: env.STORE_URL || fileConfig.store?.url || 'file:./davepi-agent-store.json',
    },
  };

  // Shallow merge of programmatic overrides on top.
  for (const key of Object.keys(overrides)) {
    const v = overrides[key];
    cfg[key] = v && typeof v === 'object' && !Array.isArray(v) ? { ...cfg[key], ...v } : v;
  }

  return cfg;
}

module.exports = { buildConfig };
