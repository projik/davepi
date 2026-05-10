const jwt = require('jsonwebtoken');
const { setupTestApp, registerUser } = require('./helpers');
const { buildMcpServer, listToolNames } = require('../utils/mcpServer');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

/**
 * Decode the JWT a registered user holds into the `{ user_id, ... }`
 * shape the auth middleware would produce. The MCP server's
 * `getUser` callback is meant to return whatever the auth layer
 * attached to `req.user`, which is always the decoded JWT payload
 * (NOT the raw User document, which uses `_id`).
 */
const decodedFromRegister = (registered) =>
  jwt.decode(registered.accessToken);

/**
 * Wire a fresh MCP client to a freshly-built MCP server through an
 * in-memory transport pair. `user` is the JWT-decoded payload — pass
 * `null` to simulate an unauthenticated caller.
 */
async function connectMcp({ schemaLoader, user, name = 'test' }) {
  const server = buildMcpServer({ schemaLoader, getUser: () => user, name });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const parseStructured = (res) => {
  if (res.structuredContent !== undefined) return res.structuredContent;
  // Fall back to parsing the text payload for SDK versions that
  // don't auto-promote structuredContent on the client side.
  const txt = res.content && res.content[0] && res.content[0].text;
  return txt ? JSON.parse(txt) : null;
};

describe('MCP server: tool registry', () => {
  const ctx = setupTestApp({ cleanCollections: false });

  test('listToolNames includes standard CRUD per schema', () => {
    const names = listToolNames(ctx.app.locals.schemaLoader);
    expect(names).toContain('list_account');
    expect(names).toContain('get_account');
    expect(names).toContain('create_account');
    expect(names).toContain('update_account');
    expect(names).toContain('delete_account');
    // Quote ships with a declared aggregation.
    expect(names).toContain('aggregate_quote_countByAccount');
  });

  test('client.listTools returns the same names', async () => {
    const registered = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(registered);
    const { client, close } = await connectMcp({
      schemaLoader: ctx.app.locals.schemaLoader,
      user,
    });
    try {
      const res = await client.listTools();
      const names = res.tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining([
        'list_account',
        'get_account',
        'create_account',
        'update_account',
        'delete_account',
        'aggregate_quote_countByAccount',
      ]));
    } finally {
      await close();
    }
  });
});

describe('MCP server: tool calls', () => {
  const ctx = setupTestApp({ cleanCollections: false });

  test('create_account stamps userId from the bound caller', async () => {
    const registered = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(registered);
    const { client, close } = await connectMcp({
      schemaLoader: ctx.app.locals.schemaLoader,
      user,
    });
    try {
      const res = await client.callTool({
        name: 'create_account',
        arguments: { record: { accountName: 'mcp-acme' } },
      });
      const created = parseStructured(res);
      expect(created.accountName).toBe('mcp-acme');
      expect(created.userId).toBe(user.user_id);
      expect(created.userId).toBe(registered._id);
    } finally {
      await close();
    }
  });

  test('list_account filters by tenant — User A and B do not see each other', async () => {
    const aReg = await registerUser(ctx.request, ctx.app);
    const bReg = await registerUser(ctx.request, ctx.app);
    const a = decodedFromRegister(aReg);
    const b = decodedFromRegister(bReg);
    const aMcp = await connectMcp({ schemaLoader: ctx.app.locals.schemaLoader, user: a });
    const bMcp = await connectMcp({ schemaLoader: ctx.app.locals.schemaLoader, user: b });
    try {
      await aMcp.client.callTool({
        name: 'create_account',
        arguments: { record: { accountName: 'A-only' } },
      });
      await bMcp.client.callTool({
        name: 'create_account',
        arguments: { record: { accountName: 'B-only' } },
      });
      const aList = parseStructured(await aMcp.client.callTool({ name: 'list_account', arguments: {} }));
      const bList = parseStructured(await bMcp.client.callTool({ name: 'list_account', arguments: {} }));
      const aNames = aList.results.map((r) => r.accountName);
      const bNames = bList.results.map((r) => r.accountName);
      expect(aNames).toEqual(expect.arrayContaining(['A-only']));
      expect(aNames).not.toContain('B-only');
      expect(bNames).toEqual(expect.arrayContaining(['B-only']));
      expect(bNames).not.toContain('A-only');
    } finally {
      await aMcp.close();
      await bMcp.close();
    }
  });

  test('get_account / update_account / delete_account round-trip', async () => {
    const registered = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(registered);
    const { client, close } = await connectMcp({
      schemaLoader: ctx.app.locals.schemaLoader,
      user,
    });
    try {
      const created = parseStructured(await client.callTool({
        name: 'create_account',
        arguments: { record: { accountName: 'rt-1' } },
      }));
      const fetched = parseStructured(await client.callTool({
        name: 'get_account',
        arguments: { id: created._id },
      }));
      expect(fetched.accountName).toBe('rt-1');

      const updated = parseStructured(await client.callTool({
        name: 'update_account',
        arguments: { id: created._id, record: { accountName: 'rt-1-updated' } },
      }));
      expect(updated.accountName).toBe('rt-1-updated');

      const deleted = parseStructured(await client.callTool({
        name: 'delete_account',
        arguments: { id: created._id },
      }));
      expect(deleted.acknowledged).toBe(true);
      expect(deleted.softDeleted).toBe(true);

      // After soft-delete, get returns NOT_FOUND.
      const missing = await client.callTool({
        name: 'get_account',
        arguments: { id: created._id },
      });
      expect(missing.isError).toBe(true);
      const body = parseStructured(missing);
      expect(body.error.code).toBe('NOT_FOUND');
    } finally {
      await close();
    }
  });

  test('typed errors come back as isError results, not exceptions', async () => {
    const registered = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(registered);
    const { client, close } = await connectMcp({
      schemaLoader: ctx.app.locals.schemaLoader,
      user,
    });
    try {
      // accountName is required; create without it should hit Mongoose
      // validation, which the errorHandler maps to VALIDATION.
      const bad = await client.callTool({
        name: 'create_account',
        arguments: { record: {} },
      });
      expect(bad.isError).toBe(true);
      const body = parseStructured(bad);
      expect(body.error.code).toBe('VALIDATION');
    } finally {
      await close();
    }
  });

  test('aggregate_quote_countByAccount runs through the same safety + tenant code path', async () => {
    const registered = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(registered);
    const { client, close } = await connectMcp({
      schemaLoader: ctx.app.locals.schemaLoader,
      user,
    });
    try {
      // Seed two quotes; the framework stamps accountId from the JWT
      // user_id (legacy quirk), so both group under the same key.
      await client.callTool({
        name: 'create_quote',
        arguments: { record: { contactId: 'c1' } },
      });
      await client.callTool({
        name: 'create_quote',
        arguments: { record: { contactId: 'c2' } },
      });
      const result = parseStructured(await client.callTool({
        name: 'aggregate_quote_countByAccount',
        arguments: {},
      }));
      expect(Array.isArray(result)).toBe(true);
      expect(result[0].count).toBe(2);
    } finally {
      await close();
    }
  });

  test('unauthenticated server (getUser returns null) rejects every tool with UNAUTHORIZED', async () => {
    const { client, close } = await connectMcp({
      schemaLoader: ctx.app.locals.schemaLoader,
      user: null, // simulate "no Bearer token"
    });
    try {
      const res = await client.callTool({ name: 'list_account', arguments: {} });
      expect(res.isError).toBe(true);
      const body = parseStructured(res);
      expect(body.error.code).toBe('UNAUTHORIZED');
    } finally {
      await close();
    }
  });
});

