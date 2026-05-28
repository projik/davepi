'use strict';

/**
 * Unit tests for davepi-plugin-queue. Uses node:test so the package
 * stays zero-runtime-dep (jest is the framework's main runner but is
 * not a dep of this package). BullMQ is injected as a stub so the
 * tests don't require a live Redis.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const queueModule = require('../index');
const { createPlugin } = queueModule;

// Yield long enough for setImmediate-scheduled stub workers AND any
// async processors they await to finish. Two raw setImmediate hops
// aren't enough when the processor is itself async — use a real
// setTimeout so the macrotask queue drains.
function flush(ms = 30) { return new Promise((r) => setTimeout(r, ms)); }

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, child: () => silentLog() };
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

/**
 * In-memory BullMQ stub. The Worker runs queued jobs synchronously
 * (via setImmediate) by handing each `queue.add()` straight to the
 * processor function the test code supplies. Enough surface to
 * exercise enqueue / worker dispatch / lifecycle events / job
 * lookup; not a faithful BullMQ — just enough to assert plugin
 * behaviour.
 */
function makeBullmqStub() {
  const queues = new Map();
  const workers = [];

  class StubJob {
    constructor(name, data, opts, id) {
      this.id = id;
      this.name = name;
      this.data = data;
      this.opts = opts || {};
      this.attemptsMade = 0;
      this.returnvalue = null;
      this.failedReason = null;
      this.progress = 0;
      this.state = 'waiting';
    }
    async getState() { return this.state; }
  }

  class StubQueue extends EventEmitter {
    constructor(name) {
      super();
      this.name = name;
      this.jobs = new Map();
      this.nextId = 1;
      queues.set(name, this);
    }
    async add(name, data, opts) {
      const id = String(this.nextId++);
      const job = new StubJob(name, data, opts, id);
      this.jobs.set(id, job);
      // Fan out to workers attached to this queue (matched by the
      // QUEUE name on the Queue/Worker constructors — `name` here is
      // the JOB name).
      const matching = workers.filter((w) => w.queueName === this.name);
      for (const w of matching) {
        setImmediate(() => w.__run(job));
      }
      return job;
    }
    async getJob(id) { return this.jobs.get(String(id)) || null; }
    async close() { this.removeAllListeners(); }
  }

  class StubWorker extends EventEmitter {
    constructor(queueName, processor, opts) {
      super();
      this.queueName = queueName;
      this.processor = processor;
      this.opts = opts;
      workers.push(this);
    }
    async __run(job) {
      job.attemptsMade += 1;
      job.state = 'active';
      try {
        const result = await this.processor(job);
        job.returnvalue = result;
        job.state = 'completed';
        this.emit('completed', job, result);
      } catch (err) {
        job.failedReason = err.message;
        job.state = 'failed';
        this.emit('failed', job, err);
      }
    }
    async close() { this.removeAllListeners(); }
  }

  return { Queue: StubQueue, Worker: StubWorker, __queues: queues, __workers: workers };
}

const REDIS = 'redis://localhost:6379';

test('default export is a plugin object with name + setup + enqueue + registerJob + createPlugin', () => {
  assert.equal(queueModule.name, 'queue');
  assert.equal(typeof queueModule.setup, 'function');
  assert.equal(typeof queueModule.enqueue, 'function');
  assert.equal(typeof queueModule.registerJob, 'function');
  assert.equal(typeof queueModule.createPlugin, 'function');
});

test('dormant when QUEUE_REDIS_URL is unset; enqueue + registerJob throw; warn logged', async () => {
  const log = capturingLog();
  const plugin = createPlugin({ env: {}, bullmq: makeBullmqStub() });
  await plugin.setup({ bus: new EventEmitter(), log, appName: 'demo' });
  assert.equal(log.records.warn.length, 1);
  assert.match(log.records.warn[0].msg, /QUEUE_REDIS_URL not set/);
  await assert.rejects(
    () => plugin.enqueue('x', { a: 1 }, { user: { user_id: 'u1' } }),
    /dormant/,
  );
  // registerJob also throws in dormant mode so a worker-only dyno
  // that forgets to set QUEUE_REDIS_URL fails loudly rather than
  // silently dropping every registration.
  assert.throws(
    () => plugin.registerJob('x', async () => {}),
    /dormant/,
  );
  assert.equal(plugin.isEnabled(), false);
});

test('enqueue stamps userId from opts.user and applies retry defaults', async () => {
  const bullmq = makeBullmqStub();
  const plugin = createPlugin({ env: { QUEUE_REDIS_URL: REDIS }, bullmq });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });
  const job = await plugin.enqueue('send-welcome', { email: 'x@y.com' }, {
    user: { user_id: 'user-abc' },
  });
  assert.equal(job.data.email, 'x@y.com');
  assert.equal(job.data.userId, 'user-abc');
  assert.equal(job.opts.attempts, 3);
  assert.deepEqual(job.opts.backoff, { type: 'exponential', delay: 2000 });
});

