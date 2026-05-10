/**
 * Prometheus metrics. Opt-in via `METRICS_ENABLED=true`. When opt-in
 * is off, both the middleware and the `/_metrics` endpoint are no-ops
 * and `prom-client` carries zero per-request overhead.
 *
 * What's exposed (when enabled):
 *   - Default Node.js process metrics — RSS, heap, GC, event loop lag,
 *     active handles. From `prom-client`'s `collectDefaultMetrics()`.
 *   - `http_requests_total{method,route,status_code}` — counter,
 *     incremented on every response.
 *   - `http_request_duration_seconds{method,route,status_code}` —
 *     histogram with sensible default buckets for latencies under a
 *     few seconds.
 *
 * The `route` label is the matched Express path template
 * (e.g. `/api/v1/account/:id`), NOT the raw URL, so it's a bounded
 * label space and won't explode Prometheus cardinality on
 * id-bearing paths.
 *
 * Security posture: `/_metrics` returns the text exposition format
 * with no auth by default. The standard Prometheus pattern is to
 * scrape from an internal-network sidecar / load-balancer that
 * isolates the metrics endpoint from the public internet. If you
 * can't isolate it, set `METRICS_TOKEN=<random>` and the endpoint
 * will require `Authorization: Bearer <token>`.
 *
 * Why a separate file: the prom-client require is gated on the env
 * var so projects that don't enable metrics never load the library.
 */

'use strict';

const { NotFoundError, UnauthorizedError } = require('../utils/errors');

let promClient = null;
let registry = null;
let httpRequestsTotal = null;
let httpRequestDuration = null;
let initialized = false;

const isEnabled = () =>
  String(process.env.METRICS_ENABLED || '').toLowerCase() === 'true';

function initMetrics() {
  if (initialized || !isEnabled()) return;

  // Build everything into locals first, then commit module state in
  // one step. If any constructor throws (missing prom-client, name
  // collision against a stale registry, etc.) we reset and rethrow
  // so the caller returns a 500 instead of leaving `initialized: true`
  // with null metric objects — that combination would crash the next
  // request when the `res.on('finish')` handler tries to inc a null
  // counter, turning a one-off init error into a permanent outage.
  let _promClient;
  let _registry;
  let _httpRequestsTotal;
  let _httpRequestDuration;
  try {
    _promClient = require('prom-client');
    _registry = new _promClient.Registry();
    _promClient.collectDefaultMetrics({ register: _registry });

    _httpRequestsTotal = new _promClient.Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests, labelled by method, route, and status.',
      labelNames: ['method', 'route', 'status_code'],
      registers: [_registry],
    });

    _httpRequestDuration = new _promClient.Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency in seconds, labelled by method, route, and status.',
      labelNames: ['method', 'route', 'status_code'],
      // Default Prometheus buckets are tuned for sub-1s web requests.
      // Keep the bottom granular for fast endpoints (5ms, 10ms, 25ms),
      // extend the top to 5s for the slow tail (file uploads,
      // aggregations).
      buckets: [
        0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5,
      ],
      registers: [_registry],
    });
  } catch (err) {
    // Belt-and-braces — locals would be GC'd anyway, but reset the
    // module-level state so the next call to initMetrics() tries
    // again from a clean slate.
    promClient = null;
    registry = null;
    httpRequestsTotal = null;
    httpRequestDuration = null;
    initialized = false;
    throw err;
  }

  // Commit. After this point the metric objects are guaranteed
  // non-null whenever `initialized === true`.
  promClient = _promClient;
  registry = _registry;
  httpRequestsTotal = _httpRequestsTotal;
  httpRequestDuration = _httpRequestDuration;
  initialized = true;
}

/**
 * Per-request middleware that records counter + histogram on response
 * finish. Returns a no-op when metrics aren't enabled.
 */
function metricsMiddleware(req, res, next) {
  if (!isEnabled()) return next();
  try {
    if (!initialized) initMetrics();
  } catch (err) {
    return next(err);
  }

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    // Belt-and-braces — initMetrics guarantees these are non-null
    // when `initialized === true`, but a race between init and a
    // late-arriving finish event could in principle find them null.
    // Skip silently rather than crash the process.
    if (!httpRequestsTotal || !httpRequestDuration) return;
    // `req.route` is set by Express once a handler matches. For
    // unmatched paths (404s, static files) fall back to a constant
    // so we don't blow up cardinality with arbitrary URLs.
    const route = (req.route && req.route.path) || req.baseUrl || 'unmatched';
    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    const elapsedNs = process.hrtime.bigint() - start;
    httpRequestDuration.observe(labels, Number(elapsedNs) / 1e9);
  });
  next();
}

/**
 * Handler for `GET /_metrics`. Throws typed errors (NotFoundError,
 * UnauthorizedError) so responses flow through the centralised
 * `errorHandler` and match the framework-wide `{ error: { code,
 * message } }` envelope.
 *
 *   - 404 NOT_FOUND when metrics are disabled.
 *   - 401 UNAUTHORIZED when `METRICS_TOKEN` is set and the caller
 *     doesn't present a matching Bearer token.
 *
 * Otherwise responds with the Prometheus text exposition format.
 */
async function metricsHandler(req, res) {
  if (!isEnabled()) {
    throw new NotFoundError('Metrics endpoint');
  }
  if (!initialized) initMetrics();

  const expectedToken = process.env.METRICS_TOKEN;
  if (expectedToken) {
    // Case-insensitive Bearer parsing matches the convention in the
    // rest of the framework (`middleware/auth.js`, `/mcp` route in
    // app.js). Some scrapers and proxies normalise the scheme name to
    // lowercase or add extra whitespace; rejecting them would surface
    // as confusing 401s.
    const header = req.headers.authorization || '';
    const m = header.match(/^\s*bearer\s+(.+)$/i);
    const presented = m ? m[1].trim() : null;
    if (presented !== expectedToken) {
      throw new UnauthorizedError('Invalid or missing metrics token.');
    }
  }

  res.setHeader('Content-Type', registry.contentType);
  res.status(200).send(await registry.metrics());
}

/**
 * Test-only — reset registry state between test runs so counters
 * don't carry over. Not part of the public API.
 */
function _resetForTests() {
  initialized = false;
  registry = null;
  httpRequestsTotal = null;
  httpRequestDuration = null;
  promClient = null;
}

module.exports = {
  isEnabled,
  metricsMiddleware,
  metricsHandler,
  _resetForTests,
};
