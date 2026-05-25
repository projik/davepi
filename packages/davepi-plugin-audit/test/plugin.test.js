'use strict';

/**
 * Unit tests for davepi-plugin-audit. Uses node:test (Jest is the
 * framework's main test runner but isn't a dep of this package).
 *
 * Strategy: build a fresh plugin via createPlugin() with an injected
 * env, drive a stub EventEmitter as the bus, and assert what the
 * plugin would have written. We don't need a real Mongo here — the
 * package-level tests cover row-shape and matcher logic; the
 * end-to-end "REST POST → row in `audit`" integration lives in the
 * framework's Jest suite under test/plugin-audit-integration.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const auditModule = require('../index');
const { createPlugin, compare, redact } = auditModule;
const { parseEventType, shouldAuditResource } = require('../lib/matcher');

// ---- Stubs ---------------------------------------------------------

function silentLog() {
  return {
    info:  () => {},
    warn:  () => {},
    error: () => {},
    child: () => silentLog(),
  };
}

function capturingLog() {
  const records = { info: [], warn: [], error: [] };
  return {
    info:  (obj, msg) => records.info.push({ obj, msg }),
    warn:  (obj, msg) => records.warn.push({ obj, msg }),
    error: (obj, msg) => records.error.push({ obj, msg }),
    child: () => capturingLog(),
    records,
  };
}

class FakeForbiddenError extends Error {
  constructor(message) { super(message); this.status = 403; }
}
const fakeErrors = { ForbiddenError: FakeForbiddenError };

// Minimal mongoose stub. Only `Schema.Types.Mixed` is touched by the
// schema builder; we don't need to actually compile the schema in
// these unit tests.
const fakeMongoose = { Schema: { Types: { Mixed: 'Mixed' } } };

/**
 * Build a stub `schemaLoader` whose `loadSchema` records the schema
 * argument and whose `getEntry` returns a fake Model with a captured
 * `create()` call list and an in-memory `collection.indexes()` /
 * `createIndex` / `dropIndex` implementation suitable for asserting
 * the plugin's TTL-index lifecycle.
 */
function fakeLoader() {
  const writes = [];
  const indexes = [];
  const model = {
    create: async (doc) => { writes.push(doc); return doc; },
    collection: {
      createIndex: async (spec, opts) => {
        indexes.push({ spec, opts });
        return opts.name;
      },
      dropIndex: async (name) => {
        const i = indexes.findIndex((idx) => idx.opts.name === name);
        if (i === -1) throw new Error(`index ${name} not found`);
        indexes.splice(i, 1);
      },
      indexes: async () =>
        indexes.map((idx) => ({
          name: idx.opts.name,
          expireAfterSeconds: idx.opts.expireAfterSeconds,
          key: idx.spec,
        })),
    },
    schema: {},
  };
  const loaded = [];
  return {
    writes,
    indexes,
    loaded,
    loadSchema: async (s) => { loaded.push(s); },
    getEntry: () => ({ model }),
  };
}

// ---- Module surface -----------------------------------------------

test('default export is a plugin object with name + setup + helpers', () => {
  assert.equal(auditModule.name, 'audit');
  assert.equal(typeof auditModule.setup, 'function');
  assert.equal(typeof auditModule.createPlugin, 'function');
  assert.equal(typeof auditModule.record, 'function');
  assert.equal(typeof auditModule.compare, 'function');
  assert.equal(typeof auditModule.redact, 'function');
});

// ---- Bootstrapping -------------------------------------------------

test('dormant when AUDIT_ENABLED=false; bus events are ignored', async () => {
  const log = capturingLog();
  const bus = new EventEmitter();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: { AUDIT_ENABLED: 'false' },
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus, log, appName: 'demo' });
  assert.equal(log.records.warn.length, 1);
  assert.match(log.records.warn[0].msg, /AUDIT_ENABLED=false/);
  // No schema loaded, no row writes.
  assert.equal(loader.loaded.length, 0);
  bus.emit('record', { type: 'order.created', userId: 'u1', recordId: 'r1' });
  await new Promise((r) => setImmediate(r));
  assert.equal(loader.writes.length, 0);
});

test('registers the audit schema on boot via schemaLoader.loadSchema', async () => {
  const log = silentLog();
  const bus = new EventEmitter();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: {},
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus, log, appName: 'demo' });

  assert.equal(loader.loaded.length, 1);
  const s = loader.loaded[0];
  assert.equal(s.path, 'audit');
  assert.equal(s.collection, 'audit');
  assert.equal(s.version, 'v1');
  assert.equal(s.softDelete, false);
  assert.equal(s.audit, false);
  assert.deepEqual(s.acl.list, ['admin']);
  assert.equal(typeof s.hooks.beforeCreate, 'function');
  assert.equal(typeof s.hooks.beforeUpdate, 'function');
  assert.equal(typeof s.hooks.beforeDelete, 'function');
});