test('enqueue refuses to run without a tenancy stamp', async () => {
  const plugin = createPlugin({ env: { QUEUE_REDIS_URL: REDIS }, bullmq: makeBullmqStub() });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });
  await assert.rejects(() => plugin.enqueue('x', { a: 1 }), /requires a userId/);
});

test('enqueue accepts explicit data.userId without a user opt', async () => {
  const plugin = createPlugin({ env: { QUEUE_REDIS_URL: REDIS }, bullmq: makeBullmqStub() });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });
  const job = await plugin.enqueue('x', { userId: 'pre-stamped' });
  assert.equal(job.data.userId, 'pre-stamped');
});

test('enqueue allows per-call attempts / backoff override', async () => {
  const plugin = createPlugin({ env: { QUEUE_REDIS_URL: REDIS }, bullmq: makeBullmqStub() });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });
  const job = await plugin.enqueue('x', {}, {
    user: { user_id: 'u1' },
    attempts: 7,
    backoff: { type: 'fixed', delay: 500 },
    delay: 1000,
  });
  assert.equal(job.opts.attempts, 7);
  assert.deepEqual(job.opts.backoff, { type: 'fixed', delay: 500 });
  assert.equal(job.opts.delay, 1000);
});

test('worker dispatches enqueued jobs to registered handlers', async () => {
  const bullmq = makeBullmqStub();
  const plugin = createPlugin({ env: { QUEUE_REDIS_URL: REDIS }, bullmq });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });
  const seen = [];
  plugin.registerJob('greet', async (data, ctx) => {
    seen.push({ data, attempt: ctx.attempt, name: ctx.name });
    return 'ok';
  });
  await plugin.enqueue('greet', { name: 'Dave' }, { user: { user_id: 'u1' } });
  await flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].data.name, 'Dave');
  assert.equal(seen[0].data.userId, 'u1');
  assert.equal(seen[0].attempt, 1);
  assert.equal(seen[0].name, 'greet');
});

test('worker rebroadcasts job.completed on the bus with userId stamp', async () => {
  const bus = new EventEmitter();
  const plugin = createPlugin({ env: { QUEUE_REDIS_URL: REDIS }, bullmq: makeBullmqStub() });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });
  const events = [];
  bus.on('record', (e) => events.push(e));
  plugin.registerJob('greet', async () => 'hi');
  await plugin.enqueue('greet', {}, { user: { user_id: 'u1' } });
  await flush();
  await flush();
  const completed = events.find((e) => e.type === 'job.completed');
  assert.ok(completed, 'expected a job.completed event');
  assert.equal(completed.name, 'greet');
  assert.equal(completed.userId, 'u1');
  assert.equal(completed.returnValue, 'hi');
});

test('worker rebroadcasts job.failed on the bus', async () => {
  const bus = new EventEmitter();
  const plugin = createPlugin({ env: { QUEUE_REDIS_URL: REDIS }, bullmq: makeBullmqStub() });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });
  const events = [];
  bus.on('record', (e) => events.push(e));
  plugin.registerJob('boom', async () => { throw new Error('kapow'); });
  await plugin.enqueue('boom', {}, { user: { user_id: 'u1' } });
  await flush();
  await flush();
  const failed = events.find((e) => e.type === 'job.failed');
  assert.ok(failed);
  assert.equal(failed.name, 'boom');
  assert.equal(failed.error, 'kapow');
  assert.equal(failed.userId, 'u1');
});

test('rebroadcasts do not loop back through rule subscribers', async () => {
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { QUEUE_REDIS_URL: REDIS },
    bullmq: makeBullmqStub(),
    rules: [
      {
        events: '*',
        // If this fires for job.completed we'll infinite-loop in tests.
        build: () => ({ name: 'should-not-fire', data: {}, user: { user_id: 'u1' } }),
      },
    ],
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });
  plugin.registerJob('hello', async () => 'k');
  plugin.registerJob('should-not-fire', async () => { throw new Error('should not run'); });
  await plugin.enqueue('hello', {}, { user: { user_id: 'u1' } });
  await flush();
  await flush();
  await flush();
  // Only the original `hello` job ran; rebroadcast did NOT trigger
  // a fresh enqueue under the wildcard rule.
  const allJobs = Array.from(plugin.getQueue().jobs.values());
  const names = allJobs.map((j) => j.name).sort();
  assert.deepEqual(names, ['hello']);
});

