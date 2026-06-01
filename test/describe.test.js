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

    test('passes through field-level UI hints', () => {
      const loader = stubLoader({
        'v1/widget': {
          schema: {
            path: 'widget',
            collection: 'widget',
            version: 'v1',
            fields: [
              { name: 'userId', type: String, required: true, stamped: true },
              { name: 'status', type: String, enum: ['lead', 'won', 'lost'] },
              {
                name: 'amount',
                type: Number,
                widget: 'currency',
                format: 'currency:USD',
              },
              { name: 'notes', type: String, widget: 'rich-text', label: 'Notes (markdown)' },
            ],
          },
        },
      });
      const m = buildManifest({ schemaLoader: loader });
      const byName = Object.fromEntries(m.schemas['v1/widget'].fields.map((f) => [f.name, f]));

      expect(byName.userId.stamped).toBe(true);
      expect(byName.status.enum).toEqual(['lead', 'won', 'lost']);
      expect(byName.amount.widget).toBe('currency');
      expect(byName.amount.format).toBe('currency:USD');
      expect(byName.notes.widget).toBe('rich-text');
      expect(byName.notes.label).toBe('Notes (markdown)');
    });

    test('passes through schema-level display hints', () => {
      const loader = stubLoader({
        'v1/widget': {
          schema: {
            path: 'widget',
            collection: 'widget',
            version: 'v1',
            label: 'Widget',
            pluralLabel: 'Widgets',
            displayField: 'widgetName',
            fields: [
              { name: 'userId', type: String, required: true },
              { name: 'widgetName', type: String, required: true },
            ],
          },
        },
      });
      const w = buildManifest({ schemaLoader: loader }).schemas['v1/widget'];
      expect(w.label).toBe('Widget');
      expect(w.pluralLabel).toBe('Widgets');
      expect(w.displayField).toBe('widgetName');
    });

    test('drops field hints that are empty / missing / wrong type', () => {
      const loader = stubLoader({
        'v1/widget': {
          schema: {
            path: 'widget',
            collection: 'widget',
            version: 'v1',
            fields: [
              { name: 'a', type: String, widget: '', format: '', label: '' },
              { name: 'b', type: String, widget: null, format: 42 },
              { name: 'c', type: String, stamped: false },
              { name: 'd', type: String, enum: [] },
              // `stamped` must pass through only on `=== true`. Truthy
              // non-boolean values (strings, numbers, objects) get
              // dropped — otherwise a typo (`stamped: 'true'`) would
              // silently coerce to true in the manifest and the UI would
              // hide the field forever.
              { name: 'e', type: String, stamped: 'true' },
              { name: 'f', type: String, stamped: 1 },
              { name: 'g', type: String, stamped: {} },
              { name: 'h', type: String, stamped: 'yes' },
            ],
          },
        },
      });
      const fields = buildManifest({ schemaLoader: loader }).schemas['v1/widget'].fields;
      for (const f of fields) {
        expect(f.widget).toBeUndefined();
        expect(f.format).toBeUndefined();
        expect(f.label).toBeUndefined();
        expect(f.stamped).toBeUndefined();
        expect(f.enum).toBeUndefined();
      }
    });

    test('stamped: true is the only value that passes through', () => {
      const loader = stubLoader({
        'v1/widget': {
          schema: {
            path: 'widget',
            collection: 'widget',
            version: 'v1',
            fields: [
              { name: 'userId', type: String, stamped: true },
            ],
          },
        },
      });
      const fields = buildManifest({ schemaLoader: loader }).schemas['v1/widget'].fields;
      expect(fields[0].stamped).toBe(true);
    });

    test('auto-populates inverse hasMany from sibling belongsTo', () => {
      const loader = stubLoader({
        'v1/account': {
          schema: {
            path: 'account',
            collection: 'account',
            version: 'v1',
            fields: [{ name: 'userId', type: String, required: true }],
          },
        },
        'v1/deal': {
          schema: {
            path: 'deal',
            collection: 'deal',
            version: 'v1',
            fields: [
              { name: 'userId', type: String, required: true },
              { name: 'accountId', type: String, required: true },
            ],
            relations: {
              account: { belongsTo: 'account', localKey: 'accountId' },
            },
          },
        },
      });
      const m = buildManifest({ schemaLoader: loader });
      // The deal still declares `belongsTo: account` straight from the schema.
      expect(m.schemas['v1/deal'].relations.account).toMatchObject({
        kind: 'belongsTo',
        target: 'account',
        localKey: 'accountId',
      });
      // The parent picks up a synthetic hasMany pointing at the child.
      const parent = m.schemas['v1/account'];
      expect(parent.relations).toBeDefined();
      const inverse = Object.values(parent.relations).find(
        (r) => r.target === 'deal' && r.foreignKey === 'accountId'
      );
      expect(inverse).toMatchObject({
        kind: 'hasMany',
        target: 'deal',
        foreignKey: 'accountId',
        inverse: true,
        callable: false,
      });
    });

    test('synthetic inverses are flagged callable: false but author-declared edges are not', () => {
      const loader = stubLoader({
        'v1/account': {
          schema: {
            path: 'account',
            collection: 'account',
            version: 'v1',
            fields: [{ name: 'userId', type: String, required: true }],
          },
        },
        'v1/deal': {
          schema: {
            path: 'deal',
            collection: 'deal',
            version: 'v1',
            fields: [
              { name: 'userId', type: String, required: true },
              { name: 'accountId', type: String, required: true },
            ],
            relations: {
              account: { belongsTo: 'account', localKey: 'accountId' },
            },
          },
        },
      });
      const m = buildManifest({ schemaLoader: loader });
      // Synthetic inverse → callable: false (manifest-only discovery hint;
      // runtime relation map is per-schema and doesn't see siblings).
      const inverse = Object.values(m.schemas['v1/account'].relations).find(
        (r) => r.target === 'deal'
      );
      expect(inverse.callable).toBe(false);
      // Author-declared edge → no callable flag (callable is the default).
      const declared = m.schemas['v1/deal'].relations.account;
      expect(declared.callable).toBeUndefined();
      expect(declared.kind).toBe('belongsTo');
    });

    test('inverse population does not override an explicit hasMany', () => {
      const loader = stubLoader({
        'v1/account': {
          schema: {
            path: 'account',
            collection: 'account',
            version: 'v1',
            fields: [{ name: 'userId', type: String, required: true }],
            // Author already declared the inverse — author wins.
            relations: {
              deals: { hasMany: 'deal', foreignKey: 'accountId', where: { stage: 'open' } },
            },
          },
        },
        'v1/deal': {
          schema: {
            path: 'deal',
            collection: 'deal',
            version: 'v1',
            fields: [{ name: 'accountId', type: String, required: true }],
            relations: {
              account: { belongsTo: 'account', localKey: 'accountId' },
            },
          },
        },
      });
      const parent = buildManifest({ schemaLoader: loader }).schemas['v1/account'];
      expect(parent.relations.deals.where).toEqual({ stage: 'open' });
      // Author's `deals` is the only relation pointing at deal/accountId — no
      // synthetic shadow gets registered.
      const dealRels = Object.values(parent.relations).filter(
        (r) => r.target === 'deal' && r.foreignKey === 'accountId'
      );
      expect(dealRels).toHaveLength(1);
      expect(dealRels[0].inverse).toBeUndefined();
    });

    test('inverse population prefers same-version parent when multiple versions exist', () => {
      const loader = stubLoader({
        'v1/account': {
          schema: {
            path: 'account',
            collection: 'account',
            version: 'v1',
            fields: [{ name: 'userId', type: String, required: true }],
          },
        },
        'v2/account': {
          schema: {
            path: 'account',
            collection: 'account',
            version: 'v2',
            fields: [
              { name: 'userId', type: String, required: true },
              { name: 'tier', type: String },
            ],
          },
        },
        'v2/deal': {
          schema: {
            path: 'deal',
            collection: 'deal',
            version: 'v2',
            fields: [
              { name: 'userId', type: String, required: true },
              { name: 'accountId', type: String, required: true },
            ],
            // un-versioned target — resolver must walk to v2 parent because
            // child is on v2, not the flat last-write-wins v2 entry by
            // accident.
            relations: {
              account: { belongsTo: 'account', localKey: 'accountId' },
            },
          },
        },
      });
      const m = buildManifest({ schemaLoader: loader });
      const v1Parent = m.schemas['v1/account'];
      const v2Parent = m.schemas['v2/account'];

      // v2/deal's inverse must land on v2/account, not v1/account.
      expect(v2Parent.relations).toBeDefined();
      const v2Inverse = Object.values(v2Parent.relations).find(
        (r) => r.target === 'deal' && r.foreignKey === 'accountId'
      );
      expect(v2Inverse).toMatchObject({ kind: 'hasMany', target: 'deal', inverse: true, callable: false });

      // v1/account stays untouched — no child on v1 declares belongsTo it.
      expect(v1Parent.relations).toBeUndefined();
    });

    test('inverse population falls back to any-version when same-version parent is missing', () => {
      const loader = stubLoader({
        'v1/account': {
          schema: {
            path: 'account',
            collection: 'account',
            version: 'v1',
            fields: [{ name: 'userId', type: String, required: true }],
          },
        },
        'v2/deal': {
          schema: {
            path: 'deal',
            collection: 'deal',
            version: 'v2',
            fields: [{ name: 'accountId', type: String, required: true }],
            relations: {
              account: { belongsTo: 'account', localKey: 'accountId' },
            },
          },
        },
      });
      const m = buildManifest({ schemaLoader: loader });
      // No v2/account — resolver falls back to v1/account so the inverse
      // edge still materialises somewhere useful.
      const v1Parent = m.schemas['v1/account'];
      expect(v1Parent.relations).toBeDefined();
      const inverse = Object.values(v1Parent.relations).find(
        (r) => r.target === 'deal' && r.foreignKey === 'accountId'
      );
      expect(inverse).toMatchObject({
        kind: 'hasMany',
        target: 'deal',
        foreignKey: 'accountId',
        inverse: true,
        callable: false,
      });
    });

    test('inverse population skips belongsTo when target is unregistered', () => {
      const loader = stubLoader({
        'v1/orphan': {
          schema: {
            path: 'orphan',
            collection: 'orphan',
            version: 'v1',
            fields: [{ name: 'ghostId', type: String, required: true }],
            relations: {
              ghost: { belongsTo: 'ghost', localKey: 'ghostId' },
            },
          },
        },
      });
      // Loader has no 'v1/ghost' — no inverse can be attached. The child
      // entry should still carry its own belongsTo unchanged.
      const m = buildManifest({ schemaLoader: loader });
      expect(m.schemas['v1/orphan'].relations.ghost).toMatchObject({
        kind: 'belongsTo',
        target: 'ghost',
      });
      // No new schema entry materialises out of thin air.
      expect(Object.keys(m.schemas)).toEqual(['v1/orphan']);
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

    test('only attaches `file` block when type is "File" (strict, matches framework detection)', () => {
      const loader = stubLoader({
        'v1/widget': {
          schema: {
            path: 'widget',
            collection: 'widget',
            version: 'v1',
            fields: [
              { name: 'realFile', type: 'File', file: { access: 'private' } },
              // A stray `file: {}` block on a non-File field — the
              // framework ignores it for routing, so the manifest
              // must too.
              { name: 'spurious', type: String, file: { access: 'public' } },
            ],
          },
        },
      });
      const w = buildManifest({ schemaLoader: loader }).schemas['v1/widget'];
      const real = w.fields.find((f) => f.name === 'realFile');
      const spurious = w.fields.find((f) => f.name === 'spurious');
      expect(real.file).toBeDefined();
      expect(real.file.access).toBe('private');
      expect(spurious.file).toBeUndefined();
      // And the top-level fileFields list also strictly matches.
      expect(w.fileFields.map((f) => f.name)).toEqual(['realFile']);
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

  test('seed schemas expose display + stamped + relation hints', async () => {
    delete process.env.DESCRIBE_REQUIRES_AUTH;
    const res = await ctx.request(ctx.app).get('/_describe');
    expect(res.status).toBe(200);
    const schemas = res.body.schemas;

    // Schema-level hints land on every seed CRM resource so an admin UI
    // doesn't have to title-case paths or sniff for a display field.
    expect(schemas['v1/account']).toMatchObject({
      label: 'Account',
      pluralLabel: 'Accounts',
      displayField: 'accountName',
    });
    expect(schemas['v1/contact'].displayField).toBe('first_name');
    expect(schemas['v1/category'].pluralLabel).toBe('Categories');
    expect(schemas['v1/product'].displayField).toBe('name');
    expect(schemas['v1/project'].displayField).toBe('name');
    expect(schemas['v1/quote'].displayField).toBe('description');

    // Stamped flag travels through on every seed userId / accountId so
    // consumers can hide tenant markers from create/edit forms.
    const accountFields = Object.fromEntries(
      schemas['v1/account'].fields.map((f) => [f.name, f])
    );
    expect(accountFields.userId.stamped).toBe(true);
    expect(accountFields.accountName.stamped).toBeUndefined();

    const contactFields = Object.fromEntries(
      schemas['v1/contact'].fields.map((f) => [f.name, f])
    );
    expect(contactFields.userId.stamped).toBe(true);
    expect(contactFields.accountId.stamped).toBe(true);
    expect(contactFields.first_name.stamped).toBeUndefined();

    // Field-level hints on contact + product.
    expect(contactFields.email.widget).toBe('email');
    expect(contactFields.first_name.label).toBe('First name');
    const productFields = Object.fromEntries(
      schemas['v1/product'].fields.map((f) => [f.name, f])
    );
    expect(productFields.price.widget).toBe('currency');
    expect(productFields.price.format).toBe('currency:USD');
    expect(productFields.sku.label).toBe('SKU');

    // Quote declares belongsTo: contact → backend auto-populates the
    // inverse hasMany on contact. The admin UI uses this to render a
    // "Quotes" tab on each contact's detail page.
    const contactRelations = schemas['v1/contact'].relations;
    expect(contactRelations).toBeDefined();
    const quotesInverse = Object.values(contactRelations).find(
      (r) => r.target === 'quote' && r.foreignKey === 'contactId'
    );
    expect(quotesInverse).toMatchObject({
      kind: 'hasMany',
      target: 'quote',
      foreignKey: 'contactId',
      inverse: true,
      callable: false,
    });

    // Self-references on category + project also surface as belongsTo
    // edges, plus their inverses.
    expect(schemas['v1/category'].relations.parentCategory).toMatchObject({
      kind: 'belongsTo',
      target: 'category',
      localKey: 'parent',
    });
    expect(schemas['v1/project'].relations.parentProject).toMatchObject({
      kind: 'belongsTo',
      target: 'project',
      localKey: 'parent',
    });
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
