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
  initialized = true;

  // Require lazily so the dep cost is only paid when metrics are on.
  promClient = require('prom-client');
  registry = new promClient.Registry();
  promClient.collectDefaultMetrics({ register: registry });

  httpRequestsTotal = new promClient.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests, labelled by method, route, and status.',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });

  httpRequestDuration = new promClient.Histogram({
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
    registers: [registry],
  });
}

/**
 * Per-request middleware that records counter + histogram on response
 * finish. Returns a no-op when metrics aren't enabled.
 */
function metricsMiddleware(req, res, next) {
  if (!isEnabled()) return next();
  if (!initialized) initMetrics();

  const start = process.hrtime.bigint();
  res.on('finish', () => {
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
    const header = req.headers.authorization || '';
    const presented = header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : null;
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
