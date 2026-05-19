const { setupTestApp, registerUser } = require('./helpers');

const ctx = setupTestApp();

const loadSchemaWithHooks = (loader, { path: p, hooks }) =>
  loader.loadSchema({
    path: p,
    collection: p,
    version: 'v1',
    fields: [
      { name: 'userId', type: String, required: true },
      { name: 'accountId', type: String, required: true },
      { name: 'title', type: String, required: true },
      { name: 'note', type: String },
      { name: 'counter', type: Number, default: 0 },
    ],
    hooks,
  });

describe('Schema lifecycle hooks — REST', () => {
  test('beforeCreate sees the stamped input and can mutate it', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const seen = [];
    await loadSchemaWithHooks(ctx.app.locals.schemaLoader, {
      path: 'hooktest_create',
      hooks: {
        beforeCreate: async ({ input, user: who, req }) => {
          seen.push({ input: { ...input }, userId: who && who.user_id, hasReq: !!req });
          return { ...input, title: input.title + ' [mutated]' };
        },
      },
    });

    const res = await ctx
      .request(ctx.app)
      .post('/api/v1/hooktest_create')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'hello' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('hello [mutated]');
    expect(seen).toHaveLength(1);
    expect(seen[0].userId).toBe(String(user._id));
    expect(seen[0].hasReq).toBe(true);
    expect(seen[0].input.userId).toBe(String(user._id));
    expect(seen[0].input.accountId).toBe(String(user._id));
  });

  test('beforeCreate throwing rejects the request through errorHandler', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const { ValidationError } = require('../utils/errors');
    await loadSchemaWithHooks(ctx.app.locals.schemaLoader, {
      path: 'hooktest_reject',
      hooks: {
        beforeCreate: async ({ input }) => {
          if (input.title === 'bad') throw new ValidationError('title forbidden');
        },
      },
    });

    const ok = await ctx
      .request(ctx.app)
      .post('/api/v1/hooktest_reject')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'fine' });
    expect(ok.status).toBe(201);

    const bad = await ctx
      .request(ctx.app)
      .post('/api/v1/hooktest_reject')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'bad' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe('title forbidden');

    const list = await ctx
      .request(ctx.app)
      .get('/api/v1/hooktest_reject')
      .set('Authorization', `Bearer ${user.token}`);
    expect(list.body.totalResults).toBe(1);
  });

  test('afterCreate receives the persisted record (best-effort: throws are logged, not surfaced)', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const seen = [];
    await loadSchemaWithHooks(ctx.app.locals.schemaLoader, {
      path: 'hooktest_aftercreate',
      hooks: {
        afterCreate: async ({ record, user: who }) => {
          seen.push({ id: record._id, title: record.title, userId: who.user_id });
          throw new Error('boom');
        },
      },
    });

    const res = await ctx
      .request(ctx.app)
      .post('/api/v1/hooktest_aftercreate')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'survives hook throw' });

    expect(res.status).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0].title).toBe('survives hook throw');
  });

  test('beforeUpdate sees current and can rewrite input; afterUpdate sees previous + record', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const beforeCalls = [];
    const afterCalls = [];
    await loadSchemaWithHooks(ctx.app.locals.schemaLoader, {
      path: 'hooktest_update',
      hooks: {
        beforeUpdate: async ({ input, current }) => {
          beforeCalls.push({ inputTitle: input.title, currentTitle: current.title });
          return { ...input, note: 'set-by-hook' };
        },
        afterUpdate: async ({ record, previous }) => {
          afterCalls.push({
            previousTitle: previous.title,
            recordTitle: record.title,
            recordNote: record.note,
          });
        },
      },
    });

    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/hooktest_update')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'first' });
    expect(created.status).toBe(201);

    const updated = await ctx
      .request(ctx.app)
      .put(`/api/v1/hooktest_update/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'second' });
    expect(updated.status).toBe(200);

    const fetched = await ctx
      .request(ctx.app)
      .get(`/api/v1/hooktest_update/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(fetched.body.title).toBe('second');
    expect(fetched.body.note).toBe('set-by-hook');

    expect(beforeCalls).toEqual([{ inputTitle: 'second', currentTitle: 'first' }]);
    expect(afterCalls).toHaveLength(1);
    expect(afterCalls[0].previousTitle).toBe('first');
    expect(afterCalls[0].recordTitle).toBe('second');
    expect(afterCalls[0].recordNote).toBe('set-by-hook');
  });

  test('beforeDelete throwing keeps the record alive', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const { ForbiddenError } = require('../utils/errors');
    let allow = false;
    const afterCalls = [];
    await loadSchemaWithHooks(ctx.app.locals.schemaLoader, {
      path: 'hooktest_delete',
      hooks: {
        beforeDelete: async ({ current }) => {
          if (!allow) throw new ForbiddenError(`refuse to delete ${current.title}`);
        },
        afterDelete: async ({ record }) => {
          afterCalls.push(record.title);
        },
      },
    });

    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/hooktest_delete')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ title: 'precious' });
    expect(created.status).toBe(201);

    const blocked = await ctx
      .request(ctx.app)
      .delete(`/api/v1/hooktest_delete/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toBe('refuse to delete precious');
    expect(afterCalls).toHaveLength(0);

    // Record is still there
    const stillThere = await ctx
      .request(ctx.app)
      .get(`/api/v1/hooktest_delete/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(stillThere.status).toBe(200);

    allow = true;
    const ok = await ctx
      .request(ctx.app)
      .delete(`/api/v1/hooktest_delete/${created.body._id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(ok.status).toBe(200);
    expect(afterCalls).toEqual(['precious']);
  });
});

describe('Schema lifecycle hooks — GraphQL', () => {
  test('createOne / updateById / removeById all fire their hooks', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const trace = [];
    await loadSchemaWithHooks(ctx.app.locals.schemaLoader, {
      path: 'hooktest_gql',
      hooks: {
        beforeCreate: async ({ input }) => {
          trace.push('beforeCreate');
          return { ...input, note: 'gql-create' };
        },
        afterCreate: async ({ record }) => {
          trace.push(`afterCreate:${record.note}`);
        },
        beforeUpdate: async ({ input, current }) => {
          trace.push(`beforeUpdate:${current.title}->${input.title}`);
          return input;
        },
        afterUpdate: async ({ record, previous }) => {
          trace.push(`afterUpdate:${previous.title}->${record.title}`);
        },
        beforeDelete: async ({ current }) => {
          trace.push(`beforeDelete:${current.title}`);
        },
        afterDelete: async ({ record }) => {
          trace.push(`afterDelete:${record ? record.title : 'null'}`);
        },
      },
    });

    const gql = (query) =>
      ctx
        .request(ctx.app)
        .post('/graphql')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ query });

    const createRes = await gql(`
      mutation {
        hooktest_gqlCreateOne(record: { title: "first" }) {
          record { _id title note }
        }
      }
    `);
    expect(createRes.status).toBe(200);
    expect(createRes.body.errors).toBeUndefined();
    const created = createRes.body.data.hooktest_gqlCreateOne.record;
    expect(created.note).toBe('gql-create');

    const updateRes = await gql(`
      mutation {
        hooktest_gqlUpdateById(_id: "${created._id}", record: { title: "second" }) {
          record { _id title }
        }
      }
    `);
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.errors).toBeUndefined();

    const removeRes = await gql(`
      mutation {
        hooktest_gqlRemoveById(_id: "${created._id}") {
          recordId
        }
      }
    `);
    expect(removeRes.status).toBe(200);
    expect(removeRes.body.errors).toBeUndefined();

    expect(trace).toEqual([
      'beforeCreate',
      'afterCreate:gql-create',
      'beforeUpdate:first->second',
      'afterUpdate:first->second',
      'beforeDelete:second',
      'afterDelete:second',
    ]);
  });

  test('hooks do NOT fire on bulk paths (createMany, updateMany)', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const trace = [];
    await loadSchemaWithHooks(ctx.app.locals.schemaLoader, {
      path: 'hooktest_gql_bulk',
      hooks: {
        beforeCreate: async ({ input }) => {
          trace.push(`beforeCreate:${input.title}`);
        },
        beforeUpdate: async ({ input }) => {
          trace.push(`beforeUpdate:${input.title}`);
        },
      },
    });

    const gql = (query) =>
      ctx
        .request(ctx.app)
        .post('/graphql')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ query });

    const res = await gql(`
      mutation {
        hooktest_gql_bulkCreateMany(records: [
          { title: "a" }, { title: "b" }
        ]) { createdCount }
      }
    `);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.hooktest_gql_bulkCreateMany.createdCount).toBe(2);

    expect(trace).toEqual([]);
  });
});
