'use strict';

const { buildRenderTools } = require('./renderTools');
const { deriveResources, shouldRoute, buildRouterTools } = require('./toolRouter');
const { assembleSystemPrompt } = require('./promptAssembly');
const logger = require('./logger');

function adaptMcpTools(tools, mcpClient, channelCtx, jsonSchemaHelper) {
  const adapted = {};
  for (const t of tools) {
    const schema = t.inputSchema || { type: 'object', properties: {} };
    adapted[t.name] = {
      description: t.description || `MCP tool ${t.name}`,
      parameters: jsonSchemaHelper(schema),
      async execute(args) {
        const result = await mcpClient.callTool(t.name, args, channelCtx);
        return normalizeMcpResult(result);
      },
    };
  }
  return adapted;
}

function normalizeMcpResult(result) {
  if (!result) return { ok: true };
  if (result.isError) {
    return {
      error: true,
      content: result.content?.map((c) => c.text || c).filter(Boolean) ?? [],
    };
  }
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return { text };
      }
    }
  }
  return result;
}

/**
 * Build a persona loader for `assembleSystemPrompt`, or `null` when no
 * `agentKey` is configured (nothing to look up — stay zero-config).
 *
 * The persona is read through the agent's own MCP identity via the
 * schema-generated `list_agentPersona` tool, so tenant isolation, ACL,
 * and scope are enforced server-side exactly like every other read. A
 * backend without the agentPersona schema (older davepi) makes the tool
 * call fail; `assembleSystemPrompt` swallows the throw and falls back to
 * the default prompt.
 */
function makePersonaFetcher({ config, mcpClient, channelCtx }) {
  const agentKey = config && config.agent && config.agent.key;
  if (!agentKey) return null;
  return async () => {
    const raw = await mcpClient.callTool(
      'list_agentPersona',
      { filter: { agentKey, status: 'active' }, perPage: 1 },
      channelCtx
    );
    const norm = normalizeMcpResult(raw);
    if (!norm || norm.error) return null;
    const rows = norm.results || norm.records || [];
    return Array.isArray(rows) ? rows[0] || null : null;
  };
}

/**
 * One orchestration "run" — given a user message plus prior history,
 * stream the model's reply with tool-calls driven through the MCP
 * client. The Vercel AI SDK's `streamText` handles the model loop;
 * we plug in tools and an `onStepFinish` to relay events to the
 * channel.
 *
 * `events.onEvent(evt)` receives a stream of:
 *   { type: 'token', text }
 *   { type: 'tool_call', name, args }
 *   { type: 'tool_result', name, result }
 *   { type: 'render', payload }     // emitted by render_chart/render_table
 *   { type: 'final', text, history }
 *
 * Returns the assembled assistant message + updated history.
 */
async function runTurn({
  config,
  model,
  mcpClient,
  channelCtx,
  history,
  userMessage,
  onEvent = () => {},
}) {
  const { streamText, jsonSchema } = await import('ai');
  const allTools = await mcpClient.listTools(channelCtx);

  const routed = shouldRoute(allTools.length, config.tools.limit);
  let exposedMcpTools;
  let routerTools = {};
  if (routed) {
    const resources = deriveResources(allTools);
    const routerState = { activeResource: null };
    // In routed mode the model talks to a stable trio (list_resources,
    // use_resource, call_mcp_tool) rather than the full schema CRUD
    // surface — the meta-tool pattern keeps the tool count small while
    // still letting the model reach any underlying MCP tool after
    // picking a resource.
    routerTools = buildRouterTools({
      resources,
      state: routerState,
      mcpClient,
      channelCtx,
    });
    exposedMcpTools = {};
  } else {
    exposedMcpTools = adaptMcpTools(allTools, mcpClient, channelCtx, jsonSchema);
  }

  const renderTools = config.tools.includeRender
    ? buildRenderTools({
        onRender: async (payload) => onEvent({ type: 'render', payload }),
      })
    : {};

  const tools = { ...routerTools, ...exposedMcpTools, ...renderTools };

  const messages = [...history, { role: 'user', content: userMessage }];

  // Persona is prompt slot #1: assemble it ahead of the operating
  // contract. Falls back to the default prompt when there's no persona
  // row (or no agentKey configured).
  const system = await assembleSystemPrompt({
    config,
    fetchPersona: makePersonaFetcher({ config, mcpClient, channelCtx }),
    log: logger,
  });

  let assembledText = '';
  const result = await streamText({
    model,
    system,
    messages,
    tools,
    maxSteps: config.llm.maxSteps,
    temperature: config.llm.temperature,
    onStepFinish({ toolCalls, toolResults }) {
      if (Array.isArray(toolCalls)) {
        for (const c of toolCalls) onEvent({ type: 'tool_call', name: c.toolName, args: c.args });
      }
      if (Array.isArray(toolResults)) {
        for (const r of toolResults) onEvent({ type: 'tool_result', name: r.toolName, result: r.result });
      }
    },
  });

  for await (const chunk of result.textStream) {
    assembledText += chunk;
    onEvent({ type: 'token', text: chunk });
  }

  const finalText = (await result.text) || assembledText;
  const newHistory = [
    ...history,
    { role: 'user', content: userMessage },
    { role: 'assistant', content: finalText },
  ];
  onEvent({ type: 'final', text: finalText, history: newHistory });
  return { text: finalText, history: newHistory };
}

async function safeRunTurn(args) {
  try {
    return await runTurn(args);
  } catch (err) {
    if ((err.code === 'UNLINKED' || err.name === 'UnlinkedError') && err.linkUrl) {
      const linkMsg =
        `You need to link your account before I can look up your data. ` +
        `Open this link and sign in: ${err.linkUrl}`;
      args.onEvent({ type: 'token', text: linkMsg });
      const newHistory = [
        ...args.history,
        { role: 'user', content: args.userMessage },
        { role: 'assistant', content: linkMsg },
      ];
      args.onEvent({ type: 'final', text: linkMsg, history: newHistory });
      return { text: linkMsg, history: newHistory, unlinked: true };
    }
    logger.error({ err: err.message, code: err.code }, 'orchestrator turn failed');
    throw err;
  }
}

module.exports = { runTurn: safeRunTurn, adaptMcpTools, normalizeMcpResult };
