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

// Per-process persona cache: agentKey -> { persona, fetchedAt }.
// Personas are near-static, tenant-level records, but the lookup was
// running on every turn, adding an MCP round-trip per user message. A
// short TTL collapses that to one fetch per window while still letting
// operator edits take effect quickly. The cache is keyed by agentKey
// only (persona is tenant-scoped, not per end-user, so channelCtx
// doesn't change the result).
const personaCache = new Map();
const DEFAULT_PERSONA_TTL_SECONDS = 60;

// Test seam: drop cached personas so a unit test starts cold.
function _resetPersonaCache() {
  personaCache.clear();
}

function personaTtlMs(config) {
  const ttl = config && config.agent && config.agent.personaCacheTtlSeconds;
  const seconds = Number.isFinite(ttl) ? ttl : DEFAULT_PERSONA_TTL_SECONDS;
  return Math.max(0, seconds) * 1000;
}

async function fetchPersonaFromMcp({ mcpClient, channelCtx, agentKey }) {
  const raw = await mcpClient.callTool(
    'list_agentPersona',
    { filter: { agentKey, status: 'active' }, perPage: 1 },
    channelCtx
  );
  const norm = normalizeMcpResult(raw);
  if (!norm || norm.error) return null;
  const rows = norm.results || norm.records || [];
  return Array.isArray(rows) ? rows[0] || null : null;
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
 *
 * Results (including a `null` "no persona" result) are cached per
 * agentKey for `config.agent.personaCacheTtlSeconds` (default 60s; set 0
 * to disable and fetch every turn). A thrown fetch is never cached, so a
 * transient MCP failure retries on the next turn.
 */
function makePersonaFetcher({ config, mcpClient, channelCtx }) {
  const agentKey = config && config.agent && config.agent.key;
  if (!agentKey) return null;
  const ttlMs = personaTtlMs(config);
  return async () => {
    const now = Date.now();
    if (ttlMs > 0) {
      const hit = personaCache.get(agentKey);
      if (hit && now - hit.fetchedAt < ttlMs) return hit.persona;
    }
    const persona = await fetchPersonaFromMcp({ mcpClient, channelCtx, agentKey });
    if (ttlMs > 0) personaCache.set(agentKey, { persona, fetchedAt: now });
    return persona;
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

module.exports = {
  runTurn: safeRunTurn,
  adaptMcpTools,
  normalizeMcpResult,
  makePersonaFetcher,
  _resetPersonaCache,
};
