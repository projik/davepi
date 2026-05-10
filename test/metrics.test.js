/**
 * Tests for the Prometheus /_metrics endpoint.
 *
 * The endpoint is gated on `METRICS_ENABLED=true`. Each test sets /
 * unsets the env var around its assertions and resets the module
 * registry between runs so counters don't leak across tests.
 *
 * `app.js` reads the env var per-request (inside the handler and
 * middleware), so toggling METRICS_ENABLED at test time works
 * without re-importing the app.
 */

const { setupTestApp, registerUser } = require('./helpers');
const { _resetForTests } = require('../middleware/metrics');

describe('Prometheus /_metrics endpoint', () => {
  const ctx = setupTestApp();

  afterEach(() => {
    // Each test runs with its own env config; reset so the next test
    // starts from a clean registry.
    delete process.env.METRICS_ENABLED;
    delete process.env.METRICS_TOKEN;
    _resetForTests();
  });

  test('returns 404 when METRICS_ENABLED is not set', async () => {
    const res = await ctx.request(ctx.app).get('/_metrics');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('returns Prometheus text format when enabled', async () => {
    process.env.METRICS_ENABLED = 'true';
    const res = await ctx.request(ctx.app).get('/_metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    // Default Node metrics from prom-client carry these standard names.
    expect(res.text).toMatch(/process_cpu_user_seconds_total/);
    expect(res.text).toMatch(/nodejs_heap_size_used_bytes/);
    // Framework's own histogram.
    expect(res.text).toMatch(/http_request_duration_seconds/);
  });

  test('records http_requests_total on every request', async () => {
    process.env.METRICS_ENABLED = 'true';
    // Make a request that goes through a known matched route.
    const user = await registerUser(ctx.request, ctx.app);
    await ctx.request(ctx.app)
      .get('/_describe')
      .set('Authorization', `Bearer ${user.token}`);

    const scrape = await ctx.request(ctx.app).get('/_metrics');
    expect(scrape.status).toBe(200);
    expect(scrape.text).toMatch(/http_requests_total\{[^}]*method="GET"[^}]*\}\s+\d+/);
  });

  test('label cardinality stays bounded via req.route.path, not raw URL', async () => {
    // Without route-template-based labelling, id-bearing URLs would
    // create one label combination per record id and explode
    // Prometheus cardinality.
    process.env.METRICS_ENABLED = 'true';
    const user = await registerUser(ctx.request, ctx.app);

    // Hit a 404 path so we exercise the unmatched-route fallback.
    await ctx.request(ctx.app)
      .get('/api/v1/nonexistent-path-' + Date.now())
      .set('Authorization', `Bearer ${user.token}`);

    const scrape = await ctx.request(ctx.app).get('/_metrics');
    // The raw URL with a timestamp must not appear in the metrics
    // text — that would be the bug we're guarding against.
    expect(scrape.text).not.toMatch(/nonexistent-path-\d+/);
  });

  test('METRICS_TOKEN gates the endpoint when set', async () => {
    process.env.METRICS_ENABLED = 'true';
    process.env.METRICS_TOKEN = 'secret-scraper-token';

    const noAuth = await ctx.request(ctx.app).get('/_metrics');
    expect(noAuth.status).toBe(401);
    expect(noAuth.body.error.code).toBe('UNAUTHORIZED');

    const wrongAuth = await ctx.request(ctx.app)
      .get('/_metrics')
      .set('Authorization', 'Bearer wrong-token');
    expect(wrongAuth.status).toBe(401);

    const goodAuth = await ctx.request(ctx.app)
      .get('/_metrics')
      .set('Authorization', 'Bearer secret-scraper-token');
    expect(goodAuth.status).toBe(200);
    expect(goodAuth.text).toMatch(/process_cpu_user_seconds_total/);
  });

  test('middleware is a no-op when not enabled (no overhead)', async () => {
    // Without METRICS_ENABLED, the middleware short-circuits at the
    // first `if`. A request still completes normally; nothing gets
    // recorded because the registry is never initialised.
    delete process.env.METRICS_ENABLED;
    const user = await registerUser(ctx.request, ctx.app);
    const res = await ctx.request(ctx.app)
      .get('/_describe')
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    // Calling _metrics now still 404s — registry was never built.
    const scrape = await ctx.request(ctx.app).get('/_metrics');
    expect(scrape.status).toBe(404);
  });
});
