const jwt = require('jsonwebtoken');
const { setupTestApp, registerUser } = require('./helpers');
const { buildMcpServer } = require('../utils/mcpServer');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

/**
 * Workstream B — the `conversation` schema (durable history + frozen
 * snapshot home). Confirms tenant isolation on the new schema and that
 * the agent's own create/update round-trip works under its identity.
 */

const ctx = setupTestApp();

const PATH = '/api/v1/conversation';

const auth = (req, token) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
const post = (path, body, token) => auth(ctx.request(ctx.app).post(path).send(body), token);
const get = (path, token) => auth(ctx.request(ctx.app).get(path), token);

const agentUserFor = (owner) => ({ user_id: owner._id, email: `${owner._id}@svc`, roles: ['agent'] });

async function connectMcp(user) {
  const server = buildMcpServer({
    schemaLoader: ctx.app.locals.schemaLoader,
    getUser: () => user,
    name: 'conversation-test',
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'conversation-test-client', version: '0.0.1' });
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

describe('conversation: tenant isolation', () => {
  test('REST — account B cannot read account A conversation', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);

    const created = await post(
      PATH,
      {
        agentKey: 'support',
        channel: 'slack',
        conversationId: 'C1::T1',
        channelUserId: 'U1',
        history: JSON.stringify([{ role: 'user', content: 'hi' }]),
      },
      a.token
    );
    expect(created.status).toBe(201);
    expect(created.body.userId).toBe(a._id);

    const bGet = await get(`${PATH}/${created.body._id}`, b.token);
    expect(bGet.status).toBe(404);
  });
});

describe('conversation: agent persists and resumes its own history', () => {
  test('agent creates, then updates, its conversation row by id', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const mcp = await connectMcp(agentUserFor(owner));
    try {
      const created = parseStructured(
        await mcp.client.callTool({
          name: 'create_conversation',
          arguments: {
            record: {
              agentKey: 'support',
              channel: 'slack',
              conversationId: 'C1::T1',
              channelUserId: 'U1',
              history: JSON.stringify([{ role: 'user', content: 'first' }]),
              systemSnapshot: 'FROZEN PREFIX',
            },
          },
        })
      );
      expect(created.userId).toBe(owner._id);
      expect(created.systemSnapshot).toBe('FROZEN PREFIX');

      // Look it up the way the orchestrator does, then append a turn.
      const list = parseStructured(
        await mcp.client.callTool({
          name: 'list_conversation',
          arguments: { filter: { agentKey: 'support', channel: 'slack', conversationId: 'C1::T1' } },
        })
      );
      expect(list.results.length).toBe(1);

      const updated = parseStructured(
        await mcp.client.callTool({
          name: 'update_conversation',
          arguments: {
            id: created._id,
            record: { history: JSON.stringify([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }]) },
          },
        })
      );
      expect(JSON.parse(updated.history).length).toBe(2);
      // Frozen snapshot untouched by the history update.
      expect(updated.systemSnapshot).toBe('FROZEN PREFIX');
    } finally {
      await mcp.close();
    }
  });

  test('one conversation per (tenant, agentKey, channel, conversationId)', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const body = { agentKey: 'support', channel: 'slack', conversationId: 'C9::T1', channelUserId: 'U7' };
    const first = await post(PATH, body, a.token);
    expect(first.status).toBe(201);
    const dup = await post(PATH, body, a.token);
    expect(dup.status).toBe(409);
  });

  test('same user, different Slack threads → distinct conversation rows', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const base = { agentKey: 'support', channel: 'slack', channelUserId: 'U7' };
    const t1 = await post(PATH, { ...base, conversationId: 'C::T1' }, a.token);
    const t2 = await post(PATH, { ...base, conversationId: 'C::T2' }, a.token);
    expect(t1.status).toBe(201);
    expect(t2.status).toBe(201); // not a 409 — different thread, different row
    expect(t1.body._id).not.toBe(t2.body._id);
  });
});
