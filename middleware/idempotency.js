const {
  hashBody,
  claimIdempotency,
  completeIdempotency,
  abandonIdempotency,
  conflictError,
  inProgressError,
  defaultTtlSeconds,
} = require('../utils/idempotency');

/**
 * Idempotency-Key middleware for write routes.
 *
 * Claim-execute-complete protocol so two concurrent retries can't
 * both miss the cache and create duplicate resource records:
 *
 *   1. Atomically insert an `in_progress` row keyed on
 *      (key, userId, route). The unique index makes this a hard
 *      mutual-exclusion primitive.
 *   2. If we won the claim, run the handler. On 2xx, promote the
 *      row to `completed` and store the response. On non-2xx (or a
 *      thrown error), DELETE the row so the agent can fix its
 *      payload and retry under the same key.
 *   3. If we lost the claim, the existing row tells us what to do:
 *        - same body, completed → replay the cached response
 *        - same body, in_progress → 409 IDEMPOTENCY_IN_PROGRESS
 *          (the in-flight call will populate the slot shortly)
 *        - different body → 409 IDEMPOTENCY_CONFLICT
 *
 * Without the header, the middleware is a no-op so existing clients
 * see no behaviour change.
 *
 * MUST be mounted AFTER `auth(true)` (so `req.user.user_id` is
 * available for tenant scoping) and AFTER `express.json()` (so
 * `req.body` is parsed for hashing).
 */
/**
 * `getBodyForHash(req)` is an optional callback that returns the
 * payload to hash for this request. The default uses `req.body`
 * verbatim, but routes that filter / stamp / transform the input
 * before persisting (e.g. ACL filtering, server-side tenant fields)
 * should pass a closure that produces the EFFECTIVE post-transform
 * shape. Otherwise two retries that the server treats as identical
 * (e.g. one with an ACL-stripped field, one without) would hash
 * differently and produce false `IDEMPOTENCY_CONFLICT` responses.
 */
function buildIdempotency({
  ttlSeconds = defaultTtlSeconds(),
  getBodyForHash = (req) => req.body,
} = {}) {
  return async function idempotencyMiddleware(req, res, next) {
    const key = req.headers['idempotency-key'];
    if (!key) return next();
    // Per-user keying — defensive guard. The auth middleware in
    // production already 403s missing tokens before this runs, but
    // tests sometimes mount routes without auth, and the contract
    // is that idempotency without identity is a no-op.
    const userId = req.user && req.user.user_id;
    if (!userId) return next();

    const route = `${req.method} ${req.baseUrl || ''}${req.path}`;
    const bodyHash = hashBody(getBodyForHash(req));

    const claim = await claimIdempotency({ key, userId, route, bodyHash, ttlSeconds });

    if (claim.status === 'conflict') return next(conflictError());
    if (claim.status === 'in_progress') return next(inProgressError());

    if (claim.status === 'hit') {
      const { record } = claim;
      res.set('Idempotency-Replay', 'true');
      if (record.headers && typeof record.headers === 'object') {
        for (const [h, v] of Object.entries(record.headers)) {
          if (v != null) res.set(h, String(v));
        }
      }
      return res.status(record.status).json(record.body);
    }

    // claim.status === 'claimed' — we hold the slot. Wire up
    // teardown so the row reflects the outcome regardless of
    // success path. We shim res.json (the only writer auto-generated
    // handlers use); abandon also fires from `finish` if the
    // response went out via something other than json (e.g. send,
    // end, errorHandler bail-out path).
    let outcomeRecorded = false;
    const finalize = async (statusCode, body) => {
      if (outcomeRecorded) return;
      outcomeRecorded = true;
      const log = req.log;
      if (statusCode >= 200 && statusCode < 300) {
        const persistedHeaders = {};
        const ct = res.get('Content-Type');
        if (ct) persistedHeaders['Content-Type'] = ct;
        await completeIdempotency({
          key,
          userId,
          route,
          status: statusCode,
          body,
          headers: persistedHeaders,
          log,
        });
      } else {
        await abandonIdempotency({ key, userId, route, log });
      }
    };

    const originalJson = res.json.bind(res);
    res.json = function (body) {
      // Capture status + body BEFORE calling originalJson so the
      // values reflect what the client receives. finalize fires
      // best-effort and asynchronously — we don't block the
      // response on the persistence write.
      finalize(res.statusCode, body).catch(() => {});
      return originalJson(body);
    };

    // Belt-and-suspenders: if a code path responded without going
    // through res.json (or threw before getting there), `finish`
    // still fires and we abandon the claim so the slot doesn't
    // stay locked until TTL.
    res.on('finish', () => {
      if (!outcomeRecorded) {
        const code = res.statusCode || 500;
        if (code < 200 || code >= 300) {
          abandonIdempotency({ key, userId, route, log: req.log }).catch(() => {});
          outcomeRecorded = true;
        }
      }
    });

    next();
  };
}

module.exports = { buildIdempotency };
