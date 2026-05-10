const { setupTestApp, registerUser } = require('./helpers');
const { buildManifest, describeFieldType } = require('../utils/describeManifest');

describe('describeManifest: pure helpers', () => {
  describe('describeFieldType', () => {
    test('normalises constructor types', () => {
      expect(describeFieldType(String)).toBe('String');
      expect(describeFieldType(Number)).toBe('Number');
      expect(describeFieldType(Boolean)).toBe('Boolean');
      expect(describeFieldType(Date)).toBe('Date');
    });

    test('handles array shorthand', () => {
      expect(describeFieldType([String])).toBe('[String]');
      expect(describeFieldType([Number])).toBe('[Number]');
    });

    test('unwraps the expanded { type: X, ... } form', () => {
      expect(describeFieldType({ type: String, required: true })).toBe('String');
    });

    test('falls back to Mixed for unknown shapes', () => {
      expect(describeFieldType(undefined)).toBe('Mixed');
      expect(describeFieldType(null)).toBe('Mixed');
      expect(describeFieldType(42)).toBe('Mixed');
    });
  });

  describe('buildManifest with a stub loader', () => {
    const stubLoader = (entries) => ({
      listSchemas: () => Object.keys(entries),
      getEntry: (k) => entries[k] || null,
    });

    test('emits service info, conventions, auth, graphql sections', () => {
      const manifest = buildManifest({ schemaLoader: stubLoader({}) });
      expect(manifest.service.name).toBeDefined();
      expect(manifest.auth.login).toBe('POST /login');
      expect(manifest.conventions.include).toMatch(/__include/);
      expect(manifest.conventions.tenancy).toMatch(/JWT/);
      expect(manifest.graphql.endpoint).toBe('POST /graphql/');
      expect(manifest.schemas).toEqual({});
    });

    test('describes a fully-featured schema', () => {
      const loader = stubLoader({
        'v1/widget': {
          schema: {
            path: 'widget',
            collection: 'widget',
            version: 'v1',
            description: 'A test widget',
            fields: [
              { name: 'userId', type: String, required: true },
              { name: 'name', type: String, required: true, searchable: true, searchWeight: 5 },
              { name: 'tags', type: [String] },
              { name: 'salary', type: Number, acl: { read: ['admin'], update: ['admin'] } },
              {
                name: 'logo',
                type: 'File',
                file: { maxBytes: 1024, accept: ['image/*'], access: 'public' },
              },
            ],
            relations: {
              owner: { belongsTo: 'user', localKey: 'userId' },
              tasks: { hasMany: 'task', foreignKey: 'widgetId' },
            },
            aggregations: [
              {
                name: 'countByTag',
                params: { tag: { type: 'string', required: true } },
                pipeline: [],
                cache: { ttlSeconds: 60 },
              },
            ],
            acl: { list: ['admin'] },
          },
        },
      });
      const m = buildManifest({ schemaLoader: loader });
      const w = m.schemas['v1/widget'];
      expect(w.path).toBe('/api/v1/widget');
      expect(w.description).toBe('A test widget');

      // Fields normalised, ACL surfaced inline + at the schema level.
      const byName = Object.fromEntries(w.fields.map((f) => [f.name, f]));
      expect(byName.tags.type).toBe('[String]');
      expect(byName.salary.acl.read).toEqual(['admin']);
      expect(byName.logo.file.accept).toEqual(['image/*']);

      // Top-level acl summary mirrors per-field ACL for quick lookup.
      expect(w.acl.list).toEqual(['admin']);
      expect(w.acl.fields.salary.read).toEqual(['admin']);

      // Relations and aggregations.
      expect(w.relations.owner).toMatchObject({ kind: 'belongsTo', target: 'user' });
      expect(w.relations.tasks).toMatchObject({ kind: 'hasMany', target: 'task' });
      expect(w.aggregations[0].name).toBe('countByTag');
      expect(w.aggregations[0].cache.ttlSeconds).toBe(60);
      expect(w.aggregations[0].params.tag).toMatchObject({
        type: 'string',
        required: true,
      });

      // Features + endpoints.
      expect(w.features.softDelete).toBe(true);
      expect(w.features.audit).toBe(true);
      expect(w.features.search).toEqual(['name']);
      expect(w.endpoints.list).toMatch(/GET\s+\/api\/v1\/widget$/);
      expect(w.endpoints.restore).toMatch(/restore/);
      expect(w.endpoints.history).toMatch(/history/);
      expect(w.endpoints.aggregations[0]).toMatch(/countByTag/);
      expect(w.endpoints.files.logo.upload).toMatch(/POST.*\/logo$/);

      // GraphQL surface.
      expect(w.graphql.queries).toContain('widgetMany');
      expect(w.graphql.queries).toContain('widgetCountByTag');
      expect(w.graphql.mutations).toContain('widgetCreateOne');
      expect(w.graphql.relations).toEqual(
        expect.arrayContaining(['widget.owner', 'widget.tasks'])
      );

      // File fields.
      expect(w.fileFields[0].name).toBe('logo');
      expect(w.fileFields[0].access).toBe('public');
    });

    test('omits restore/history/files/aggregations when not declared', () => {
      const loader = stubLoader({
        'v1/minimal': {
          schema: {
            path: 'minimal',
            collection: 'minimal',
            version: 'v1',
            fields: [{ name: 'userId', type: String }],
            softDelete: false,
            audit: false,
          },
        },
      });
      const m = buildManifest({ schemaLoader: loader });
      const min = m.schemas['v1/minimal'];
      expect(min.endpoints.restore).toBeUndefined();
      expect(min.endpoints.history).toBeUndefined();
      expect(min.endpoints.files).toBeUndefined();
      expect(min.endpoints.aggregations).toBeUndefined();
      expect(min.fileFields).toBeUndefined();
      expect(min.aggregations).toBeUndefined();
      expect(min.relations).toBeUndefined();
      expect(min.features.softDelete).toBe(false);
    });

    test('serialises function defaults as a stable token', () => {
      const loader = stubLoader({
        'v1/widget': {
          schema: {
            path: 'widget',
            collection: 'widget',
            version: 'v1',
            fields: [{ name: 'createdAt', type: Date, default: Date.now }],
          },
        },
      });
      const m = buildManifest({ schemaLoader: loader });
      const f = m.schemas['v1/widget'].fields.find((x) => x.name === 'createdAt');
      expect(f.default).toBe('[fn]');
    });

    test('drops aggregations without a pipeline array (matches loader mount predicate)', () => {
      const loader = stubLoader({
        'v1/widget': {
          schema: {
            path: 'widget',
            collection: 'widget',
            version: 'v1',
            fields: [{ name: 'userId', type: String }],
            aggregations: [
              { name: 'good', pipeline: [{ $count: 'n' }] },
              { name: 'missingPipeline' }, // loader would skip this
              { pipeline: [{ $count: 'n' }] }, // missing name
            ],
          },
        },
      });
      const w = buildManifest({ schemaLoader: loader }).schemas['v1/widget'];
      // `aggregations` block: only the live one survives.
      expect(w.aggregations.map((a) => a.name)).toEqual(['good']);
      // Endpoint list: same.
      expect(w.endpoints.aggregations).toEqual([
        expect.stringMatching(/aggregations\/good$/),
      ]);
      // GraphQL queries: only widgetGood, not widgetMissingPipeline.
      expect(w.graphql.queries).toContain('widgetGood');
      expect(w.graphql.queries).not.toContain('widgetMissingPipeline');
    });

    test('keys are composite (version/path) so two versions of the same resource do not collide', () => {
      const loader = stubLoader({
        'v1/account': {
          schema: {
            path: 'account',
            collection: 'account',
            version: 'v1',
            fields: [{ name: 'name', type: String }],
          },
        },
        'v2/account': {
          schema: {
            path: 'account',
            collection: 'account',
            version: 'v2',
            fields: [
              { name: 'name', type: String },
              { name: 'tier', type: String },
            ],
          },
        },
      });
      const m = buildManifest({ schemaLoader: loader });
      // Both entries survive the build — neither overwrites the other.
      expect(m.schemas['v1/account']).toBeDefined();
      expect(m.schemas['v2/account']).toBeDefined();
      // And each carries its own version + field set.
      expect(m.schemas['v1/account'].version).toBe('v1');
      expect(m.schemas['v2/account'].version).toBe('v2');
      expect(m.schemas['v2/account'].fields.map((f) => f.name)).toContain('tier');
      expect(m.schemas['v1/account'].fields.map((f) => f.name)).not.toContain('tier');
    });
  });
});

