const crypto = require('crypto');
const IdempotencyKey = require('../model/idempotencyKey');
const {
  IdempotencyConflictError,
  IdempotencyInProgressError,
} = require('./errors');

/**
 * Default TTL for idempotency records. 24h matches Stripe's window
 * — long enough that a client that crashes and resumes a workflow
 * the next morning can still replay safely, short enough that the
 * collection doesn't grow unbounded. Override via
 * `IDEMPOTENCY_TTL_SECONDS`.
 *
 * Guarded against non-numeric env values (`Number.isFinite` rejects
 * `NaN` and `Infinity`) so a typo doesn't poison `expiresAt` and
 * silently break persistence.
 */
const defaultTtlSeconds = () => {
  const raw = Number(process.env.IDEMPOTENCY_TTL_SECONDS);
  const ttl = Number.isFinite(raw) ? raw : 86400;
  return Math.max(1, Math.floor(ttl));
};

/**
 * Recursive stable stringify: sorts object keys at every level so
 * `{a:1,b:2}` and `{b:2,a:1}` serialise identically. Plain
 * `JSON.stringify` preserves insertion order, which would make
 * `hashBody` falsely report two semantically identical payloads as
 * different — exactly the wrong behaviour for an idempotency key.
 *
 * Arrays preserve their order (a[0] vs a[1] is meaningful — these
 * aren't sets) and primitives go through unchanged.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') +
    '}'
  );
}

/**
 * Stable hash of a request payload. Canonicalises via the recursive
 * stringify above so two requests with the same logical content but
 * different key ordering produce the same hash.
 */
function hashBody(body) {
  const canonical = body == null ? '' : stableStringify(body);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Atomically claim an idempotency slot. Three outcomes:
 *
 *   { status: 'claimed' }       — caller may run the handler. The
 *                                 row is now `in_progress` and a
 *                                 concurrent request with the same
 *                                 key+body will see `in_progress`.
 *   { status: 'hit', record }   — slot already held a completed
 *                                 response with the same body hash;
 *                                 caller should replay it.
 *   { status: 'in_progress' }   — slot is held by another request
 *                                 still running with the same body
 *                                 hash; caller should throw
 *                                 IDEMPOTENCY_IN_PROGRESS.
 *   { status: 'conflict' }      — slot is held with a different
 *                                 body hash; caller should throw
 *                                 IDEMPOTENCY_CONFLICT.
 *
 * The atomic step is the unique-indexed insert: if two requests race
 * the same (key, userId, route), exactly one insert succeeds and the
 * other gets a duplicate-key error. The loser then reads the winner's
 * row to decide between hit / in_progress / conflict.
 */
async function claimIdempotency({
  key,
  userId,
  route,
  bodyHash,
  ttlSeconds = defaultTtlSeconds(),
}) {
  if (!key || !userId || !route) return { status: 'claimed' };
  try {
    await IdempotencyKey.create({
      key,
      userId,
      route,
      bodyHash,
      state: 'in_progress',
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    });
    return { status: 'claimed' };
  } catch (err) {
    if (!err || err.code !== 11000) throw err;
    // Re-read with an explicit `expiresAt` floor: Mongo's TTL
    // monitor sweeps on a ~60s cycle, so without this filter we'd
    // see a row whose TTL passed but whose deletion hasn't fired
    // yet — and would treat it as a hit / conflict against an
    // expired ghost.
    const now = new Date();
    const existing = await IdempotencyKey.findOne({
      key,
      userId,
      route,
      expiresAt: { $gt: now },
    }).lean();
    if (!existing) {
      // Either the row never existed (race window between our
      // failed insert and the re-read) or it's expired and the
      // TTL hasn't swept it yet. Opportunistically delete any
      // stale row so the agent's next retry can claim cleanly.
      await IdempotencyKey.deleteOne({
        key,
        userId,
        route,
        expiresAt: { $lte: now },
      }).catch(() => {});
      // Try the claim once more now that the slot is clear. If
      // this still loses (legit concurrent winner), bail and let
      // the caller try again on the next request.
      try {
        await IdempotencyKey.create({
          key,
          userId,
          route,
          bodyHash,
          state: 'in_progress',
          expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        });
        return { status: 'claimed' };
      } catch (retryErr) {
        if (!retryErr || retryErr.code !== 11000) throw retryErr;
        return { status: 'in_progress' };
      }
    }
    if (existing.bodyHash !== bodyHash) return { status: 'conflict' };
    if (existing.state === 'in_progress') return { status: 'in_progress' };
    return { status: 'hit', record: existing };
  }
}

/**
 * Promote a claimed slot to a completed response. Called by the
 * caller AFTER the handler finishes with a 2xx.
 *
 * Best-effort: a write failure here doesn't break the user-facing
 * response — the worst outcome is the slot stays `in_progress`, the
 * TTL eventually sweeps it, and the agent's next retry (after TTL)
 * starts fresh. We log via the supplied `log` if provided.
 */
async function completeIdempotency({ key, userId, route, status, body, headers, log }) {
  if (!key || !userId || !route) return;
  try {
    await IdempotencyKey.updateOne(
      { key, userId, route, state: 'in_progress' },
      { $set: { state: 'completed', status, body, headers: headers || null } }
    );
  } catch (err) {
    if (log && log.warn) log.warn({ err }, 'idempotency: completeIdempotency failed');
  }
}

/**
 * Tear down a claim that won't complete (handler failed, returned a
 * non-2xx, or threw). Removes the in-progress row so the agent can
 * fix its payload and retry under the same key. Without this, a
 * 400 would lock the (key, body) tuple until TTL.
 */
async function abandonIdempotency({ key, userId, route, log }) {
  if (!key || !userId || !route) return;
  try {
    await IdempotencyKey.deleteOne({ key, userId, route, state: 'in_progress' });
  } catch (err) {
    if (log && log.warn) log.warn({ err }, 'idempotency: abandonIdempotency failed');
  }
}

const conflictError = () => new IdempotencyConflictError();
const inProgressError = () => new IdempotencyInProgressError();

module.exports = {
  hashBody,
  claimIdempotency,
  completeIdempotency,
  abandonIdempotency,
  conflictError,
  inProgressError,
  defaultTtlSeconds,
};
