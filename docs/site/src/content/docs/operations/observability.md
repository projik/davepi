---
title: Observability
description: Wire dAvePi into OpenTelemetry, Sentry, Datadog APM, or Prometheus — copy-paste recipes for each, plus the built-in /_metrics endpoint.
---

dAvePi runs on stock Node + Express + Mongoose + Apollo. That means
every mainstream observability tool that auto-instruments those
libraries works against dAvePi out of the box — typically with
zero framework changes.

The framework's own contributions to your observability stack:

- A built-in [`/_metrics` endpoint](#prometheus) (Prometheus text
  format) gated on `METRICS_ENABLED=true`.
- A request-scoped `reqId` (UUID) on every request, set on the
  `x-request-id` response header and included in every structured
  log line for correlation.
- Pino JSON logs to stdout with redaction for `authorization`,
  `cookie`, `set-cookie`, `*.password`, `*.token` — safe to ship
  raw to a log collector.
- A centralised `errorHandler` that ensures every unhandled
  rejection from an async route reaches the same termination point.

Pick the stack(s) below that match what you already run.

## OpenTelemetry

Process-level auto-instrumentation. Captures HTTP spans, Mongo
queries, Express middleware, GraphQL resolvers, and outbound
fetches without touching any application code.

### Install

```bash
npm install \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http
```

### Wire it

Create `telemetry.js` at the project root:

```js
// telemetry.js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'davepi',
    [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version,
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
process.on('SIGTERM', () => sdk.shutdown());
```

Boot with `--require`:

```bash
node --require ./telemetry.js index.js
```

The `--require` flag matters: auto-instrumentation patches `http`,
`express`, `mongoose`, etc. before they're loaded. Importing
`telemetry.js` from inside `index.js` is too late.

### Env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `OTEL_SERVICE_NAME` | `davepi` | Shows up as the service name in your backend. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318/v1/traces` | Honeycomb, Jaeger, Tempo, Datadog, etc. accept OTLP. |
| `OTEL_EXPORTER_OTLP_HEADERS` | _(unset)_ | For backends that require auth: `x-honeycomb-team=...` or similar. |

### Verify

Make a request and look for traces in your backend within ~10s.
The span tree should show:

```
POST /api/v1/account
└── mongoose query: account.findOne
└── mongoose query: account.save
```

If you see the request span but no Mongo children, double-check
that `getNodeAutoInstrumentations()` includes the `mongoose`
instrumentation (it does by default).

## Sentry

Process-level error reporting plus a pino transport so framework-
logged errors carry the request's `reqId` into Sentry events.

### Install

```bash
npm install @sentry/node @sentry/pino-transport
```

### Wire it

Create `sentry.js` at the project root:

```js
// sentry.js
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  release: process.env.npm_package_version,
  tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
  // Auto-instruments http, express, mongoose, postgres, redis.
  integrations: [
    Sentry.httpIntegration(),
    Sentry.expressIntegration(),
    Sentry.mongooseIntegration(),
  ],
});

// Surface unhandled rejections too — dAvePi catches async route
// errors via asyncHandler, but standalone promises (in custom
// scripts, etc.) need this.
process.on('unhandledRejection', (err) => Sentry.captureException(err));
```

Boot with `--require`:

```bash
node --require ./sentry.js index.js
```

### Pino → Sentry for logged errors

Pino is dAvePi's structured logger, and every error-level log line
already carries the request's `reqId` and `userId`. Pipe those to
Sentry to capture handled errors with full request context.

Set `PINO_TRANSPORTS=sentry` and provide a `pino-transport-sentry.js`:

```js
// pino-transport-sentry.js
const Sentry = require('@sentry/node');

module.exports = async function (opts) {
  const { default: build } = await import('pino-abstract-transport');
  return build(async function (source) {
    for await (const line of source) {
      if (line.level >= 50) {
        // 50 = error in pino's numeric levels
        Sentry.captureMessage(line.msg, {
          level: 'error',
          extra: line,
          tags: { reqId: line.reqId, userId: line.userId },
        });
      }
    }
  });
};
```

Then either pipe Pino through this transport via env config, or
use `@sentry/pino-transport` directly when it stabilises.

### Env vars

| Variable | Required | Description |
|----------|----------|-------------|
| `SENTRY_DSN` | yes | Project-specific DSN from Sentry. |
| `SENTRY_TRACES_SAMPLE_RATE` | no (default `0.1`) | Fraction of transactions to capture for performance monitoring. |

### Verify

Throw a deliberate error from a custom route and confirm it lands
in Sentry within ~1 minute. The event should carry `reqId`,
`userId`, route, and the user-agent.

## Datadog APM

Datadog's `dd-trace` is the most batteries-included of the bunch —
one require, no SDK boilerplate.

### Install

```bash
npm install dd-trace
```

### Wire it

```bash
DD_TRACE_AGENT_URL=http://datadog-agent:8126 \
DD_SERVICE=davepi \
DD_ENV=production \
DD_VERSION=$(node -p "require('./package.json').version") \
node --require dd-trace/init index.js
```

