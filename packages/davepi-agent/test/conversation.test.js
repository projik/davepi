'use strict';

/**
 * Frozen-snapshot session + conversation persistence (ticket B).
 *
 * Exercises lib/conversation.js against an mcpClient stub so we can assert
 * the three behavioural acceptance criteria without a live backend:
 *   - a fact taught in session 1 appears (via a re-frozen snapshot) in
 *     session 2;
 *   - the prefix is reused byte-for-byte within a session;
 *   - mid-session memory writes do NOT change the in-flight prefix.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startSession, canPersist, _resetSessionCaches } = require('../lib/conversation');

const quietLog = { warn() {}, info() {}, error() {} };

const persona = (row) => async () => row;
const memory = (row) => async () => row;
const profile = (row) => async () => row;

// A minimal mcpClient stub backed by a single in-memory conversation row,
// so update_conversation/create_conversation/list_conversation round-trip.
function convoStub(initial = null) {
  let row = initial; // { _id, history, systemSnapshot, lastTurnAt, ... } | null
  const calls = [];
  const wrap = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
  return {
    get row() { return row; },
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'list_conversation') {
        return wrap({ results: row ? [row] : [], totalResults: row ? 1 : 0 });
      }
      if (name === 'create_conversation') {
        row = { _id: 'c1', ...args.record };
        return wrap(row);
      }
      if (name === 'update_conversation') {
        row = { ...row, ...args.record };
        return wrap(row);
      }
      return wrap({});
    },
  };
}

const baseConfig = { agent: { key: 'support', sessionIdleSeconds: 1800 }, llm: {} };
const ctx = { channel: 'slack', channelUserId: 'U1' };

test('canPersist requires agentKey + channel + channelUserId', () => {
  assert.equal(canPersist(baseConfig, ctx), true);
  assert.equal(canPersist(baseConfig, { channel: 'http', channelUserId: null }), false);
  assert.equal(canPersist({ agent: {} }, ctx), false);
  assert.equal(
    canPersist({ agent: { key: 'support', persistConversations: false } }, ctx),
    false
  );
});

test('first turn snapshots, persists the prefix, and stores history', async () => {
  _resetSessionCaches();
  const mcp = convoStub(null);
  const session = await startSession({
    config: baseConfig,
    mcpClient: mcp,
    channelCtx: ctx,
    fetchMemory: memory({ body: 'Fact A.' }),
    passedHistory: [],
    log: quietLog,
  });
  assert.equal(session.isNewSession, true);
  assert.match(session.system, /Fact A\./);
  assert.deepEqual(session.history, []);

  await session.commit([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
  // A conversation row now exists carrying the frozen snapshot + history.
  assert.ok(mcp.row);
  assert.equal(mcp.row.systemSnapshot, session.system);
  assert.deepEqual(JSON.parse(mcp.row.history).length, 2);
});

test('a continuing turn reuses the frozen snapshot byte-for-byte', async () => {
  _resetSessionCaches();
  // Existing row from a recent turn (lastTurnAt = now) with a stored snapshot.
  const frozen = 'FROZEN PREFIX v1';
  const mcp = convoStub({
    _id: 'c1',
    agentKey: 'support',
    channel: 'slack',
    channelUserId: 'U1',
    history: JSON.stringify([{ role: 'user', content: 'earlier' }]),
    systemSnapshot: frozen,
    lastTurnAt: new Date().toISOString(),
  });
  // Memory now holds a DIFFERENT fact — but the in-flight prefix must not change.
  const session = await startSession({
    config: baseConfig,
    mcpClient: mcp,
    channelCtx: ctx,
    fetchMemory: memory({ body: 'Fact B (written mid-session).' }),
    passedHistory: [],
    log: quietLog,
  });
  assert.equal(session.isNewSession, false);
  assert.equal(session.system, frozen); // reused, not reassembled
  assert.doesNotMatch(session.system, /Fact B/);
  // Persisted history is loaded as the base, not the (empty) passed history.
  assert.equal(session.history.length, 1);
});

test('a fact taught in session 1 appears in session 2 (after an idle gap)', async () => {
  _resetSessionCaches();
  // Row from session 1: stale lastTurnAt (2 hours ago) and an old snapshot.
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const mcp = convoStub({
    _id: 'c1',
    agentKey: 'support',
    channel: 'slack',
    channelUserId: 'U1',
    history: JSON.stringify([{ role: 'user', content: 's1' }]),
    systemSnapshot: 'OLD PREFIX (no fact)',
    lastTurnAt: twoHoursAgo,
  });
  // Session 2: the idle gap exceeds sessionIdleSeconds, so the snapshot is
  // re-frozen and picks up the fact recorded during session 1.
  const session = await startSession({
    config: baseConfig,
    mcpClient: mcp,
    channelCtx: ctx,
    fetchMemory: memory({ body: 'Customer prefers email (taught in session 1).' }),
    passedHistory: [],
    log: quietLog,
  });
  assert.equal(session.isNewSession, true);
  assert.match(session.system, /taught in session 1/);
  // History from session 1 still carries over.
  assert.equal(session.history.length, 1);
});

test('service-mode (no channelUserId) freezes a snapshot in-process and never persists', async () => {
  _resetSessionCaches();
  const mcp = convoStub(null);
  const serviceCtx = { channel: 'http', channelUserId: null };
  const first = await startSession({
    config: baseConfig,
    mcpClient: mcp,
    channelCtx: serviceCtx,
    fetchPersona: persona({ identity: 'You are Ada.' }),
    fetchMemory: memory({ body: 'Tenant fact.' }),
    passedHistory: [{ role: 'user', content: 'seed' }],
    log: quietLog,
  });
  assert.equal(first.persisted, false);
  assert.match(first.system, /Tenant fact\./);
  // Channel-supplied history passes straight through.
  assert.deepEqual(first.history, [{ role: 'user', content: 'seed' }]);

  // Second turn within the idle window reuses the cached snapshot even if
  // memory changed — frozen for cache stability.
  const second = await startSession({
    config: baseConfig,
    mcpClient: mcp,
    channelCtx: serviceCtx,
    fetchMemory: memory({ body: 'Changed fact.' }),
    passedHistory: [],
    log: quietLog,
  });
  assert.equal(second.system, first.system);
  assert.doesNotMatch(second.system, /Changed fact/);
  // No conversation row was ever written.
  assert.equal(mcp.calls.filter((c) => c.name !== undefined && c.name.endsWith('_conversation') && c.name.startsWith('create')).length, 0);
  assert.equal(mcp.row, null);
});

test('a conversation load failure degrades to non-persistent rather than throwing', async () => {
  _resetSessionCaches();
  const mcp = {
    async callTool(name) {
      if (name === 'list_conversation') throw new Error('schema missing (older davepi)');
      return { content: [{ type: 'text', text: '{}' }] };
    },
  };
  const session = await startSession({
    config: baseConfig,
    mcpClient: mcp,
    channelCtx: ctx,
    fetchMemory: memory({ body: 'still works' }),
    passedHistory: [{ role: 'user', content: 'x' }],
    log: quietLog,
  });
  assert.equal(session.persisted, false);
  assert.match(session.system, /still works/);
  assert.deepEqual(session.history, [{ role: 'user', content: 'x' }]);
  await session.commit([]); // must be a safe no-op
});
