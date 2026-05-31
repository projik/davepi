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

// Compare `<host>` strings with default-port tolerance: 'example.com'
// matches 'example.com:80' when scheme is http and 'example.com:443' when
// scheme is https. Browsers usually omit default ports in the Host
// header, but some clients / proxies don't, so the comparison has to
// handle both.
const stripDefaultPort = (host, scheme) => {
  if (!host) return host;
  const defaultPort = scheme === 'https' ? ':443' : ':80';
  return host.endsWith(defaultPort) ? host.slice(0, -defaultPort.length) : host;
};

// Returns the effective request host — `X-Forwarded-Host` when the app
// runs behind a trusted proxy, otherwise the `Host` header. Comma-split
// + first-token: some proxies chain values when there are multiple
// forwarders, and the originator (left-most) is the one to match.
const effectiveRequestHost = (req) => {
  const trustsProxy = req.app && req.app.get('trust proxy');
  if (trustsProxy) {
    const fwd = req.headers['x-forwarded-host'];
    if (fwd) return String(fwd).split(',')[0].trim().toLowerCase();
  }
  return String(req.headers.host || '').trim().toLowerCase();
};

// True when the request's Origin matches its effective Host — i.e. the
// request is hitting the same server that emitted the page making it.
// The admin SPA is served by this server, so its asset loads and
// fetches back to /api/v1/* are same-origin and must be allowed
// regardless of CORS_ORIGINS.
//
// Comparison is robust to:
//   - Hostname case (hosts are case-insensitive per RFC 3986).
//   - Default ports — 'example.com' vs 'example.com:80' / ':443'.
//   - Reverse-proxy deployments via `TRUST_PROXY=true`: we honour
//     `X-Forwarded-Host` so requests proxied through Caddy / nginx
//     resolve to the externally-visible hostname the browser used.
//
// A cross-site attacker can't spoof this: the browser sets `Host`
// based on the target URL it's fetching, not the attacker page's
// origin, so a malicious page at evil.example.com fetching
// api.example.com will have `Origin: evil.example.com` and
// `Host: api.example.com` — the mismatch keeps it on the allowlist
// path.
const isSameOrigin = (req) => {
  const origin = req.headers.origin;
  if (!origin) return false;

  let originHost;
  let originScheme;
  try {
    const url = new URL(origin);
    originHost = url.host.toLowerCase();
    originScheme = url.protocol.replace(':', '');
  } catch {
    return false;
  }

  const requestHost = effectiveRequestHost(req);
  if (!originHost || !requestHost) return false;

  return (
    stripDefaultPort(originHost, originScheme) ===
    stripDefaultPort(requestHost, originScheme)
  );
};

// Apollo Server v5's embedded Sandbox (served whenever introspection is
// on, i.e. outside production) loads from
// https://studio.apollographql.com and then issues XHRs back to the
// local /graphql endpoint. Without this origin on the allowlist the
// Sandbox shows "Unable to reach server". Scoped to non-production
// because production never serves the Sandbox in the first place
// (introspection is gated off there).
const APOLLO_STUDIO_ORIGIN = 'https://studio.apollographql.com';

const buildCorsMiddleware = (raw = process.env.CORS_ORIGINS) => {
  const allowedOrigins = parseOrigins(raw);
  const allowAll = allowedOrigins.includes('*');

  if (!allowedOrigins.length) {
    logger.warn(
      'CORS_ORIGINS is unset; defaulting to http://localhost:3000. Set CORS_ORIGINS to a comma-separated allowlist for production.'
    );
    allowedOrigins.push('http://localhost:3000');
  }

  if (
    process.env.NODE_ENV !== 'production' &&
    !allowAll &&
    !allowedOrigins.includes(APOLLO_STUDIO_ORIGIN)
  ) {
    allowedOrigins.push(APOLLO_STUDIO_ORIGIN);
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

module.exports = {
  buildCorsMiddleware,
  parseOrigins,
  CorsNotAllowedError,
  isSameOrigin,
  effectiveRequestHost,
};
