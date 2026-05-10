const jwt = require('jsonwebtoken');
const { setupTestApp, registerUser } = require('./helpers');
const { buildMcpServer, listToolNames } = require('../utils/mcpServer');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const {
  ToolListChangedNotificationSchema,
} = require('@modelcontextprotocol/sdk/types.js');

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

  test('unauthenticated server (getUser returns null) flags the error with auth: true', async () => {
    const { client, close } = await connectMcp({
      schemaLoader: ctx.app.locals.schemaLoader,
      user: null, // simulate "no Bearer token"
    });
    try {
      const res = await client.callTool({ name: 'list_account', arguments: {} });
      expect(res.isError).toBe(true);
      const body = parseStructured(res);
      expect(body.error.code).toBe('UNAUTHORIZED');
      // Auth annotation lets clients dispatch credential refresh /
      // re-prompting without parsing free-text codes.
      expect(body.error.auth).toBe(true);
      // UNAUTHORIZED is not retry-recoverable — the call shape isn't
      // the problem.
      expect(body.error.recoverable).toBeUndefined();
    } finally {
      await close();
    }
  });

  test('VALIDATION errors are flagged recoverable so agents can retry with corrected args', async () => {
    const registered = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(registered);
    const { client, close } = await connectMcp({
      schemaLoader: ctx.app.locals.schemaLoader,
      user,
    });
    try {
      // accountName is required — this triggers a Mongoose
      // ValidationError that the handler maps to VALIDATION.
      const bad = await client.callTool({
        name: 'create_account',
        arguments: { record: {} },
      });
      expect(bad.isError).toBe(true);
      const body = parseStructured(bad);
      expect(body.error.code).toBe('VALIDATION');
      expect(body.error.recoverable).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('MCP server: restore / history / search / relation / file tools', () => {
  const ctx = setupTestApp({ cleanCollections: false });

  test('restore_<path>: clears the soft-delete tombstone', async () => {
    const registered = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(registered);
    const { client, close } = await connectMcp({
      schemaLoader: ctx.app.locals.schemaLoader,
      user,
    });
    try {
      const created = parseStructured(await client.callTool({
        name: 'create_account',
        arguments: { record: { accountName: 'restore-me' } },
      }));
      await client.callTool({ name: 'delete_account', arguments: { id: created._id } });
      const restored = parseStructured(await client.callTool({
        name: 'restore_account',
        arguments: { id: created._id },
      }));
      expect(restored.acknowledged).toBe(true);
      expect(restored.restored).toBe(true);
      // Now a get succeeds again.
      const fetched = parseStructured(await client.callTool({
        name: 'get_account',
        arguments: { id: created._id },
      }));
      expect(fetched.accountName).toBe('restore-me');
    } finally {
      await close();
    }
  });

  test('history_<path>: returns audit entries with field-level ACL applied', async () => {
    const registered = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(registered);
    const { client, close } = await connectMcp({
      schemaLoader: ctx.app.locals.schemaLoader,
      user,
    });
    try {
      const created = parseStructured(await client.callTool({
        name: 'create_account',
        arguments: { record: { accountName: 'audit-me' } },
      }));
      await client.callTool({
        name: 'update_account',
        arguments: { id: created._id, record: { description: 'changed' } },
      });
      await client.callTool({ name: 'delete_account', arguments: { id: created._id } });

      const history = parseStructured(await client.callTool({
        name: 'history_account',
        arguments: { id: created._id },
      }));
      const actions = history.results.map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['create', 'update', 'delete']));
    } finally {
      await close();
    }
  });

  test('search_<path>: not registered when no field is searchable', async () => {
    const names = listToolNames(ctx.app.locals.schemaLoader);
    // The seed schemas don't declare any `searchable: true` fields,
    // so the search tool should be absent for every one of them.
    expect(names.find((n) => n.startsWith('search_'))).toBeUndefined();
  });

  test('search_<path>: registered and runs full-text when a field is searchable', async () => {
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'mcp_searchable',
      collection: 'mcp_searchable',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true, searchable: true },
      ],
    });
    try {
      const names = listToolNames(ctx.app.locals.schemaLoader);
      expect(names).toContain('search_mcp_searchable');

      const registered = await registerUser(ctx.request, ctx.app);
      const user = decodedFromRegister(registered);
      const { client, close } = await connectMcp({
        schemaLoader: ctx.app.locals.schemaLoader,
        user,
      });
      try {
        await client.callTool({
          name: 'create_mcp_searchable',
          arguments: { record: { title: 'urgent ticket' } },
        });
        await client.callTool({
          name: 'create_mcp_searchable',
          arguments: { record: { title: 'unrelated note' } },
        });
        const out = parseStructured(await client.callTool({
          name: 'search_mcp_searchable',
          arguments: { q: 'urgent' },
        }));
        expect(out.totalResults).toBeGreaterThanOrEqual(1);
        expect(out.results.map((r) => r.title)).toContain('urgent ticket');
      } finally {
        await close();
      }
    } finally {
      await ctx.app.locals.schemaLoader.unloadSchema('v1/mcp_searchable');
    }
  });

  test('per-relation tools: list_<path>_<rel> for hasMany, get_<path>_<rel> for belongsTo', async () => {
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'mcp_acct',
      collection: 'mcp_acct',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'name', type: String, required: true },
      ],
      relations: { contacts: { hasMany: 'mcp_contact', foreignKey: 'parentId' } },
    }, { deferGraphqlRebuild: true });
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'mcp_contact',
      collection: 'mcp_contact',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'parentId', type: String, required: true },
        { name: 'name', type: String, required: true },
      ],
      relations: { account: { belongsTo: 'mcp_acct', localKey: 'parentId' } },
    });
    try {
      const names = listToolNames(ctx.app.locals.schemaLoader);
      expect(names).toContain('list_mcp_acct_contacts');
      expect(names).toContain('get_mcp_contact_account');

      const registered = await registerUser(ctx.request, ctx.app);
      const user = decodedFromRegister(registered);
      const { client, close } = await connectMcp({
        schemaLoader: ctx.app.locals.schemaLoader,
        user,
      });
      try {
        const acct = parseStructured(await client.callTool({
          name: 'create_mcp_acct',
          arguments: { record: { name: 'Acme' } },
        }));
        await client.callTool({
          name: 'create_mcp_contact',
          arguments: { record: { parentId: acct._id, name: 'Jane' } },
        });
        await client.callTool({
          name: 'create_mcp_contact',
          arguments: { record: { parentId: acct._id, name: 'Bob' } },
        });
        const contacts = parseStructured(await client.callTool({
          name: 'list_mcp_acct_contacts',
          arguments: { id: acct._id },
        }));
        expect(contacts.map((c) => c.name).sort()).toEqual(['Bob', 'Jane']);

        // belongsTo navigation in the other direction.
        const someContact = contacts[0];
        const resolved = parseStructured(await client.callTool({
          name: 'get_mcp_contact_account',
          arguments: { id: someContact._id },
        }));
        expect(resolved.name).toBe('Acme');
      } finally {
        await close();
      }
    } finally {
      await ctx.app.locals.schemaLoader.unloadSchema('v1/mcp_contact');
      await ctx.app.locals.schemaLoader.unloadSchema('v1/mcp_acct');
    }
  });

  test('file upload tool: round-trip via base64', async () => {
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'mcp_doc',
      collection: 'mcp_doc',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String },
        {
          name: 'attachment',
          type: 'File',
          file: { maxBytes: 1024, accept: ['text/plain'], access: 'public' },
        },
      ],
    });
    try {
      const names = listToolNames(ctx.app.locals.schemaLoader);
      expect(names).toContain('upload_mcp_doc_attachment');
      expect(names).toContain('fetch_mcp_doc_attachment');
      expect(names).toContain('delete_mcp_doc_attachment');

      const registered = await registerUser(ctx.request, ctx.app);
      const user = decodedFromRegister(registered);
      const { client, close } = await connectMcp({
        schemaLoader: ctx.app.locals.schemaLoader,
        user,
      });
      try {
        const doc = parseStructured(await client.callTool({
          name: 'create_mcp_doc',
          arguments: { record: { title: 't' } },
        }));
        const body = Buffer.from('hello world').toString('base64');
        const meta = parseStructured(await client.callTool({
          name: 'upload_mcp_doc_attachment',
          arguments: {
            id: doc._id,
            base64: body,
            filename: 'hello.txt',
            mimeType: 'text/plain',
          },
        }));
        expect(meta.size).toBe(11);
        expect(meta.contentType).toBe('text/plain');

        const fetched = parseStructured(await client.callTool({
          name: 'fetch_mcp_doc_attachment',
          arguments: { id: doc._id },
        }));
        expect(fetched.url).toBeDefined();
        expect(fetched.meta.size).toBe(11);

        // Reject a file over maxBytes (1024).
        const tooBig = await client.callTool({
          name: 'upload_mcp_doc_attachment',
          arguments: {
            id: doc._id,
            base64: Buffer.alloc(2048, 'a').toString('base64'),
            filename: 'big.txt',
            mimeType: 'text/plain',
          },
        });
        expect(tooBig.isError).toBe(true);
        expect(parseStructured(tooBig).error.code).toBe('VALIDATION');

        // Reject the wrong mime type.
        const wrongMime = await client.callTool({
          name: 'upload_mcp_doc_attachment',
          arguments: {
            id: doc._id,
            base64: body,
            filename: 'hello.bin',
            mimeType: 'application/octet-stream',
          },
        });
        expect(wrongMime.isError).toBe(true);
        expect(parseStructured(wrongMime).error.code).toBe('VALIDATION');
      } finally {
        await close();
      }
    } finally {
      await ctx.app.locals.schemaLoader.unloadSchema('v1/mcp_doc');
    }
  });

  test('update_<path>: empty writable (every field ACL-stripped) does not return a misleading 404', async () => {
    // Schema where every field is gated to a role the test user
    // doesn't have on update — so filterWritable returns {} and the
    // REST contract says "verify the doc still exists, then no-op".
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'mcp_locked',
      collection: 'mcp_locked',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'note', type: String, acl: { update: ['admin'] } },
      ],
    });
    try {
      const registered = await registerUser(ctx.request, ctx.app);
      const user = decodedFromRegister(registered); // 'user' role only
      const { client, close } = await connectMcp({
        schemaLoader: ctx.app.locals.schemaLoader,
        user,
      });
      try {
        const created = parseStructured(await client.callTool({
          name: 'create_mcp_locked',
          arguments: { record: { note: 'seeded' } }, // also ACL-stripped, but record is created
        }));
        const out = await client.callTool({
          name: 'update_mcp_locked',
          arguments: { id: created._id, record: { note: 'attempted' } },
        });
        // Should NOT be NOT_FOUND just because the writable shape was empty.
        expect(out.isError).not.toBe(true);
        const fresh = parseStructured(out);
        expect(String(fresh._id)).toBe(String(created._id));
      } finally {
        await close();
      }
    } finally {
      await ctx.app.locals.schemaLoader.unloadSchema('v1/mcp_locked');
    }
  });

  test('update_<path>: client cannot reassign userId/accountId via record payload', async () => {
    const registered = await registerUser(ctx.request, ctx.app);
    const otherReg = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(registered);
    const { client, close } = await connectMcp({
      schemaLoader: ctx.app.locals.schemaLoader,
      user,
    });
    try {
      const created = parseStructured(await client.callTool({
        name: 'create_account',
        arguments: { record: { accountName: 'tenant-test' } },
      }));
      // Try to hijack ownership: pass a different userId / accountId
      // in the update payload. The server must strip them.
      const updated = parseStructured(await client.callTool({
        name: 'update_account',
        arguments: {
          id: created._id,
          record: {
            accountName: 'new name',
            userId: otherReg._id,
            accountId: otherReg._id,
          },
        },
      }));
      expect(updated.accountName).toBe('new name');
      // userId stayed bound to the original tenant — the payload's
      // forged userId was stripped by the update handler.
      expect(updated.userId).toBe(user.user_id);
      expect(updated.userId).not.toBe(otherReg._id);
    } finally {
      await close();
    }
  });
});

