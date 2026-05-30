const jwt = require('jsonwebtoken');
const { setupTestApp, registerUser } = require('./helpers');
const { buildMcpServer } = require('../utils/mcpServer');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

/**
 * Workstream C — the `skill` schema (governed procedural memory with
 * L0/L1/L2 progressive disclosure).
 *
 * Acceptance bar covered here (the backend half):
 *   - Tenant isolation across REST, GraphQL, AND MCP — account A can't
 *     read another account's skills on any surface.
 *   - Governance: an `agent`-role caller (sharing the tenant userId) can
 *     CREATE skills, but every create lands `draft` regardless of what it
 *     supplies, and the agent cannot transition `draft → approved` on any
 *     surface — only an operator can.
 *   - The state machine constrains the operator to draft → approved →
 *     deprecated; an illegal transition is a 400.
 *   - The L0 query (`status: approved`) only ever returns approved skills,
 *     so drafts are invisible and deprecated skills drop out again.
 *
 * The prompt-index rendering (slot #3) lives in the agent package's
 * promptAssembly + orchestrator tests.
 */

const ctx = setupTestApp();

const PATH = '/api/v1/skill';

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
    name: 'skill-test',
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'skill-test-client', version: '0.0.1' });
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

const agentUserFor = (owner) => ({ user_id: owner._id, email: `${owner._id}@svc`, roles: ['agent'] });

describe('skill: tenant isolation', () => {
  test('REST — account B cannot read account A skills (list + by id)', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);

    const created = await post(
      PATH,
      { agentKey: 'support', name: 'Issue a refund', description: 'within policy', body: 'steps' },
      a.token
    );
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
    expect(aGet.body.name).toBe('Issue a refund');
  });

  test('GraphQL — account B cannot read account A skills', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);

    const createRes = await gql(
      a.token,
      'mutation { skillCreateOne(record: { agentKey: "sales", name: "Upsell", body: "graph body" }) { record { _id name } } }'
    );
    expect(createRes.body.errors).toBeUndefined();
    const id = createRes.body.data.skillCreateOne.record._id;

    const bMany = await gql(b.token, 'query { skillMany { _id name } }');
    expect(bMany.body.errors).toBeUndefined();
    expect(bMany.body.data.skillMany).toEqual([]);

    const bById = await gql(
      b.token,
      'query($id: MongoID!) { skillById(_id: $id) { _id name } }',
      { id }
    );
    expect(bById.body.errors).toBeUndefined();
    expect(bById.body.data.skillById).toBeNull();
  });

  test('MCP — account B cannot read account A skills', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);
    const aUser = jwt.decode(a.accessToken);
    const bUser = jwt.decode(b.accessToken);

    const aMcp = await connectMcp(aUser);
    const bMcp = await connectMcp(bUser);
    try {
      const created = parseStructured(
        await aMcp.client.callTool({
          name: 'create_skill',
          arguments: { record: { agentKey: 'ops', name: 'Triage', body: 'A body' } },
        })
      );
      expect(created.userId).toBe(a._id);

      const bList = parseStructured(
        await bMcp.client.callTool({ name: 'list_skill', arguments: {} })
      );
      expect(bList.results).toEqual([]);
      expect(bList.totalResults).toBe(0);

      const bGet = await bMcp.client.callTool({
        name: 'get_skill',
        arguments: { id: created._id },
      });
      expect(bGet.isError).toBe(true);
    } finally {
      await aMcp.close();
      await bMcp.close();
    }
  });
});

