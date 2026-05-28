'use strict';

/**
 * Plugin-level setup tests. Drives `createPlugin({ ... }).setup(...)`
 * with injected mongoose / errors / auth / asyncHandler / express
 * stubs so the package's own test suite stays zero-runtime-dep on
 * the framework.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createPlugin } = require('../index');

// ---- Shared stubs --------------------------------------------------

function silentLog() {
  const records = { info: [], warn: [], error: [] };
  return {
    info:  (o, m) => records.info.push({ o, m }),
    warn:  (o, m) => records.warn.push({ o, m }),
    error: (o, m) => records.error.push({ o, m }),
    child: () => silentLog(),
    records,
  };
}

class FakeNotFoundError   extends Error { constructor(m) { super(m); this.code = 'NOT_FOUND';   this.status = 404; } }
class FakeValidationError extends Error { constructor(m) { super(m); this.code = 'VALIDATION';  this.status = 400; } }
class FakeForbiddenError  extends Error { constructor(m) { super(m); this.code = 'FORBIDDEN';   this.status = 403; } }
const fakeErrors = {
  NotFoundError:   FakeNotFoundError,
  ValidationError: FakeValidationError,
  ForbiddenError:  FakeForbiddenError,
};

function fakeAuth(_required) { return (req, _res, next) => next(); }
function fakeAsyncHandler(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

const fakeMongoose = { Schema: { Types: { Mixed: 'Mixed' } } };

function fakeExpress() {
  // Build a tiny Router shim that records mounted handlers.
  function Router() {
    const r = { handlers: {} };
    const add = (m) => (p, ...fns) => { r.handlers[`${m} ${p}`] = fns; };
    r.post = add('POST'); r.get = add('GET'); r.put = add('PUT'); r.delete = add('DELETE');
    return r;
  }
  return { Router };
}

function fakeApp() {
  const mounted = [];
  return {
    mounted,
    use(prefix, router) { mounted.push({ prefix, router }); },
    post() {}, get() {}, put() {}, delete() {},
  };
}

/**
 * Build a fake schemaLoader whose `loadSchema` records the registration
 * and whose `getEntry` returns a fake Model whose `create` / `findById`
 * / `deleteOne` / `find` route through an in-memory array.
 */
function fakeSchemaLoader() {
  const loaded = [];
  const model = (() => {
    const docs = [];
    let nextId = 1;
    return {
      docs,
      async create(o) { const w = { ...o, _id: o._id || `id_${nextId++}`, toObject() { return { ...this }; }, save() { return Promise.resolve(this); } }; docs.push(w); return w; },
      async findById(id) { return docs.find((d) => String(d._id) === String(id)) || null; },
      async deleteOne(filter) { const i = docs.findIndex((d) => String(d._id) === String(filter._id)); if (i >= 0) { docs.splice(i, 1); return { deletedCount: 1 }; } return { deletedCount: 0 }; },
      find() { return { limit: () => Promise.resolve([]) }; },
      collection: { createIndex: async () => {}, dropIndex: async () => {}, indexes: async () => [] },
    };
  })();
  return {
    loaded,
    async loadSchema(s) { loaded.push(s); },
    getEntry(_key) { return { schema: loaded[0], model }; },
    listSchemas() { return loaded.map((_, i) => `v1/file${i}`); },
    model,
  };
}

function fakeAdapter() {
  const calls = [];
  return {
    bucket: 'test-bucket',
    name:   'fake',
    calls,
    async getSignedPutUrl(args) { calls.push({ op: 'put', args }); return `https://stub/put/${args.key}`; },
    async getSignedGetUrl(args) { calls.push({ op: 'get', args }); return `https://stub/get/${args.key}`; },
    async headObject(args)      { calls.push({ op: 'head', args }); return { exists: true, contentLength: 100 }; },
    async deleteObject(args)    { calls.push({ op: 'del', args }); },
  };
}

