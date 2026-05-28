'use strict';

/**
 * Unit tests for the upload-url / complete / download-url routes.
 *
 * Strategy: build a fake Express-like router that captures the route
 * registrations, then invoke each handler with a constructed req / res
 * pair. This avoids pulling in Express for the package's own test
 * suite (mirrors the audit plugin's zero-runtime-dep posture).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRouter } = require('../lib/routes');

// ---- Stubs ---------------------------------------------------------

function fakeRouter() {
  const handlers = {};
  function add(method) {
    return (path, ...fns) => {
      const key = `${method.toUpperCase()} ${path}`;
      handlers[key] = fns;
    };
  }
  return {
    handlers,
    post: add('post'),
    get:  add('get'),
    put:  add('put'),
    delete: add('delete'),
  };
}

function fakeAuth(_required) {
  // Just attach req.user from a header on the test request.
  return (req, _res, next) => {
    if (!req.user && req._injectUser) req.user = req._injectUser;
    next();
  };
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

class FakeNotFoundError extends Error {
  constructor(m) { super(`${m} not found`); this.status = 404; this.code = 'NOT_FOUND'; }
}
class FakeValidationError extends Error {
  constructor(m) { super(m); this.status = 400; this.code = 'VALIDATION'; }
}
class FakeForbiddenError extends Error {
  constructor(m) { super(m); this.status = 403; this.code = 'FORBIDDEN'; }
}
const fakeErrors = {
  NotFoundError:   FakeNotFoundError,
  ValidationError: FakeValidationError,
  ForbiddenError:  FakeForbiddenError,
};

function fakeRes() {
  const r = {
    statusCode: 200,
    body:       null,
    status(c) { r.statusCode = c; return r; },
    json(o)   { r.body = o; return r; },
  };
  return r;
}

/**
 * Build a fake Mongoose model. Each `create` lands in `docs`; findById
 * returns the matching doc with toObject + save methods that the
 * routes use.
 */
function fakeModel({ initial = [] } = {}) {
  let nextId = 1;
  function wrap(o) {
    return {
      ...o,
      _id: o._id || `id_${nextId++}`,
      toObject() {
        const out = {};
        for (const k of Object.keys(this)) {
          if (typeof this[k] === 'function') continue;
          out[k] = this[k];
        }
        return out;
      },
      save() {
        return Promise.resolve(this);
      },
    };
  }
  const docs = initial.map(wrap);
  return {
    docs,
    async create(o)          { const w = wrap(o); docs.push(w); return w; },
    async findById(id)       { return docs.find((d) => String(d._id) === String(id)) || null; },
    async deleteOne(filter)  {
      const i = docs.findIndex((d) => String(d._id) === String(filter._id));
      if (i >= 0) { docs.splice(i, 1); return { deletedCount: 1 }; }
      return { deletedCount: 0 };
    },
  };
}

function fakeAdapter({ exists = true, contentLength = null } = {}) {
  const calls = [];
  return {
    bucket: 'test-bucket',
    calls,
    async getSignedPutUrl(args) {
      calls.push({ op: 'put', args });
      return `https://stub.example/put/${args.key}?ct=${args.contentType}`;
    },
    async getSignedGetUrl(args) {
      calls.push({ op: 'get', args });
      return `https://stub.example/get/${args.key}`;
    },
    async headObject(args) {
      calls.push({ op: 'head', args });
      return { exists, contentLength };
    },
    async deleteObject(args) {
      calls.push({ op: 'del', args });
    },
  };
}

function defaultConfig(overrides = {}) {
  return {
    maxBytes:          1024 * 1024,
    allowedMime:       [],
    putUrlTtlSeconds:  300,
    getUrlTtlSeconds:  600,
    verifyOnComplete:  true,
    ...overrides,
  };
}

function build({ model, adapter, config }) {
  const router = fakeRouter();
  buildRouter({
    router,
    auth:          fakeAuth,
    asyncHandler,
    errors:        fakeErrors,
    getModel:      () => model,
    adapter,
    config,
  });
  return router;
}

async function runHandler(router, key, { user, body, params }) {
  const fns = router.handlers[key];
  if (!fns) throw new Error(`no route for ${key}`);
  const req = { _injectUser: user, body: body || {}, params: params || {}, user: undefined };
  const res = fakeRes();
  let nextErr = null;
  for (const fn of fns) {
    if (nextErr) break;
    let resolved = false;
    await new Promise((resolve) => {
      const safeResolve = () => { if (!resolved) { resolved = true; resolve(); } };
      const next = (err) => {
        if (err) nextErr = err;
        safeResolve();
      };
      const result = fn(req, res, next);
      if (result && typeof result.then === 'function') {
        result.then(safeResolve, (e) => { if (e) nextErr = e; safeResolve(); });
      } else {
        // Sync middleware: if it didn't call next() synchronously,
        // it's done; resolve so the loop can advance.
        safeResolve();
      }
    });
  }
  return { req, res, error: nextErr };
}

