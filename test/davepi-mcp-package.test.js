/**
 * End-to-end smoke test for the @davepi/mcp HTTP-proxy mode.
 *
 * The package's own `npm test` runs node:test against `lib/` with
 * stub servers (fast, dep-light). This file exercises the real
 * /mcp endpoint inside the monorepo's jest harness — proves that
 * the proxy speaks the actual protocol against the framework's
 * live MCP server, not just a hand-written stub.
 */

const http = require('node:http');
const { setupTestApp, registerUser } = require('./helpers');
const { forwardOne } = require('../packages/mcp/lib/http-proxy');

describe('@davepi/mcp HTTP-proxy: end-to-end against /mcp', () => {
  const ctx = setupTestApp();

  test('initialize round-trips through the proxy and returns serverInfo', async () => {
    const user = await registerUser(ctx.request, ctx.app);

    // forwardOne uses global fetch, which needs a real listening
    // socket. Spin up an ephemeral server in front of the test app.
    const server = http.createServer(ctx.app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}`;

    try {
      const response = await forwardOne(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'davepi-mcp-e2e', version: '1.0.0' },
          },
        }),
        { url, token: user.token }
      );
      const parsed = JSON.parse(response);
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.id).toBe(1);
      expect(parsed.result).toBeDefined();
      expect(parsed.result.serverInfo).toBeDefined();
      expect(parsed.result.serverInfo.name).toBeTruthy();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('rejected JWT surfaces as a JSON-RPC error, not a hang', async () => {
    const server = http.createServer(ctx.app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const response = await forwardOne(
        JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize' }),
        { url: `http://127.0.0.1:${port}`, token: 'definitely-not-a-real-jwt' }
      );
      const parsed = JSON.parse(response);
      expect(parsed.id).toBe(9);
      expect(parsed.error).toBeDefined();
      // dAvePi's auth middleware returns 401 for bad tokens; the
      // proxy wraps that as a -32000 JSON-RPC error and surfaces the
      // status code in `data` so the agent can branch on auth-vs-other.
      expect(parsed.error.code).toBe(-32000);
      expect(parsed.error.data.status).toBe(401);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
