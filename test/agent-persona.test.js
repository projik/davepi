const jwt = require('jsonwebtoken');
const { setupTestApp, registerUser } = require('./helpers');
const User = require('../model/user');
const { buildMcpServer } = require('../utils/mcpServer');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

/**
 * Workstream A — the `agentPersona` schema (SOUL.md analog).
 *
 * The acceptance bar this file covers:
 *   - Tenant isolation across REST, GraphQL, AND MCP — account A can't
 *     read account B's persona on any of the three surfaces.
 *   - Operators own the persona; an `agent`-role caller is write-gated
 *     on every surface (field-level ACL strips live fields on
 *     REST/GraphQL/MCP create+update; a beforeDelete hook refuses agent
 *     deletes) and can only write `proposedPatch` for operator review.
 *   - `agentKey` is unique per account.
 *
 * The prompt-assembly / sanitizer / fallback half lives in the agent
 * package's promptAssembly test.
 */

const ctx = setupTestApp();

const PATH = '/api/v1/agentPersona';

const auth = (req, token) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
const post = (path, body, token) => auth(ctx.request(ctx.app).post(path).send(body), token);
const get = (path, token) => auth(ctx.request(ctx.app).get(path), token);
const put = (path, body, token) => auth(ctx.request(ctx.app).put(path).send(body), token);
const gql = (token, query, variables) =>
  auth(ctx.request(ctx.app).post('/graphql/').send({ query, variables }), token);

// Mint an access token for an existing user with an arbitrary role set
// — the production agent runs as the tenant owner's user_id but with an
// `agent` role on its service token, which a normal /login can't
// produce. Mirrors utils/tokens.signAccessToken's claim shape.
const tokenFor = (userId, roles) =>
  jwt.sign({ user_id: userId, email: `${userId}@svc`, roles }, process.env.TOKEN_KEY, {
    expiresIn: '15m',
  });

async function connectMcp(user) {
  const server = buildMcpServer({
    schemaLoader: ctx.app.locals.schemaLoader,
    getUser: () => user,
    name: 'persona-test',
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'persona-test-client', version: '0.0.1' });
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

describe('agentPersona: tenant isolation', () => {
  test('REST — account B cannot read account A persona (list + by id)', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);

    const created = await post(
      PATH,
      { agentKey: 'support', identity: 'I am account A support.' },
      a.token
    );
    expect(created.status).toBe(201);
    const id = created.body._id;
    expect(created.body.userId).toBe(a._id);

    // B's list is empty (owner-scoped, no list bypass on this schema).
    const bList = await get(PATH, b.token);
    expect(bList.status).toBe(200);
    const rows = bList.body.results || bList.body;
    expect(Array.isArray(rows) ? rows : rows.results).toEqual([]);

    // B's by-id read of A's persona is a 404.
    const bGet = await get(`${PATH}/${id}`, b.token);
    expect(bGet.status).toBe(404);

    // A still sees their own.
    const aGet = await get(`${PATH}/${id}`, a.token);
    expect(aGet.status).toBe(200);
    expect(aGet.body.identity).toBe('I am account A support.');
  });

  test('GraphQL — account B cannot read account A persona', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);

    const createRes = await gql(
      a.token,
      'mutation { agentPersonaCreateOne(record: { agentKey: "sales", identity: "A-only voice" }) { record { _id identity } } }'
    );
    expect(createRes.body.errors).toBeUndefined();
    const id = createRes.body.data.agentPersonaCreateOne.record._id;

    const bMany = await gql(b.token, 'query { agentPersonaMany { _id identity } }');
    expect(bMany.body.errors).toBeUndefined();
    expect(bMany.body.data.agentPersonaMany).toEqual([]);

    const bById = await gql(
      b.token,
      'query($id: MongoID!) { agentPersonaById(_id: $id) { _id identity } }',
      { id }
    );
    expect(bById.body.errors).toBeUndefined();
    expect(bById.body.data.agentPersonaById).toBeNull();
  });

  test('MCP — account B cannot read account A persona', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);
    const aUser = jwt.decode(a.accessToken);
    const bUser = jwt.decode(b.accessToken);

    const aMcp = await connectMcp(aUser);
    const bMcp = await connectMcp(bUser);
    try {
      const created = parseStructured(
        await aMcp.client.callTool({
          name: 'create_agentPersona',
          arguments: { record: { agentKey: 'ops', identity: 'A ops voice' } },
        })
      );
      expect(created.userId).toBe(a._id);

      const bList = parseStructured(
        await bMcp.client.callTool({ name: 'list_agentPersona', arguments: {} })
      );
      expect(bList.results).toEqual([]);
      expect(bList.totalResults).toBe(0);

      const bGet = await bMcp.client.callTool({
        name: 'get_agentPersona',
        arguments: { id: created._id },
      });
      expect(bGet.isError).toBe(true);
    } finally {
      await aMcp.close();
      await bMcp.close();
    }
  });
});

describe('agentPersona: agentKey uniqueness', () => {
  test('a second persona with the same agentKey for one owner is rejected', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const first = await post(PATH, { agentKey: 'support', identity: 'one' }, a.token);
    expect(first.status).toBe(201);
    const dup = await post(PATH, { agentKey: 'support', identity: 'two' }, a.token);
    expect(dup.status).toBe(409);
  });
});

