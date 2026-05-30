'use strict';

const logger = require('./logger');
const { normalizeMcpResult } = require('./mcpResult');
const { assembleSystemPrompt } = require('./promptAssembly');

/**
 * Conversation persistence + frozen-snapshot session management.
 *
 * Two jobs (docs/agent-learning-layer.md §5):
 *
 *   1. **Durable history.** Load/save the transcript to davepi's
 *      `conversation` schema (keyed by tenant + agentKey + channel +
 *      channelUserId) through the agent's own MCP identity, so history
 *      survives across requests and restarts. Auth state stays in
 *      `store.js`; history is tenant data and lives in davepi.
 *
 *   2. **Frozen snapshot.** The assembled prompt prefix (persona +
 *      contract + memory + profile) is captured **once** at session
 *      start, persisted on the conversation row (`systemSnapshot`), and
 *      reused byte-for-byte every turn — that's what keeps Anthropic
 *      prompt caching hitting. A new session (an idle gap past
 *      `sessionIdleSeconds`) re-snapshots, picking up memory/profile
 *      writes from the prior session; mid-session writes never mutate the
 *      live prefix.
 *
 * When there's no stable per-user key to persist against — service-mode
 * HTTP has no `channelUserId` — we fall back to an in-process snapshot
 * cache keyed by the session, so the prefix is still frozen for cache
 * stability while the channel keeps round-tripping history itself.
 */

const DEFAULT_SESSION_IDLE_SECONDS = 30 * 60;

// In-process snapshot cache for the non-persistent (service-mode) path:
// sessionKey -> { system, at }. Frozen for `sessionIdleSeconds` so the
// prefix stays byte-stable within a session even without a DB row.
const snapshotCache = new Map();

// Test seams: drop cached snapshots so a unit test starts cold, and peek
// at the cache size to assert eviction.
function _resetSessionCaches() {
  snapshotCache.clear();
}
function _snapshotCacheSize() {
  return snapshotCache.size;
}

// Drop every entry past TTL. Run opportunistically when a new snapshot is
// assembled (i.e. on the new-session rate, not every turn), so a
// long-lived process with churning session keys can't grow the Map
// without bound — without it, keys that are never revisited live forever.
function sweepSnapshotCache(ttl, now) {
  if (ttl <= 0) return;
  for (const [k, v] of snapshotCache) {
    if (now - v.at >= ttl) snapshotCache.delete(k);
  }
}

function sessionIdleMs(config) {
  const s = config && config.agent && config.agent.sessionIdleSeconds;
  const seconds = Number.isFinite(s) ? s : DEFAULT_SESSION_IDLE_SECONDS;
  return Math.max(0, seconds) * 1000;
}

function persistenceEnabled(config) {
  return !(config && config.agent && config.agent.persistConversations === false);
}

function sessionKeyParts(config, channelCtx) {
  // A conversation is finer-grained than an end-user: Slack scopes by
  // thread (`channel::thread_ts`), so two threads from the same user are
  // distinct transcripts and must NOT share a row (cross-thread / DM →
  // public-channel context leakage). Channels supply `conversationId`
  // for that scope; we fall back to `channelUserId` for channels with no
  // sub-user concept (e.g. one ongoing HTTP conversation per logged-in
  // user). `channelUserId` is still recorded for the per-user profile
  // lookup and audit, but it is NOT the persistence key.
  const channelUserId = (channelCtx && channelCtx.channelUserId) || null;
  return {
    agentKey: (config && config.agent && config.agent.key) || null,
    channel: (channelCtx && channelCtx.channel) || null,
    channelUserId,
    conversationId: (channelCtx && channelCtx.conversationId) || channelUserId,
  };
}

// Persist only when we have a stable conversation scope to key the row
// on. Service mode (no channelUserId / conversationId) keeps the
// channel-managed round-trip instead.
function canPersist(config, channelCtx) {
  if (!persistenceEnabled(config)) return false;
  const { agentKey, channel, conversationId } = sessionKeyParts(config, channelCtx);
  return Boolean(agentKey && channel && conversationId);
}

async function loadConversationRecord({ mcpClient, channelCtx, parts }) {
  const raw = await mcpClient.callTool(
    'list_conversation',
    {
      filter: { agentKey: parts.agentKey, channel: parts.channel, conversationId: parts.conversationId },
      perPage: 1,
    },
    channelCtx
  );
  const norm = normalizeMcpResult(raw);
  if (!norm || norm.error) return null;
  const rows = norm.results || norm.records || [];
  return Array.isArray(rows) ? rows[0] || null : null;
}

