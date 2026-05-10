/**
 * Unit tests for the HTTP-proxy mode. Uses node:test to keep the
 * package zero-runtime-dep — Jest is the framework's main test
 * runner but isn't a dep of @davepi/mcp.
 *
 * The tests stand up a tiny HTTP server that mimics dAvePi's /mcp
 * endpoint just enough to exercise the proxy's success / failure /
 * malformed paths, then call `forwardOne` directly so we don't have
 * to wire stdin / stdout fixtures.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { forwardOne, buildErrorResponse, extractSseData } = require('../lib/http-proxy');

function startStubServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

test('forwards a successful JSON-RPC response unchanged', async () => {
  const expected = {
    jsonrpc: '2.0',
    id: 1,
    result: { tools: [{ name: 'list_account' }] },
  };
  const { url, server } = await startStubServer((req, res, body) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/mcp');
    assert.equal(req.headers.authorization, 'Bearer test-token');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(body), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(expected));
  });
  try {
    const response = await forwardOne(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      { url, token: 'test-token' }
    );
    assert.deepEqual(JSON.parse(response), expected);
  } finally {
    server.close();
  }
});

test('returns a JSON-RPC parse error for invalid stdin lines', async () => {
  // No HTTP call should be made when the line itself is unparsable.
  let hits = 0;
  const { url, server } = await startStubServer((req, res) => {
    hits++;
    res.end();
  });
  try {
    const response = await forwardOne('this is not json', { url, token: 'tok' });
    const parsed = JSON.parse(response);
    assert.equal(parsed.jsonrpc, '2.0');
    assert.equal(parsed.id, null);
    assert.equal(parsed.error.code, -32700);
    assert.match(parsed.error.message, /Parse error/);
    assert.equal(hits, 0);
  } finally {
    server.close();
  }
});

test('surfaces an upstream HTTP 500 as a JSON-RPC error', async () => {
  const { url, server } = await startStubServer((req, res, body) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'oops' } }));
  });
  try {
    const response = await forwardOne(
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
      { url, token: 'tok' }
    );
    const parsed = JSON.parse(response);
    assert.equal(parsed.id, 7);
    assert.equal(parsed.error.code, -32000);
    assert.match(parsed.error.message, /500/);
    assert.equal(parsed.error.data.status, 500);
    assert.equal(parsed.error.data.body.error.code, 'INTERNAL');
  } finally {
    server.close();
  }
});

test('surfaces a 401 from /mcp as a JSON-RPC transport error', async () => {
  const { url, server } = await startStubServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'no token' } }));
  });
  try {
    const response = await forwardOne(
      JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'tools/list' }),
      { url, token: 'wrong-token' }
    );
    const parsed = JSON.parse(response);
    assert.equal(parsed.id, 'x');
    assert.equal(parsed.error.data.status, 401);
  } finally {
    server.close();
  }
});

test('surfaces a network failure as a JSON-RPC transport error (no hang)', async () => {
  // Point at a port nothing is listening on.
  const response = await forwardOne(
    JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
    { url: 'http://127.0.0.1:1', token: 'tok' }
  );
  const parsed = JSON.parse(response);
  assert.equal(parsed.id, 99);
  assert.equal(parsed.error.code, -32000);
  assert.match(parsed.error.message, /Transport error/);
});

test('preserves request id on the error path even when input has no id (notifications)', async () => {
  // JSON-RPC notifications have no `id`. The error response we
  // synthesize should carry `id: null` per spec, not `undefined`.
  const response = await forwardOne(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    { url: 'http://127.0.0.1:1', token: 'tok' }
  );
  const parsed = JSON.parse(response);
  assert.equal(parsed.id, null);
});

test('strips trailing slashes from DAVEPI_URL when constructing the /mcp path', async () => {
  let calledPath = null;
  const { url, server } = await startStubServer((req, res) => {
    calledPath = req.url;
    res.end('{}');
  });
  try {
    await forwardOne(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      { url: `${url}/`, token: 'tok' }
    );
    assert.equal(calledPath, '/mcp');
  } finally {
    server.close();
  }
});

test('aborts a stalled upstream within DAVEPI_HTTP_TIMEOUT_MS and returns a JSON-RPC error', async () => {
  // Stub server that accepts the connection but never writes a
  // response — exactly the failure mode the timeout is there to
  // guard against.
  let opened;
  const { url, server } = await startStubServer((req, res, body) => {
    // Hold the response open. The proxy's AbortController should
    // fire and close us out.
    opened = res;
  });
  process.env.DAVEPI_HTTP_TIMEOUT_MS = '150';
  try {
    const start = Date.now();
    const response = await forwardOne(
      JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
      { url, token: 'tok' }
    );
    const elapsed = Date.now() - start;
    const parsed = JSON.parse(response);
    assert.equal(parsed.id, 5);
    assert.equal(parsed.error.code, -32000);
    assert.match(parsed.error.message, /timed out/);
    assert.equal(parsed.error.data.timeoutMs, 150);
    // The whole call must finish within a small window above the
    // timeout — if it ran to fetch's ~5 minute default, the test
    // would hang. Generous upper bound to avoid flakes on a busy
    // CI runner.
    assert.ok(elapsed < 2000, `expected <2000ms, got ${elapsed}ms`);
  } finally {
    delete process.env.DAVEPI_HTTP_TIMEOUT_MS;
    try { opened?.end(); } catch { /* already closed */ }
    server.close();
  }
});

test('decodes an SSE response from the upstream into the inner JSON-RPC payload', async () => {
  // The MCP SDK on the server side sends Content-Type:
  // text/event-stream and frames responses as `event: message\ndata:
  // <json>\n\n`. Replicate that and confirm the proxy hands back
  // just the JSON.
  const inner = { jsonrpc: '2.0', id: 1, result: { ok: true } };
  const sseBody = `event: message\ndata: ${JSON.stringify(inner)}\n\n`;
  const { url, server } = await startStubServer((req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sseBody);
  });
  try {
    const response = await forwardOne(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      { url, token: 'tok' }
    );
    assert.deepEqual(JSON.parse(response), inner);
  } finally {
    server.close();
  }
});

test('extractSseData: handles multi-line data fields per SSE spec', () => {
  // Per the SSE spec, multiple consecutive `data:` lines within a
  // single event are joined with `\n` to form the value. JSON
  // payloads that legitimately contain newlines hit this path.
  const body = 'event: message\ndata: {\ndata:   "ok": true\ndata: }\n\n';
  const extracted = extractSseData(body);
  assert.equal(extracted, '{\n  "ok": true\n}');
});

test('extractSseData: returns null when no data field is present', () => {
  assert.equal(extractSseData('event: ping\n\n'), null);
  assert.equal(extractSseData(': just a comment\n\n'), null);
});

test('extractSseData: tolerates CRLF line endings', () => {
  const body = 'event: message\r\ndata: {"x":1}\r\n\r\n';
  assert.equal(extractSseData(body), '{"x":1}');
});

test('buildErrorResponse: id round-trips correctly for all JSON-RPC id types', () => {
  // String ids, numeric ids, null, and missing ids are all valid in
  // JSON-RPC; the response id MUST match whatever the request used
  // (or null when the request was unparseable).
  for (const id of ['abc', 1, 0, null]) {
    const out = JSON.parse(buildErrorResponse(id, -32000, 'x'));
    assert.equal(out.id, id);
  }
  // `undefined` (missing) becomes `null` per JSON-RPC spec.
  const out = JSON.parse(buildErrorResponse(undefined, -32000, 'x'));
  assert.equal(out.id, null);
});
