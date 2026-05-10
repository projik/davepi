const { setupTestApp, registerUser } = require('./helpers');
const {
  isComputedField,
  computedFieldsOf,
  buildComputedContext,
  applyComputed,
} = require('../utils/computedFields');

describe('computedFields: pure helpers', () => {
  test('isComputedField only matches fields with a computed function', () => {
    expect(isComputedField({ name: 'x', computed: () => 1 })).toBe(true);
    expect(isComputedField({ name: 'x' })).toBe(false);
    expect(isComputedField({ name: 'x', computed: 'not-a-fn' })).toBe(false);
    expect(isComputedField(null)).toBe(false);
  });

  test('computedFieldsOf returns only the computed entries', () => {
    const schema = {
      fields: [
        { name: 'a', type: String },
        { name: 'b', type: String, computed: () => 'B' },
        { name: 'c', type: String, computed: () => 'C' },
      ],
    };
    expect(computedFieldsOf(schema).map((f) => f.name)).toEqual(['b', 'c']);
  });

  test('applyComputed fans out N×K promises across records and computeds', async () => {
    const schema = {
      fields: [
        { name: 'firstName', type: String },
        { name: 'lastName', type: String },
        {
          name: 'fullName',
          type: String,
          computed: (r) => `${r.firstName} ${r.lastName}`,
        },
        {
          name: 'asyncField',
          type: String,
          computed: async (r) => `async:${r.firstName}`,
        },
      ],
    };
    const records = [
      { firstName: 'Ada', lastName: 'Lovelace' },
      { firstName: 'Linus', lastName: 'Torvalds' },
    ];
    const ctx = buildComputedContext({ user: { user_id: 'u' } });
    await applyComputed(records, schema, ctx);
    expect(records[0].fullName).toBe('Ada Lovelace');
    expect(records[0].asyncField).toBe('async:Ada');
    expect(records[1].fullName).toBe('Linus Torvalds');
    expect(records[1].asyncField).toBe('async:Linus');
  });

  test('a throwing computed function does not break the whole pass', async () => {
    const schema = {
      fields: [
        { name: 'good', type: String, computed: () => 'OK' },
        { name: 'bad', type: String, computed: () => { throw new Error('boom'); } },
      ],
    };
    const records = [{}];
    const ctx = buildComputedContext({ user: { user_id: 'u' } });
    await applyComputed(records, schema, ctx);
    expect(records[0].good).toBe('OK');
    expect(records[0].bad).toBeNull();
  });

  test('async computeds run in parallel, not sequentially', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const schema = {
      fields: Array.from({ length: 5 }, (_, i) => ({
        name: `c${i}`,
        type: String,
        computed: async () => {
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await new Promise((r) => setTimeout(r, 25));
          inFlight -= 1;
          return `v${i}`;
        },
      })),
    };
    const records = [{}, {}];
    const ctx = buildComputedContext({ user: { user_id: 'u' } });
    await applyComputed(records, schema, ctx);
    // 2 records × 5 computeds = 10 tasks. Sequential would have
    // maxInFlight === 1; parallel should have far more — assert at
    // least 4 to allow CI scheduler jitter.
    expect(maxInFlight).toBeGreaterThanOrEqual(4);
  });
});

