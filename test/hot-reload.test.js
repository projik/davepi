const fs = require('fs');
const path = require('path');
const { setupTestApp, registerUser } = require('./helpers');

const ctx = setupTestApp();

const TEST_SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  'schema',
  'versions',
  'v1',
  '__hotreload.js'
);

const writeSchema = (fields) => {
  const src = `module.exports = ${JSON.stringify(
    {
      path: 'hotreload',
      collection: 'hotreload',
      fields: fields.map((f) => ({ ...f, type: '__TYPE__' })),
    },
    null,
    2
  )};`
    // JSON.stringify can't handle native types — splice them in.
    .replace(/"__TYPE__"/g, 'String');
  fs.writeFileSync(TEST_SCHEMA_PATH, src);
};

afterAll(() => {
  if (fs.existsSync(TEST_SCHEMA_PATH)) fs.unlinkSync(TEST_SCHEMA_PATH);
});

describe('Schema hot reload (programmatic)', () => {
  test('loadSchema mounts REST routes immediately, no restart', async () => {
    const user = await registerUser(ctx.request, ctx.app);
    const token = user.token;

    // Pre-load: route does not exist.
    const before = await ctx
      .request(ctx.app)
      .get('/api/v1/hotreload')
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(404);

    const schema = {
      path: 'hotreload',
      collection: 'hotreload',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
      ],
    };
    await ctx.app.locals.schemaLoader.loadSchema(schema);

    // POST works against the freshly-mounted route.
    const created = await ctx
      .request(ctx.app)
      .post('/api/v1/hotreload')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'first' });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe('first');

    // GET list works too.
    const listed = await ctx
      .request(ctx.app)
      .get('/api/v1/hotreload')
      .set('Authorization', `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.totalResults).toBe(1);
    expect(listed.body.results[0].title).toBe('first');

    // Swagger spec now lists the new resource.
    const swagger = await ctx.request(ctx.app).get('/api-docs/swagger.json');
    expect(swagger.status).toBe(200);
    expect(swagger.body.paths['/api/v1/hotreload']).toBeDefined();
    expect(swagger.body.definitions['hotreload']).toBeDefined();

    // GraphQL has the new type/resolvers.
    const gql = await ctx
      .request(ctx.app)
      .post('/graphql/')
      .set('Authorization', `Bearer ${token}`)
      .send({ query: 'query { hotreloadMany { _id title } }' });
    expect(gql.status).toBe(200);
    expect(gql.body.data.hotreloadMany).toBeDefined();
    expect(gql.body.data.hotreloadMany[0].title).toBe('first');
  });

  test('reloading the same schema is idempotent (no duplicate routes)', async () => {
    const schema = {
      path: 'hotreload',
      collection: 'hotreload',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
      ],
    };
    await ctx.app.locals.schemaLoader.loadSchema(schema);
    await ctx.app.locals.schemaLoader.loadSchema(schema);
    await ctx.app.locals.schemaLoader.loadSchema(schema);

    // Inspect the underlying Express stack: there must be exactly one
    // mounted Router that handles /api/v1/hotreload.
    const stack = ctx.app._router.stack;
    const routerLayers = stack.filter(
      (l) => l.handle && l.handle.stack && l.handle.stack.some((s) =>
        s.route && /\/api\/v1\/hotreload/.test(s.route.path)
      )
    );
    expect(routerLayers).toHaveLength(1);
  });

  test('unloadSchema removes REST routes, Swagger, and GraphQL fields', async () => {
    const schema = {
      path: 'hotreload',
      collection: 'hotreload',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
      ],
    };
    await ctx.app.locals.schemaLoader.loadSchema(schema);

    const user = await registerUser(ctx.request, ctx.app);
    const token = user.token;

    // Route is reachable.
    const before = await ctx
      .request(ctx.app)
      .get('/api/v1/hotreload')
      .set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);

    await ctx.app.locals.schemaLoader.unloadSchema('v1/hotreload');

    // Route is gone.
    const after = await ctx
      .request(ctx.app)
      .get('/api/v1/hotreload')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(404);

    // Swagger spec dropped it.
    const swagger = await ctx.request(ctx.app).get('/api-docs/swagger.json');
    expect(swagger.body.paths['/api/v1/hotreload']).toBeUndefined();
    expect(swagger.body.definitions['hotreload']).toBeUndefined();

    // GraphQL no longer knows about hotreloadMany.
    const gql = await ctx
      .request(ctx.app)
      .post('/graphql/')
      .set('Authorization', `Bearer ${token}`)
      .send({ query: 'query { hotreloadMany { _id } }' });
    // Either the field is missing (validation error) or the parse fails.
    expect(gql.body.errors).toBeDefined();
  });

  test('schema edits are picked up: rebuilding with new fields exposes them', async () => {
    const v1 = {
      path: 'hotreload',
      collection: 'hotreload',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
      ],
    };
    await ctx.app.locals.schemaLoader.loadSchema(v1);

    const user = await registerUser(ctx.request, ctx.app);
    const token = user.token;

    const beforeCreate = await ctx
      .request(ctx.app)
      .post('/api/v1/hotreload')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'has no body field', body: 'should be ignored' });
    expect(beforeCreate.status).toBe(201);
    expect(beforeCreate.body.body).toBeUndefined();

    // Reload with a new field.
    const v2 = {
      ...v1,
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
        { name: 'body', type: String },
      ],
    };
    await ctx.app.locals.schemaLoader.loadSchema(v2);

    // Now `body` round-trips on POST/GET.
    const afterCreate = await ctx
      .request(ctx.app)
      .post('/api/v1/hotreload')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'after edit', body: 'now persisted' });
    expect(afterCreate.status).toBe(201);
    expect(afterCreate.body.body).toBe('now persisted');
  });
});

describe('Schema watcher (gated by HOT_RELOAD_SCHEMAS)', () => {
  const { startSchemaWatcher } = require('../utils/schemaWatcher');

  test('returns a no-op watcher when not enabled', async () => {
    const original = process.env.HOT_RELOAD_SCHEMAS;
    delete process.env.HOT_RELOAD_SCHEMAS;
    try {
      const w = startSchemaWatcher({ loader: ctx.app.locals.schemaLoader });
      // No methods to assert on directly; success is "doesn't throw, no
      // chokidar instance was constructed". stop() should be a noop.
      await w.stop();
      expect(typeof w.stop).toBe('function');
    } finally {
      if (original !== undefined) process.env.HOT_RELOAD_SCHEMAS = original;
    }
  });

  test('returns a no-op watcher in production even when flag is true', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalFlag = process.env.HOT_RELOAD_SCHEMAS;
    process.env.NODE_ENV = 'production';
    process.env.HOT_RELOAD_SCHEMAS = 'true';
    try {
      const w = startSchemaWatcher({ loader: ctx.app.locals.schemaLoader });
      await w.stop();
      expect(typeof w.stop).toBe('function');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      process.env.HOT_RELOAD_SCHEMAS = originalFlag;
    }
  });

  // A minimal stand-in for chokidar: records event handlers and lets the
  // test fire them synchronously. chokidar v4 is ESM and can't be
  // require()'d under Jest, so the watcher accepts an injectable instance.
  const makeFakeChokidar = () => {
    const handlers = {};
    const fakeWatcher = {
      on(event, fn) {
        handlers[event] = fn;
        return fakeWatcher;
      },
      close: async () => {},
      emit: (event, arg) => handlers[event] && handlers[event](arg),
    };
    return { watch: () => fakeWatcher, _watcher: () => fakeWatcher };
  };

  // Regression: a schema loaded at boot (stamped with `__sourceFile` by
  // app.js) is never seen by the watcher's `add` handler because
  // `ignoreInitial: true` suppresses the initial scan. Before the
  // seed-from-registry fix, deleting that file left `fileToKey` without
  // an entry, so the `unlink` handler early-returned and the routes /
  // model / GraphQL fields lingered forever — yet the tutorials tell
  // users to delete the starter schema once the server is up.
  test('deleting a boot-loaded schema file unloads it (seeds from registry)', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalFlag = process.env.HOT_RELOAD_SCHEMAS;
    process.env.NODE_ENV = 'development';
    process.env.HOT_RELOAD_SCHEMAS = 'true';

    const loader = ctx.app.locals.schemaLoader;
    const schemasDir = path.resolve(__dirname, '..', 'schema', 'versions');
    const filePath = path.join(schemasDir, 'v1', '__bootloaded.js');
    let watcher;
    try {
      // Simulate the boot-time load: app.js stamps version + __sourceFile
      // before handing the schema to the loader. The file need not exist
      // on disk for this path — the watcher seeds purely from the registry.
      await loader.loadSchema({
        path: 'bootloaded',
        collection: 'bootloaded',
        version: 'v1',
        __sourceFile: filePath,
        fields: [{ name: 'userId', type: String, required: true }],
      });
      expect(loader.listSchemas()).toContain('v1/bootloaded');

      const fake = makeFakeChokidar();
      watcher = startSchemaWatcher({ loader, schemasDir, _chokidar: fake });

      // Fire the unlink chokidar would emit when the developer deletes the
      // starter schema. Without the registry seed, fileToKey has no entry
      // and this is a silent no-op.
      fake._watcher().emit('unlink', filePath);

      // Debounce (100ms) + async unload; poll until it propagates.
      const deadline = Date.now() + 3000;
      while (loader.listSchemas().includes('v1/bootloaded') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(loader.listSchemas()).not.toContain('v1/bootloaded');
    } finally {
      if (watcher) await watcher.stop();
      process.env.NODE_ENV = originalNodeEnv;
      process.env.HOT_RELOAD_SCHEMAS = originalFlag;
    }
  });

  // Regression: creating a new schema file (`workout.js`) used to log a
  // scary "schema reload failed" TypeError, because the editor writes
  // the file empty first — it exports `{}` — and the watcher handed
  // that to the loader, which crashed on `s.fields.forEach`. The
  // watcher must now skip a file that doesn't yet export a usable
  // schema and never call loadSchema for it.
  test('creating an empty schema file is skipped, not handed to the loader', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalFlag = process.env.HOT_RELOAD_SCHEMAS;
    process.env.NODE_ENV = 'development';
    process.env.HOT_RELOAD_SCHEMAS = 'true';

    const loader = ctx.app.locals.schemaLoader;
    const schemasDir = path.resolve(__dirname, '..', 'schema', 'versions');
    const emptyFile = path.join(schemasDir, 'v1', '__empty.js');
    fs.writeFileSync(emptyFile, ''); // an empty .js module exports {}

    // Spy on loadSchema without losing the real behaviour.
    const origLoad = loader.loadSchema;
    const seen = [];
    loader.loadSchema = (s, opts) => {
      seen.push(s);
      return origLoad.call(loader, s, opts);
    };

    let watcher;
    try {
      const fake = makeFakeChokidar();
      watcher = startSchemaWatcher({ loader, schemasDir, _chokidar: fake });
      fake._watcher().emit('add', emptyFile);
      // Wait past the 100ms debounce so the handler has run.
      await new Promise((r) => setTimeout(r, 250));
      expect(seen).toHaveLength(0);
    } finally {
      if (watcher) await watcher.stop();
      loader.loadSchema = origLoad;
      if (fs.existsSync(emptyFile)) fs.unlinkSync(emptyFile);
      process.env.NODE_ENV = originalNodeEnv;
      process.env.HOT_RELOAD_SCHEMAS = originalFlag;
    }
  });

  // The loader itself gives a clear, typed error if it is ever handed a
  // schema with no `fields` array (boot path, programmatic callers),
  // rather than the cryptic destructuring TypeError.
  test('loadSchema rejects a fieldless schema with a clear ValidationError', async () => {
    const loader = ctx.app.locals.schemaLoader;
    await expect(
      loader.loadSchema({ path: 'nofields', collection: 'nofields', version: 'v1' })
    ).rejects.toThrow(/fields/);

    let caught;
    try {
      await loader.loadSchema({ path: 'nofields', collection: 'nofields', version: 'v1' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.message).not.toMatch(/Cannot read properties/);
    expect(loader.listSchemas()).not.toContain('v1/nofields');
  });
});

describe('GraphQL rebuild with an empty registry', () => {
  const express = require('express');
  const { createSchemaLoader } = require('../utils/schemaLoader');

  // Build a standalone loader (independent of the shared test app) so we
  // can drive the registry all the way to empty — which the shared app,
  // with its seed schemas always loaded, can't reach.
  const makeLoader = () => {
    const app = express();
    const apiSpec = { paths: {}, definitions: {} };
    return createSchemaLoader({
      app,
      apiSpec,
      setApolloRouter: () => {},
      buildGraphqlContext: async () => ({}),
      isProduction: () => false,
      errorHandler: (err, req, res, next) => next(err),
    });
  };

  // Regression: unloading the *last* schema left `queryFields` empty, so
  // `composer.buildSchema()` threw "Type Query must define one or more
  // fields" and `rebuildGraphQL` rejected — wedging the server exactly
  // when a developer follows the tutorial's "feel free to delete note.js"
  // step on a single-resource project. The placeholder `_empty` query
  // field keeps the schema valid when no resources are loaded.
  test('unloading the last schema does not throw (empty Query gets a placeholder)', async () => {
    const loader = makeLoader();
    const schema = {
      path: 'emptyrebuild',
      collection: 'emptyrebuild',
      version: 'v1',
      fields: [
        { name: 'userId', type: String, required: true },
        { name: 'title', type: String, required: true },
      ],
    };

    await loader.loadSchema(schema);
    expect(loader.listSchemas()).toContain('v1/emptyrebuild');

    // The unload triggers rebuildGraphQL with zero remaining schemas.
    // Pre-fix this rejected with the empty-Query GraphQLError; now it
    // resolves to `true` (the unload succeeded) instead of throwing.
    await expect(loader.unloadSchema('v1/emptyrebuild')).resolves.toBe(true);
    expect(loader.listSchemas()).toEqual([]);

    // A subsequent rebuild on the still-empty registry must also stay
    // valid (the placeholder is re-added every rebuild while empty).
    await expect(loader.rebuildGraphQL()).resolves.toBeUndefined();
  });
});
