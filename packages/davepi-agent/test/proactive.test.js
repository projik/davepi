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

test('handler does not post when the cron lease was lost mid-run (signal aborted)', async () => {
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
    _runTurn: async () => ({ text: 'Digest ready.', history: [] }),
  });
  const ac = new AbortController();
  ac.abort();
  const res = await handler({ log: { info() {}, warn() {} }, signal: ac.signal });
  assert.deepEqual(res, { posted: false, aborted: true });
  assert.equal(poster.posts.length, 0);
});
