const jwt = require('jsonwebtoken');
const { setupTestApp, registerUser } = require('./helpers');
const { hashBody } = require('../utils/idempotency');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { buildMcpServer } = require('../utils/mcpServer');

const decodedFromRegister = (registered) => jwt.decode(registered.accessToken);

describe('idempotency: hashBody', () => {
  test('null / undefined / empty stringify to the same canonical hash', () => {
    expect(hashBody(undefined)).toBe(hashBody(null));
    expect(hashBody({})).not.toBe(hashBody(null)); // {} != ''
  });

  test('different payloads hash differently', () => {
    expect(hashBody({ a: 1 })).not.toBe(hashBody({ a: 2 }));
  });
});

describe('idempotency: REST POST routes', () => {
  const ctx = setupTestApp({ cleanCollections: false });

  test('repeating POST with the same Idempotency-Key returns the same record + Idempotency-Replay: true', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const key = 'idem-replay-1';

    const first = await ctx
      .request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send({ accountName: 'Acme' });
    expect(first.status).toBe(201);
    expect(first.headers['idempotency-replay']).toBeUndefined();

    const second = await ctx
      .request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send({ accountName: 'Acme' });
    expect(second.status).toBe(201);
    expect(second.headers['idempotency-replay']).toBe('true');
    // Same _id — no duplicate record was created.
    expect(second.body._id).toBe(first.body._id);
  });

  test('reusing a key with a different body returns 409 IDEMPOTENCY_CONFLICT', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const key = 'idem-conflict-1';

    const ok = await ctx
      .request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send({ accountName: 'first' });
    expect(ok.status).toBe(201);

    const conflict = await ctx
      .request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send({ accountName: 'different' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('CONFLICT');
    expect(conflict.body.error.message).toMatch(/idempotency/i);
  });

  test('keys are scoped per-user (User A and B can use the same key)', async () => {
    const a = await registerUser(ctx.request, ctx.app);
    const b = await registerUser(ctx.request, ctx.app);
    const key = 'idem-shared-key';

    const aRes = await ctx
      .request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${a.token}`)
      .set('Idempotency-Key', key)
      .send({ accountName: 'A-record' });
    expect(aRes.status).toBe(201);

    const bRes = await ctx
      .request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${b.token}`)
      .set('Idempotency-Key', key)
      .send({ accountName: 'B-record' });
    expect(bRes.status).toBe(201);
    // Different records: each user's key is scoped to their tenant.
    expect(bRes.body._id).not.toBe(aRes.body._id);
    expect(bRes.body.accountName).toBe('B-record');
  });

  test('keys are scoped per-route (same key on different paths does not collide)', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const key = 'idem-cross-route';

    const acc = await ctx
      .request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send({ accountName: 'A' });
    expect(acc.status).toBe(201);

    const cat = await ctx
      .request(ctx.app)
      .post('/api/v1/category')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send({ name: 'C' });
    expect(cat.status).toBe(201);
    expect(cat.headers['idempotency-replay']).toBeUndefined();
  });

  test('non-2xx responses are not cached — agent can fix and retry', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const key = 'idem-bad-then-good';

    // First call: missing required field → 400 VALIDATION
    const bad = await ctx
      .request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send({ /* accountName missing */ });
    expect(bad.status).toBe(400);

    // Second call: corrected payload should succeed (NOT replay the
    // 400). This proves we don't cache failures.
    const good = await ctx
      .request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send({ accountName: 'fixed' });
    expect(good.status).toBe(201);
    expect(good.headers['idempotency-replay']).toBeUndefined();
  });

  test('omitting the header preserves existing behaviour (no caching, no Idempotency-Replay header)', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const r1 = await ctx
      .request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ accountName: 'no-key-1' });
    const r2 = await ctx
      .request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ accountName: 'no-key-1' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    // Two separate records — without a key, retries are not deduped.
    expect(r1.body._id).not.toBe(r2.body._id);
    expect(r1.headers['idempotency-replay']).toBeUndefined();
    expect(r2.headers['idempotency-replay']).toBeUndefined();
  });

  test('expired records do not match (TTL is the floor; we simulate via direct collection mutation)', async () => {
    const mongoose = require('mongoose');
    const IdempotencyKey = require('../model/idempotencyKey');
    const user = await registerUser(ctx.request, ctx.app);
    const key = 'idem-ttl-expired';

    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send({ accountName: 'expiring' });
    expect(created.status).toBe(201);

    // Force the record to look expired. Mongo's TTL monitor sweeps
    // on a ~60s cycle so we can't wait — we expire the row by
    // hand and prove that a subsequent request behaves as if the
    // key was never seen (a fresh insert succeeds rather than
    // being deduped to the original). The middleware stores
    // `userId` from the JWT's user_id claim, which equals
    // `user._id` (the User document's id).
    await IdempotencyKey.deleteMany({ key, userId: user._id });

    const retried = await ctx
      .request(ctx.app)
      .post('/api/v1/account')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send({ accountName: 'expiring' });
    expect(retried.status).toBe(201);
    expect(retried.body._id).not.toBe(created.body._id);
    expect(retried.headers['idempotency-replay']).toBeUndefined();
  });
});

describe('idempotency: MCP create_<path>', () => {
  const ctx = setupTestApp({ cleanCollections: false });

  async function connectMcp(user) {
    const server = buildMcpServer({
      schemaLoader: ctx.app.locals.schemaLoader,
      getUser: () => user,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'idem-test', version: '0.0.1' });
    await Promise.all([server.connect(b), client.connect(a)]);
    return {
      client,
      close: async () => { await client.close(); await server.close(); },
    };
  }

  const parseStructured = (res) => {
    if (res.structuredContent !== undefined) return res.structuredContent;
    const txt = res.content && res.content[0] && res.content[0].text;
    return txt ? JSON.parse(txt) : null;
  };

  test('idempotencyKey arg surfaces in the tool schema', async () => {
    const reg = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(reg);
    const { client, close } = await connectMcp(user);
    try {
      const list = await client.listTools();
      const create = list.tools.find((t) => t.name === 'create_account');
      expect(create.inputSchema.properties.idempotencyKey).toBeDefined();
    } finally {
      await close();
    }
  });

  test('repeating create with same key + record returns the same record (replay flag set)', async () => {
    const reg = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(reg);
    const { client, close } = await connectMcp(user);
    try {
      const args = { record: { accountName: 'mcp-idem' }, idempotencyKey: 'mcp-key-1' };
      const first = parseStructured(await client.callTool({ name: 'create_account', arguments: args }));
      const second = parseStructured(await client.callTool({ name: 'create_account', arguments: args }));
      expect(String(first._id)).toBe(String(second._id));
      expect(second._idempotent_replay).toBe(true);
    } finally {
      await close();
    }
  });

  test('reusing a key with a different record returns CONFLICT', async () => {
    const reg = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(reg);
    const { client, close } = await connectMcp(user);
    try {
      const ok = await client.callTool({
        name: 'create_account',
        arguments: { record: { accountName: 'first' }, idempotencyKey: 'mcp-conflict' },
      });
      expect(ok.isError).not.toBe(true);
      const conflict = await client.callTool({
        name: 'create_account',
        arguments: { record: { accountName: 'different' }, idempotencyKey: 'mcp-conflict' },
      });
      expect(conflict.isError).toBe(true);
      const body = parseStructured(conflict);
      expect(body.error.code).toBe('CONFLICT');
    } finally {
      await close();
    }
  });
});
