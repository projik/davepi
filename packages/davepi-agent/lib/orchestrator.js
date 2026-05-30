'use strict';

const { buildRenderTools } = require('./renderTools');
const { deriveResources, shouldRoute, buildRouterTools } = require('./toolRouter');
const { normalizeMcpResult } = require('./mcpResult');
const { startSession, _resetSessionCaches } = require('./conversation');
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

// Per-process persona cache: agentKey -> { persona, fetchedAt }.
// Personas are near-static, tenant-level records, but the lookup was
// running on every turn, adding an MCP round-trip per user message. A
// short TTL collapses that to one fetch per window while still letting
// operator edits take effect quickly. The cache is keyed by agentKey
// only (persona is tenant-scoped, not per end-user, so channelCtx
// doesn't change the result).
const personaCache = new Map();
const DEFAULT_PERSONA_TTL_SECONDS = 60;

// Test seam: drop cached personas (and session snapshots) so a unit test
// starts cold.
function _resetPersonaCache() {
  personaCache.clear();
  _resetSessionCaches();
}

function personaTtlMs(config) {
  const ttl = config && config.agent && config.agent.personaCacheTtlSeconds;
  const seconds = Number.isFinite(ttl) ? ttl : DEFAULT_PERSONA_TTL_SECONDS;
  return Math.max(0, seconds) * 1000;
}

