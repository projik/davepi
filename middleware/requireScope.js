const { ForbiddenError } = require('../utils/errors');
const { hasScope } = require('../utils/scopes');

/**
 * Express middleware factory that gates a route on a coarse API-key
 * scope (`'read'` or `'write'`). Mount it AFTER `auth(true)` so
 * `req.user` is populated. JWT and client-id sessions carry no
 * `scopes` array and pass through unchanged (see utils/scopes.js); a
 * scope-limited API key that lacks the required scope is rejected with
 * a 403 via the centralised errorHandler.
 */
const requireScope = (scope) => (req, res, next) => {
  if (hasScope(req.user, scope)) return next();
  return next(new ForbiddenError(`API key missing required scope: ${scope}`));
};

module.exports = requireScope;
