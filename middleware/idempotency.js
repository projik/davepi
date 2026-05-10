const {
  hashBody,
  checkIdempotency,
  recordIdempotency,
  conflictError,
  defaultTtlSeconds,
} = require('../utils/idempotency');

/**
 * Idempotency-Key middleware for write routes.
 *
 * On a request that carries an `Idempotency-Key` header:
 *   - Cache hit (same key + same body hash): replay the stored
 *     response (status, body, selected headers) and stamp
 *     `Idempotency-Replay: true` so callers can tell the difference.
 *   - Cache hit with mismatched body: 409 IDEMPOTENCY_CONFLICT.
 *   - Cache miss: install a `res.json` shim that captures the eventual
 *     2xx response and persists it for the configured TTL. Non-2xx
 *     responses are NOT cached — agents are meant to fix their input
 *     and retry, which would be defeated by caching a failure.
 *
 * Without the header, the middleware is a no-op so existing clients
 * that don't set it see no behaviour change.
 *
 * MUST be mounted AFTER `auth(true)` (so `req.user.user_id` is
 * available for tenant scoping) and AFTER `express.json()` (so
 * `req.body` is parsed for hashing).
 */
function buildIdempotency({ ttlSeconds = defaultTtlSeconds() } = {}) {
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
    const bodyHash = hashBody(req.body);

    let lookup;
    try {
      lookup = await checkIdempotency({ key, userId, route, bodyHash });
    } catch (err) {
      return next(err);
    }

    if (lookup.status === 'conflict') {
      return next(conflictError());
    }

    if (lookup.status === 'hit') {
      const { record } = lookup;
      res.set('Idempotency-Replay', 'true');
      if (record.headers && typeof record.headers === 'object') {
        for (const [h, v] of Object.entries(record.headers)) {
          if (v != null) res.set(h, String(v));
        }
      }
      return res.status(record.status).json(record.body);
    }

    // Cache miss: capture the upcoming response. We shim res.json
    // (the only writer the auto-generated handlers use) so the
    // capture stays tiny and predictable. If a future custom route
    // calls res.send instead, the absence of caching is a quiet
    // no-op rather than a wrong cache.
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      // Only persist 2xx — see contract above.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const persistedHeaders = {};
        const ct = res.get('Content-Type');
        if (ct) persistedHeaders['Content-Type'] = ct;
        // recordIdempotency is best-effort: a write failure to the
        // idempotency_keys collection must not break the actual
        // response, so we don't await it inline. Errors land in
        // the request log.
        recordIdempotency({
          key,
          userId,
          route,
          bodyHash,
          status: res.statusCode,
          body,
          headers: persistedHeaders,
          ttlSeconds,
        }).catch((err) => {
          (req.log && req.log.warn ? req.log.warn.bind(req.log) : () => {})(
            { err },
            'idempotency: failed to persist response'
          );
        });
      }
      return originalJson(body);
    };

    next();
  };
}

module.exports = { buildIdempotency };
