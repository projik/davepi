'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createReaper } = require('../lib/reaper');

function fakeModel(initial = []) {
  const docs = initial.map((d) => ({ ...d }));
  return {
    docs,
    find(filter) {
      const matching = docs.filter((d) => {
        if (filter.status && d.status !== filter.status) return false;
        if (filter.createdAt && filter.createdAt.$lt) {
          if (!(d.createdAt < filter.createdAt.$lt)) return false;
        }
        return true;
      });
      return {
        limit(_n) {
          return Promise.resolve(matching);
        },
      };
    },
    async deleteOne(filter) {
      const i = docs.findIndex((d) => String(d._id) === String(filter._id));
      if (i >= 0) { docs.splice(i, 1); return { deletedCount: 1 }; }
      return { deletedCount: 0 };
    },
  };
}

function fakeAdapter({ failDelete = false } = {}) {
  const calls = [];
  return {
    calls,
    async deleteObject({ key }) {
      calls.push(key);
      if (failDelete) throw new Error('storage hiccup');
    },
  };
}

function silentLog() {
  return { warn: () => {}, error: () => {}, info: () => {} };
}

function configWith(overrides = {}) {
  return {
    putUrlTtlSeconds: 300,
    reapMultiplier:   3,
    reapIntervalMs:   60000,
    reapEnabled:      true,
    ...overrides,
  };
}

test('reaper.runOnce: deletes the storage object + DB row for stale pending records', async () => {
  const now = Date.now();
  const oldDate = new Date(now - 30 * 60 * 1000); // 30 min ago
  const freshDate = new Date(now - 60 * 1000);    // 1 min ago

  const model = fakeModel([
    { _id: 'a', status: 'pending',  key: 'u/a/x.png', createdAt: oldDate },
    { _id: 'b', status: 'pending',  key: 'u/b/x.png', createdAt: freshDate },
    { _id: 'c', status: 'uploaded', key: 'u/c/x.png', createdAt: oldDate },
  ]);
  const adapter = fakeAdapter();
  const reaper = createReaper({
    getModel: () => model,
    adapter,
    config: configWith(),
    log: silentLog(),
  });

  const out = await reaper.runOnce({ now });
  assert.equal(out.deleted, 1);
  assert.deepEqual(adapter.calls, ['u/a/x.png']);
  assert.equal(model.docs.find((d) => d._id === 'a'), undefined);
  assert.ok(model.docs.find((d) => d._id === 'b'));
  assert.ok(model.docs.find((d) => d._id === 'c'));
});

test('reaper.runOnce: storage failure leaves the DB row in place for retry', async () => {
  const now = Date.now();
  const oldDate = new Date(now - 30 * 60 * 1000);

  const model = fakeModel([
    { _id: 'a', status: 'pending', key: 'u/a/x.png', createdAt: oldDate },
  ]);
  const adapter = fakeAdapter({ failDelete: true });
  const reaper = createReaper({
    getModel: () => model,
    adapter,
    config: configWith(),
    log: silentLog(),
  });

  const out = await reaper.runOnce({ now });
  assert.equal(out.deleted, 0);
  // Row is still there → next sweep will retry.
  assert.ok(model.docs.find((d) => d._id === 'a'));
});

test('reaper.runOnce: concurrent calls de-dupe via the inflight guard', async () => {
  const model = fakeModel([]);
  const adapter = fakeAdapter();
  const reaper = createReaper({
    getModel: () => model,
    adapter,
    config: configWith(),
    log: silentLog(),
  });
  // Both calls race. The second should report `skipped`.
  const [a, b] = await Promise.all([reaper.runOnce(), reaper.runOnce()]);
  // One of them is the skip; we don't care which since Promise.all
  // doesn't guarantee start order on the microtask queue.
  const skipped = [a, b].find((r) => r.skipped);
  const ran     = [a, b].find((r) => !r.skipped);
  assert.ok(skipped);
  assert.ok(ran);
});

test('reaper.start: noop when reapEnabled is false', async () => {
  const reaper = createReaper({
    getModel: () => fakeModel([]),
    adapter:  fakeAdapter(),
    config:   configWith({ reapEnabled: false }),
    log:      silentLog(),
  });
  reaper.start();
  // No timer pinned → process can exit. Calling stop() should also be safe.
  reaper.stop();
});

test('reaper.start / stop: idempotent', async () => {
  const reaper = createReaper({
    getModel: () => fakeModel([]),
    adapter:  fakeAdapter(),
    config:   configWith({ reapIntervalMs: 60000 }),
    log:      silentLog(),
  });
  reaper.start();
  reaper.start(); // no double-timer
  reaper.stop();
  reaper.stop();  // safe to call twice
});
