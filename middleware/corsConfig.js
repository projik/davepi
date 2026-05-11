const cors = require('cors');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');

class CorsNotAllowedError extends AppError {
  constructor(origin) {
    super(`Origin ${origin} not allowed by CORS`, 403, 'CORS_NOT_ALLOWED');
  }
}

const parseOrigins = (raw) => {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

// True when the request's Origin matches its Host — i.e. the request
// is hitting the same server that emitted the page making it. The
// admin SPA is served by this server, so its asset loads and fetches
// back to /api/v1/* are same-origin and must be allowed regardless
// of CORS_ORIGINS. A cross-site attacker can't spoof this: the
// browser sets Host based on the target URL, not the attacker's page.
const isSameOrigin = (req) => {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  const originHost = origin.replace(/^https?:\/\//, '');
  return originHost === host;
};

const buildCorsMiddleware = (raw = process.env.CORS_ORIGINS) => {
  const allowedOrigins = parseOrigins(raw);
  const allowAll = allowedOrigins.includes('*');

  if (!allowedOrigins.length) {
    logger.warn(
      'CORS_ORIGINS is unset; defaulting to http://localhost:3000. Set CORS_ORIGINS to a comma-separated allowlist for production.'
    );
    allowedOrigins.push('http://localhost:3000');
  }

  const allowlistCors = cors({
    origin: (origin, cb) => {
      // Same-origin requests, server-to-server, and tools like curl have
      // no Origin header — let those through unconditionally.
      if (!origin) return cb(null, true);
      if (allowAll || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new CorsNotAllowedError(origin));
    },
    credentials: true,
  });

  // Reflect-Origin variant used for same-origin requests so the
  // browser's `crossorigin` checks on `<script>` / `<link>` succeed
  // without needing the API's own origin in CORS_ORIGINS.
  const sameOriginCors = cors({ origin: true, credentials: true });

  return (req, res, next) => {
    if (isSameOrigin(req)) return sameOriginCors(req, res, next);
    return allowlistCors(req, res, next);
  };
};

module.exports = { buildCorsMiddleware, parseOrigins, CorsNotAllowedError, isSameOrigin };
