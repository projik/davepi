const jwt = require('jsonwebtoken');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');
const { API_KEY_PREFIX, resolveApiKeyUser } = require('../utils/tokens');

/**
 * Bearer authentication middleware. Verifies a JWT by default; if the
 * bearer value is a `dpk_`-prefixed API key, it takes the API-key path
 * instead — hashing the key, looking it up, and populating `req.user`
 * with the same shape a JWT produces (plus `scopes` and
 * `authMethod: 'apiKey'`) so every downstream tenant-scoping, ACL, and
 * scopeResolver path keeps working unchanged. See
 * utils/tokens.js#resolveApiKeyUser.
 *
 * Errors propagate via `next(err)` so the centralised errorHandler is
 * the only thing that writes auth-failure responses — agents and
 * humans both get the canonical `{ error: { code, message } }` shape
 * instead of plain-text 401/403s. The status codes (403 missing /
 * 401 invalid) are preserved from the legacy implementation; existing
 * clients see the same HTTP code, only the body shape changes. An
 * API-key miss throws UnauthorizedError — the SAME class JWT failures
 * use — so it's shaped identically.
 */
const verifyToken = (bool) => (req, res, next) => {
  if (!bool) return next();
  // An upstream middleware (e.g. clientAuth resolving X-Client-Id)
  // may have already populated req.user with a synthetic identity.
  // When it has, skip the Bearer check — the rest of the stack only
  // cares that req.user.user_id is present.
  if (req.user && req.user.user_id) return next();
  const token =
    req.headers.authorization &&
    req.headers.authorization.replace(/bearer /i, '');
  if (!token) {
    return next(new ForbiddenError('A token is required for authentication'));
  }
  // API-key path: a `dpk_`-prefixed bearer is a long-lived
  // programmatic key, not a JWT. Hash → look up → stamp req.user.
  if (token.startsWith(API_KEY_PREFIX)) {
    return resolveApiKeyUser(token)
      .then((user) => {
        if (!user) return next(new UnauthorizedError('Invalid API key'));
        req.user = user;
        return next();
      })
      .catch(next);
  }
  try {
    req.user = jwt.verify(token, process.env.TOKEN_KEY, { algorithms: ['HS256'] });
  } catch (err) {
    return next(new UnauthorizedError('Invalid Token'));
  }
  return next();
};

module.exports = verifyToken;