// ---- Tests ---------------------------------------------------------

test('POST /upload-url: creates a pending record + returns presigned PUT URL', async () => {
  const model = fakeModel();
  const adapter = fakeAdapter();
  const config = defaultConfig();
  const router = build({ model, adapter, config });

  const { res, error } = await runHandler(router, 'POST /upload-url', {
    user: { user_id: 'u1' },
    body: { contentType: 'image/png', originalName: 'avatar.png', size: 100 },
  });
  assert.equal(error, null);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.contentType, 'image/png');
  assert.match(res.body.url, /^https:\/\/stub\.example\/put\//);
  assert.equal(model.docs.length, 1);
  const created = model.docs[0];
  assert.equal(created.userId, 'u1');
  assert.equal(created.status, 'pending');
  assert.equal(created.bucket, 'test-bucket');
  assert.equal(created.contentType, 'image/png');
  // Adapter was asked for a presigned PUT with the same key + content type.
  assert.equal(adapter.calls[0].op, 'put');
  assert.equal(adapter.calls[0].args.contentType, 'image/png');
  assert.equal(adapter.calls[0].args.expires, 300);
});

test('POST /upload-url: rejects when contentType is missing', async () => {
  const router = build({ model: fakeModel(), adapter: fakeAdapter(), config: defaultConfig() });
  const { error } = await runHandler(router, 'POST /upload-url', {
    user: { user_id: 'u1' },
    body: { originalName: 'x.png' },
  });
  assert.equal(error && error.code, 'VALIDATION');
});

test('POST /upload-url: rejects content types not in allowlist', async () => {
  const router = build({
    model: fakeModel(),
    adapter: fakeAdapter(),
    config: defaultConfig({ allowedMime: ['image/png', 'application/pdf'] }),
  });
  const { error } = await runHandler(router, 'POST /upload-url', {
    user: { user_id: 'u1' },
    body: { contentType: 'video/mp4' },
  });
  assert.equal(error && error.code, 'VALIDATION');
  assert.match(error.message, /S3_ALLOWED_MIME/);
});

test('POST /upload-url: rejects sizes over maxBytes', async () => {
  const router = build({
    model: fakeModel(),
    adapter: fakeAdapter(),
    config: defaultConfig({ maxBytes: 1000 }),
  });
  const { error } = await runHandler(router, 'POST /upload-url', {
    user: { user_id: 'u1' },
    body: { contentType: 'image/png', size: 2000 },
  });
  assert.equal(error && error.code, 'VALIDATION');
  assert.match(error.message, /S3_MAX_BYTES/);
});

test('POST /upload-url: rejects when size is non-numeric or zero', async () => {
  const router = build({ model: fakeModel(), adapter: fakeAdapter(), config: defaultConfig() });
  for (const bad of ['abc', 0, -5, NaN]) {
    const { error } = await runHandler(router, 'POST /upload-url', {
      user: { user_id: 'u1' },
      body: { contentType: 'image/png', size: bad },
    });
    assert.equal(error && error.code, 'VALIDATION', `expected VALIDATION for size=${bad}`);
  }
});

test('POST /:fileId/complete: HEADs the object, flips status to uploaded', async () => {
  const model = fakeModel({
    initial: [{ _id: 'f1', userId: 'u1', key: 'u1/abc/x.png', status: 'pending', contentType: 'image/png', size: 100 }],
  });
  const adapter = fakeAdapter({ exists: true, contentLength: 100 });
  const router = build({ model, adapter, config: defaultConfig() });

  const { res, error } = await runHandler(router, 'POST /:fileId/complete', {
    user: { user_id: 'u1' },
    params: { fileId: 'f1' },
  });
  assert.equal(error, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'uploaded');
  assert.equal(adapter.calls.find((c) => c.op === 'head').args.key, 'u1/abc/x.png');
});

test('POST /:fileId/complete: refuses when object is not in storage', async () => {
  const model = fakeModel({
    initial: [{ _id: 'f1', userId: 'u1', key: 'u1/abc/x.png', status: 'pending', contentType: 'image/png' }],
  });
  const adapter = fakeAdapter({ exists: false });
  const router = build({ model, adapter, config: defaultConfig() });

  const { error } = await runHandler(router, 'POST /:fileId/complete', {
    user: { user_id: 'u1' },
    params: { fileId: 'f1' },
  });
  assert.equal(error && error.code, 'VALIDATION');
  assert.match(error.message, /upload not found/);
});

test('POST /:fileId/complete: refuses when storage size mismatches declared size', async () => {
  const model = fakeModel({
    initial: [{ _id: 'f1', userId: 'u1', key: 'u1/abc/x.png', status: 'pending', contentType: 'image/png', size: 100 }],
  });
  const adapter = fakeAdapter({ exists: true, contentLength: 999 });
  const router = build({ model, adapter, config: defaultConfig() });

  const { error } = await runHandler(router, 'POST /:fileId/complete', {
    user: { user_id: 'u1' },
    params: { fileId: 'f1' },
  });
  assert.equal(error && error.code, 'VALIDATION');
  assert.match(error.message, /does not match/);
});

