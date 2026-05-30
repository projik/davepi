'use strict';

const { buildConfig } = require('./lib/config');
const { createAuth } = require('./lib/auth');
const { createMcpClient } = require('./lib/mcpClient');
const { resolveModel } = require('./lib/llm');
const { createHttpApp, startHttpServer } = require('./lib/channels/http');
const { startSlackChannel } = require('./lib/channels/slack');
const { runTurn } = require('./lib/orchestrator');
const { createScheduledHandler, runScheduledSkill } = require('./lib/proactive');
const logger = require('./lib/logger');

async function createAgent(overrides = {}) {
  const config = buildConfig(overrides);
  const auth = createAuth(config);
  const mcpClient = createMcpClient({
    davepiUrl: config.davepiUrl,
    mcpPath: config.mcpPath,
    auth,
  });
  const { model, modelId, provider } = resolveModel(config);
  logger.info({ provider, modelId, auth: auth.mode, davepiUrl: config.davepiUrl }, 'agent built');
  const agent = { config, auth, mcpClient, model, modelId, provider };
  // Convenience: build a cron handler bound to this agent. Hand the
  // result to `davepi-plugin-cron`'s `register(name, { schedule, handler })`.
  agent.scheduledSkill = (opts) => createScheduledHandler({ agent, ...opts });
  return agent;
}

async function startAgent(overrides = {}) {
  const agent = await createAgent(overrides);
  const handles = {};
  if (agent.config.http.enabled) {
    handles.http = await startHttpServer(agent);
  }
  if (agent.config.slack.enabled) {
    handles.slack = await startSlackChannel(agent);
  }
  return { ...agent, ...handles };
}

module.exports = {
  createAgent,
  startAgent,
  createHttpApp,
  runTurn,
  buildConfig,
  createScheduledHandler,
  runScheduledSkill,
};
