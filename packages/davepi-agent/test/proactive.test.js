'use strict';

/**
 * Proactive / scheduled-agent tests (workstream E). The orchestrator's
 * `runTurn` (and the `ai` SDK behind it) is injected via the `_runTurn`
 * seam, and the Slack poster via the `poster` option, so these cover the
 * cron→skill→Slack wiring without a live model or Slack network call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runScheduledSkill,
  loadSkillByName,
  createScheduledHandler,
  buildTriggerMessage,
} = require('../lib/proactive');

// mcpClient stub returning a list_skill payload in the MCP text shape and
// recording every call.
function skillMcpStub(rows) {
  const calls = [];
  return {
    calls,
    async callTool(name, args, ctx) {
      calls.push({ name, args, ctx });
      return { content: [{ type: 'text', text: JSON.stringify({ results: rows, totalResults: rows.length }) }] };
    },
  };
}

// A fake poster capturing what would be sent to Slack.
function fakePoster() {
  const posts = [];
  return { posts, async post(p) { posts.push(p); return { ts: '1.1' }; } };
}

const APPROVED_SKILL = {
  _id: 's1',
  agentKey: 'support',
  name: 'Daily SLA digest',
  description: 'Summarise tickets breaching SLA.',
  body: '1. List open tickets.\n2. Flag any past their SLA.',
  status: 'approved',
};

test('loadSkillByName filters list_skill to the named approved skill', async () => {
  const stub = skillMcpStub([APPROVED_SKILL]);
  const row = await loadSkillByName({
    mcpClient: stub,
    channelCtx: { channel: 'cron' },
    agentKey: 'support',
    name: 'Daily SLA digest',
  });
  assert.deepEqual(row, APPROVED_SKILL);
  assert.equal(stub.calls[0].name, 'list_skill');
  assert.deepEqual(stub.calls[0].args.filter, {
    agentKey: 'support',
    name: 'Daily SLA digest',
    status: 'approved',
  });
});

test('loadSkillByName returns null on empty result or error envelope', async () => {
  assert.equal(
    await loadSkillByName({ mcpClient: skillMcpStub([]), agentKey: 'support', name: 'x' }),
    null
  );
  const erroring = { async callTool() { return { isError: true, content: [{ type: 'text', text: 'boom' }] }; } };
  assert.equal(await loadSkillByName({ mcpClient: erroring, agentKey: 'support', name: 'x' }), null);
  // No name → no lookup at all.
  const stub = skillMcpStub([APPROVED_SKILL]);
  assert.equal(await loadSkillByName({ mcpClient: stub, agentKey: 'support', name: '' }), null);
  assert.equal(stub.calls.length, 0);
});

test('buildTriggerMessage inlines the runbook name, description and body', () => {
  const msg = buildTriggerMessage({ skill: APPROVED_SKILL });
  assert.match(msg, /scheduled job/i);
  assert.match(msg, /# Runbook: Daily SLA digest/);
  assert.match(msg, /Summarise tickets breaching SLA\./);
  assert.match(msg, /List open tickets/);
});

test('buildTriggerMessage uses a custom preamble when given', () => {
  const msg = buildTriggerMessage({ skill: APPROVED_SKILL, prompt: 'CUSTOM PREAMBLE' });
  assert.ok(msg.startsWith('CUSTOM PREAMBLE'));
  assert.match(msg, /# Runbook: Daily SLA digest/);
});

test('runScheduledSkill loads the skill, runs a fresh cron turn, collects render blocks', async () => {
  const stub = skillMcpStub([APPROVED_SKILL]);
  let received = null;
  const _runTurn = async (args) => {
    received = args;
    // Simulate the orchestrator emitting a render event mid-turn.
    args.onEvent({ type: 'render', payload: { type: 'table', title: 'SLA', columns: [{ key: 'id', label: 'ID' }], rows: [{ id: 1 }] } });
    return { text: 'Two tickets are breaching SLA.', history: [] };
  };

  const out = await runScheduledSkill({
    config: { agent: { key: 'support' } },
    model: 'fake-model',
    mcpClient: stub,
    skill: 'Daily SLA digest',
    _runTurn,
  });

  assert.equal(out.text, 'Two tickets are breaching SLA.');
  assert.equal(out.skill.name, 'Daily SLA digest');
  assert.ok(out.renderBlocks.length >= 1); // table rendered to blocks

  // Fresh turn: empty history, cron channel scoped by agentKey, no end-user.
  assert.deepEqual(received.history, []);
  assert.equal(received.channelCtx.channel, 'cron');
  assert.equal(received.channelCtx.agentKey, 'support');
  assert.equal(received.channelCtx.channelUserId, undefined);
  assert.match(received.userMessage, /# Runbook: Daily SLA digest/);
});

test('runScheduledSkill throws SKILL_NOT_FOUND when no approved skill matches', async () => {
  await assert.rejects(
    () =>
      runScheduledSkill({
        config: { agent: { key: 'support' } },
        mcpClient: skillMcpStub([]),
        skill: 'No such skill',
        _runTurn: async () => ({ text: 'x', history: [] }),
      }),
    (err) => err.code === 'SKILL_NOT_FOUND'
  );
});

test('runScheduledSkill requires an agentKey', async () => {
  await assert.rejects(
    () => runScheduledSkill({ config: { agent: {} }, mcpClient: skillMcpStub([]), skill: 'x' }),
    /requires config\.agent\.key/
  );
});

test('createScheduledHandler validates agent, skill, and channel', () => {
  const agent = { config: { slack: { botToken: 't' } }, mcpClient: {} };
  assert.throws(() => createScheduledHandler({}), /requires an agent/);
  assert.throws(() => createScheduledHandler({ agent, slackChannel: 'C1' }), /requires a `skill`/);
  assert.throws(() => createScheduledHandler({ agent, skill: 's' }), /requires a `slackChannel`/);
});

test('createScheduledHandler runs the skill and posts the result to Slack', async () => {
  const stub = skillMcpStub([APPROVED_SKILL]);
  const poster = fakePoster();
  const agent = {
    config: { agent: { key: 'support' }, slack: { botToken: 'xoxb-test' } },
    model: 'fake',
    mcpClient: stub,
  };
  const handler = createScheduledHandler({
    agent,
    skill: 'Daily SLA digest',
    slackChannel: 'C123',
    poster,
    _runTurn: async (args) => {
      args.onEvent({ type: 'render', payload: { type: 'chart', title: 'Trend', vegaLiteSpec: {} } });
      return { text: 'Digest ready.', history: [] };
    },
  });

  const res = await handler({ log: { info() {}, warn() {} } });
  assert.deepEqual(res, { posted: true });
  assert.equal(poster.posts.length, 1);
  assert.equal(poster.posts[0].channel, 'C123');
  assert.equal(poster.posts[0].text, 'Digest ready.');
  assert.ok(poster.posts[0].renderBlocks.length >= 1); // chart block included
});

test('handler skips posting when the run produces no output', async () => {
  const agent = {
    config: { agent: { key: 'support' }, slack: { botToken: 'xoxb-test' } },
    mcpClient: skillMcpStub([APPROVED_SKILL]),
  };
  const poster = fakePoster();
  const handler = createScheduledHandler({
    agent,
    skill: 'Daily SLA digest',
    slackChannel: 'C123',
    poster,
    _runTurn: async () => ({ text: '', history: [] }),
  });
  const res = await handler({ log: { info() {}, warn() {} } });
  assert.deepEqual(res, { posted: false, empty: true });
  assert.equal(poster.posts.length, 0);
});

test('handler exits before doing any work when the lease is already lost', async () => {
  let runTurnCalled = false;
  const stub = skillMcpStub([APPROVED_SKILL]);
  const agent = {
    config: { agent: { key: 'support' }, slack: { botToken: 'xoxb-test' } },
    mcpClient: stub,
  };
  const poster = fakePoster();
  const handler = createScheduledHandler({
    agent,
    skill: 'Daily SLA digest',
    slackChannel: 'C123',
    poster,
    _runTurn: async () => {
      runTurnCalled = true;
      return { text: 'Digest ready.', history: [] };
    },
  });
  const ac = new AbortController();
  ac.abort();
  const res = await handler({ log: { info() {}, warn() {} }, signal: ac.signal });
  assert.deepEqual(res, { posted: false, aborted: true });
  assert.equal(poster.posts.length, 0);
  // Pre-aborted: neither the skill lookup nor the turn should have run.
  assert.equal(stub.calls.length, 0);
  assert.equal(runTurnCalled, false);
});

test('handler stops mid-run and does not post when the lease is lost during the turn', async () => {
  const stub = skillMcpStub([APPROVED_SKILL]);
  const agent = {
    config: { agent: { key: 'support' }, slack: { botToken: 'xoxb-test' } },
    mcpClient: stub,
  };
  const poster = fakePoster();
  const ac = new AbortController();
  let toolCallsAfterAbort = 0;
  const handler = createScheduledHandler({
    agent,
    skill: 'Daily SLA digest',
    slackChannel: 'C123',
    poster,
    // Simulate the lease being lost partway through generation: the signal
    // flips, then the model attempts another tool call which the cancelled
    // transport would reject. We assert the run reports aborted and no post.
    _runTurn: async (args) => {
      assert.equal(args.signal, ac.signal); // signal threaded into the turn
      assert.equal(args.channelCtx.signal, ac.signal); // and onto the MCP ctx
      ac.abort();
      if (args.signal.aborted) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      toolCallsAfterAbort += 1;
      return { text: 'should not get here', history: [] };
    },
  });

  const res = await handler({ log: { info() {}, warn() {} }, signal: ac.signal });
  assert.deepEqual(res, { posted: false, aborted: true });
  assert.equal(poster.posts.length, 0);
  assert.equal(toolCallsAfterAbort, 0);
});

test('runScheduledSkill threads the signal onto the MCP ctx and the turn', async () => {
  const stub = skillMcpStub([APPROVED_SKILL]);
  const ac = new AbortController();
  let received = null;
  await runScheduledSkill({
    config: { agent: { key: 'support' } },
    mcpClient: stub,
    skill: 'Daily SLA digest',
    signal: ac.signal,
    _runTurn: async (args) => {
      received = args;
      return { text: 'ok', history: [] };
    },
  });
  // The skill lookup ran under a ctx carrying the signal...
  assert.equal(stub.calls[0].ctx.signal, ac.signal);
  // ...and the turn got both the signal and a ctx carrying it.
  assert.equal(received.signal, ac.signal);
  assert.equal(received.channelCtx.signal, ac.signal);
});

test('runScheduledSkill returns aborted before the lookup when pre-aborted', async () => {
  const stub = skillMcpStub([APPROVED_SKILL]);
  const ac = new AbortController();
  ac.abort();
  const out = await runScheduledSkill({
    config: { agent: { key: 'support' } },
    mcpClient: stub,
    skill: 'Daily SLA digest',
    signal: ac.signal,
    _runTurn: async () => ({ text: 'x', history: [] }),
  });
  assert.deepEqual(out, { aborted: true });
  assert.equal(stub.calls.length, 0); // no lookup, no turn
});

test('createScheduledHandler rejects per-user auth without an explicit channelUserId', () => {
  const agent = {
    config: { agent: { key: 'support' }, slack: { botToken: 't' } },
    mcpClient: {},
    auth: { mode: 'per-user' },
  };
  assert.throws(
    () => createScheduledHandler({ agent, skill: 'Daily SLA digest', slackChannel: 'C1' }),
    /service auth, or an explicit channelCtx with channelUserId/
  );
  // Advanced: an explicit channelCtx with a channelUserId is accepted.
  assert.doesNotThrow(() =>
    createScheduledHandler({
      agent,
      skill: 'Daily SLA digest',
      slackChannel: 'C1',
      poster: fakePoster(),
      channelCtx: { channel: 'cron', agentKey: 'support', channelUserId: 'U1' },
    })
  );
});