test('every field declares a no-one write ACL so POST/PUT bodies strip empty', async () => {
  const log = silentLog();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: {},
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus: new EventEmitter(), log, appName: 'demo' });
  const s = loader.loaded[0];
  for (const f of s.fields) {
    assert.ok(Array.isArray(f.acl.create) && f.acl.create.length, `${f.name} should have acl.create`);
    assert.ok(Array.isArray(f.acl.update) && f.acl.update.length, `${f.name} should have acl.update`);
    // The sentinel role: a real user would never carry it, so
    // hasOverlap is guaranteed-false.
    assert.match(f.acl.create[0], /davepi_audit_plugin/);
  }
});

test('beforeCreate / beforeUpdate / beforeDelete hooks reject with ForbiddenError', async () => {
  const log = silentLog();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: {},
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus: new EventEmitter(), log, appName: 'demo' });
  const s = loader.loaded[0];
  for (const name of ['beforeCreate', 'beforeUpdate', 'beforeDelete']) {
    await assert.rejects(() => s.hooks[name]({}), (err) => {
      assert.ok(err instanceof FakeForbiddenError, `${name} should throw ForbiddenError`);
      assert.match(err.message, /append-only/);
      return true;
    });
  }
});

// ---- Bus subscription / write path ---------------------------------

test('writes one row for a created event with diff(null, after)', async () => {
  const log = silentLog();
  const bus = new EventEmitter();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: {},
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus, log, appName: 'demo' });

  bus.emit('record', {
    type: 'order.created',
    version: 'v1',
    userId: 'u1',
    recordId: 'r1',
    record: { title: 'first', total: 10 },
    before: null,
    after: { title: 'first', total: 10 },
    req: { ip: '127.0.0.1', userAgent: 'curl', reqId: 'req-1' },
  });
  await new Promise((r) => setImmediate(r));

  assert.equal(loader.writes.length, 1);
  const row = loader.writes[0];
  assert.equal(row.userId, 'u1');
  assert.equal(row.action, 'created');
  assert.equal(row.resource, 'order');
  assert.equal(row.resourceId, 'r1');
  assert.equal(row.before, null);
  assert.deepEqual(row.after, { title: 'first', total: 10 });
  assert.equal(row.ip, '127.0.0.1');
  assert.equal(row.userAgent, 'curl');
  assert.equal(row.reqId, 'req-1');
  assert.ok(row.at instanceof Date);
  // Diff covers every key added
  const titleOp = row.diff.find((o) => o.path === '/title');
  assert.deepEqual(titleOp, { op: 'add', path: '/title', value: 'first' });
});

test('writes one row for an updated event with replace ops in the diff', async () => {
  const log = silentLog();
  const bus = new EventEmitter();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: {},
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus, log, appName: 'demo' });

  bus.emit('record', {
    type: 'order.updated',
    userId: 'u1',
    recordId: 'r1',
    before: { title: 'old', total: 10 },
    after:  { title: 'new', total: 20 },
  });
  await new Promise((r) => setImmediate(r));

  assert.equal(loader.writes.length, 1);
  const row = loader.writes[0];
  assert.equal(row.action, 'updated');
  assert.deepEqual(row.diff.find((o) => o.path === '/title'), {
    op: 'replace', path: '/title', value: 'new',
  });
  assert.deepEqual(row.diff.find((o) => o.path === '/total'), {
    op: 'replace', path: '/total', value: 20,
  });
});

test('writes one row for a deleted event with remove ops in the diff', async () => {
  const log = silentLog();
  const bus = new EventEmitter();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: {},
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus, log, appName: 'demo' });

  bus.emit('record', {
    type: 'order.deleted',
    userId: 'u1',
    recordId: 'r1',
    before: { title: 'gone' },
    after:  null,
  });
  await new Promise((r) => setImmediate(r));

  const row = loader.writes[0];
  assert.equal(row.action, 'deleted');
  assert.deepEqual(row.diff, [{ op: 'remove', path: '/title' }]);
});

test('bulk events produce ONE row with numAffected and filter (not N rows)', async () => {
  const log = silentLog();
  const bus = new EventEmitter();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: {},
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus, log, appName: 'demo' });

  bus.emit('record', {
    type: 'order.updated',
    userId: 'u1',
    filter: { status: 'pending' },
    numAffected: 42,
  });
  await new Promise((r) => setImmediate(r));

  assert.equal(loader.writes.length, 1);
  const row = loader.writes[0];
  assert.equal(row.resourceId, null);
  assert.equal(row.before, null);
  assert.equal(row.after, null);
  assert.equal(row.numAffected, 42);
  assert.deepEqual(row.filter, { status: 'pending' });
});

