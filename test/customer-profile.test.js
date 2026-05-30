const jwt = require('jsonwebtoken');
const { setupTestApp, registerUser } = require('./helpers');
const { buildMcpServer } = require('../utils/mcpServer');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

/**
 * Workstream B — the `customerProfile` schema (USER.md analog).
 *
 * Acceptance bar covered here:
 *   - Tenant isolation across REST, GraphQL, AND MCP.
 *   - Self-authored: an `agent`-role caller can create/update profiles.
 *   - Shared across agents of one tenant — keyed by endUserKey, no
 *     agentKey, so any agent reads the same profile under the owner scope.
 */

const ctx = setupTestApp();

const PATH = '/api/v1/customerProfile';

const auth = (req, token) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
const post = (path, body, token) => auth(ctx.request(ctx.app).post(path).send(body), token);
const get = (path, token) => auth(ctx.request(ctx.app).get(path), token);
const gql = (token, query, variables) =>
  auth(ctx.request(ctx.app).post('/graphql/').send({ query, variables }), token);

const agentUserFor = (owner) => ({ user_id: owner._id, email: `${owner._id}@svc`, roles: ['agent'] });

async function connectMcp(user) {
  const server = buildMcpServer({
    schemaLoader: ctx.app.locals.schemaLoader,
    getUser: () => user,
    name: 'profile-test',
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'profile-test-client', version: '0.0.1' });
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
  const txt = res.content && res.content[0] && res.content[0].text;
  return txt ? JSON.parse(txt) : null;
};

describe('customerProfile: tenant isolation', () => {
  test('REST — account B cannot read account A profile', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);

    const created = await post(
      PATH,
      { endUserKey: 'slack:U1', preferences: 'email', notes: 'A note' },
      a.token
    );
    expect(created.status).toBe(201);
    const id = created.body._id;
    expect(created.body.userId).toBe(a._id);

    const bGet = await get(`${PATH}/${id}`, b.token);
    expect(bGet.status).toBe(404);

    const bList = await get(PATH, b.token);
    const rows = bList.body.results || bList.body;
    expect(Array.isArray(rows) ? rows : rows.results).toEqual([]);
  });

  test('GraphQL — account B cannot read account A profile', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);

    const createRes = await gql(
      a.token,
      'mutation { customerProfileCreateOne(record: { endUserKey: "slack:U9", notes: "A graph note" }) { record { _id notes } } }'
    );
    expect(createRes.body.errors).toBeUndefined();

    const bMany = await gql(b.token, 'query { customerProfileMany { _id notes } }');
    expect(bMany.body.errors).toBeUndefined();
    expect(bMany.body.data.customerProfileMany).toEqual([]);
  });

  test('MCP — account B cannot read account A profile', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);

    const aMcp = await connectMcp(agentUserFor(a));
    const bMcp = await connectMcp(agentUserFor(b));
    try {
      const created = parseStructured(
        await aMcp.client.callTool({
          name: 'create_customerProfile',
          arguments: { record: { endUserKey: 'slack:U1', preferences: 'email' } },
        })
      );
      expect(created.userId).toBe(a._id);
      // Self-authored via MCP → provenance default.
      expect(created.updatedBy).toBe('agent');

      const bList = parseStructured(
        await bMcp.client.callTool({ name: 'list_customerProfile', arguments: {} })
      );
      expect(bList.results).toEqual([]);

      const bGet = await bMcp.client.callTool({
        name: 'get_customerProfile',
        arguments: { id: created._id },
      });
      expect(bGet.isError).toBe(true);
    } finally {
      await aMcp.close();
      await bMcp.close();
    }
  });
});

describe('customerProfile: shared across agents of one tenant', () => {
  test('a profile created by one agent is visible to another agent on the same tenant', async () => {
    const owner = await registerUser(ctx.request, ctx.app);

    // "support" agent records the profile...
    const supportMcp = await connectMcp(agentUserFor(owner));
    let id;
    try {
      const created = parseStructured(
        await supportMcp.client.callTool({
          name: 'create_customerProfile',
          arguments: { record: { endUserKey: 'slack:U1', preferences: 'prefers email' } },
        })
      );
      id = created._id;
    } finally {
      await supportMcp.close();
    }

    // ...and the "sales" agent (same tenant userId) reads it back by endUserKey.
    const salesMcp = await connectMcp(agentUserFor(owner));
    try {
      const list = parseStructured(
        await salesMcp.client.callTool({
          name: 'list_customerProfile',
          arguments: { filter: { endUserKey: 'slack:U1' } },
        })
      );
      expect(list.results.length).toBe(1);
      expect(String(list.results[0]._id)).toBe(String(id));
      expect(list.results[0].preferences).toBe('prefers email');
    } finally {
      await salesMcp.close();
    }
  });

  test('one profile per (tenant, endUserKey)', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const first = await post(PATH, { endUserKey: 'slack:U2', notes: 'one' }, a.token);
    expect(first.status).toBe(201);
    const dup = await post(PATH, { endUserKey: 'slack:U2', notes: 'two' }, a.token);
    expect(dup.status).toBe(409);
  });
});