function buildSetupArgs() {
  return {
    app:          fakeApp(),
    schemaLoader: fakeSchemaLoader(),
    bus:          new EventEmitter(),
    log:          silentLog(),
    appName:      'test-app',
  };
}

// ---- Dormancy ------------------------------------------------------

test('dormant: S3_BUCKET unset → setup logs warn, no schema registered, no routes mounted', async () => {
  const plugin = createPlugin({ env: {} });
  const args = buildSetupArgs();
  await plugin.setup(args);
  assert.equal(args.schemaLoader.loaded.length, 0);
  assert.equal(args.app.mounted.length, 0);
  assert.ok(args.log.records.warn.some((r) => /S3_BUCKET/.test(r.m)));
});

test('dormant: programmatic API throws clearly when called pre-setup', async () => {
  const plugin = createPlugin({ env: {} });
  await assert.rejects(
    () => plugin.createUploadUrl({ user: { user_id: 'u1' }, contentType: 'image/png' }),
    /dormant/
  );
});

test('fail-fast: missing schemaLoader throws (no silent dormancy on real errors)', async () => {
  // Per utils/pluginLoader's documented contract, setup() must propagate
  // real failures so boot fails loud instead of leaving a half-wired
  // plugin in production. The PR #122 review flagged the previous
  // log-and-return behaviour as a violation; this test pins the fix.
  const plugin = createPlugin({
    env:     { S3_BUCKET: 'b' },
    adapter: fakeAdapter(),
    errors:  fakeErrors,
    auth:    fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose: fakeMongoose,
    express:  fakeExpress(),
  });
  const args = buildSetupArgs();
  args.schemaLoader = null;
  await assert.rejects(() => plugin.setup(args), /schemaLoader.*required/);
});

test('fail-fast: missing app throws', async () => {
  const plugin = createPlugin({
    env:     { S3_BUCKET: 'b' },
    adapter: fakeAdapter(),
    errors:  fakeErrors,
    auth:    fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose: fakeMongoose,
    express:  fakeExpress(),
  });
  const args = buildSetupArgs();
  args.app = null;
  await assert.rejects(() => plugin.setup(args), /app.*required/);
});

test('fail-fast: adapter construction failure (e.g. gcs without SDK) throws', async () => {
  // Simulate the adapter-ctor failure path. The real-world trigger is
  // S3_BACKEND=gcs without @google-cloud/storage installed, which the
  // adapter ctor surfaces as a thrown Error — the plugin must propagate
  // that rather than swallow it into a dormant state.
  const throwingAdapter = null; // forces createAdapter to run
  const plugin = createPlugin({
    env:     { S3_BUCKET: 'b', S3_BACKEND: 'gcs' },
    adapter: throwingAdapter,
    sdkOverrides: { gcs: null }, // explicit: no GCS SDK available
    errors:  fakeErrors,
    auth:    fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose: fakeMongoose,
    express:  fakeExpress(),
  });
  const args = buildSetupArgs();
  await assert.rejects(() => plugin.setup(args), /@google-cloud\/storage|not installed/);
});

test('fail-fast: schemaLoader.loadSchema failure propagates', async () => {
  const plugin = createPlugin({
    env:     { S3_BUCKET: 'b' },
    adapter: fakeAdapter(),
    errors:  fakeErrors,
    auth:    fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose: fakeMongoose,
    express:  fakeExpress(),
  });
  const args = buildSetupArgs();
  args.schemaLoader.loadSchema = async () => {
    throw new Error('mongo connection refused');
  };
  await assert.rejects(() => plugin.setup(args), /mongo connection refused/);
});

// ---- Happy path ----------------------------------------------------

