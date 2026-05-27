const jwt = require('jsonwebtoken');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');

/**
 * JWT verification middleware.
 *
 * Errors propagate via `next(err)` so the centralised errorHandler is
 * the only thing that writes auth-failure responses — agents and
 * humans both get the canonical `{ error: { code, message } }` shape
 * instead of plain-text 401/403s. The status codes (403 missing /
 * 401 invalid) are preserved from the legacy implementation; existing
 * clients see the same HTTP code, only the body shape changes.
 */
const verifyToken = (bool) => (req, res, next) => {
  if (!bool) return next();
  const token =
    req.headers.authorization &&
    req.headers.authorization.replace(/bearer /i, '');
  if (!token) {
    return next(new ForbiddenError('A token is required for authentication'));
  }
  try {
    req.user = jwt.verify(token, process.env.TOKEN_KEY, { algorithms: ['HS256'] });
  } catch (err) {
    return next(new UnauthorizedError('Invalid Token'));
  }
  return next();
};

module.exports = verifyToken;