describe('computed fields: REST integration', () => {
  const ctx = setupTestApp({ cleanCollections: false });

  beforeAll(async () => {
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'cf_person',
      collection: 'cf_person',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'firstName', type: String, required: true },
        { name: 'lastName', type: String, required: true },
        {
          name: 'fullName',
          type: String,
          description: 'Concatenated first + last name.',
          computed: (r) => `${r.firstName} ${r.lastName}`,
        },
        {
          name: 'shoutName',
          type: String,
          computed: async (r) =>
            `${r.firstName.toUpperCase()} ${r.lastName.toUpperCase()}!`,
        },
        {
          name: 'secretComputed',
          type: String,
          acl: { read: ['admin'] },
          computed: () => 'top-secret',
        },
      ],
    });
  });

  afterAll(async () => {
    await ctx.app.locals.schemaLoader.unloadSchema('v1/cf_person');
  });

  test('POST response includes computed values', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const res = await ctx
      .request(ctx.app)
      .post('/api/v1/cf_person')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ firstName: 'Ada', lastName: 'Lovelace' });
    expect(res.status).toBe(201);
    expect(res.body.fullName).toBe('Ada Lovelace');
    expect(res.body.shoutName).toBe('ADA LOVELACE!');
  });

  test('GET /:id includes computed values', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/cf_person')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ firstName: 'Linus', lastName: 'Torvalds' });
    const fetched = await ctx
      .request(ctx.app)
      .get(`/api/v1/cf_person/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.fullName).toBe('Linus Torvalds');
    expect(fetched.body.shoutName).toBe('LINUS TORVALDS!');
  });

  test('GET list applies computed values to every row', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    await ctx
      .request(ctx.app)
      .post('/api/v1/cf_person')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ firstName: 'A', lastName: 'B' });
    await ctx
      .request(ctx.app)
      .post('/api/v1/cf_person')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ firstName: 'C', lastName: 'D' });
    const list = await ctx
      .request(ctx.app)
      .get('/api/v1/cf_person')
      .set('Authorization', `Bearer ${user.token}`);
    expect(list.status).toBe(200);
    for (const row of list.body.results) {
      expect(row.fullName).toBe(`${row.firstName} ${row.lastName}`);
    }
  });

  test('client-supplied values for computed fields are dropped on POST', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const res = await ctx
      .request(ctx.app)
      .post('/api/v1/cf_person')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        firstName: 'Server',
        lastName: 'Wins',
        fullName: 'CLIENT-FORGED',
      });
    expect(res.status).toBe(201);
    // The framework recomputed; the client's forged value never
    // touched the database.
    expect(res.body.fullName).toBe('Server Wins');
  });

  test('client-supplied values for computed fields are dropped on PUT', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/cf_person')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ firstName: 'A', lastName: 'B' });
    await ctx
      .request(ctx.app)
      .put(`/api/v1/cf_person/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ fullName: 'forged-on-update', firstName: 'C' });
    const fetched = await ctx
      .request(ctx.app)
      .get(`/api/v1/cf_person/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`);
    // firstName updated; fullName recomputed; client-forged value
    // never persisted.
    expect(fetched.body.firstName).toBe('C');
    expect(fetched.body.fullName).toBe('C B');
  });

  test('field-level ACL strips a computed field for callers without the role', async () => {
    const user = await registerUser(ctx.request, ctx.app); // role 'user'
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/cf_person')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ firstName: 'A', lastName: 'B' });
    expect(created.body.secretComputed).toBeUndefined();
    const fetched = await ctx
      .request(ctx.app)
      .get(`/api/v1/cf_person/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(fetched.body.secretComputed).toBeUndefined();
  });

  test('Swagger documents computed fields with readOnly: true', async () => {
    const swagger = await ctx
      .request(ctx.app)
      .get('/api-docs/swagger.json');
    const def = swagger.body.definitions.cf_person;
    expect(def.properties.fullName).toBeDefined();
    expect(def.properties.fullName.readOnly).toBe(true);
    expect(def.properties.fullName.description).toMatch(/Concatenated/);
  });

  test('GET list query parameters do NOT include computed fields (you can\'t filter Mongo by a derived value)', async () => {
    const swagger = await ctx
      .request(ctx.app)
      .get('/api-docs/swagger.json');
    const params = swagger.body.paths['/api/v1/cf_person'].get.parameters;
    const names = params.map((p) => p.name);
    // Computed names are advertised in the response definition but
    // must NOT appear in the GET filter param list.
    expect(names).not.toContain('fullName');
    expect(names).not.toContain('shoutName');
    expect(names).not.toContain('secretComputed');
    // Persisted fields should still be there.
    expect(names).toContain('firstName');
    expect(names).toContain('lastName');
  });

  test('GET /api/v1/cf_person-schema lists computed fields with readOnly: true', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const r = await ctx
      .request(ctx.app)
      .get('/api/v1/cf_person-schema')
      .set('Authorization', `Bearer ${user.token}`);
    expect(r.status).toBe(200);
    expect(r.body.properties.fullName).toBeDefined();
    expect(r.body.properties.fullName.readOnly).toBe(true);
  });

  test('ctx.count is tenant-scoped', async () => {
    // Load a schema where one field counts records of another. Two
    // separate users seed different counts; each sees only their
    // own.
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'cf_widget',
      collection: 'cf_widget',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'label', type: String },
      ],
    });
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'cf_widget_owner',
      collection: 'cf_widget_owner',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'name', type: String },
        {
          name: 'widgetCount',
          type: Number,
          computed: async (r, c) => c.count('cf_widget'),
        },
      ],
    });
    try {
      const a = await registerUser(ctx.request, ctx.app);
      const b = await registerUser(ctx.request, ctx.app);
      const post = (token, p, body) =>
        ctx.request(ctx.app)
          .post(`/api/v1/${p}`)
          .set('Authorization', `Bearer ${token}`)
          .send(body);
      await post(a.token, 'cf_widget', { label: 'a1' });
      await post(a.token, 'cf_widget', { label: 'a2' });
      await post(a.token, 'cf_widget', { label: 'a3' });
      await post(b.token, 'cf_widget', { label: 'b1' });

      const aOwner = await post(a.token, 'cf_widget_owner', { name: 'A' });
      const bOwner = await post(b.token, 'cf_widget_owner', { name: 'B' });
      expect(aOwner.body.widgetCount).toBe(3);
      expect(bOwner.body.widgetCount).toBe(1);
    } finally {
      await ctx.app.locals.schemaLoader.unloadSchema('v1/cf_widget_owner');
      await ctx.app.locals.schemaLoader.unloadSchema('v1/cf_widget');
    }
  });
});

describe('computed fields: GraphQL', () => {
  const ctx = setupTestApp({ cleanCollections: false });

  beforeAll(async () => {
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'cf_gql',
      collection: 'cf_gql',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'firstName', type: String, required: true },
        { name: 'lastName', type: String, required: true },
        {
          name: 'fullName',
          type: String,
          computed: (r) => `${r.firstName} ${r.lastName}`,
        },
        {
          name: 'secretComputed',
          type: String,
          acl: { read: ['admin'] },
          computed: () => 'top-secret',
        },
      ],
    });
  });

  afterAll(async () => {
    await ctx.app.locals.schemaLoader.unloadSchema('v1/cf_gql');
  });

  const gql = (token, query, variables) => {
    const r = ctx
      .request(ctx.app)
      .post('/graphql/')
      .send({ query, variables });
    if (token) r.set('Authorization', `Bearer ${token}`);
    return r;
  };

  test('GraphQL resolves computed fields lazily on request', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    await ctx
      .request(ctx.app)
      .post('/api/v1/cf_gql')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ firstName: 'Ada', lastName: 'Lovelace' });
    const res = await gql(
      user.token,
      'query { cf_gqlMany { firstName lastName fullName } }'
    );
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.cf_gqlMany[0].fullName).toBe('Ada Lovelace');
  });

  test('GraphQL input type rejects computed fields on create (cannot forge)', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const res = await gql(
      user.token,
      `mutation { cf_gqlCreateOne(record: {
         firstName: "X", lastName: "Y", fullName: "FORGED"
       }) { record { fullName } } }`
    );
    // graphql-compose-mongoose's input type doesn't expose
    // computed-only fields, so this is a validation error from the
    // schema layer.
    expect(res.body.errors).toBeDefined();
    expect(res.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  test('field-level ACL on a computed field returns null for callers without the role', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    await ctx
      .request(ctx.app)
      .post('/api/v1/cf_gql')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ firstName: 'A', lastName: 'B' });
    const res = await gql(
      user.token,
      'query { cf_gqlMany { firstName secretComputed } }'
    );
    expect(res.body.errors).toBeUndefined();
    for (const row of res.body.data.cf_gqlMany) {
      expect(row.secretComputed).toBeNull();
    }
  });

  test('a throwing computed returns null on the GraphQL surface (matches REST)', async () => {
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'cf_throws',
      collection: 'cf_throws',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'name', type: String, required: true },
        {
          name: 'good',
          type: String,
          computed: () => 'OK',
        },
        {
          name: 'bad',
          type: String,
          computed: () => { throw new Error('boom'); },
        },
      ],
    });
    try {
      const user = await registerUser(ctx.request, ctx.app);
      await ctx
        .request(ctx.app)
        .post('/api/v1/cf_throws')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ name: 'X' });
      const res = await gql(user.token, 'query { cf_throwsMany { name good bad } }');
      // The throwing field returns null for that field only — the
      // sibling `good` and the rest of the response survive.
      expect(res.body.errors).toBeUndefined();
      const row = res.body.data.cf_throwsMany[0];
      expect(row.name).toBe('X');
      expect(row.good).toBe('OK');
      expect(row.bad).toBeNull();
    } finally {
      await ctx.app.locals.schemaLoader.unloadSchema('v1/cf_throws');
    }
  });
});