test('AUDIT_BULK_BYPASS=true skips bulk events but still writes single-record rows', async () => {
  const log = silentLog();
  const bus = new EventEmitter();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: { AUDIT_BULK_BYPASS: 'true' },
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus, log, appName: 'demo' });

  bus.emit('record', { type: 'order.updated', userId: 'u1', filter: {}, numAffected: 99 });
  bus.emit('record', { type: 'order.created', userId: 'u1', recordId: 'r1', after: { title: 'x' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(loader.writes.length, 1);
  assert.equal(loader.writes[0].action, 'created');
});

test('AUDIT_INCLUDE allowlists resources; others are dropped', async () => {
  const log = silentLog();
  const bus = new EventEmitter();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: { AUDIT_INCLUDE: 'order, invoice' },
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus, log, appName: 'demo' });
  bus.emit('record', { type: 'order.created', userId: 'u1', recordId: 'r1', after: {} });
  bus.emit('record', { type: 'product.created', userId: 'u1', recordId: 'p1', after: {} });
  bus.emit('record', { type: 'invoice.created', userId: 'u1', recordId: 'i1', after: {} });
  await new Promise((r) => setImmediate(r));
  const resources = loader.writes.map((w) => w.resource).sort();
  assert.deepEqual(resources, ['invoice', 'order']);
});

test('AUDIT_EXCLUDE wins over AUDIT_INCLUDE on a conflict', async () => {
  const log = silentLog();
  const bus = new EventEmitter();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: {
      AUDIT_INCLUDE: 'order, invoice',
      AUDIT_EXCLUDE: 'invoice',
    },
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus, log, appName: 'demo' });
  bus.emit('record', { type: 'order.created',   userId: 'u1', recordId: 'r1', after: {} });
  bus.emit('record', { type: 'invoice.created', userId: 'u1', recordId: 'i1', after: {} });
  await new Promise((r) => setImmediate(r));
  assert.equal(loader.writes.length, 1);
  assert.equal(loader.writes[0].resource, 'order');
});

test('events for the audit schema itself are short-circuited (no feedback loop)', async () => {
  const log = silentLog();
  const bus = new EventEmitter();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: {},
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus, log, appName: 'demo' });
  // Even if some other consumer were to manually emit such an event,
  // the plugin must not turn it into an audit row.
  bus.emit('record', { type: 'audit.created', userId: 'u1', recordId: 'a1', after: { resource: 'x' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(loader.writes.length, 0);
});

// ---- Redaction -----------------------------------------------------

test('redacts default password/token/secret fields in before AND after', async () => {
  const log = silentLog();
  const bus = new EventEmitter();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: {},
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus, log, appName: 'demo' });
  bus.emit('record', {
    type: 'user.updated',
    userId: 'u1',
    recordId: 'r1',
    before: { email: 'a@b.com', password: 'hash-old', nested: { secret: 'old' } },
    after:  { email: 'a@b.com', password: 'hash-new', nested: { secret: 'new' } },
  });
  await new Promise((r) => setImmediate(r));
  const row = loader.writes[0];
  assert.equal(row.before.password, '[REDACTED]');
  assert.equal(row.after.password, '[REDACTED]');
  assert.equal(row.before.nested.secret, '[REDACTED]');
  assert.equal(row.after.nested.secret, '[REDACTED]');
  // Email passes through unchanged
  assert.equal(row.after.email, 'a@b.com');
});

test('AUDIT_REDACT lets the operator override the field list', async () => {
  const log = silentLog();
  const bus = new EventEmitter();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: { AUDIT_REDACT: 'ssn, taxId' },
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus, log, appName: 'demo' });
  bus.emit('record', {
    type: 'person.created',
    userId: 'u1',
    recordId: 'p1',
    after: { ssn: '123-45-6789', taxId: 'ABC', password: 'kept-now' },
  });
  await new Promise((r) => setImmediate(r));
  const row = loader.writes[0];
  assert.equal(row.after.ssn, '[REDACTED]');
  assert.equal(row.after.taxId, '[REDACTED]');
  // Override REPLACES the default — password is no longer in the
  // redact list, so it's kept. Documented in the README.
  assert.equal(row.after.password, 'kept-now');
});

// ---- TTL index lifecycle ------------------------------------------