describe('GET /_describe endpoint', () => {
  const ctx = setupTestApp({ cleanCollections: false });
  const ORIGINAL_REQUIRES_AUTH = process.env.DESCRIBE_REQUIRES_AUTH;

  afterAll(() => {
    if (ORIGINAL_REQUIRES_AUTH === undefined) {
      delete process.env.DESCRIBE_REQUIRES_AUTH;
    } else {
      process.env.DESCRIBE_REQUIRES_AUTH = ORIGINAL_REQUIRES_AUTH;
    }
  });

  test('public 200 with the seed schemas listed', async () => {
    delete process.env.DESCRIBE_REQUIRES_AUTH;
    const res = await ctx.request(ctx.app).get('/_describe');
    expect(res.status).toBe(200);
    // Seed schemas (account, contact, product, project, quote, category)
    // all live under v1/.
    expect(res.body.schemas['v1/account']).toBeDefined();
    expect(res.body.schemas['v1/account'].path).toBe('/api/v1/account');
    expect(res.body.schemas['v1/account'].endpoints.list).toMatch(/\/api\/v1\/account$/);
    expect(res.body.schemas['v1/account'].graphql.queries).toContain('accountMany');
    // Quote ships with an aggregation declared.
    expect(res.body.schemas['v1/quote'].aggregations).toBeDefined();
    expect(res.body.schemas['v1/quote'].aggregations[0].name).toBe('countByAccount');
    expect(res.body.conventions.include).toMatch(/__include/);
    expect(res.body.auth.login).toBe('POST /login');
  });

  test('hot-reload: a newly-loaded schema appears on the next request', async () => {
    delete process.env.DESCRIBE_REQUIRES_AUTH;
    const before = await ctx.request(ctx.app).get('/_describe');
    expect(before.body.schemas['v1/dyn_describe']).toBeUndefined();

    await ctx.app.locals.schemaLoader.loadSchema({
      path: 'dyn_describe',
      collection: 'dyn_describe',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String },
      ],
      relations: { author: { belongsTo: 'account', localKey: 'userId' } },
    });

    const after = await ctx.request(ctx.app).get('/_describe');
    expect(after.body.schemas['v1/dyn_describe']).toBeDefined();
    expect(after.body.schemas['v1/dyn_describe'].relations.author).toMatchObject({
      kind: 'belongsTo',
      target: 'account',
    });

    // Cleanup so this test doesn't bleed into siblings.
    await ctx.app.locals.schemaLoader.unloadSchema('v1/dyn_describe');
    const reverted = await ctx.request(ctx.app).get('/_describe');
    expect(reverted.body.schemas['v1/dyn_describe']).toBeUndefined();
  });

  test('DESCRIBE_REQUIRES_AUTH=true gates the endpoint', async () => {
    process.env.DESCRIBE_REQUIRES_AUTH = 'true';
    try {
      const blocked = await ctx.request(ctx.app).get('/_describe');
      expect(blocked.status).toBe(403);

      const user = await registerUser(ctx.request, ctx.app);
      const allowed = await ctx
        .request(ctx.app)
        .get('/_describe')
        .set('Authorization', `Bearer ${user.token}`);
      expect(allowed.status).toBe(200);
      expect(allowed.body.schemas['v1/account']).toBeDefined();
    } finally {
      delete process.env.DESCRIBE_REQUIRES_AUTH;
    }
  });

  test('manifest is much smaller than swagger.json', async () => {
    delete process.env.DESCRIBE_REQUIRES_AUTH;
    const [d, s] = await Promise.all([
      ctx.request(ctx.app).get('/_describe'),
      ctx.request(ctx.app).get('/api-docs/swagger.json'),
    ]);
    const dSize = JSON.stringify(d.body).length;
    const sSize = JSON.stringify(s.body).length;
    // Loose assertion — swagger.json's redundancy guarantees at least 2x.
    expect(dSize).toBeLessThan(sSize);
  });
});
