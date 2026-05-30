'use strict';

/**
 * Frozen-snapshot session + conversation persistence (ticket B).
 *
 * Exercises lib/conversation.js against an mcpClient stub so we can assert
 * the behavioural acceptance criteria without a live backend:
 *   - a fact taught in session 1 appears (via a re-frozen snapshot) in
 *     session 2;
 *   - the prefix is reused byte-for-byte within a session;
 *   - mid-session memory writes do NOT change the in-flight prefix;
 *   - conversations are scoped per conversationId (Slack thread), so two
 *     threads from one user do not share a transcript.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startSession, canPersist, _resetSessionCaches } = require('../lib/conversation');

const quietLog = { warn() {}, info() {}, error() {} };

const persona = (row) => async () => row;
const memory = (row) => async () => row;

// A minimal mcpClient stub backed by a Map of conversation rows keyed by
// conversationId, so list/create/update round-trip and distinct
// conversations stay distinct.
function convoStub(initial = null) {
  const rows = new Map(); // conversationId -> row
  let lastTouched = null;
  let idSeq = 0;
  const calls = [];
  const wrap = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
  if (initial) {
    rows.set(initial.conversationId, initial);
    lastTouched = initial;
  }
  return {
    get row() { return lastTouched; },
    rowFor(cid) { return rows.get(cid) || null; },
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'list_conversation') {
        const cid = args.filter && args.filter.conversationId;
        const row = rows.get(cid) || null;
        return wrap({ results: row ? [row] : [], totalResults: row ? 1 : 0 });
      }
      if (name === 'create_conversation') {
        const row = { _id: `c${++idSeq}`, ...args.record };
        rows.set(row.conversationId, row);
        lastTouched = row;
        return wrap(row);
      }
      if (name === 'update_conversation') {
        let target = null;
        for (const r of rows.values()) if (r._id === args.id) target = r;
        if (target) {
          Object.assign(target, args.record);
          lastTouched = target;
        }
        return wrap(target || {});
      }
      return wrap({});
    },
  };
}

const baseConfig = { agent: { key: 'support', sessionIdleSeconds: 1800 }, llm: {} };
const ctx = { channel: 'slack', channelUserId: 'U1', conversationId: 'C1::T1' };

test('canPersist requires agentKey + channel + a conversation scope', () => {
  assert.equal(canPersist(baseConfig, ctx), true);
  // No conversationId, but channelUserId is a valid fallback scope.
  assert.equal(canPersist(baseConfig, { channel: 'slack', channelUserId: 'U1' }), true);
  // Service mode: neither conversationId nor channelUserId → no persistence.
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
  // A conversation row now exists carrying the frozen snapshot + history,
  // keyed by the conversationId (not just the user).
  const row = mcp.rowFor('C1::T1');
  assert.ok(row);
  assert.equal(row.conversationId, 'C1::T1');
  assert.equal(row.channelUserId, 'U1');
  assert.equal(row.systemSnapshot, session.system);
  assert.deepEqual(JSON.parse(row.history).length, 2);
});

test('a continuing turn reuses the frozen snapshot byte-for-byte', async () => {
  _resetSessionCaches();
  const frozen = 'FROZEN PREFIX v1';
  const mcp = convoStub({
    _id: 'c1',
    agentKey: 'support',
    channel: 'slack',
    conversationId: 'C1::T1',
    channelUserId: 'U1',
    history: JSON.stringify([{ role: 'user', content: 'earlier' }]),
    systemSnapshot: frozen,
    lastTurnAt: new Date().toISOString(),
  });
  // Memory now holds a DIFFERENT fact — the in-flight prefix must not change.
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
  assert.equal(session.history.length, 1);
});

test('a fact taught in session 1 appears in session 2 (after an idle gap)', async () => {
  _resetSessionCaches();
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const mcp = convoStub({
    _id: 'c1',
    agentKey: 'support',
    channel: 'slack',
    conversationId: 'C1::T1',
    channelUserId: 'U1',
    history: JSON.stringify([{ role: 'user', content: 's1' }]),
    systemSnapshot: 'OLD PREFIX (no fact)',
    lastTurnAt: twoHoursAgo,
  });
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
  assert.equal(session.history.length, 1);
});

test('two Slack threads from the same user do not share a transcript', async () => {
  _resetSessionCaches();
  const mcp = convoStub(null);
  const u = 'U1';
  const thread1 = { channel: 'slack', channelUserId: u, conversationId: 'C::T1' };
  const thread2 = { channel: 'slack', channelUserId: u, conversationId: 'C::T2' };

  // Thread 1 records a (private) transcript.
  const s1 = await startSession({
    config: baseConfig, mcpClient: mcp, channelCtx: thread1, passedHistory: [], log: quietLog,
  });
  await s1.commit([{ role: 'user', content: 'secret in thread 1' }]);

  // Thread 2 is a separate conversation: brand-new, empty history — it
  // must NOT inherit thread 1's transcript.
  const s2 = await startSession({
    config: baseConfig, mcpClient: mcp, channelCtx: thread2, passedHistory: [], log: quietLog,
  });
  assert.equal(s2.isNewSession, true);
  assert.deepEqual(s2.history, []);
  // Each thread has its own row.
  assert.ok(mcp.rowFor('C::T1'));
  assert.equal(mcp.rowFor('C::T2'), null); // not created until s2 commits
});

test('service-mode (no channelUserId) freezes a snapshot in-process and never persists', async () => {
  _resetSessionCaches();
  const mcp = convoStub(null);
  const serviceCtx = { channel: 'http', channelUserId: null, conversationId: null };
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
  assert.deepEqual(first.history, [{ role: 'user', content: 'seed' }]);

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
  assert.equal(mcp.calls.length, 0); // nothing ever written or read
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