// Pull the first row out of a normalised MCP list result.
function firstRow(norm) {
  if (!norm || norm.error) return null;
  const rows = norm.results || norm.records || [];
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function fetchPersonaFromMcp({ mcpClient, channelCtx, agentKey }) {
  const raw = await mcpClient.callTool(
    'list_agentPersona',
    { filter: { agentKey, status: 'active' }, perPage: 1 },
    channelCtx
  );
  return firstRow(normalizeMcpResult(raw));
}

/**
 * Build a persona loader for the prompt snapshot, or `null` when no
 * `agentKey` is configured (nothing to look up — stay zero-config).
 *
 * The persona is read through the agent's own MCP identity via the
 * schema-generated `list_agentPersona` tool, so tenant isolation, ACL,
 * and scope are enforced server-side exactly like every other read.
 *
 * Results (including a `null` "no persona" result) are cached per
 * agentKey for `config.agent.personaCacheTtlSeconds` (default 60s; set 0
 * to disable). A thrown fetch is never cached, so a transient MCP
 * failure retries on the next assembly.
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
 * Build an agent-memory loader (prompt slot #4), or `null` when no
 * `agentKey` is configured. Reads the single `agentMemory` row for the
 * agent through the schema-generated `list_agentMemory` tool.
 */
function makeMemoryFetcher({ config, mcpClient, channelCtx }) {
  const agentKey = config && config.agent && config.agent.key;
  if (!agentKey) return null;
  return async () => {
    const raw = await mcpClient.callTool(
      'list_agentMemory',
      { filter: { agentKey }, perPage: 1 },
      channelCtx
    );
    return firstRow(normalizeMcpResult(raw));
  };
}

/**
 * Build a customer-profile loader (prompt slot #5), or `null` when there
 * is no end-user to key on (service mode has none, so per-user profile
 * simply doesn't apply).
 *
 * The canonical `endUserKey` is **channel-prefixed** (`${channel}:${id}`,
 * e.g. `slack:U123`) — the format the `customerProfile` schema documents
 * and the backend tests use. Prefixing namespaces the platform id per
 * channel (a Slack `U1` and a Telegram `U1` are different people) and,
 * critically, means a profile pre-seeded or edited via REST/GraphQL in
 * the documented format is read back into the snapshot here.
 */
function makeProfileFetcher({ mcpClient, channelCtx }) {
  const channelUserId = channelCtx && channelCtx.channelUserId;
  if (!channelUserId) return null;
  const channel = (channelCtx && channelCtx.channel) || 'unknown';
  const endUserKey = `${channel}:${channelUserId}`;
  return async () => {
    const raw = await mcpClient.callTool(
      'list_customerProfile',
      { filter: { endUserKey }, perPage: 1 },
      channelCtx
    );
    return firstRow(normalizeMcpResult(raw));
  };
}

/**
 * Anthropic prompt caching is on by default (and only meaningful for the
 * Anthropic provider). The frozen snapshot is a byte-stable prefix, so a
 * cache breakpoint right after it is reused every turn within a session.
 * Set `LLM_PROMPT_CACHING=false` to disable.
 */
function promptCachingEnabled(config) {
  const provider = ((config && config.llm && config.llm.provider) || 'anthropic').toLowerCase();
  if (provider !== 'anthropic') return false;
  const flag = config && config.llm && config.llm.promptCaching;
  return flag === undefined ? true : Boolean(flag);
}

/**
 * Place the frozen system prefix as a `system`-role message carrying an
 * Anthropic `cacheControl` breakpoint, ahead of the volatile turns. This
 * is the AI-SDK way to mark a cache breakpoint after the system prompt:
 * the prefix (`tools` → this system block) is cached, the trailing user/
 * assistant turns are not. Returns `{ system, messages }` to spread into
 * `streamText`. With caching off, `system` stays the top-level string.
 */
function buildModelInput({ system, messages, caching }) {
  if (!caching) return { system, messages };
  return {
    system: undefined,
    messages: [
      {
        role: 'system',
        content: system,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
      ...messages,
    ],
  };
}

/**
 * One orchestration "run" — given a user message plus prior history,
 * stream the model's reply with tool-calls driven through the MCP
 * client.
 *
 * History is now loaded from (and saved back to) davepi's `conversation`
 * schema when a stable per-user session key is available; the passed
 * `history` seeds a fresh conversation and remains authoritative for
 * service-mode channels that round-trip it themselves.
 *
 * `events.onEvent(evt)` receives a stream of:
 *   { type: 'token', text }
 *   { type: 'tool_call', name, args }
 *   { type: 'tool_result', name, result }
 *   { type: 'render', payload }
 *   { type: 'cache', cacheReadInputTokens, cacheCreationInputTokens }
 *   { type: 'final', text, history }
 */
async function runTurn({
  config,
  model,
  mcpClient,
  channelCtx,
  history = [],
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
    routerTools = buildRouterTools({ resources, state: routerState, mcpClient, channelCtx });
    exposedMcpTools = {};
  } else {
    exposedMcpTools = adaptMcpTools(allTools, mcpClient, channelCtx, jsonSchema);
  }

  const renderTools = config.tools.includeRender
    ? buildRenderTools({ onRender: async (payload) => onEvent({ type: 'render', payload }) })
    : {};

  const tools = { ...routerTools, ...exposedMcpTools, ...renderTools };

  // Start/resume the session: assemble (or reuse) the frozen prompt
  // snapshot and load durable history. The snapshot reads persona
  // (slot 1), memory (slot 4) and customer profile (slot 5) once at
  // session start and freezes them for the conversation.
  const session = await startSession({
    config,
    mcpClient,
    channelCtx,
    fetchPersona: makePersonaFetcher({ config, mcpClient, channelCtx }),
    fetchMemory: makeMemoryFetcher({ config, mcpClient, channelCtx }),
    fetchProfile: makeProfileFetcher({ mcpClient, channelCtx }),
    passedHistory: history,
    log: logger,
  });

  const baseHistory = session.history || [];
  const messages = [...baseHistory, { role: 'user', content: userMessage }];

  const caching = promptCachingEnabled(config);
  const modelInput = buildModelInput({ system: session.system, messages, caching });

  let assembledText = '';
  const result = await streamText({
    model,
    ...modelInput,
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

  // Surface prompt-cache usage so operators can confirm the frozen
  // prefix is being reused within a session (acceptance criterion).
  await emitCacheMetric(result, onEvent);

  const newHistory = [
    ...baseHistory,
    { role: 'user', content: userMessage },
    { role: 'assistant', content: finalText },
  ];
  await session.commit(newHistory);
  onEvent({ type: 'final', text: finalText, history: newHistory });
  return { text: finalText, history: newHistory };
}

// Read Anthropic cache token counts off the streamText result (the AI
// SDK exposes them via providerMetadata) and emit a `cache` event +
// info log. Best-effort: a provider without these fields is silently
// skipped.
async function emitCacheMetric(result, onEvent) {
  try {
    const meta = await (result.providerMetadata || result.experimental_providerMetadata);
    const a = meta && meta.anthropic;
    if (!a) return;
    const metric = {
      cacheReadInputTokens: a.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: a.cacheCreationInputTokens ?? 0,
    };
    logger.info(metric, 'prompt cache usage');
    onEvent({ type: 'cache', ...metric });
  } catch {
    /* provider without cache metadata — ignore */
  }
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
        ...(args.history || []),
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
  makeMemoryFetcher,
  makeProfileFetcher,
  promptCachingEnabled,
  buildModelInput,
  _resetPersonaCache,
};
