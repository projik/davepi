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

// Test seam: drop cached snapshots so a unit test starts cold.
function _resetSessionCaches() {
  snapshotCache.clear();
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
  return {
    agentKey: (config && config.agent && config.agent.key) || null,
    channel: (channelCtx && channelCtx.channel) || null,
    channelUserId: (channelCtx && channelCtx.channelUserId) || null,
  };
}

// Persist only when we have a stable identity to key the row on. Service
// mode (no channelUserId) keeps the channel-managed round-trip instead.
function canPersist(config, channelCtx) {
  if (!persistenceEnabled(config)) return false;
  const { agentKey, channel, channelUserId } = sessionKeyParts(config, channelCtx);
  return Boolean(agentKey && channel && channelUserId);
}

async function loadConversationRecord({ mcpClient, channelCtx, parts }) {
  const raw = await mcpClient.callTool(
    'list_conversation',
    {
      filter: { agentKey: parts.agentKey, channel: parts.channel, channelUserId: parts.channelUserId },
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
    const key = `${parts.agentKey || '-'}::${parts.channel || '-'}::${parts.channelUserId || '-'}`;
    const ttl = sessionIdleMs(config);
    const now = Date.now();
    let system;
    const hit = snapshotCache.get(key);
    if (ttl > 0 && hit && now - hit.at < ttl) {
      system = hit.system;
    } else {
      system = await assemble();
      if (ttl > 0) snapshotCache.set(key, { system, at: now });
    }
    return {
      persisted: false,
      system,
      history: passedHistory,
      isNewSession: !hit,
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
};
