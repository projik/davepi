const cors = require('cors');
const logger = require('../utils/logger');

const parseOrigins = (raw) => {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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

  return cors({
    origin: (origin, cb) => {
      // Same-origin requests, server-to-server, and tools like curl have
      // no Origin header — let those through unconditionally.
      if (!origin) return cb(null, true);
      if (allowAll || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
  });
};

module.exports = { buildCorsMiddleware, parseOrigins };