test('setup: with bucket + injected deps → registers schema, mounts routes', async () => {
  const plugin = createPlugin({
    env:          { S3_BUCKET: 'b1', S3_BACKEND: 'aws' },
    adapter:      fakeAdapter(),
    errors:       fakeErrors,
    auth:         fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose:     fakeMongoose,
    express:      fakeExpress(),
  });
  const args = buildSetupArgs();
  await plugin.setup(args);

  assert.equal(args.schemaLoader.loaded.length, 1);
  const schema = args.schemaLoader.loaded[0];
  assert.equal(schema.path, 'file');
  assert.equal(schema.collection, 'file');
  assert.equal(schema.softDelete, false);
  // Write-locked fields must declare a sentinel ACL role.
  const keyField = schema.fields.find((f) => f.name === 'key');
  assert.ok(keyField.acl.create.length === 1 && keyField.acl.create[0].includes('plugin_object_storage'));

  assert.equal(args.app.mounted.length, 1);
  assert.equal(args.app.mounted[0].prefix, '/api/files');
  const routes = Object.keys(args.app.mounted[0].router.handlers);
  assert.ok(routes.includes('POST /upload-url'));
  assert.ok(routes.includes('POST /:fileId/complete'));
  assert.ok(routes.includes('GET /:fileId/download-url'));
});

test('setup: programmatic createUploadUrl writes a pending record + returns URL', async () => {
  const plugin = createPlugin({
    env:          { S3_BUCKET: 'b1' },
    adapter:      fakeAdapter(),
    errors:       fakeErrors,
    auth:         fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose:     fakeMongoose,
    express:      fakeExpress(),
  });
  const args = buildSetupArgs();
  await plugin.setup(args);

  const out = await plugin.createUploadUrl({
    user:        { user_id: 'u1' },
    contentType: 'image/png',
    originalName: 'a.png',
  });
  assert.ok(out.fileId);
  assert.ok(out.url.startsWith('https://stub/put/'));
  assert.equal(out.expiresIn, 300);
});

// The next four pin the fix to PR #122 review comment 2: the
// programmatic API must enforce the same MIME / size policy the REST
// route applies. A hook author who reaches for createUploadUrl from
// custom code can't bypass S3_ALLOWED_MIME or S3_MAX_BYTES.

test('createUploadUrl: rejects when contentType is missing', async () => {
  const plugin = createPlugin({
    env:          { S3_BUCKET: 'b1' },
    adapter:      fakeAdapter(),
    errors:       fakeErrors,
    auth:         fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose:     fakeMongoose,
    express:      fakeExpress(),
  });
  await plugin.setup(buildSetupArgs());
  await assert.rejects(
    () => plugin.createUploadUrl({ user: { user_id: 'u1' }, originalName: 'a.png' }),
    /contentType is required/
  );
});

test('createUploadUrl: rejects content types not in S3_ALLOWED_MIME', async () => {
  const plugin = createPlugin({
    env:          { S3_BUCKET: 'b1', S3_ALLOWED_MIME: 'image/png,application/pdf' },
    adapter:      fakeAdapter(),
    errors:       fakeErrors,
    auth:         fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose:     fakeMongoose,
    express:      fakeExpress(),
  });
  await plugin.setup(buildSetupArgs());
  await assert.rejects(
    () => plugin.createUploadUrl({
      user:        { user_id: 'u1' },
      contentType: 'video/mp4',
    }),
    /S3_ALLOWED_MIME/
  );
});

test('createUploadUrl: rejects sizes over S3_MAX_BYTES', async () => {
  const plugin = createPlugin({
    env:          { S3_BUCKET: 'b1', S3_MAX_BYTES: '1024' },
    adapter:      fakeAdapter(),
    errors:       fakeErrors,
    auth:         fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose:     fakeMongoose,
    express:      fakeExpress(),
  });
  await plugin.setup(buildSetupArgs());
  await assert.rejects(
    () => plugin.createUploadUrl({
      user:        { user_id: 'u1' },
      contentType: 'image/png',
      size:        2048,
    }),
    /S3_MAX_BYTES/
  );
});