describe('skill: governance (create lands draft; only operators approve)', () => {
  test('agent (service role) can create a skill, but it lands as draft', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const agentMcp = await connectMcp(agentUserFor(owner));
    try {
      // Even with a forged status, the create is forced to `draft`.
      const created = parseStructured(
        await agentMcp.client.callTool({
          name: 'create_skill',
          arguments: {
            record: { agentKey: 'support', name: 'Refund', body: 'runbook', status: 'approved' },
          },
        })
      );
      expect(created.userId).toBe(owner._id);
      expect(created.name).toBe('Refund');
      expect(created.status).toBe('draft');
    } finally {
      await agentMcp.close();
    }
  });

  test('agent cannot transition draft → approved (status stripped on MCP update)', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const agentMcp = await connectMcp(agentUserFor(owner));
    try {
      const created = parseStructured(
        await agentMcp.client.callTool({
          name: 'create_skill',
          arguments: { record: { agentKey: 'support', name: 'Refund', body: 'runbook' } },
        })
      );
      expect(created.status).toBe('draft');

      // The agent's attempt to approve is a no-op: field ACL strips
      // `status`, so no transition fires and the skill stays draft.
      const updated = parseStructured(
        await agentMcp.client.callTool({
          name: 'update_skill',
          arguments: { id: created._id, record: { status: 'approved', body: 'refined' } },
        })
      );
      expect(updated.status).toBe('draft');
      // The non-governed field still updates.
      expect(updated.body).toBe('refined');
    } finally {
      await agentMcp.close();
    }
  });

  test('operator REST create is also forced to draft, then can be approved', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const created = await post(
      PATH,
      { agentKey: 'support', name: 'Refund', body: 'runbook', status: 'approved' },
      owner.token
    );
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('draft'); // stampInitialStates + beforeCreate

    const approved = await put(`${PATH}/${created.body._id}`, { status: 'approved' }, owner.token);
    expect(approved.status).toBe(200);
    const after = await get(`${PATH}/${created.body._id}`, owner.token);
    expect(after.body.status).toBe('approved');
  });

  test('operator cannot make an illegal transition (approved → draft is 400)', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const created = await post(PATH, { agentKey: 'support', name: 'Refund', body: 'r' }, owner.token);
    await put(`${PATH}/${created.body._id}`, { status: 'approved' }, owner.token);

    const bad = await put(`${PATH}/${created.body._id}`, { status: 'draft' }, owner.token);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_TRANSITION');
  });

  test('agent cannot delete a skill (beforeDelete refuses; operator can)', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const created = await post(PATH, { agentKey: 'support', name: 'Refund', body: 'r' }, owner.token);
    const id = created.body._id;

    const agentDelete = await auth(
      ctx.request(ctx.app).delete(`${PATH}/${id}`),
      tokenFor(owner._id, ['agent'])
    );
    expect(agentDelete.status).toBe(403);

    const opDelete = await auth(ctx.request(ctx.app).delete(`${PATH}/${id}`), owner.token);
    expect(opDelete.status).toBe(200); // soft-delete tombstone
    expect(opDelete.body.softDeleted).toBe(true);

    const gone = await get(`${PATH}/${id}`, owner.token);
    expect(gone.status).toBe(404);
  });
});

describe('skill: L0 index only ever shows approved skills', () => {
  test('the approved-status filter excludes draft and deprecated skills', async () => {
    const owner = await registerUser(ctx.request, ctx.app);

    // Three skills in three states.
    const draft = await post(PATH, { agentKey: 'support', name: 'Draft one', body: 'd' }, owner.token);
    const approved = await post(PATH, { agentKey: 'support', name: 'Approved one', body: 'a' }, owner.token);
    const deprecated = await post(PATH, { agentKey: 'support', name: 'Old one', body: 'o' }, owner.token);

    await put(`${PATH}/${approved.body._id}`, { status: 'approved' }, owner.token);
    await put(`${PATH}/${deprecated.body._id}`, { status: 'approved' }, owner.token);
    await put(`${PATH}/${deprecated.body._id}`, { status: 'deprecated' }, owner.token);

    // The L0 index query the orchestrator runs.
    const l0 = await get(`${PATH}?status=approved&agentKey=support`, owner.token);
    expect(l0.status).toBe(200);
    const names = (l0.body.results || l0.body).map((r) => r.name);
    expect(names).toContain('Approved one');
    expect(names).not.toContain('Draft one');
    expect(names).not.toContain('Old one');

    // Sanity: the draft and deprecated rows still exist, just not in L0.
    expect(draft.body.status).toBe('draft');
    const all = await get(`${PATH}?agentKey=support`, owner.token);
    expect((all.body.results || all.body).length).toBe(3);
  });
});

describe('skill: unique name per (tenant, agentKey)', () => {
  test('a second skill with the same name + agentKey for one owner is rejected', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const first = await post(PATH, { agentKey: 'support', name: 'Refund', body: 'one' }, a.token);
    expect(first.status).toBe(201);
    const dup = await post(PATH, { agentKey: 'support', name: 'Refund', body: 'two' }, a.token);
    expect(dup.status).toBe(409);
    // Same name under a different agentKey is fine.
    const other = await post(PATH, { agentKey: 'sales', name: 'Refund', body: 'three' }, a.token);
    expect(other.status).toBe(201);
  });
});
