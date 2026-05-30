const path = require('path');
const { setupTestApp, registerUser } = require('./helpers');

/**
 * Workstream D — the learning loop (docs/agent-learning-layer.md §7,
 * issue #132). End-to-end across the real schema layer + event bus +
 * skill model:
 *
 *   resolving a conversation (status open → resolved) emits a
 *   `conversation.resolved` record event carrying the transcript →
 *   davepi-plugin-skill-extractor (loaded through the real pluginLoader,
 *   with a stub queue + stub LLM) runs extraction → a non-trivial,
 *   positive conversation produces a tenant-scoped `draft` skill, a
 *   trivial one produces none, and resolution never blocks the response.
 *
 * The package's own test/plugin.test.js mocks the bus; this proves the
 * conversation schema's onEnter actually fires the event the plugin
 * consumes, and that the worker writes a real `skill` row.
 */

const ctx = setupTestApp();

const auth = (req, token) => req.set('Authorization', `Bearer ${token}`);

// A synchronous queue stub: registerJob stashes the handler, enqueue
// runs it inline so the test can assert the resulting skill without a
// real BullMQ/Redis. (The "off-thread / non-blocking" property is a
// property of the production queue; here we only need to exercise the
// wiring + extraction + persistence.)
function makeQueueStub() {
  const handlers = new Map();
  const enqueued = [];
  return {
    handlers,
    enqueued,
    registerJob(name, handler) {
      handlers.set(name, handler);
    },
    async enqueue(name, data, opts) {
      enqueued.push({ name, data, opts });
      const handler = handlers.get(name);
      return handler ? handler(data, { log: console, attempt: 1, jobId: '1', name }) : null;
    },
  };
}

// Plugins subscribe to the process-global record bus (that's where the
// conversation onEnter emits). Track each loaded instance so we can
// detach its listener after the test — otherwise listeners from earlier
// tests would also fire on later tests' resolved events.
const loadedPlugins = [];

afterEach(() => {
  const { bus } = require('../utils/events');
  for (const p of loadedPlugins) {
    if (p && typeof p._onRecord === 'function') bus.removeListener('record', p._onRecord);
  }
  loadedPlugins.length = 0;
});

async function loadExtractor({ queue, runExtraction }) {
  const { loadPlugins } = require('../utils/pluginLoader');
  const { bus } = require('../utils/events');
  const modPath = path.resolve(__dirname, '..', 'packages', 'davepi-plugin-skill-extractor');
  const { createPlugin } = require(modPath);
  const plugin = createPlugin({ queue, runExtraction });
  await loadPlugins({
    plugins: [plugin],
    app: ctx.app,
    schemaLoader: ctx.app.locals.schemaLoader,
    bus,
    appName: 'learning-loop-test',
  });
  loadedPlugins.push(plugin);
  return plugin;
}

function skillModel() {
  return ctx.app.locals.schemaLoader.getEntry('v1/skill').model;
}

// Build a conversation, return its id. agent-role token shares the
// tenant userId, matching how the agent writes its own conversations.
async function createConversation(token, history) {
  const res = await auth(
    ctx.request(ctx.app).post('/api/v1/conversation'),
    token
  ).send({
    agentKey: 'support',
    channel: 'slack',
    conversationId: `C1::${Date.now()}`,
    channelUserId: 'U123',
    history: JSON.stringify(history),
  });
  expect(res.status).toBe(201);
  // Stamped open by the state machine.
  expect(res.body.status).toBe('open');
  return res.body._id;
}

const longTranscript = Array.from({ length: 6 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user',
  content: `turn ${i}: a real exchange about an account lockout`,
}));

describe('learning loop: skill extraction on resolution', () => {
  test('a non-trivial resolved conversation produces a tenant-scoped draft skill', async () => {
    const queue = makeQueueStub();
    await loadExtractor({
      queue,
      runExtraction: async ({ transcript }) => {
        expect(transcript).toContain('account lockout');
        return JSON.stringify({
          skill: {
            name: 'Reset a locked account',
            description: 'Unlock after repeated failed logins.',
            body: '1. Verify identity.\n2. Clear the lockout.',
          },
        });
      },
    });

    const owner = await registerUser(ctx.request, ctx.app);
    const id = await createConversation(owner.token, longTranscript);

    // Resolve it: open → resolved. This is the only thing that should
    // trigger extraction.
    const resolved = await auth(
      ctx.request(ctx.app).put(`/api/v1/conversation/${id}`),
      owner.token
    ).send({ status: 'resolved' });
    expect(resolved.status).toBe(200);

    // Let the onEnter emit + the (synchronous-stub) enqueue/handler run.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0].name).toBe('skill.extract');

    const rows = await skillModel().find({ userId: owner._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Reset a locked account');
    expect(rows[0].status).toBe('draft');
    expect(rows[0].agentKey).toBe('support');
    expect(String(rows[0].userId)).toBe(String(owner._id));
    expect(String(rows[0].accountId)).toBe(String(owner._id));
  });

  test('a trivial conversation produces no skill', async () => {
    const queue = makeQueueStub();
    await loadExtractor({
      queue,
      // Even if the LLM were consulted, the verdict is "nothing worth
      // keeping"; for a 2-message chat the pre-filter skips it anyway.
      runExtraction: async () => '{"skill": null}',
    });

    const owner = await registerUser(ctx.request, ctx.app);
    const id = await createConversation(owner.token, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello! anything I can help with?' },
    ]);

    const resolved = await auth(
      ctx.request(ctx.app).put(`/api/v1/conversation/${id}`),
      owner.token
    ).send({ status: 'resolved' });
    expect(resolved.status).toBe(200);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const rows = await skillModel().find({ userId: owner._id }).lean();
    expect(rows).toHaveLength(0);
  });

  test('abandoning a conversation does not trigger extraction', async () => {
    const queue = makeQueueStub();
    await loadExtractor({ queue, runExtraction: async () => '{"skill": {"name":"x","body":"y"}}' });

    const owner = await registerUser(ctx.request, ctx.app);
    const id = await createConversation(owner.token, longTranscript);

    const res = await auth(
      ctx.request(ctx.app).put(`/api/v1/conversation/${id}`),
      owner.token
    ).send({ status: 'abandoned' });
    expect(res.status).toBe(200);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(queue.enqueued).toHaveLength(0);
    const rows = await skillModel().find({ userId: owner._id }).lean();
    expect(rows).toHaveLength(0);
  });

  test('resolved is terminal — cannot reopen', async () => {
    const queue = makeQueueStub();
    await loadExtractor({ queue, runExtraction: async () => '{"skill": null}' });

    const owner = await registerUser(ctx.request, ctx.app);
    const id = await createConversation(owner.token, longTranscript);

    await auth(ctx.request(ctx.app).put(`/api/v1/conversation/${id}`), owner.token).send({
      status: 'resolved',
    });
    const reopen = await auth(
      ctx.request(ctx.app).put(`/api/v1/conversation/${id}`),
      owner.token
    ).send({ status: 'open' });
    expect(reopen.status).toBe(400);
    expect(reopen.body.error.code).toBe('INVALID_TRANSITION');
  });
});
