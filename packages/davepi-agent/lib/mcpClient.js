'use strict';

const logger = require('./logger');

/**
 * Thin wrapper around @modelcontextprotocol/sdk's HTTP client.
 *
 * Two things this wrapper does that a direct SDK use wouldn't:
 *
 * 1. Auth headers are attached *per request*, not at construction.
 *    Per-user deployments need to swap identity between turns, so we
 *    open a fresh transport per call. The cost (one TCP / TLS setup
 *    if the keep-alive pool isn't already warm) is dwarfed by LLM
 *    latency on tool calls.
 *
 * 2. Tool list is cached and re-pulled on `tools/list_changed`
 *    notifications. The davepi MCP server emits these when its
 *    schema registry changes (hot reload in dev), so a long-running
 *    agent process picks up new schemas without a restart.
 *
 * We don't hold open one long-lived MCP session because the davepi
 * /mcp transport is stateless StreamableHTTPServerTransport — each
 * POST is a request-response pair. So per-turn transports are the
 * natural shape.
 */

function buildHeaders(auth, channelCtx) {
  return auth.headersFor(channelCtx);
}

// An `AbortSignal` carried on the channel context (e.g. a cron lease's
// signal) is forwarded to the underlying fetch so an in-flight tool call
// is cancelled when the lease is lost — the agent must not keep issuing
// writes after another node has taken over.
function signalOf(channelCtx) {
  return (channelCtx && channelCtx.signal) || undefined;
}

async function listTools({ url, auth, channelCtx }) {
  const sdk = await loadSdk();
  const transport = new sdk.StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: await buildHeaders(auth, channelCtx), signal: signalOf(channelCtx) },
  });
  const client = new sdk.Client(
    { name: 'davepi-agent', version: '0.1.0' },
    { capabilities: {} }
  );
  try {
    await client.connect(transport);
    const list = await client.listTools();
    return list.tools || [];
  } finally {
    await client.close().catch(() => {});
  }
}

async function callTool({ url, auth, channelCtx, name, args }) {
  const sdk = await loadSdk();
  const transport = new sdk.StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: await buildHeaders(auth, channelCtx), signal: signalOf(channelCtx) },
  });
  const client = new sdk.Client(
    { name: 'davepi-agent', version: '0.1.0' },
    { capabilities: {} }
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args || {} });
    return result;
  } finally {
    await client.close().catch(() => {});
  }
}

let _sdkPromise = null;
async function loadSdk() {
  if (_sdkPromise) return _sdkPromise;
  _sdkPromise = (async () => {
    const clientMod = await import('@modelcontextprotocol/sdk/client/index.js');
    const httpMod = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    return {
      Client: clientMod.Client,
      StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport,
    };
  })();
  return _sdkPromise;
}

function createMcpClient({ davepiUrl, mcpPath = '/mcp', auth }) {
  const url = new URL(mcpPath, davepiUrl).toString();
  let toolCache = null;

  return {
    url,
    async listTools(channelCtx) {
      if (toolCache) return toolCache;
      toolCache = await listTools({ url, auth, channelCtx });
      logger.info({ count: toolCache.length }, 'mcp tool list loaded');
      return toolCache;
    },
    async refreshTools(channelCtx) {
      toolCache = null;
      return this.listTools(channelCtx);
    },
    async callTool(name, args, channelCtx) {
      return callTool({ url, auth, channelCtx, name, args });
    },
    invalidateCache() {
      toolCache = null;
    },
  };
}

module.exports = { createMcpClient, listTools, callTool };