test('createUploadUrl: rejects when size is non-numeric, zero, or negative', async () => {
  const plugin = createPlugin({
    env:          { S3_BUCKET: 'b1' },
    adapter:      fakeAdapter(),
    errors:       fakeErrors,
    auth:         fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose:     fakeMongoose,
    express:      fakeExpress(),
  });
  await plugin.setup(buildSetupArgs());
  for (const bad of ['abc', 0, -5, NaN]) {
    await assert.rejects(
      () => plugin.createUploadUrl({
        user:        { user_id: 'u1' },
        contentType: 'image/png',
        size:        bad,
      }),
      /size must be a positive number/,
      `expected throw for size=${bad}`
    );
  }
});

test('setup: programmatic createDownloadUrl returns null for foreign-tenant fileId', async () => {
  const plugin = createPlugin({
    env:          { S3_BUCKET: 'b1' },
    adapter:      fakeAdapter(),
    errors:       fakeErrors,
    auth:         fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose:     fakeMongoose,
    express:      fakeExpress(),
  });
  const args = buildSetupArgs();
  await plugin.setup(args);

  const created = await plugin.createUploadUrl({
    user:        { user_id: 'u1' },
    contentType: 'image/png',
  });
  // Mark as uploaded so download is in principle valid.
  args.schemaLoader.model.docs[0].status = 'uploaded';

  // Owner can get a URL.
  const own = await plugin.createDownloadUrl({ user: { user_id: 'u1' }, fileId: created.fileId });
  assert.ok(own && own.url);

  // Attacker gets null — same posture as the REST 404, no leak.
  const foreign = await plugin.createDownloadUrl({ user: { user_id: 'attacker' }, fileId: created.fileId });
  assert.equal(foreign, null);
});

test('setup: deleteFile removes both blob + DB row, returns true for owner / false for foreign', async () => {
  const adapter = fakeAdapter();
  const plugin = createPlugin({
    env:          { S3_BUCKET: 'b1' },
    adapter,
    errors:       fakeErrors,
    auth:         fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose:     fakeMongoose,
    express:      fakeExpress(),
  });
  const args = buildSetupArgs();
  await plugin.setup(args);

  const created = await plugin.createUploadUrl({
    user:        { user_id: 'u1' },
    contentType: 'image/png',
  });

  const foreignOut = await plugin.deleteFile({ user: { user_id: 'attacker' }, fileId: created.fileId });
  assert.equal(foreignOut, false);
  assert.equal(args.schemaLoader.model.docs.length, 1);

  const ownOut = await plugin.deleteFile({ user: { user_id: 'u1' }, fileId: created.fileId });
  assert.equal(ownOut, true);
  assert.equal(args.schemaLoader.model.docs.length, 0);
  assert.ok(adapter.calls.some((c) => c.op === 'del'));
});

// ---- Schema hook coverage ------------------------------------------

test('schema afterDelete hook: noop when cascadeDelete is off', async () => {
  const adapter = fakeAdapter();
  const plugin = createPlugin({
    env:          { S3_BUCKET: 'b1', S3_CASCADE_DELETE: 'false' },
    adapter,
    errors:       fakeErrors,
    auth:         fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose:     fakeMongoose,
    express:      fakeExpress(),
  });
  const args = buildSetupArgs();
  await plugin.setup(args);

  const schema = args.schemaLoader.loaded[0];
  await schema.hooks.afterDelete({ record: { key: 'u/abc/x.png' } });
  assert.equal(adapter.calls.find((c) => c.op === 'del'), undefined);
});

test('schema afterDelete hook: deletes the blob when cascadeDelete is on', async () => {
  const adapter = fakeAdapter();
  const plugin = createPlugin({
    env:          { S3_BUCKET: 'b1', S3_CASCADE_DELETE: 'true' },
    adapter,
    errors:       fakeErrors,
    auth:         fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose:     fakeMongoose,
    express:      fakeExpress(),
  });
  const args = buildSetupArgs();
  await plugin.setup(args);

  const schema = args.schemaLoader.loaded[0];
  await schema.hooks.afterDelete({ record: { userId: 'u', key: 'u/abc/x.png' } });
  assert.deepEqual(adapter.calls.find((c) => c.op === 'del').args, { key: 'u/abc/x.png' });
});