`dd-trace/init` auto-detects every supported library (HTTP, Express,
Mongoose, GraphQL via Apollo, async-hooks for context propagation)
and starts shipping traces / runtime metrics to the Datadog agent.

### Logs ↔ traces

dAvePi's pino logs are JSON. Datadog Log Pipelines parse them
automatically. To wire traces and logs together, add the trace IDs
to log lines:

```js
// In your custom logger config (if you don't use the framework default):
const tracer = require('dd-trace');
const logger = require('pino')({
  base: undefined,
  mixin() {
    const span = tracer.scope().active();
    if (!span) return {};
    const { trace_id, span_id } = span.context().toTraceContext();
    return { dd: { trace_id, span_id } };
  },
});
```

The framework's default logger doesn't yet do this — track / fork it
if you need bidirectional log↔trace navigation in Datadog.

### Sample dashboard

A starter Datadog dashboard JSON is in
[`docs/site/public/dashboards/datadog-davepi.json`](https://github.com/projik/davepi/blob/main/docs/site/public/dashboards/datadog-davepi.json).
Import it via _Dashboards → Import_ and adjust the `service:`
scope to match your `DD_SERVICE`.

## Prometheus

dAvePi ships a built-in `/_metrics` endpoint. Opt in with
`METRICS_ENABLED=true`; without that, the endpoint returns 404 and
the per-request middleware is a no-op.

### Enable

```bash
METRICS_ENABLED=true npm start
```

Then scrape:

```bash
curl -s http://localhost:5050/_metrics
```

### What's exposed

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| Default Node.js metrics | various | _(none)_ | Memory, GC, event-loop lag, active handles. (From `prom-client`'s `collectDefaultMetrics()`.) |
| `http_requests_total` | counter | `method`, `route`, `status_code` | Total HTTP requests. |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status_code` | Latency in seconds. Buckets tuned for sub-1s web requests, extending to 5s. |

The `route` label is the **matched Express path template**
(e.g. `/api/v1/account/:id`), not the raw URL. This keeps Prometheus
label cardinality bounded even when traffic hits a million distinct
record IDs.

### Scraping in Kubernetes / Docker

Standard Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: davepi
    metrics_path: /_metrics
    static_configs:
      - targets: ['davepi:5050']
    scrape_interval: 15s
```

### Token-gated metrics

The default exposes `/_metrics` without auth (the standard
Prometheus posture is to scrape from an internal-network sidecar).
If your metrics endpoint is reachable from the public internet,
set `METRICS_TOKEN=<random>`:

```bash
METRICS_ENABLED=true METRICS_TOKEN=$(openssl rand -hex 32) npm start
```

Configure your scraper to send the token in the `Authorization`
header:

```yaml
scrape_configs:
  - job_name: davepi
    metrics_path: /_metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/davepi-metrics-token
    static_configs:
      - targets: ['davepi:5050']
```

### Sample Grafana dashboard

A starter Grafana dashboard JSON is in
[`docs/site/public/dashboards/grafana-davepi.json`](https://github.com/projik/davepi/blob/main/docs/site/public/dashboards/grafana-davepi.json).
Import it via _Dashboards → Import_ and pick the Prometheus
datasource that scrapes your dAvePi instance.

It includes:

- Request rate per route (top-N)
- Latency p50 / p95 / p99 per route
- Error rate (status_code >= 500) per route
- Node.js memory / event-loop lag / GC

### Why not /metrics?

Prometheus convention is usually `/metrics` without the underscore.
dAvePi uses `/_metrics` to match the framework's existing
`/_describe` convention — leading-underscore for framework
endpoints distinguishes them from auto-generated resource routes
(`/api/v1/_metrics` would otherwise look like a resource path).

## Picking a stack

| You want... | Use |
|-------------|-----|
| Distributed tracing across services | OTel — vendor-neutral, your backend is interchangeable. |
| One tool that does traces + metrics + logs + errors | Datadog (paid) or a Sentry + Prometheus + Loki stack (free / OSS). |
| Self-hosted, OSS-only | Prometheus + Grafana for metrics, Sentry self-hosted for errors, OTel + Jaeger / Tempo for traces. |
| Error reporting only | Sentry. |

The four recipes above are non-exclusive — you can run OTel for
traces AND Prometheus for metrics AND Sentry for errors. Each
adds independent overhead (a few % CPU each); benchmark before
turning on all of them in latency-critical paths.

## What dAvePi doesn't do

- **No bundled APM dashboards beyond the two starters.** Build your own around the metric names this page documents — they're [stable](/reference/stability/).
- **No automatic PII redaction in spans.** OTel auto-instrumentation captures URL paths, query strings, and request bodies depending on the library. Configure your backend to strip / hash before storage if you handle regulated data.
- **No built-in error reporting.** Use Sentry (or your APM's error tracking) for that.

## See also

- [Deployment](/operations/deployment/) — env-var setup for production.
- [Errors](/reference/errors/) — typed error codes you might want to filter on in Sentry.
- [Stability commitments](/reference/stability/) — the `/_metrics` shape and metric names are stable as of v1.0.0.
