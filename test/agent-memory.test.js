const jwt = require('jsonwebtoken');
const { setupTestApp, registerUser } = require('./helpers');
const { buildMcpServer } = require('../utils/mcpServer');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

/**
 * Workstream B — the `agentMemory` schema (MEMORY.md analog).
 *
 * Acceptance bar covered here:
 *   - Tenant isolation across REST, GraphQL, AND MCP — account A can't
 *     read or write account B's memory on any surface.
 *   - Self-authored: an `agent`-role caller (sharing the tenant userId)
 *     CAN create/update its own memory, unlike the operator-only persona.
 *   - Provenance: agent (MCP) writes are stamped `agent`; operator
 *     (REST/GraphQL) writes are stamped `operator:<id>`.
 *
 * The prompt-snapshot / sanitizer half lives in the agent package's
 * promptAssembly + conversation tests.
 */

const ctx = setupTestApp();

const PATH = '/api/v1/agentMemory';

const auth = (req, token) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
const post = (path, body, token) => auth(ctx.request(ctx.app).post(path).send(body), token);
const get = (path, token) => auth(ctx.request(ctx.app).get(path), token);
const put = (path, body, token) => auth(ctx.request(ctx.app).put(path).send(body), token);
const gql = (token, query, variables) =>
  auth(ctx.request(ctx.app).post('/graphql/').send({ query, variables }), token);

const tokenFor = (userId, roles) =>
  jwt.sign({ user_id: userId, email: `${userId}@svc`, roles }, process.env.TOKEN_KEY, {
    expiresIn: '15m',
  });

async function connectMcp(user) {
  const server = buildMcpServer({
    schemaLoader: ctx.app.locals.schemaLoader,
    getUser: () => user,
    name: 'memory-test',
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'memory-test-client', version: '0.0.1' });
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

describe('agentMemory: tenant isolation', () => {
  test('REST — account B cannot read account A memory (list + by id)', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);

    const created = await post(PATH, { agentKey: 'support', body: 'A-only memory' }, a.token);
    expect(created.status).toBe(201);
    const id = created.body._id;
    expect(created.body.userId).toBe(a._id);

    const bList = await get(PATH, b.token);
    expect(bList.status).toBe(200);
    const rows = bList.body.results || bList.body;
    expect(Array.isArray(rows) ? rows : rows.results).toEqual([]);

    const bGet = await get(`${PATH}/${id}`, b.token);
    expect(bGet.status).toBe(404);

    const aGet = await get(`${PATH}/${id}`, a.token);
    expect(aGet.status).toBe(200);
    expect(aGet.body.body).toBe('A-only memory');
  });

  test('GraphQL — account B cannot read account A memory', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);

    const createRes = await gql(
      a.token,
      'mutation { agentMemoryCreateOne(record: { agentKey: "sales", body: "A graph memory" }) { record { _id body } } }'
    );
    expect(createRes.body.errors).toBeUndefined();
    const id = createRes.body.data.agentMemoryCreateOne.record._id;

    const bMany = await gql(b.token, 'query { agentMemoryMany { _id body } }');
    expect(bMany.body.errors).toBeUndefined();
    expect(bMany.body.data.agentMemoryMany).toEqual([]);

    const bById = await gql(
      b.token,
      'query($id: MongoID!) { agentMemoryById(_id: $id) { _id body } }',
      { id }
    );
    expect(bById.body.errors).toBeUndefined();
    expect(bById.body.data.agentMemoryById).toBeNull();
  });

  test('MCP — account B cannot read account A memory', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);
    const aUser = jwt.decode(a.accessToken);
    const bUser = jwt.decode(b.accessToken);

    const aMcp = await connectMcp(aUser);
    const bMcp = await connectMcp(bUser);
    try {
      const created = parseStructured(
        await aMcp.client.callTool({
          name: 'create_agentMemory',
          arguments: { record: { agentKey: 'ops', body: 'A ops memory' } },
        })
      );
      expect(created.userId).toBe(a._id);

      const bList = parseStructured(
        await bMcp.client.callTool({ name: 'list_agentMemory', arguments: {} })
      );
      expect(bList.results).toEqual([]);
      expect(bList.totalResults).toBe(0);

      const bGet = await bMcp.client.callTool({
        name: 'get_agentMemory',
        arguments: { id: created._id },
      });
      expect(bGet.isError).toBe(true);
    } finally {
      await aMcp.close();
      await bMcp.close();
    }
  });
});

describe('agentMemory: self-authored, with provenance', () => {
  const agentTokenFor = (owner) => tokenFor(owner._id, ['agent']);
  const agentUserFor = (owner) => ({ user_id: owner._id, email: `${owner._id}@svc`, roles: ['agent'] });

  test('agent (service role) can create and update its own memory', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const agentMcp = await connectMcp(agentUserFor(owner));
    try {
      const created = parseStructured(
        await agentMcp.client.callTool({
          name: 'create_agentMemory',
          arguments: { record: { agentKey: 'support', body: 'learned fact' } },
        })
      );
      expect(created.userId).toBe(owner._id);
      expect(created.body).toBe('learned fact');
      // MCP is hookless, so the field default marks the self-authored write.
      expect(created.updatedBy).toBe('agent');

      const updated = parseStructured(
        await agentMcp.client.callTool({
          name: 'update_agentMemory',
          arguments: { id: created._id, record: { body: 'refined fact' } },
        })
      );
      expect(updated.body).toBe('refined fact');
    } finally {
      await agentMcp.close();
    }
  });

  test('operator REST/GraphQL writes stamp operator provenance', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const created = await post(PATH, { agentKey: 'support', body: 'operator note' }, owner.token);
    expect(created.status).toBe(201);
    expect(created.body.updatedBy).toBe(`operator:${owner._id}`);

    const upd = await put(`${PATH}/${created.body._id}`, { body: 'edited by operator' }, owner.token);
    expect(upd.status).toBe(200);
    const after = await get(`${PATH}/${created.body._id}`, owner.token);
    expect(after.body.body).toBe('edited by operator');
    expect(after.body.updatedBy).toBe(`operator:${owner._id}`);
  });
});

describe('agentMemory: one row per (tenant, agentKey)', () => {
  test('a second memory with the same agentKey for one owner is rejected', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const first = await post(PATH, { agentKey: 'support', body: 'one' }, a.token);
    expect(first.status).toBe(201);
    const dup = await post(PATH, { agentKey: 'support', body: 'two' }, a.token);
    expect(dup.status).toBe(409);
  });
});