describe('MCP server: hot-reload', () => {
  const ctx = setupTestApp({ cleanCollections: false });

  test('listToolNames includes restore/history per-schema (seed schemas have softDelete + audit by default)', () => {
    const names = listToolNames(ctx.app.locals.schemaLoader);
    expect(names).toContain('restore_account');
    expect(names).toContain('history_account');
  });

  test('liveReload: tools rebuild on schemaLoader.onChange and clients get tools/list_changed', async () => {
    const registered = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(registered);
    const { buildMcpServer } = require('../utils/mcpServer');
    const server = buildMcpServer({
      schemaLoader: ctx.app.locals.schemaLoader,
      getUser: () => user,
      liveReload: true,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'reload-client', version: '0.0.1' });
    let listChangedCount = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      listChangedCount += 1;
    });
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const beforeList = await client.listTools();
      const beforeNames = beforeList.tools.map((t) => t.name);
      expect(beforeNames).not.toContain('list_dyn_reload');

      await ctx.app.locals.schemaLoader.loadSchema({
        path: 'dyn_reload',
        collection: 'dyn_reload',
        version: 'v1',
        fields: [
          { name: 'userId', type: String, required: true },
          { name: 'title', type: String, required: true },
        ],
      });

      // Give the SDK a tick to flush the notification.
      await new Promise((r) => setImmediate(r));

      const afterList = await client.listTools();
      const afterNames = afterList.tools.map((t) => t.name);
      expect(afterNames).toContain('list_dyn_reload');
      expect(afterNames).toContain('create_dyn_reload');
      expect(listChangedCount).toBeGreaterThan(0);
    } finally {
      await ctx.app.locals.schemaLoader.unloadSchema('v1/dyn_reload');
      await client.close();
      await server.close();
    }
  });

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

  test('GET /mcp without Bearer is rejected by auth middleware before reaching the 405 handler', async () => {
    const res = await ctx.request(ctx.app).get('/mcp');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('GET /mcp with valid Bearer returns 405 through the centralised errorHandler', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const res = await ctx
      .request(ctx.app)
      .get('/mcp')
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  test('DELETE /mcp also goes through auth + 405', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const res = await ctx
      .request(ctx.app)
      .delete('/mcp')
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
