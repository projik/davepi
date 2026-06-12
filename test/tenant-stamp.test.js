const { setupTestApp, registerUser } = require('./helpers');

const ctx = setupTestApp();

const loadSchema = (loader, opts = {}) =>
  loader.loadSchema({
    path: opts.path || 'stamp_target',
    collection: opts.path || 'stamp_target',
    version: 'v1',
    fields: [
      { name: 'userId', type: String, required: true },
      { name: 'accountId', type: String, required: true },
      { name: 'name', type: String, required: true },
      { name: 'note', type: String },
    ],
    hooks: opts.hooks,
  });

describe('Tenant ownership stamping — REST', () => {
  test('POST: client-supplied userId/accountId in body are ignored; JWT values win', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const attacker = await registerUser(ctx.request, ctx.app);
    await loadSchema(ctx.app.locals.schemaLoader, { path: 'stamp_post' });

    const res = await ctx
      .request(ctx.app)
      .post('/api/v1/stamp_post')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        name: 'forged',
        userId: attacker._id,
        accountId: attacker._id,
      });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(String(owner._id));
    expect(res.body.accountId).toBe(String(owner._id));

    // Attacker's list must NOT contain it.
    const attackerList = await ctx
      .request(ctx.app)
      .get('/api/v1/stamp_post')
      .set('Authorization', `Bearer ${attacker.token}`);
    expect(attackerList.body.totalResults).toBe(0);
  });

  test('POST: a malicious beforeCreate hook cannot rewrite ownership', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const attacker = await registerUser(ctx.request, ctx.app);
    await loadSchema(ctx.app.locals.schemaLoader, {
      path: 'stamp_post_hook',
      hooks: {
        beforeCreate: async ({ input }) => ({
          ...input,
          userId: attacker._id,
          accountId: attacker._id,
          note: 'hook tried to hijack',
        }),
      },
    });

    const res = await ctx
      .request(ctx.app)
      .post('/api/v1/stamp_post_hook')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'legit' });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(String(owner._id));
    expect(res.body.accountId).toBe(String(owner._id));
    expect(res.body.note).toBe('hook tried to hijack'); // other hook changes persist

    const attackerList = await ctx
      .request(ctx.app)
      .get('/api/v1/stamp_post_hook')
      .set('Authorization', `Bearer ${attacker.token}`);
    expect(attackerList.body.totalResults).toBe(0);
  });

  test('PUT /:id: client-supplied userId in body cannot move the record to another tenant', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const attacker = await registerUser(ctx.request, ctx.app);
    await loadSchema(ctx.app.locals.schemaLoader, { path: 'stamp_put' });

    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/stamp_put')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'original' });
    expect(created.status).toBe(201);

    const updated = await ctx
      .request(ctx.app)
      .put(`/api/v1/stamp_put/${created.body._id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        name: 'renamed',
        userId: attacker._id,
        accountId: attacker._id,
      });
    expect(updated.status).toBe(200);

    const fetched = await ctx
      .request(ctx.app)
      .get(`/api/v1/stamp_put/${created.body._id}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.name).toBe('renamed');
    expect(fetched.body.userId).toBe(String(owner._id));
    expect(fetched.body.accountId).toBe(String(owner._id));

    const attackerFetch = await ctx
      .request(ctx.app)
      .get(`/api/v1/stamp_put/${created.body._id}`)
      .set('Authorization', `Bearer ${attacker.token}`);
    expect(attackerFetch.status).toBe(404);
  });

  test('PUT /:id: a malicious beforeUpdate hook cannot move the record', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const attacker = await registerUser(ctx.request, ctx.app);
    await loadSchema(ctx.app.locals.schemaLoader, {
      path: 'stamp_put_hook',
      hooks: {
        beforeUpdate: async ({ input }) => ({
          ...input,
          userId: attacker._id,
          accountId: attacker._id,
        }),
      },
    });

    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/stamp_put_hook')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'original' });
    expect(created.status).toBe(201);

    const updated = await ctx
      .request(ctx.app)
      .put(`/api/v1/stamp_put_hook/${created.body._id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'renamed' });
    expect(updated.status).toBe(200);

    const fetched = await ctx
      .request(ctx.app)
      .get(`/api/v1/stamp_put_hook/${created.body._id}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.userId).toBe(String(owner._id));
    expect(fetched.body.accountId).toBe(String(owner._id));

    const attackerFetch = await ctx
      .request(ctx.app)
      .get(`/api/v1/stamp_put_hook/${created.body._id}`)
      .set('Authorization', `Bearer ${attacker.token}`);
    expect(attackerFetch.status).toBe(404);
  });

  test('bulk PUT: $set cannot rewrite userId/accountId on matched docs', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const attacker = await registerUser(ctx.request, ctx.app);
    await loadSchema(ctx.app.locals.schemaLoader, { path: 'stamp_bulk' });

    await ctx
      .request(ctx.app)
      .post('/api/v1/stamp_bulk')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'one' });
    await ctx
      .request(ctx.app)
      .post('/api/v1/stamp_bulk')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'two' });

    const bulk = await ctx
      .request(ctx.app)
      .put('/api/v1/stamp_bulk?name=one')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        note: 'updated',
        userId: attacker._id,
        accountId: attacker._id,
      });
    expect(bulk.status).toBe(200);

    const list = await ctx
      .request(ctx.app)
      .get('/api/v1/stamp_bulk')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(list.body.totalResults).toBe(2);
    for (const r of list.body.results) {
      expect(r.userId).toBe(String(owner._id));
      expect(r.accountId).toBe(String(owner._id));
    }

    const attackerList = await ctx
      .request(ctx.app)
      .get('/api/v1/stamp_bulk')
      .set('Authorization', `Bearer ${attacker.token}`);
    expect(attackerList.body.totalResults).toBe(0);
  });

  test('bulk PUT: a tenantScoped:false schema upserts without a userId (no strict-mode 500)', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'stamp_global',
      collection: 'stamp_global',
      version: 'v1',
      tenantScoped: false,
      fields: [
        { name: 'eventId', type: String, required: true, unique: true },
        { name: 'note', type: String },
      ],
    });

    // The handler injects `userId` into the upsert filter only when the
    // schema declares it. Without that guard this 500'd: the schema has
    // no `userId` path, so Mongoose strict mode throws on upsert. Now the
    // upsert seeds only the caller-supplied keys and succeeds.
    const bulk = await ctx
      .request(ctx.app)
      .put('/api/v1/stamp_global?eventId=evt_1')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ note: 'seeded' });

    expect(bulk.status).toBe(200);
    expect(bulk.body.upsertedCount).toBe(1);
  });
});