test('creates TTL index on `at` using AUDIT_RETENTION_DAYS (default 365)', async () => {
  const log = silentLog();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: {},
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus: new EventEmitter(), log, appName: 'demo' });
  assert.equal(loader.indexes.length, 1);
  assert.deepEqual(loader.indexes[0].spec, { at: 1 });
  assert.equal(loader.indexes[0].opts.expireAfterSeconds, 365 * 86400);
});

test('AUDIT_RETENTION_DAYS=0 drops any existing TTL index and creates none', async () => {
  const log = silentLog();
  const loader = fakeLoader();
  // Pre-seed an existing TTL index so we can assert dropIndex was called.
  loader.indexes.push({ spec: { at: 1 }, opts: { name: 'audit_at_ttl', expireAfterSeconds: 60 } });
  const plugin = createPlugin({
    env: { AUDIT_RETENTION_DAYS: '0' },
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus: new EventEmitter(), log, appName: 'demo' });
  assert.equal(loader.indexes.length, 0);
});

test('AUDIT_RETENTION_DAYS=7 narrows the TTL on the existing index', async () => {
  const log = silentLog();
  const loader = fakeLoader();
  loader.indexes.push({ spec: { at: 1 }, opts: { name: 'audit_at_ttl', expireAfterSeconds: 365 * 86400 } });
  const plugin = createPlugin({
    env: { AUDIT_RETENTION_DAYS: '7' },
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus: new EventEmitter(), log, appName: 'demo' });
  assert.equal(loader.indexes.length, 1);
  assert.equal(loader.indexes[0].opts.expireAfterSeconds, 7 * 86400);
});

// ---- Failure isolation --------------------------------------------

test('a write failure logs an error but the bus listener keeps firing', async () => {
  const log = capturingLog();
  const bus = new EventEmitter();
  const loader = fakeLoader();
  // Grab the underlying collection BEFORE overwriting getEntry so we
  // don't recurse into ourselves.
  const baseCollection = loader.getEntry().model.collection;
  let throwOnce = true;
  loader.getEntry = () => ({
    model: {
      create: async (doc) => {
        if (throwOnce) { throwOnce = false; throw new Error('mongo gone'); }
        loader.writes.push(doc);
        return doc;
      },
      collection: baseCollection,
    },
  });
  const plugin = createPlugin({
    env: {},
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus, log, appName: 'demo' });

  bus.emit('record', { type: 'order.created', userId: 'u1', recordId: 'r1', after: {} });
  bus.emit('record', { type: 'order.created', userId: 'u1', recordId: 'r2', after: {} });
  await new Promise((r) => setImmediate(r));

  // First write threw — error logged. Second write got through.
  assert.equal(log.records.error.length, 1);
  assert.match(log.records.error[0].msg, /write failed/);
  assert.equal(loader.writes.length, 1);
});

// ---- record() (public helper) -------------------------------------

test('record() lets a hook write a custom audit row through the same surface', async () => {
  const log = silentLog();
  const loader = fakeLoader();
  const plugin = createPlugin({
    env: {},
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: loader, bus: new EventEmitter(), log, appName: 'demo' });

  const ok = await plugin.record({
    userId: 'u1',
    action: 'custom_thing',
    resource: 'order',
    resourceId: 'r1',
    after: { manual: true },
  });
  assert.equal(ok, true);
  assert.equal(loader.writes.length, 1);
  assert.equal(loader.writes[0].action, 'custom_thing');
  assert.equal(loader.writes[0].after.manual, true);
});

test('record() is a no-op (no throw) when the plugin is dormant', async () => {
  const log = silentLog();
  const plugin = createPlugin({
    env: { AUDIT_ENABLED: 'false' },
    mongoose: fakeMongoose,
    errors: fakeErrors,
  });
  await plugin.setup({ schemaLoader: fakeLoader(), bus: new EventEmitter(), log, appName: 'demo' });
  const ok = await plugin.record({ userId: 'u1', action: 'x', resource: 'order' });
  assert.equal(ok, false);
});

// ---- compare() (JSON-Patch) ---------------------------------------

test('compare(null, obj) emits add ops for each top-level key', () => {
  const ops = compare(null, { a: 1, b: { nested: true } });
  // Order is insertion-order of Object.keys; both keys should be present.
  assert.deepEqual(ops.sort((x, y) => x.path.localeCompare(y.path)), [
    { op: 'add', path: '/a', value: 1 },
    { op: 'add', path: '/b', value: { nested: true } },
  ]);
});

