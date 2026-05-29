'use strict';

/**
 * Local asyncHandler — mirrors the framework's utils/asyncHandler.js
 * but lives in this package so the agent can be deployed alongside a
 * davepi instance without reaching across the package boundary.
 * Forwards rejected promises to Express's error middleware so the
 * canonical { error: { code, message } } shape comes from one place.
 */

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = asyncHandler;