test('schema afterDelete hook: refuses cascade-delete when record.userId disagrees with key prefix', async () => {
  // Defence-in-depth: the `key` field is API-write-locked, but a
  // corrupted / direct-Mongoose-written row could carry a mismatched
  // pair. The hook must refuse rather than wipe another tenant's blob.
  const adapter = fakeAdapter();
  const log = silentLog();
  const plugin = createPlugin({
    env:          { S3_BUCKET: 'b1', S3_CASCADE_DELETE: 'true' },
    adapter,
    errors:       fakeErrors,
    auth:         fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose:     fakeMongoose,
    express:      fakeExpress(),
  });
  const args = buildSetupArgs();
  args.log = log;
  await plugin.setup(args);

  const schema = args.schemaLoader.loaded[0];
  // record claims owner 'attacker', but the key lives under 'victim'
  await schema.hooks.afterDelete({
    record: { userId: 'attacker', key: 'victim/abc/secret.pdf' },
  });
  assert.equal(adapter.calls.find((c) => c.op === 'del'), undefined);
  assert.ok(
    log.records.warn.some((r) => /key does not belong to record owner/.test(r.m)),
    'expected a warn entry explaining the refused delete'
  );
});

test('schema afterDelete hook: refuses cascade-delete when key has no userId prefix', async () => {
  // A key shape outside the documented `<userId>/<hash>/<name>` —
  // either a framework bug or a manually-inserted row — must not get
  // a blob delete either.
  const adapter = fakeAdapter();
  const log = silentLog();
  const plugin = createPlugin({
    env:          { S3_BUCKET: 'b1', S3_CASCADE_DELETE: 'true' },
    adapter,
    errors:       fakeErrors,
    auth:         fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose:     fakeMongoose,
    express:      fakeExpress(),
  });
  const args = buildSetupArgs();
  args.log = log;
  await plugin.setup(args);

  const schema = args.schemaLoader.loaded[0];
  await schema.hooks.afterDelete({
    record: { userId: 'u', key: 'noslashes' },
  });
  assert.equal(adapter.calls.find((c) => c.op === 'del'), undefined);
});

test('schema afterDelete hook: storage failure is logged, not thrown (best-effort)', async () => {
  const adapter = {
    bucket: 'b',
    async deleteObject() { throw new Error('storage hiccup'); },
  };
  const log = silentLog();
  const plugin = createPlugin({
    env:          { S3_BUCKET: 'b1', S3_CASCADE_DELETE: 'true' },
    adapter,
    errors:       fakeErrors,
    auth:         fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose:     fakeMongoose,
    express:      fakeExpress(),
  });
  const args = buildSetupArgs();
  args.log = log;
  await plugin.setup(args);

  const schema = args.schemaLoader.loaded[0];
  // Must NOT throw — `after*` hooks are best-effort per framework contract.
  await schema.hooks.afterDelete({ record: { userId: 'u', key: 'u/abc/x.png' } });
  assert.ok(log.records.error.some((r) => /cascade-delete/.test(r.m)));
});

// ---- Custom schema path --------------------------------------------

test('S3_FILE_PATH overrides the schema path so consumers with an existing `file` schema do not collide', async () => {
  const plugin = createPlugin({
    env:          { S3_BUCKET: 'b1', S3_FILE_PATH: 'attachment' },
    adapter:      fakeAdapter(),
    errors:       fakeErrors,
    auth:         fakeAuth,
    asyncHandler: fakeAsyncHandler,
    mongoose:     fakeMongoose,
    express:      fakeExpress(),
  });
  const args = buildSetupArgs();
  await plugin.setup(args);
  assert.equal(args.schemaLoader.loaded[0].path, 'attachment');
  assert.equal(args.schemaLoader.loaded[0].collection, 'attachment');
});