describe('Tenant ownership stamping — GraphQL', () => {
  const gql = (token, query) =>
    ctx
      .request(ctx.app)
      .post('/graphql')
      .set('Authorization', `Bearer ${token}`)
      .send({ query });

  test('createOne: client-supplied userId is stripped from input type and JWT wins', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const attacker = await registerUser(ctx.request, ctx.app);
    await loadSchema(ctx.app.locals.schemaLoader, { path: 'stamp_gql_create' });

    // The GraphQL input type strips userId/accountId via stripFromInput,
    // so attempting to send them is a SCHEMA-level error (the mutation
    // simply can't accept them). Send a clean mutation; the framework
    // stamps ownership from the JWT.
    const res = await gql(
      owner.token,
      `mutation {
        stamp_gql_createCreateOne(record: { name: "legit" }) {
          record { _id userId accountId name }
        }
      }`
    );
    expect(res.body.errors).toBeUndefined();
    const rec = res.body.data.stamp_gql_createCreateOne.record;
    expect(rec.userId).toBe(String(owner._id));
    expect(rec.accountId).toBe(String(owner._id));

    const attackerList = await gql(
      attacker.token,
      `query { stamp_gql_createMany { _id } }`
    );
    expect(attackerList.body.data.stamp_gql_createMany).toEqual([]);
  });

  test('createOne: a malicious beforeCreate hook cannot rewrite ownership', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const attacker = await registerUser(ctx.request, ctx.app);
    await loadSchema(ctx.app.locals.schemaLoader, {
      path: 'stamp_gql_createhook',
      hooks: {
        beforeCreate: async ({ input }) => ({
          ...input,
          userId: attacker._id,
          accountId: attacker._id,
        }),
      },
    });

    const res = await gql(
      owner.token,
      `mutation {
        stamp_gql_createhookCreateOne(record: { name: "legit" }) {
          record { _id userId accountId }
        }
      }`
    );
    expect(res.body.errors).toBeUndefined();
    const rec = res.body.data.stamp_gql_createhookCreateOne.record;
    expect(rec.userId).toBe(String(owner._id));
    expect(rec.accountId).toBe(String(owner._id));
  });

  test('updateById: a malicious beforeUpdate hook cannot move the record', async () => {
    const owner = await registerUser(ctx.request, ctx.app);
    const attacker = await registerUser(ctx.request, ctx.app);
    await loadSchema(ctx.app.locals.schemaLoader, {
      path: 'stamp_gql_update',
      hooks: {
        beforeUpdate: async ({ input }) => ({
          ...input,
          userId: attacker._id,
          accountId: attacker._id,
        }),
      },
    });

    const created = await gql(
      owner.token,
      `mutation {
        stamp_gql_updateCreateOne(record: { name: "original" }) {
          record { _id }
        }
      }`
    );
    const id = created.body.data.stamp_gql_updateCreateOne.record._id;

    const updated = await gql(
      owner.token,
      `mutation {
        stamp_gql_updateUpdateById(_id: "${id}", record: { name: "renamed" }) {
          record { _id name userId accountId }
        }
      }`
    );
    expect(updated.body.errors).toBeUndefined();
    const rec = updated.body.data.stamp_gql_updateUpdateById.record;
    expect(rec.name).toBe('renamed');
    expect(rec.userId).toBe(String(owner._id));
    expect(rec.accountId).toBe(String(owner._id));

    // Attacker still sees no records.
    const attackerList = await gql(
      attacker.token,
      `query { stamp_gql_updateMany { _id } }`
    );
    expect(attackerList.body.data.stamp_gql_updateMany).toEqual([]);
  });
});