test('compare(obj, null) emits remove ops for each top-level key', () => {
  const ops = compare({ a: 1, b: 2 }, null);
  assert.deepEqual(ops.sort((x, y) => x.path.localeCompare(y.path)), [
    { op: 'remove', path: '/a' },
    { op: 'remove', path: '/b' },
  ]);
});

test('compare descends into nested plain objects and reports per-leaf changes', () => {
  const ops = compare(
    { user: { name: 'old', email: 'a@b.com' }, count: 1 },
    { user: { name: 'new', email: 'a@b.com' }, count: 1 }
  );
  // Only `/user/name` changed.
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0], { op: 'replace', path: '/user/name', value: 'new' });
});

test('compare diffs arrays per RFC 6902 (fast-json-patch produces per-index ops)', () => {
  const ops = compare({ tags: ['a', 'b'] }, { tags: ['a', 'c'] });
  // fast-json-patch's array diff emits the minimal per-index ops
  // rather than a whole-array replace. The audit UI can render either
  // shape; what matters is that the patch round-trips via
  // applyPatch({tags: ['a','b']}, ops) back to {tags: ['a','c']}.
  const jsonpatch = require('fast-json-patch');
  const applied = jsonpatch.applyPatch({ tags: ['a', 'b'] }, ops).newDocument;
  assert.deepEqual(applied, { tags: ['a', 'c'] });
});

test('compare produces a JSON-Patch that round-trips through fast-json-patch.applyPatch', () => {
  const jsonpatch = require('fast-json-patch');
  const before = { user: { name: 'old', email: 'a@b.com' }, count: 1 };
  const after  = { user: { name: 'new', email: 'a@b.com' }, count: 2 };
  const ops = compare(before, after);
  // Deep-clone the start state so applyPatch doesn't mutate our
  // local before; round-trip applicability is the RFC 6902
  // correctness guarantee the audit row promises.
  const applied = jsonpatch.applyPatch(JSON.parse(JSON.stringify(before)), ops).newDocument;
  assert.deepEqual(applied, after);
});

test('compare(obj, obj) returns [] when snapshots are deeply equal', () => {
  assert.deepEqual(compare({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }), []);
});

test('compare escapes ~ and / in keys per RFC 6901', () => {
  const ops = compare({}, { 'a/b': 1, 'c~d': 2 });
  const paths = ops.map((o) => o.path).sort();
  assert.deepEqual(paths, ['/a~1b', '/c~0d']);
});

// ---- parseEventType / shouldAuditResource -------------------------

test('parseEventType splits on the last dot', () => {
  assert.deepEqual(parseEventType('order.created'), { resource: 'order', action: 'created' });
  assert.deepEqual(parseEventType('order.transitioned'), { resource: 'order', action: 'transitioned' });
  assert.equal(parseEventType('weird'), null);
  assert.equal(parseEventType(''), null);
  assert.equal(parseEventType(null), null);
});

test('shouldAuditResource: empty include + empty exclude = all pass', () => {
  assert.equal(shouldAuditResource('order',   { include: [], exclude: [] }), true);
  assert.equal(shouldAuditResource('account', { include: [], exclude: [] }), true);
});

test('shouldAuditResource: include is an allowlist when non-empty', () => {
  assert.equal(shouldAuditResource('order',   { include: ['order'], exclude: [] }), true);
  assert.equal(shouldAuditResource('account', { include: ['order'], exclude: [] }), false);
});

test('shouldAuditResource: exclude wins over include', () => {
  assert.equal(
    shouldAuditResource('order', { include: ['order'], exclude: ['order'] }),
    false
  );
});

// ---- redact() ------------------------------------------------------

test('redact returns the input unchanged when fields list is empty', () => {
  const input = { password: 'plain' };
  const out = redact(input, []);
  assert.equal(out, input);
});

test('redact does not mutate the input', () => {
  const input = { password: 'plain', email: 'a@b.com' };
  const out = redact(input, ['password']);
  assert.equal(input.password, 'plain');
  assert.equal(out.password, '[REDACTED]');
});

test('redact is case-insensitive on field names', () => {
  const out = redact({ Password: 'x', TOKEN: 'y' }, ['password', 'token']);
  assert.equal(out.Password, '[REDACTED]');
  assert.equal(out.TOKEN, '[REDACTED]');
});

test('redact handles arrays element-by-element', () => {
  const out = redact([{ password: 'a' }, { password: 'b' }], ['password']);
  assert.deepEqual(out, [{ password: '[REDACTED]' }, { password: '[REDACTED]' }]);
});

test('redact preserves Date instances', () => {
  const d = new Date('2026-01-01T00:00:00Z');
  const out = redact({ when: d, password: 'p' }, ['password']);
  assert.equal(out.when, d);
});