test("bus 'job:enqueue' channel enqueues without import", async () => {
  const bus = new EventEmitter();
  const plugin = createPlugin({ env: { QUEUE_REDIS_URL: REDIS }, bullmq: makeBullmqStub() });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });
  const seen = [];
  plugin.registerJob('audit', async (d) => { seen.push(d); });
  bus.emit('job:enqueue', { name: 'audit', data: { action: 'login' }, opts: { user: { user_id: 'u1' } } });
  await flush();
  await flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, 'login');
  assert.equal(seen[0].userId, 'u1');
});

test("bus 'job:enqueue' with missing name is logged and ignored", async () => {
  const log = capturingLog();
  const bus = new EventEmitter();
  const plugin = createPlugin({ env: { QUEUE_REDIS_URL: REDIS }, bullmq: makeBullmqStub() });
  await plugin.setup({ bus, log, appName: 'shop' });
  bus.emit('job:enqueue', { data: {} });
  await flush();
  assert.equal(log.records.warn.length, 1);
  assert.match(log.records.warn[0].msg, /missing required `name`/);
});

test('rules subscribe to record events and enqueue per match', async () => {
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { QUEUE_REDIS_URL: REDIS },
    bullmq: makeBullmqStub(),
    rules: [
      {
        events: 'user.created',
        build: (event) => ({
          name: 'send-welcome',
          data: { email: event.record && event.record.email },
        }),
      },
    ],
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });
  const seen = [];
  plugin.registerJob('send-welcome', async (d) => { seen.push(d); });
  bus.emit('record', {
    type: 'user.created',
    userId: 'u-new',
    record: { email: 'new@example.com' },
  });
  await flush();
  await flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].email, 'new@example.com');
  assert.equal(seen[0].userId, 'u-new');
});

test('rule build() returning null skips the enqueue', async () => {
  const bus = new EventEmitter();
  const plugin = createPlugin({
    env: { QUEUE_REDIS_URL: REDIS },
    bullmq: makeBullmqStub(),
    rules: [
      { events: 'user.*', build: () => null },
    ],
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });
  bus.emit('record', { type: 'user.created', userId: 'u1' });
  await flush();
  assert.equal(plugin.getQueue().jobs.size, 0);
});

test('invalid rule shape throws at setup (typo guard)', async () => {
  const plugin = createPlugin({
    env: { QUEUE_REDIS_URL: REDIS },
    bullmq: makeBullmqStub(),
    rules: [{ events: 'x' /* missing build */ }],
  });
  await assert.rejects(
    () => plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' }),
    /build must be a function/,
  );
});

test('registerJob refuses to double-register the same name', async () => {
  const plugin = createPlugin({ env: { QUEUE_REDIS_URL: REDIS }, bullmq: makeBullmqStub() });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });
  plugin.registerJob('x', async () => {});
  assert.throws(() => plugin.registerJob('x', async () => {}), /already registered/);
});

test('QUEUE_WORKER=false skips worker boot (enqueue still works)', async () => {
  const bullmq = makeBullmqStub();
  const plugin = createPlugin({
    env: { QUEUE_REDIS_URL: REDIS, QUEUE_WORKER: 'false' },
    bullmq,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });
  assert.equal(bullmq.__workers.length, 0);
  assert.equal(plugin.getWorker(), null);
  // enqueue still works (web dyno is just a producer).
  const job = await plugin.enqueue('x', {}, { user: { user_id: 'u1' } });
  assert.equal(job.name, 'x');
});

test('QUEUE_NAME / QUEUE_PREFIX / QUEUE_CONCURRENCY flow through to BullMQ', async () => {
  const bullmq = makeBullmqStub();
  const plugin = createPlugin({
    env: {
      QUEUE_REDIS_URL: REDIS,
      QUEUE_NAME: 'mailers',
      QUEUE_PREFIX: 'myapp',
      QUEUE_CONCURRENCY: '12',
    },
    bullmq,
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });
  assert.ok(bullmq.__queues.has('mailers'));
  assert.equal(bullmq.__workers[0].queueName, 'mailers');
  assert.equal(bullmq.__workers[0].opts.concurrency, 12);
  assert.equal(bullmq.__workers[0].opts.prefix, 'myapp');
});

test('QUEUE_FAILED_TTL adds removeOnFail to enqueued jobs', async () => {
  const plugin = createPlugin({
    env: { QUEUE_REDIS_URL: REDIS, QUEUE_FAILED_TTL: '7d' },
    bullmq: makeBullmqStub(),
  });
  await plugin.setup({ bus: new EventEmitter(), log: silentLog(), appName: 'shop' });
  const job = await plugin.enqueue('x', {}, { user: { user_id: 'u1' } });
  assert.ok(job.opts.removeOnFail);
  assert.equal(job.opts.removeOnFail.age, 7 * 24 * 60 * 60);
});

