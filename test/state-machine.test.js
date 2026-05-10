const jwt = require('jsonwebtoken');
const { setupTestApp, registerUser } = require('./helpers');
const {
  isStateMachineField,
  validateTransition,
  computeAvailableTransitions,
  stampInitialStates,
  listTransitionsToValidate,
  attachAvailableTransitions,
} = require('../utils/stateMachine');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { buildMcpServer } = require('../utils/mcpServer');

const sm = {
  initial: 'draft',
  states: ['draft', 'review', 'approved', 'rejected', 'archived'],
  transitions: {
    draft: ['review', 'archived'],
    review: ['approved', 'rejected'],
    approved: ['archived'],
    rejected: ['draft'],
    archived: [],
  },
};

// One outer describe owns the app + Mongo lifecycle. Pure-helper
// tests don't need it but live inside as nested suites — keeping a
// single setupTestApp avoids the cross-describe teardown races where
// an in-flight bus handler from the integration suite hits the
// disconnected pool of a sibling suite that already finished.
const ctx = setupTestApp({ cleanCollections: false });

describe('stateMachine', () => {

describe('pure helpers', () => {
  test('isStateMachineField requires `states` array', () => {
    expect(isStateMachineField({ name: 's', stateMachine: sm })).toBe(true);
    expect(isStateMachineField({ name: 's', stateMachine: { initial: 'x' } })).toBe(false);
    expect(isStateMachineField({ name: 's' })).toBe(false);
    expect(isStateMachineField(null)).toBe(false);
  });

  test('validateTransition: same value is a valid no-op', () => {
    const v = validateTransition({ stateMachine: sm }, 'draft', 'draft');
    expect(v.valid).toBe(true);
    expect(v.transition).toBe(false);
  });

  test('validateTransition: declared edge is allowed', () => {
    const v = validateTransition({ stateMachine: sm }, 'draft', 'review');
    expect(v).toMatchObject({ valid: true, transition: true });
  });

  test('validateTransition: undeclared edge is rejected with structured details', () => {
    const v = validateTransition({ name: 'status', stateMachine: sm }, 'draft', 'approved');
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('invalid_transition');
    expect(v.current).toBe('draft');
    expect(v.attempted).toBe('approved');
    expect(v.allowed).toEqual(['review', 'archived']);
  });

  test('validateTransition: terminal state has empty allowed list', () => {
    const v = validateTransition({ name: 'status', stateMachine: sm }, 'archived', 'draft');
    expect(v.valid).toBe(false);
    expect(v.allowed).toEqual([]);
    expect(v.message).toMatch(/terminal state/);
  });

  test('validateTransition: from null only initial is acceptable', () => {
    const ok = validateTransition({ name: 'status', stateMachine: sm }, null, 'draft');
    expect(ok.valid).toBe(true);
    const bad = validateTransition({ name: 'status', stateMachine: sm }, null, 'approved');
    expect(bad.valid).toBe(false);
    expect(bad.reason).toBe('initial_state_required');
  });

  test('validateTransition: unknown state is rejected before edge check', () => {
    const v = validateTransition({ name: 'status', stateMachine: sm }, 'draft', 'made-up');
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('unknown_state');
  });

  test('computeAvailableTransitions returns initial when current is empty', () => {
    expect(computeAvailableTransitions({ stateMachine: sm }, null)).toEqual(['draft']);
    expect(computeAvailableTransitions({ stateMachine: sm }, '')).toEqual(['draft']);
  });

  test('computeAvailableTransitions returns the declared edges', () => {
    expect(computeAvailableTransitions({ stateMachine: sm }, 'review')).toEqual(['approved', 'rejected']);
    expect(computeAvailableTransitions({ stateMachine: sm }, 'archived')).toEqual([]);
  });

  test('stampInitialStates overwrites client-supplied non-initial states', () => {
    const schema = {
      fields: [
        { name: 'status', type: String, stateMachine: sm },
      ],
    };
    const data = { status: 'approved' };
    stampInitialStates(data, schema);
    expect(data.status).toBe('draft');
  });

  test('listTransitionsToValidate skips no-op (current === next) and missing keys', () => {
    const schema = {
      fields: [
        { name: 'status', type: String, stateMachine: sm },
        { name: 'priority', type: String, stateMachine: sm },
      ],
    };
    const out = listTransitionsToValidate(
      { status: 'review' },
      { status: 'draft', priority: 'draft' },
      schema
    );
    expect(out).toHaveLength(1);
    expect(out[0].field.name).toBe('status');
    expect(out[0].current).toBe('draft');
    expect(out[0].next).toBe('review');
  });

  test('attachAvailableTransitions stamps the per-field virtual', () => {
    const schema = {
      fields: [
        { name: 'status', type: String, stateMachine: sm },
        { name: 'paymentStatus', type: String, stateMachine: sm },
      ],
    };
    const records = [{ status: 'review', paymentStatus: 'draft' }];
    attachAvailableTransitions(records, schema);
    expect(records[0].statusAvailableTransitions).toEqual(['approved', 'rejected']);
    expect(records[0].paymentStatusAvailableTransitions).toEqual(['review', 'archived']);
  });
});

// All three integration surfaces (REST / GraphQL / MCP) share one
// app + Mongo lifecycle. Splitting these into separate top-level
// describes worked in isolation but jest's afterAll race between
// describes (one's `mongoose.disconnect()` hits the next's pending
// MCP / Apollo cleanup) reported the suite as failed even when all
// tests passed individually.
describe('integration', () => {
  const onEnterApproved = jest.fn();

  beforeAll(async () => {
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'sm_doc',
      collection: 'sm_doc',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
        {
          name: 'status',
          type: String,
          stateMachine: {
            initial: 'draft',
            states: ['draft', 'review', 'approved', 'rejected', 'archived'],
            transitions: sm.transitions,
            onEnter: { approved: onEnterApproved },
          },
        },
        // Multi-machine schema: a second independent state machine.
        {
          name: 'paymentStatus',
          type: String,
          stateMachine: {
            initial: 'unpaid',
            states: ['unpaid', 'paid', 'refunded'],
            transitions: { unpaid: ['paid'], paid: ['refunded'], refunded: [] },
          },
        },
      ],
    });
  });

  afterAll(async () => {
    // Stop the webhook dispatcher BEFORE unloading any schema. The
    // tests above enqueued bus events whose handler is async and
    // hits Mongo (`WebhookSubscription.find()`); detaching the
    // dispatcher here keeps those queries from racing setupTestApp's
    // disconnect and surfacing as MongoPoolClosedError noise.
    if (ctx.app.locals.webhookDispatcher) {
      ctx.app.locals.webhookDispatcher.stop();
    }
    await new Promise((r) => setImmediate(r));
    // Unload all three schemas here — nested describes don't run
    // their own afterAlls so each unload's rebuildGraphQL doesn't
    // race the next describe's setup or teardown.
    for (const key of ['v1/sm_doc', 'v1/sm_gql', 'v1/sm_mcp']) {
      try { await ctx.app.locals.schemaLoader.unloadSchema(key); }
      catch (_) { /* schema may not be loaded if a nested describe was skipped */ }
    }
  });

  test('POST stamps initial states regardless of supplied value', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const res = await ctx
      .request(ctx.app)
      .post('/api/v1/sm_doc')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'X', status: 'approved', paymentStatus: 'paid' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.paymentStatus).toBe('unpaid');
  });

  test('POST response carries availableTransitions virtuals per machine', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const res = await ctx
      .request(ctx.app)
      .post('/api/v1/sm_doc')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'X' });
    expect(res.body.statusAvailableTransitions).toEqual(['review', 'archived']);
    expect(res.body.paymentStatusAvailableTransitions).toEqual(['paid']);
  });

  test('PUT with a valid transition succeeds', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/sm_doc')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'X' });
    const res = await ctx
      .request(ctx.app)
      .put(`/api/v1/sm_doc/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ status: 'review' });
    expect(res.status).toBe(200);
    const fetched = await ctx
      .request(ctx.app)
      .get(`/api/v1/sm_doc/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(fetched.body.status).toBe('review');
    expect(fetched.body.statusAvailableTransitions).toEqual(['approved', 'rejected']);
  });

  test('PUT with an invalid transition returns 400 INVALID_TRANSITION + structured details', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/sm_doc')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'X' });
    // draft → approved is not declared; only draft → review / archived are.
    const res = await ctx
      .request(ctx.app)
      .put(`/api/v1/sm_doc/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ status: 'approved' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect(res.body.error.details).toMatchObject({
      field: 'status',
      current: 'draft',
      attempted: 'approved',
      allowed: ['review', 'archived'],
      reason: 'invalid_transition',
    });
    // The DB wasn't mutated.
    const fetched = await ctx
      .request(ctx.app)
      .get(`/api/v1/sm_doc/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(fetched.body.status).toBe('draft');
  });

  test('audit log records action: transition and ${path}.transitioned event fires', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/sm_doc')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'X' });

    let transitionedSeen = null;
    const events = require('../utils/events');
    const handler = (e) => {
      if (e.type === 'sm_doc.transitioned') transitionedSeen = e;
    };
    events.bus.on('record', handler);
    try {
      await ctx
        .request(ctx.app)
        .put(`/api/v1/sm_doc/${created.body._id}`)
        .set('Authorization', `Bearer ${user.token}`)
        .send({ status: 'review' });
    } finally {
      events.bus.off('record', handler);
    }
    expect(transitionedSeen).toBeTruthy();
    expect(transitionedSeen).toMatchObject({
      type: 'sm_doc.transitioned',
      field: 'status',
      from: 'draft',
      to: 'review',
    });

    const history = await ctx
      .request(ctx.app)
      .get(`/api/v1/sm_doc/${created.body._id}/history`)
      .set('Authorization', `Bearer ${user.token}`);
    const actions = history.body.results.map((r) => r.action);
    expect(actions).toContain('transition');
  });

  test('onEnter hook fires on the receiving state, errors are non-fatal', async () => {
    onEnterApproved.mockClear();
    const user = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/sm_doc')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'X' });
    await ctx
      .request(ctx.app)
      .put(`/api/v1/sm_doc/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ status: 'review' });
    await ctx
      .request(ctx.app)
      .put(`/api/v1/sm_doc/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ status: 'approved' });
    expect(onEnterApproved).toHaveBeenCalledTimes(1);
    const [record, hookCtx] = onEnterApproved.mock.calls[0];
    expect(record.status).toBe('approved');
    expect(hookCtx.from).toBe('review');
    expect(hookCtx.to).toBe('approved');
    expect(hookCtx.user.user_id).toBeDefined();
  });

  test('multiple state machines on the same schema operate independently', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/sm_doc')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'X' });
    // status: draft → review (allowed)
    // paymentStatus: unpaid → paid (allowed)
    const res = await ctx
      .request(ctx.app)
      .put(`/api/v1/sm_doc/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ status: 'review', paymentStatus: 'paid' });
    expect(res.status).toBe(200);
    const fetched = await ctx
      .request(ctx.app)
      .get(`/api/v1/sm_doc/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(fetched.body.status).toBe('review');
    expect(fetched.body.paymentStatus).toBe('paid');
  });

  describe('GraphQL transition mutation', () => {

  beforeAll(async () => {
    // Schema for the GraphQL describe — loaded once, unloaded by
    // the outer describe's afterAll along with sm_doc, so we don't
    // pay the rebuildGraphQL cost in this nested afterAll.
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'sm_gql',
      collection: 'sm_gql',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
        {
          name: 'status',
          type: String,
          stateMachine: {
            initial: 'draft',
            states: ['draft', 'review', 'approved'],
            transitions: { draft: ['review'], review: ['approved'], approved: [] },
          },
        },
      ],
    });
  });

  // Note: no afterAll here — sm_gql is unloaded by the outer
  // describe's afterAll. Nested describes skip rebuildGraphQL
  // round-trips that surface as pool-close races during teardown.

  const gql = (token, query, variables) => {
    const r = ctx.request(ctx.app).post('/graphql/').send({ query, variables });
    if (token) r.set('Authorization', `Bearer ${token}`);
    return r;
  };

  test('Transition<Field> mutation runs an allowed transition', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/sm_gql')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'X' });
    const res = await gql(
      user.token,
      `mutation Q($id: MongoID!) {
         sm_gqlTransitionStatus(_id: $id, to: review) { _id status }
       }`,
      { id: created.body._id }
    );
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.sm_gqlTransitionStatus.status).toBe('review');
  });

  test('Transition<Field> mutation rejects an undeclared edge', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/sm_gql')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'X' });
    const res = await gql(
      user.token,
      `mutation Q($id: MongoID!) {
         sm_gqlTransitionStatus(_id: $id, to: approved) { _id status }
       }`,
      { id: created.body._id }
    );
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('INVALID_TRANSITION');
  });

  test('Transition<Field> mutation typechecks the `to` enum at validation time', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/sm_gql')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'X' });
    const res = await gql(
      user.token,
      `mutation Q($id: MongoID!) {
         sm_gqlTransitionStatus(_id: $id, to: bogus) { _id status }
       }`,
      { id: created.body._id }
    );
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });
  }); // close GraphQL describe

  describe('MCP', () => {

  async function connectMcp(user) {
    const server = buildMcpServer({
      schemaLoader: ctx.app.locals.schemaLoader,
      getUser: () => user,
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0.0.1' });
    await Promise.all([server.connect(b), client.connect(a)]);
    return {
      client,
      close: async () => { await client.close(); await server.close(); },
    };
  }

  const decodedFromRegister = (r) => jwt.decode(r.accessToken);
  const parseStructured = (res) => {
    if (res.structuredContent !== undefined) return res.structuredContent;
    const txt = res.content && res.content[0] && res.content[0].text;
    return txt ? JSON.parse(txt) : null;
  };

  beforeAll(async () => {
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'sm_mcp',
      collection: 'sm_mcp',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
        {
          name: 'status',
          type: String,
          stateMachine: {
            initial: 'draft',
            states: ['draft', 'review', 'approved'],
            transitions: { draft: ['review'], review: ['approved'], approved: [] },
          },
        },
      ],
    });
  });

  // Note: no afterAll here — sm_mcp is unloaded by the outer
  // describe's afterAll for the same reason as sm_gql.

  test('create_<path> stamps initial state and surfaces availableTransitions', async () => {
    const reg = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(reg);
    const { client, close } = await connectMcp(user);
    try {
      const created = parseStructured(await client.callTool({
        name: 'create_sm_mcp',
        arguments: { record: { title: 'X', status: 'approved' } },
      }));
      expect(created.status).toBe('draft');
      expect(created.statusAvailableTransitions).toEqual(['review']);
    } finally {
      await close();
    }
  });

  test('update_<path> rejects undeclared transition with INVALID_TRANSITION', async () => {
    const reg = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(reg);
    const { client, close } = await connectMcp(user);
    try {
      const created = parseStructured(await client.callTool({
        name: 'create_sm_mcp',
        arguments: { record: { title: 'X' } },
      }));
      const bad = await client.callTool({
        name: 'update_sm_mcp',
        arguments: { id: created._id, record: { status: 'approved' } },
      });
      expect(bad.isError).toBe(true);
      const body = parseStructured(bad);
      expect(body.error.code).toBe('INVALID_TRANSITION');
    } finally {
      await close();
    }
  });

  test('update_<path> accepts an allowed transition and emits transitioned event', async () => {
    const reg = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(reg);
    const { client, close } = await connectMcp(user);
    try {
      const created = parseStructured(await client.callTool({
        name: 'create_sm_mcp',
        arguments: { record: { title: 'X' } },
      }));

      const events = require('../utils/events');
      let seen = null;
      const handler = (e) => { if (e.type === 'sm_mcp.transitioned') seen = e; };
      events.bus.on('record', handler);
      try {
        const ok = parseStructured(await client.callTool({
          name: 'update_sm_mcp',
          arguments: { id: created._id, record: { status: 'review' } },
        }));
        expect(ok.status).toBe('review');
        expect(ok.statusAvailableTransitions).toEqual(['approved']);
      } finally {
        events.bus.off('record', handler);
      }
      expect(seen).toMatchObject({ field: 'status', from: 'draft', to: 'review' });
    } finally {
      await close();
    }
  });

  test('update_<path> on a missing record returns NOT_FOUND, not INVALID_TRANSITION', async () => {
    const reg = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(reg);
    const { client, close } = await connectMcp(user);
    try {
      const fakeId = '6a0007000000000000000000';
      const res = await client.callTool({
        name: 'update_sm_mcp',
        arguments: { id: fakeId, record: { status: 'review' } },
      });
      expect(res.isError).toBe(true);
      const body = parseStructured(res);
      expect(body.error.code).toBe('NOT_FOUND');
    } finally {
      await close();
    }
  });

  test('update_<path> emits the standard `updated` event alongside `transitioned`', async () => {
    const reg = await registerUser(ctx.request, ctx.app);
    const user = decodedFromRegister(reg);
    const { client, close } = await connectMcp(user);
    try {
      const created = parseStructured(await client.callTool({
        name: 'create_sm_mcp',
        arguments: { record: { title: 'X' } },
      }));
      const events = require('../utils/events');
      const seen = [];
      const handler = (e) => {
        if (e.recordId === String(created._id)) seen.push(e.type);
      };
      events.bus.on('record', handler);
      try {
        await client.callTool({
          name: 'update_sm_mcp',
          arguments: { id: created._id, record: { status: 'review' } },
        });
      } finally {
        events.bus.off('record', handler);
      }
      expect(seen).toEqual(expect.arrayContaining(['sm_mcp.transitioned', 'sm_mcp.updated']));
    } finally {
      await close();
    }
  });
  }); // close MCP describe

  describe('regressions', () => {
    test('PUT on a missing record returns 404, not 400 INVALID_TRANSITION', async () => {
      const user = await registerUser(ctx.request, ctx.app);
      const fakeId = '6a0007000000000000000000';
      const res = await ctx
        .request(ctx.app)
        .put(`/api/v1/sm_doc/${fakeId}`)
        .set('Authorization', `Bearer ${user.token}`)
        .send({ status: 'review' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    test('availableTransitions virtual is hidden from callers without read access to the field', async () => {
      // Schema with the state field locked to admin reads only.
      await ctx.app.locals.schemaLoader.loadSchema({
        path: 'sm_acl',
        collection: 'sm_acl',
        version: 'v1',
        fields: [
          { name: 'userId', type: String, required: true },
          {
            name: 'status',
            type: String,
            acl: { read: ['admin'] },
            stateMachine: {
              initial: 'draft',
              states: ['draft', 'approved'],
              transitions: { draft: ['approved'], approved: [] },
            },
          },
        ],
      });
      try {
        const user = await registerUser(ctx.request, ctx.app); // role 'user'
        const created = await ctx
          .request(ctx.app)
          .post('/api/v1/sm_acl')
          .set('Authorization', `Bearer ${user.token}`)
          .send({});
        // The status field is hidden by projectByAcl; the derived
        // availableTransitions virtual would otherwise leak the
        // current state ('draft' → ['approved']).
        expect(created.body.status).toBeUndefined();
        expect(created.body.statusAvailableTransitions).toBeUndefined();
      } finally {
        await ctx.app.locals.schemaLoader.unloadSchema('v1/sm_acl');
      }
    });

    test('GraphQL builds enums for state strings with non-identifier characters', async () => {
      // States like `in-progress` would otherwise crash
      // composer.createEnumTC because hyphens aren't valid in
      // GraphQL enum names.
      await ctx.app.locals.schemaLoader.loadSchema({
        path: 'sm_kebab',
        collection: 'sm_kebab',
        version: 'v1',
        fields: [
          { name: 'userId', type: String, required: true },
          {
            name: 'status',
            type: String,
            stateMachine: {
              initial: 'in-progress',
              states: ['in-progress', 'done'],
              transitions: { 'in-progress': ['done'], done: [] },
            },
          },
        ],
      });
      try {
        const user = await registerUser(ctx.request, ctx.app);
        const created = await ctx
          .request(ctx.app)
          .post('/api/v1/sm_kebab')
          .set('Authorization', `Bearer ${user.token}`)
          .send({});
        expect(created.status).toBe(201);
        expect(created.body.status).toBe('in-progress');
        // The mutation accepts the sanitised enum name; payload is
        // the original string.
        const res = await ctx
          .request(ctx.app)
          .post('/graphql/')
          .set('Authorization', `Bearer ${user.token}`)
          .send({
            query: `mutation Q($id: MongoID!) {
                     sm_kebabTransitionStatus(_id: $id, to: done) { status }
                   }`,
            variables: { id: created.body._id },
          });
        expect(res.body.errors).toBeUndefined();
        expect(res.body.data.sm_kebabTransitionStatus.status).toBe('done');
      } finally {
        await ctx.app.locals.schemaLoader.unloadSchema('v1/sm_kebab');
      }
    });
  });
}); // close integration describe
}); // close outer stateMachine describe