function parseHistory(rec) {
  if (!rec || typeof rec.history !== 'string' || !rec.history) return [];
  try {
    const parsed = JSON.parse(rec.history);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Start (or resume) a session.
 *
 * Returns `{ persisted, system, history, isNewSession, commit }`:
 *   - `system`   — the frozen prompt prefix to send this turn.
 *   - `history`  — the base transcript (persisted history wins when
 *                  present; otherwise the channel-supplied `passedHistory`
 *                  seeds it, so stateless clients still work).
 *   - `commit(newHistory)` — persist the updated transcript (a no-op in
 *                  the non-persistent path).
 */
async function startSession({
  config,
  mcpClient,
  channelCtx,
  fetchPersona,
  fetchMemory,
  fetchProfile,
  passedHistory = [],
  log = logger,
}) {
  const assemble = () =>
    assembleSystemPrompt({ config, fetchPersona, fetchMemory, fetchProfile, log });

  if (!canPersist(config, channelCtx)) {
    const parts = sessionKeyParts(config, channelCtx);
    const key = `${parts.agentKey || '-'}::${parts.channel || '-'}::${parts.conversationId || '-'}`;
    const ttl = sessionIdleMs(config);
    const now = Date.now();
    const hit = snapshotCache.get(key);
    // Reused only when there's a *live* (non-expired) entry. An expired
    // hit is a new session: we reassemble below, so isNewSession must be
    // true (the earlier `!hit` reported a stale entry as a continuation).
    const reused = ttl > 0 && hit && now - hit.at < ttl;
    let system;
    if (reused) {
      system = hit.system;
    } else {
      system = await assemble();
      if (ttl > 0) {
        sweepSnapshotCache(ttl, now); // bound growth: drop other expired keys
        snapshotCache.set(key, { system, at: now }); // overwrites an expired entry
      } else {
        snapshotCache.delete(key); // ttl 0: never cache
      }
    }
    return {
      persisted: false,
      system,
      history: passedHistory,
      isNewSession: !reused,
      async commit() {},
    };
  }

  const parts = sessionKeyParts(config, channelCtx);
  let rec = null;
  try {
    rec = await loadConversationRecord({ mcpClient, channelCtx, parts });
  } catch (err) {
    // Backend without the conversation schema (older davepi) or a
    // transient MCP failure: degrade to the non-persistent behaviour
    // rather than failing the turn.
    log.warn({ err: err && err.message }, 'conversation load failed; continuing without persistence');
    const system = await assemble();
    return { persisted: false, system, history: passedHistory, isNewSession: true, async commit() {} };
  }

  const now = Date.now();
  const idleMs = sessionIdleMs(config);
  const lastTurn = rec && rec.lastTurnAt ? new Date(rec.lastTurnAt).getTime() : 0;
  const isNewSession =
    !rec || !rec.systemSnapshot || idleMs === 0 || now - lastTurn > idleMs;

  const system = isNewSession ? await assemble() : rec.systemSnapshot;

  const storedHistory = parseHistory(rec);
  const history = storedHistory.length ? storedHistory : passedHistory || [];

  return {
    persisted: true,
    system,
    history,
    isNewSession,
    async commit(newHistory) {
      const fields = {
        history: JSON.stringify(newHistory || []),
        lastTurnAt: new Date().toISOString(),
      };
      // Freeze the snapshot onto the row only when this turn started a
      // new session — never on a continuing turn, so mid-session memory
      // writes can't alter the in-flight prefix.
      if (isNewSession) {
        fields.systemSnapshot = system;
        fields.snapshotAt = new Date().toISOString();
      }
      try {
        if (rec && rec._id) {
          await mcpClient.callTool('update_conversation', { id: rec._id, record: fields }, channelCtx);
        } else {
          await mcpClient.callTool(
            'create_conversation',
            {
              record: {
                agentKey: parts.agentKey,
                channel: parts.channel,
                conversationId: parts.conversationId,
                channelUserId: parts.channelUserId,
                ...fields,
              },
            },
            channelCtx
          );
        }
      } catch (err) {
        log.warn({ err: err && err.message }, 'conversation persist failed; history not saved this turn');
      }
    },
  };
}

module.exports = {
  startSession,
  canPersist,
  parseHistory,
  sessionIdleMs,
  _resetSessionCaches,
  _snapshotCacheSize,
};
