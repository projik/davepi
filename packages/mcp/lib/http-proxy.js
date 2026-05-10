/**
 * HTTP-proxy mode: bridge stdio JSON-RPC ↔ remote /mcp HTTP endpoint.
 *
 * Why a manual stdio loop instead of the MCP SDK's bridge classes:
 * the MCP protocol is JSON-RPC 2.0 with specific method names. The
 * wrapper doesn't need to understand any of the methods — it just
 * forwards bytes — so importing the SDK would add ~MB of code to
 * pump line-delimited JSON through `fetch`. The dAvePi server's
 * /mcp endpoint runs StreamableHTTPServerTransport in stateless
 * mode, which means each POST is one request-response pair with
 * a JSON body.
 *
 * Each line on stdin is one JSON-RPC message from the agent. We
 * POST it to ${url}/mcp with the bearer token and write the
 * response body to stdout, terminated by a newline (the SDK's
 * stdio transport is line-delimited).
 *
 * Errors surface to the agent as JSON-RPC error responses so the
 * agent sees an actionable failure instead of a silent hang. When
 * the upstream is unreachable we keep the loop alive — the user
 * may have a transient network blip, and exiting would force the
 * agent to restart the proxy.
 */

'use strict';

const readline = require('node:readline');

function buildErrorResponse(reqId, code, message, data) {
  // JSON-RPC 2.0 error envelope. -32000 to -32099 is the reserved
  // server-implementation range; we use -32000 for transport errors
  // so a downstream agent can branch on "talk to operator" vs
  // "fix your call".
  return JSON.stringify({
    jsonrpc: '2.0',
    id: reqId === undefined ? null : reqId,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

// Default upstream timeout. Long enough that a slow aggregation
// against a remote /mcp doesn't false-positive, short enough that a
// stalled connection doesn't block the agent indefinitely. Tunable
// via DAVEPI_HTTP_TIMEOUT_MS for CI / dev / latency-sensitive setups.
const DEFAULT_TIMEOUT_MS = 30_000;

function getTimeoutMs() {
  const raw = process.env.DAVEPI_HTTP_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

async function forwardOne(line, { url, token }) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (parseErr) {
    return buildErrorResponse(null, -32700, `Parse error: ${parseErr.message}`);
  }
  const reqId = parsed && Object.prototype.hasOwnProperty.call(parsed, 'id') ? parsed.id : undefined;

  // AbortController guards both phases — the fetch() promise (TCP
  // connect, headers received) AND response.text() (body streaming).
  // Without this, a stalled upstream that holds the socket open but
  // never sends bytes would block the entire stdio loop and every
  // subsequent message behind it.
  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response;
    try {
      response = await fetch(`${url.replace(/\/+$/, '')}/mcp`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: line,
        signal: controller.signal,
      });
    } catch (fetchErr) {
      // AbortError surfaces with .name === 'AbortError' on Node 18+;
      // distinguish it from generic transport errors so the agent
      // can react differently (a timeout is "retry shortly", a
      // network error is "operator's broken").
      if (fetchErr.name === 'AbortError') {
        return buildErrorResponse(
          reqId,
          -32000,
          `Upstream /mcp timed out after ${timeoutMs}ms`,
          { timeoutMs }
        );
      }
      return buildErrorResponse(
        reqId,
        -32000,
        `Transport error contacting ${url}: ${fetchErr.message}`
      );
    }

    let body;
    try {
      body = await response.text();
    } catch (readErr) {
      if (readErr.name === 'AbortError') {
        return buildErrorResponse(
          reqId,
          -32000,
          `Upstream /mcp body read timed out after ${timeoutMs}ms`,
          { timeoutMs }
        );
      }
      return buildErrorResponse(
        reqId,
        -32000,
        `Transport error reading /mcp body: ${readErr.message}`
      );
    }

    if (!response.ok) {
      return buildErrorResponse(
        reqId,
        -32000,
        `Upstream /mcp returned ${response.status}`,
        { status: response.status, body: tryParseJson(body) ?? body }
      );
    }

    // The MCP HTTP transport (per spec) uses Content-Type to pick
    // the response shape:
    //   - application/json — body is the raw JSON-RPC message.
    //   - text/event-stream — body is one or more SSE events; the
    //     `data:` field of each event carries the JSON-RPC payload.
    // The dAvePi server happens to use SSE for typical responses
    // (the SDK's StreamableHTTPServerTransport sends event: message
    // frames), so we parse SSE first and fall back to JSON.
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      const extracted = extractSseData(body);
      if (extracted) return extracted;
      // SSE body but no parseable data event — surface as a transport
      // error rather than dropping the response on the floor.
      return buildErrorResponse(
        reqId,
        -32000,
        'Upstream /mcp returned SSE with no data frame',
        { body }
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the JSON-RPC payload from an SSE response body. Handles the
 * standard cases (one `event: message` with one `data:` line) and the
 * spec-permitted multi-line `data:` form (concatenated with newlines).
 * Returns null when no `data:` field is present.
 */
function extractSseData(body) {
  // Per SSE spec, events are separated by a blank line. Each event
  // is a sequence of `field: value` lines. We only care about
  // `data:` for forwarding the JSON-RPC payload upward.
  const events = body.split(/\r?\n\r?\n/);
  for (const event of events) {
    const dataLines = [];
    for (const line of event.split(/\r?\n/)) {
      // Spec: `data: <value>` (the leading space is optional). Lines
      // starting with `:` are comments; everything else is metadata
      // we ignore for forwarding.
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(line.startsWith('data: ') ? 6 : 5));
      }
    }
    if (dataLines.length > 0) {
      // Multi-line data fields are joined with `\n` per spec.
      return dataLines.join('\n');
    }
  }
  return null;
}

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

async function runHttpProxy({ url, token }) {
  if (!url) throw new Error('runHttpProxy: url is required');
  if (!token) throw new Error('runHttpProxy: token is required');

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const out = await forwardOne(line, { url, token });
    process.stdout.write(out + '\n');
  }
}

module.exports = { runHttpProxy, forwardOne, buildErrorResponse, extractSseData };