test('status route returns job state for the owner', async () => {
  const express = require('express');
  const errors = {
    NotFoundError: class NotFoundError extends Error { constructor(m) { super(m); this.status = 404; } },
    ForbiddenError: class ForbiddenError extends Error { constructor(m) { super(m); this.status = 403; } },
  };
  // Stub auth: takes the user_id from a `X-Test-User` header so the
  // integration test can drive multi-tenant scenarios without JWT.
  const auth = () => (req, res, next) => {
    const uid = req.headers['x-test-user'];
    if (!uid) return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'no user' } });
    req.user = { user_id: uid };
    next();
  };
  // Mirrors davepi/utils/asyncHandler so a rejection from inside the
  // route handler reaches our terminal error middleware below.
  const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
  // Terminal error handler so our typed errors render as JSON.
  const app = express();
  const plugin = createPlugin({
    env: { QUEUE_REDIS_URL: REDIS, QUEUE_WORKER: 'false' },
    bullmq: makeBullmqStub(),
    express,
    errors,
    auth,
    asyncHandler,
  });
  await plugin.setup({ app, bus: new EventEmitter(), log: silentLog(), appName: 'shop' });
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: { message: err.message } });
  });

  const job = await plugin.enqueue('greet', { x: 1 }, { user: { user_id: 'alice' } });

  const http = require('http');
  const server = app.listen(0);
  const port = server.address().port;

  async function getStatus(jobId, asUser) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: `/api/jobs/${jobId}`, method: 'GET', headers: { 'X-Test-User': asUser } },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  // Owner can see it.
  const own = await getStatus(job.id, 'alice');
  assert.equal(own.status, 200);
  assert.equal(own.body.id, String(job.id));
  assert.equal(own.body.name, 'greet');

  // Different tenant gets 404 (not 403 — don't disclose existence).
  const other = await getStatus(job.id, 'bob');
  assert.equal(other.status, 404);

  // Missing job → 404.
  const missing = await getStatus('does-not-exist', 'alice');
  assert.equal(missing.status, 404);

  server.close();
});

test('QUEUE_STATUS_PATH empty disables the route', async () => {
  const express = require('express');
  const http = require('http');
  const app = express();
  const plugin = createPlugin({
    env: { QUEUE_REDIS_URL: REDIS, QUEUE_STATUS_PATH: '', QUEUE_WORKER: 'false' },
    bullmq: makeBullmqStub(),
    express,
    errors: { NotFoundError: class extends Error {}, ForbiddenError: class extends Error {} },
    auth: () => (req, res, next) => next(),
    asyncHandler: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
  });
  await plugin.setup({ app, bus: new EventEmitter(), log: silentLog(), appName: 'shop' });
  // Express's default 404 handler responds when no route matches.
  const server = app.listen(0);
  const port = server.address().port;
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/jobs/anything' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  assert.equal(status, 404);
  server.close();
});

test('rule user precedence: built.opts.user > built.user > event.userId', async () => {
  const bus = new EventEmitter();
  // Three rules, one per source of tenancy, all listening to the
  // same event. The job names differ so we can pick each one out
  // of the queue by handler invocation.
  const seen = { fromOptsUser: null, fromBuiltUser: null, fromEventUser: null };
  const plugin = createPlugin({
    env: { QUEUE_REDIS_URL: REDIS },
    bullmq: makeBullmqStub(),
    rules: [
      {
        events: 'thing.created',
        build: () => ({
          name: 'from-opts-user',
          data: {},
          // Explicit opts.user — should win over everything.
          opts: { user: { user_id: 'opts-winner' } },
          // ...even when built.user is also present.
          user: { user_id: 'should-be-ignored' },
        }),
      },
      {
        events: 'thing.created',
        build: () => ({
          name: 'from-built-user',
          data: {},
          // Only built.user; should override event.userId.
          user: { user_id: 'built-winner' },
        }),
      },
      {
        events: 'thing.created',
        build: () => ({
          name: 'from-event-user',
          data: {},
          // No user info anywhere; should fall back to event.userId.
        }),
      },
    ],
  });
  await plugin.setup({ bus, log: silentLog(), appName: 'shop' });
  plugin.registerJob('from-opts-user',  async (d) => { seen.fromOptsUser  = d.userId; });
  plugin.registerJob('from-built-user', async (d) => { seen.fromBuiltUser = d.userId; });
  plugin.registerJob('from-event-user', async (d) => { seen.fromEventUser = d.userId; });
  bus.emit('record', { type: 'thing.created', userId: 'event-user' });
  await flush();
  assert.equal(seen.fromOptsUser,  'opts-winner');
  assert.equal(seen.fromBuiltUser, 'built-winner');
  assert.equal(seen.fromEventUser, 'event-user');
});