describe('MCP server: hot-reload', () => {
  const ctx = setupTestApp({ cleanCollections: false });

  test('a newly-loaded schema produces tools on the next buildMcpServer call', async () => {
    const before = listToolNames(ctx.app.locals.schemaLoader);
    expect(before).not.toContain('list_dyn_mcp');

    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'dyn_mcp',
      collection: 'dyn_mcp',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
      ],
    });

    const after = listToolNames(ctx.app.locals.schemaLoader);
    expect(after).toContain('list_dyn_mcp');
    expect(after).toContain('create_dyn_mcp');

    await ctx.app.locals.schemaLoader.unloadSchema('v1/dyn_mcp');
    const reverted = listToolNames(ctx.app.locals.schemaLoader);
    expect(reverted).not.toContain('list_dyn_mcp');
  });
});

describe('MCP HTTP transport at /mcp', () => {
  const ctx = setupTestApp({ cleanCollections: false });

  // Streamable HTTP requires a couple of MCP-specific headers and a
  // valid JSON-RPC 2.0 envelope. We hand-craft minimal calls instead
  // of using the SDK Client (which insists on its own session lifecycle
  // that's awkward to mock under supertest).
  const mcpHeaders = (token) => ({
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': '2025-06-18',
  });

  test('rejects missing Bearer with 403 (auth(true) middleware)', async () => {
    const res = await ctx
      .request(ctx.app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('GET /mcp returns 405 (stateless, no SSE upgrade channel)', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const res = await ctx
      .request(ctx.app)
      .get('/mcp')
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  test('initialize handshake succeeds and lists schema-derived tools', async () => {
    const user = await registerUser(ctx.request, ctx.app);

    // 1. initialize
    const init = await ctx
      .request(ctx.app)
      .post('/mcp')
      .set(mcpHeaders(user.token))
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.1' },
        },
      });
    // Streamable HTTP may return either application/json or
    // text/event-stream; both encode the same JSON-RPC envelope.
    expect([200]).toContain(init.status);
    const initBody = init.body && init.body.result
      ? init.body
      : JSON.parse((init.text || '').split('\n').find((l) => l.startsWith('data: ')).slice(6));
    expect(initBody.result.serverInfo).toBeDefined();

    // 2. tools/list
    const list = await ctx
      .request(ctx.app)
      .post('/mcp')
      .set(mcpHeaders(user.token))
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listBody = list.body && list.body.result
      ? list.body
      : JSON.parse((list.text || '').split('\n').find((l) => l.startsWith('data: ')).slice(6));
    const toolNames = listBody.result.tools.map((t) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining([
      'list_account',
      'create_account',
      'aggregate_quote_countByAccount',
    ]));
  });
});
