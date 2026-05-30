'use strict';

/**
 * Unit tests for the plugin wiring: bus subscription → enqueue →
 * handler → draft skill. Everything external (queue, skill model, LLM)
 * is stubbed, so the test runs with no Redis, Mongo, or API key.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createPlugin } = require('../index');

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog,
};

function flush(ms = 10) {
  return new Promise((r) => setTimeout(r, ms));
}

// A queue stub that mirrors davepi-plugin-queue's surface: registerJob
// stashes the handler, enqueue invokes it synchronously (good enough to
// assert the worker behaviour without BullMQ).
function makeQueueStub() {
  const handlers = new Map();
  const enqueued = [];
  return {
    handlers,
    enqueued,
    registerJob(name, handler) {
      if (handlers.has(name)) throw new Error(`already registered: ${name}`);
      handlers.set(name, handler);
    },
    async enqueue(name, data, opts) {
      enqueued.push({ name, data, opts });
      const handler = handlers.get(name);
      if (handler) {
        return handler(data, { log: silentLog, attempt: 1, jobId: '1', name });
      }
      return null;
    },
  };
}

// Skill-model stub. Real Mongoose `findOne(...)` returns a query with a
// `.lean()`; the persist layer calls `.lean()`, so the stub matches that
// shape rather than resolving directly.
function makeModel() {
  const rows = [];
  return {
    rows,
    findOne(q) {
      const hit = rows.find(
        (r) => r.userId === q.userId && r.agentKey === q.agentKey && r.name === q.name
      );
      return { lean: async () => hit || null };
    },
    async create(doc) {
      const row = { _id: `id-${rows.length + 1}`, ...doc };
      rows.push(row);
      return row;
    },
  };
}

// Conversation-model stub. The worker re-reads the transcript by id, so
// the stub resolves a conversation row from `findOne({ _id, userId })`.
// Pass `null` rows to simulate a missing (e.g. deleted) conversation.
function makeConversationModel(rows = []) {
  return {
    rows,
    findOne(q) {
      const hit = rows.find(
        (r) => r._id === q._id && (q.userId == null || r.userId === q.userId)
      );
      return { lean: async () => hit || null };
    },
  };
}

const sixTurns = JSON.stringify(
  Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `msg ${i}`,
  }))
);

// A conversation model holding one row (id `conv-1`, tenant `acct-A`)
// whose transcript the worker will load.
function convModel(history = sixTurns) {
  return makeConversationModel([
    { _id: 'conv-1', userId: 'acct-A', agentKey: 'support', history },
  ]);
}

function resolvedEvent(overrides = {}) {
  const history = sixTurns;
  return {
    type: 'conversation.resolved',
    version: 'v1',
    userId: 'acct-A',
    recordId: 'conv-1',
    record: {
      _id: 'conv-1',
      userId: 'acct-A',
      accountId: 'acct-A',
      agentKey: 'support',
      channel: 'slack',
      conversationId: 'C1::t1',
      history,
    },
    ...overrides,
  };
}

test('default export is a plugin object with name + setup', () => {
  const mod = require('../index');
  assert.equal(mod.name, 'skill-extractor');
  assert.equal(typeof mod.setup, 'function');
  assert.equal(typeof mod.createPlugin, 'function');
});

test('non-trivial resolved conversation → a tenant-scoped draft skill', async () => {
  const queue = makeQueueStub();
  const model = makeModel();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    queue,
    getSkillModel: () => model,
    getConversationModel: () => convModel(),
    runExtraction: async () =>
      JSON.stringify({
        skill: { name: 'Reset a locked account', description: 'unlock', body: '1. verify\n2. unlock' },
      }),
  });

  await plugin.setup({ bus, log: silentLog });
  assert.equal(plugin.isEnabled(), true);

  bus.emit('record', resolvedEvent());
  await flush();

  // Enqueued under the originating tenant.
  assert.equal(queue.enqueued.length, 1);
  assert.equal(queue.enqueued[0].name, 'skill.extract');
  assert.equal(queue.enqueued[0].opts.user.user_id, 'acct-A');

  // The transcript is NOT carried in the job payload — only identifiers
  // + tenancy, so an unbounded history never lands in Redis.
  assert.equal(queue.enqueued[0].data.history, undefined);
  assert.equal(queue.enqueued[0].data.recordId, 'conv-1');
  assert.equal(queue.enqueued[0].data.userId, 'acct-A');

  // A draft skill was created, scoped to the account.
  assert.equal(model.rows.length, 1);
  const skill = model.rows[0];
  assert.equal(skill.name, 'Reset a locked account');
  assert.equal(skill.status, 'draft');
  assert.equal(skill.userId, 'acct-A');
  assert.equal(skill.accountId, 'acct-A');
  assert.equal(skill.agentKey, 'support');
  assert.equal(skill.useCount, 0);
});

test('trivial chat → no skill', async () => {
  const queue = makeQueueStub();
  const model = makeModel();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    queue,
    getSkillModel: () => model,
    getConversationModel: () => convModel(),
    runExtraction: async () => '{"skill": null}',
  });
  await plugin.setup({ bus, log: silentLog });

  bus.emit('record', resolvedEvent());
  await flush();

  assert.equal(queue.enqueued.length, 1, 'still enqueued — triviality is decided in the worker');
  assert.equal(model.rows.length, 0, 'no skill persisted');
});

test('a missing conversation (deleted before extraction) → no skill, no throw', async () => {
  const queue = makeQueueStub();
  const model = makeModel();
  const bus = new EventEmitter();
  let llmCalled = false;
  const plugin = createPlugin({
    queue,
    getSkillModel: () => model,
    getConversationModel: () => makeConversationModel([]), // not found
    runExtraction: async () => {
      llmCalled = true;
      return '{"skill": {"name":"x","body":"y"}}';
    },
  });
  await plugin.setup({ bus, log: silentLog });

  bus.emit('record', resolvedEvent());
  await flush();

  assert.equal(queue.enqueued.length, 1);
  assert.equal(llmCalled, false, 'no transcript to extract from');
  assert.equal(model.rows.length, 0);
});

test('short transcript is filtered before the LLM and creates no skill', async () => {
  const queue = makeQueueStub();
  const model = makeModel();
  const bus = new EventEmitter();
  let llmCalled = false;
  const short = JSON.stringify([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'bye' }]);
  const plugin = createPlugin({
    queue,
    getSkillModel: () => model,
    getConversationModel: () => convModel(short),
    runExtraction: async () => {
      llmCalled = true;
      return JSON.stringify({ skill: { name: 'x', body: 'y' } });
    },
  });
  await plugin.setup({ bus, log: silentLog });

  bus.emit('record', resolvedEvent());
  await flush();

  assert.equal(llmCalled, false);
  assert.equal(model.rows.length, 0);
});

test('re-resolution does not duplicate an existing skill', async () => {
  const queue = makeQueueStub();
  const model = makeModel();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    queue,
    getSkillModel: () => model,
    getConversationModel: () => convModel(),
    runExtraction: async () =>
      JSON.stringify({ skill: { name: 'Same runbook', body: 'steps' } }),
  });
  await plugin.setup({ bus, log: silentLog });

  bus.emit('record', resolvedEvent());
  await flush();
  bus.emit('record', resolvedEvent());
  await flush();

  assert.equal(model.rows.length, 1, 'second resolution skips the duplicate');
});

test('only conversation.resolved is acted on', async () => {
  const queue = makeQueueStub();
  const model = makeModel();
  const bus = new EventEmitter();
  const plugin = createPlugin({
    queue,
    getSkillModel: () => model,
    runExtraction: async () => '{"skill": {"name":"x","body":"y"}}',
  });
  await plugin.setup({ bus, log: silentLog });

  bus.emit('record', { type: 'conversation.updated', userId: 'acct-A', record: {} });
  bus.emit('record', { type: 'conversation.transitioned', to: 'abandoned', userId: 'acct-A' });
  await flush();

  assert.equal(queue.enqueued.length, 0);
  assert.equal(model.rows.length, 0);
});

test('dormant when no queue is available (registerJob unavailable)', async () => {
  const bus = new EventEmitter();
  const plugin = createPlugin({
    queue: {}, // no registerJob
    getSkillModel: () => makeModel(),
    runExtraction: async () => '{"skill": null}',
  });
  await plugin.setup({ bus, log: silentLog });
  assert.equal(plugin.isEnabled(), false);
  // Events are ignored without throwing.
  bus.emit('record', resolvedEvent());
  await flush();
});

test('dormant when registerJob throws (queue without Redis)', async () => {
  const bus = new EventEmitter();
  const plugin = createPlugin({
    queue: {
      registerJob() {
        throw new Error('dormant (QUEUE_REDIS_URL not set)');
      },
      enqueue: async () => {},
    },
    getSkillModel: () => makeModel(),
    runExtraction: async () => '{"skill": null}',
  });
  await plugin.setup({ bus, log: silentLog });
  assert.equal(plugin.isEnabled(), false);
});