describe('agentPersona: operators own the persona, agents are write-gated', () => {
  // The agent's service token shares the operator's user_id (so it can
  // read the persona it owns) but carries only the `agent` role.
  const agentTokenFor = (owner) => tokenFor(owner._id, ['agent']);
  const agentUserFor = (owner) => ({ user_id: owner._id, email: `${owner._id}@svc`, roles: ['agent'] });

  test('operator can author and update the live persona directly', async () => {
    const owner = await registerUser(ctx.request, ctx.app); // default role: ['user']
    const created = await post(PATH, { agentKey: 'sales', identity: 'draft identity' }, owner.token);
    expect(created.status).toBe(201);
    const id = created.body._id;

    const upd = await put(`${PATH}/${id}`, { identity: 'final identity' }, owner.token);
    expect(upd.status).toBe(200);

    const after = await get(`${PATH}/${id}`, owner.token);
    expect(after.body.identity).toBe('final identity');
    expect(after.body.proposedPatch == null).toBe(true);
  });

  test('agent-authored create is refused (field ACL strips agentKey; hook 403s)', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const res = await post(
      PATH,
      { agentKey: 'support', identity: 'rogue persona' },
      agentTokenFor(owner)
    );
    expect(res.status).toBe(403);
    // Nothing was persisted.
    const list = await get(PATH, owner.token);
    expect(list.body.results || list.body).toEqual([]);
  });

  test('agent cannot mutate live persona fields via REST update (stripped by ACL)', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const created = await post(
      PATH,
      { agentKey: 'support', identity: 'approved identity', avoid: 'never promise refunds' },
      owner.token
    );
    const id = created.body._id;

    const upd = await put(
      `${PATH}/${id}`,
      { identity: 'rogue identity', avoid: 'promise anything', status: 'archived' },
      agentTokenFor(owner)
    );
    expect(upd.status).toBe(200); // accepted, but every live field was stripped

    const after = await get(`${PATH}/${id}`, owner.token);
    expect(after.body.identity).toBe('approved identity');
    expect(after.body.avoid).toBe('never promise refunds');
    expect(after.body.status).toBe('active');
  });

  test('agent proposes edits by writing proposedPatch; live persona untouched', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const created = await post(PATH, { agentKey: 'support', identity: 'approved' }, owner.token);
    const id = created.body._id;

    const proposal = JSON.stringify({ identity: 'suggested identity' });
    const upd = await put(`${PATH}/${id}`, { proposedPatch: proposal }, agentTokenFor(owner));
    expect(upd.status).toBe(200);

    const after = await get(`${PATH}/${id}`, owner.token);
    expect(after.body.identity).toBe('approved'); // unchanged
    expect(after.body.proposedPatch).toBe(proposal); // proposal recorded for review
  });

  test('an agent update that omits proposedPatch does not clobber a pending one', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const created = await post(PATH, { agentKey: 'support', identity: 'approved' }, owner.token);
    const id = created.body._id;
    // Seed a pending proposal as the operator.
    await put(`${PATH}/${id}`, { proposedPatch: '{"identity":"pending"}' }, owner.token);

    // Agent updates something else (everything but proposedPatch is ACL-stripped,
    // so this is effectively a no-op) — the pending patch must survive.
    const upd = await put(`${PATH}/${id}`, { identity: 'x', status: 'archived' }, agentTokenFor(owner));
    expect(upd.status).toBe(200);

    const after = await get(`${PATH}/${id}`, owner.token);
    expect(after.body.proposedPatch).toBe('{"identity":"pending"}');
  });

  test('agent cannot delete a persona; operator can', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const created = await post(PATH, { agentKey: 'support', identity: 'approved' }, owner.token);
    const id = created.body._id;

    const agentDel = await auth(ctx.request(ctx.app).delete(`${PATH}/${id}`), agentTokenFor(owner));
    expect(agentDel.status).toBe(403);
    expect((await get(`${PATH}/${id}`, owner.token)).status).toBe(200); // still there

    const opDel = await auth(ctx.request(ctx.app).delete(`${PATH}/${id}`), owner.token);
    expect(opDel.status).toBe(200);
  });

  test('agent cannot mutate live fields via MCP update or create', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const created = await post(PATH, { agentKey: 'support', identity: 'approved' }, owner.token);
    const id = created.body._id;

    const agentMcp = await connectMcp(agentUserFor(owner));
    try {
      // Update: live fields stripped, proposedPatch allowed through.
      await agentMcp.client.callTool({
        name: 'update_agentPersona',
        arguments: { id, record: { identity: 'rogue', proposedPatch: '{"identity":"rogue"}' } },
      });
      const after = await get(`${PATH}/${id}`, owner.token);
      expect(after.body.identity).toBe('approved');
      expect(after.body.proposedPatch).toBe('{"identity":"rogue"}');

      // Create: agentKey stripped (required) → validation error, nothing live authored.
      const createRes = await agentMcp.client.callTool({
        name: 'create_agentPersona',
        arguments: { record: { agentKey: 'sales', identity: 'rogue' } },
      });
      expect(createRes.isError).toBe(true);
    } finally {
      await agentMcp.close();
    }
  });

  test('agent cannot mutate live fields via GraphQL updateById', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const created = await post(PATH, { agentKey: 'support', identity: 'approved' }, owner.token);
    const id = created.body._id;

    const res = await gql(
      agentTokenFor(owner),
      'mutation($id: MongoID!) { agentPersonaUpdateById(_id: $id, record: { identity: "rogue" }) { record { identity } } }',
      { id }
    );
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.agentPersonaUpdateById.record.identity).toBe('approved');
  });
});