test('POST /:fileId/complete: refuses when actual blob exceeds maxBytes (client lied at presign)', async () => {
  const model = fakeModel({
    initial: [{ _id: 'f1', userId: 'u1', key: 'u1/abc/x.png', status: 'pending', contentType: 'image/png' }],
  });
  // No declared size, but the actual blob is huge.
  const adapter = fakeAdapter({ exists: true, contentLength: 100_000_000 });
  const router = build({ model, adapter, config: defaultConfig({ maxBytes: 1_000_000 }) });

  const { error } = await runHandler(router, 'POST /:fileId/complete', {
    user: { user_id: 'u1' },
    params: { fileId: 'f1' },
  });
  assert.equal(error && error.code, 'VALIDATION');
  assert.match(error.message, /exceeds S3_MAX_BYTES/);
});

test('POST /:fileId/complete: idempotent — second call on `uploaded` returns the existing state', async () => {
  const model = fakeModel({
    initial: [{ _id: 'f1', userId: 'u1', key: 'u1/abc/x.png', status: 'uploaded', contentType: 'image/png' }],
  });
  const adapter = fakeAdapter({ exists: true });
  const router = build({ model, adapter, config: defaultConfig() });

  const { res, error } = await runHandler(router, 'POST /:fileId/complete', {
    user: { user_id: 'u1' },
    params: { fileId: 'f1' },
  });
  assert.equal(error, null);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'uploaded');
  // No HEAD on idempotent path.
  assert.equal(adapter.calls.find((c) => c.op === 'head'), undefined);
});

test('POST /:fileId/complete: returns 404 for foreign-tenant fileId (no info leak)', async () => {
  const model = fakeModel({
    initial: [{ _id: 'f1', userId: 'victim', key: 'victim/abc/secret.pdf', status: 'pending', contentType: 'application/pdf' }],
  });
  const adapter = fakeAdapter();
  const router = build({ model, adapter, config: defaultConfig() });

  const { error } = await runHandler(router, 'POST /:fileId/complete', {
    user: { user_id: 'attacker' },
    params: { fileId: 'f1' },
  });
  assert.equal(error && error.code, 'NOT_FOUND');
});

test('POST /:fileId/complete: skips HEAD when verifyOnComplete is off', async () => {
  const model = fakeModel({
    initial: [{ _id: 'f1', userId: 'u1', key: 'u1/abc/x.png', status: 'pending', contentType: 'image/png' }],
  });
  const adapter = fakeAdapter({ exists: false });
  const router = build({ model, adapter, config: defaultConfig({ verifyOnComplete: false }) });

  const { res, error } = await runHandler(router, 'POST /:fileId/complete', {
    user: { user_id: 'u1' },
    params: { fileId: 'f1' },
  });
  assert.equal(error, null);
  assert.equal(res.body.status, 'uploaded');
  assert.equal(adapter.calls.find((c) => c.op === 'head'), undefined);
});

test('GET /:fileId/download-url: returns presigned GET for owner', async () => {
  const model = fakeModel({
    initial: [{ _id: 'f1', userId: 'u1', key: 'u1/abc/x.png', status: 'uploaded', contentType: 'image/png' }],
  });
  const adapter = fakeAdapter();
  const router = build({ model, adapter, config: defaultConfig() });

  const { res, error } = await runHandler(router, 'GET /:fileId/download-url', {
    user: { user_id: 'u1' },
    params: { fileId: 'f1' },
  });
  assert.equal(error, null);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.url, /^https:\/\/stub\.example\/get\//);
  assert.equal(res.body.expiresIn, 600);
});

test('GET /:fileId/download-url: returns 404 for foreign-tenant fileId', async () => {
  const model = fakeModel({
    initial: [{ _id: 'f1', userId: 'victim', key: 'victim/abc/secret.pdf', status: 'uploaded', contentType: 'application/pdf' }],
  });
  const adapter = fakeAdapter();
  const router = build({ model, adapter, config: defaultConfig() });

  const { error } = await runHandler(router, 'GET /:fileId/download-url', {
    user: { user_id: 'attacker' },
    params: { fileId: 'f1' },
  });
  assert.equal(error && error.code, 'NOT_FOUND');
});

test('GET /:fileId/download-url: refuses pending files', async () => {
  const model = fakeModel({
    initial: [{ _id: 'f1', userId: 'u1', key: 'u1/abc/x.png', status: 'pending', contentType: 'image/png' }],
  });
  const adapter = fakeAdapter();
  const router = build({ model, adapter, config: defaultConfig() });

  const { error } = await runHandler(router, 'GET /:fileId/download-url', {
    user: { user_id: 'u1' },
    params: { fileId: 'f1' },
  });
  assert.equal(error && error.code, 'VALIDATION');
  assert.match(error.message, /status "pending"/);
});
