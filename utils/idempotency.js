const crypto = require('crypto');
const IdempotencyKey = require('../model/idempotencyKey');
const { ConflictError } = require('./errors');

/**
 * Default TTL for idempotency records. 24h matches Stripe's window
 * — long enough that a client that crashes and resumes a workflow
 * the next morning can still replay safely, short enough that the
 * collection doesn't grow unbounded. Override via
 * `IDEMPOTENCY_TTL_SECONDS`.
 */
const defaultTtlSeconds = () =>
  Math.max(1, parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || '86400', 10));

/**
 * Stable hash of a request payload. We canonicalise via JSON
 * stringify rather than just `crypto.createHash().update(buffer)`
 * because two requests with the same logical content but different
 * key ordering should match — agents emit objects, not byte
 * streams.
 */
function hashBody(body) {
  const canonical = body == null ? '' : JSON.stringify(body);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Look up an existing idempotency record for the (key, user, route)
 * tuple. Returns one of:
 *
 *   { status: 'miss' }                — no record; caller should run
 *                                       and then `recordIdempotency`
 *   { status: 'hit', record }         — replay the stored response
 *   { status: 'conflict', existing }  — the key was used before with
 *                                       a different body; throw
 *                                       ConflictError on the caller
 */
async function checkIdempotency({ key, userId, route, bodyHash }) {
  if (!key || !userId || !route) return { status: 'miss' };
  const existing = await IdempotencyKey.findOne({ key, userId, route }).lean();
  if (!existing) return { status: 'miss' };
  if (existing.bodyHash !== bodyHash) {
    return { status: 'conflict', existing };
  }
  return { status: 'hit', record: existing };
}

/**
 * Persist an idempotency record. Caller is responsible for only
 * recording successful (2xx) responses — non-2xx is the agent's cue
 * to fix its request and retry, which would be defeated by caching
 * the failure.
 *
 * Race-safe: if two concurrent requests with the same key both
 * pass `checkIdempotency` and reach `recordIdempotency`, the unique
 * index guarantees one wins and the other gets a duplicate-key
 * error — which we swallow because the cached value is by definition
 * the same body hash.
 */
async function recordIdempotency({
  key,
  userId,
  route,
  bodyHash,
  status,
  body,
  headers,
  ttlSeconds = defaultTtlSeconds(),
}) {
  if (!key || !userId || !route) return;
  try {
    await IdempotencyKey.create({
      key,
      userId,
      route,
      bodyHash,
      status,
      body,
      headers: headers || null,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    });
  } catch (err) {
    if (err && err.code === 11000) return; // race: another request won
    throw err;
  }
}

/**
 * Convert a `conflict` lookup result into the canonical
 * `ConflictError` so callers don't repeat the message everywhere.
 */
function conflictError() {
  return new ConflictError(
    'Idempotency-Key was reused with a different request body'
  );
}

module.exports = {
  hashBody,
  checkIdempotency,
  recordIdempotency,
  conflictError,
  defaultTtlSeconds,
};
