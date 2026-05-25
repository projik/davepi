/**
 * Integration test for davepi-plugin-oauth: load it through the real
 * pluginLoader, against a live schema + real Mongo (via
 * mongodb-memory-server), and confirm the full OAuth dance works
 * end-to-end:
 *
 *   1. GET /auth/google issues a redirect carrying a signed state.
 *   2. GET /auth/google/callback (with a mocked Google fetch) mints
 *      a local User, persists an oauth_identity, and issues the
 *      framework's standard JWT — which then works against the
 *      existing auth-gated `/api/v1/...` routes.
 *
 * This is the proof that "list davepi-plugin-oauth under
 * davepi.plugins and it just works" — the package's own
 * test/plugin.test.js mocks the framework's User/Identity/issue; this
 * test exercises the real ones.
 */

const path = require('path');
const { URL } = require('url');
const { setupTestApp } = require('./helpers');

const ctx = setupTestApp();

describe('davepi-plugin-oauth — end-to-end via pluginLoader', () => {
  beforeAll(() => {
    process.env.OAUTH_BASE_URL = 'https://api.example.com';
    process.env.OAUTH_STATE_SECRET = 's'.repeat(32);
    process.env.OAUTH_GOOGLE_CLIENT_ID = 'g-id';
    process.env.OAUTH_GOOGLE_CLIENT_SECRET = 'g-secret';
  });

  test('GET /auth/google → callback mints user + JWT, JWT works against /api/v1/...', async () => {
    const { loadPlugins } = require('../utils/pluginLoader');
    const { bus } = require('../utils/events');
    const pkgPath = path.resolve(__dirname, '..', 'packages', 'davepi-plugin-oauth');
    const { createPlugin } = require(pkgPath);

    // Mock Google's REST surface. The plugin asks for an access_token
    // then a userinfo profile; we intercept both.
    const fetchCalls = [];
    const fakeFetch = async (url, init) => {
      fetchCalls.push({ url, init });
      if (url === 'https://oauth2.googleapis.com/token') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'fake-google-AT', token_type: 'Bearer' }),
        };
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sub: 'GOOGLE-INT-1',
            email: `oauth-${Date.now()}@example.com`,
            email_verified: true,
            name: 'OAuth Tester',
            given_name: 'OAuth',
            family_name: 'Tester',
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const pluginInstance = createPlugin({
      env: {
        OAUTH_BASE_URL: 'https://api.example.com',
        OAUTH_STATE_SECRET: 's'.repeat(32),
        OAUTH_GOOGLE_CLIENT_ID: 'g-id',
        OAUTH_GOOGLE_CLIENT_SECRET: 'g-secret',
      },
      fetch: fakeFetch,
    });

    await loadPlugins({
      plugins: [pluginInstance],
      app: ctx.app,
      schemaLoader: ctx.app.locals.schemaLoader,
      bus,
      appName: 'integration-test-app',
    });

    // Step 1: hit /auth/google — should 302 to Google with state + PKCE.
    const redirectRes = await ctx.request(ctx.app).get('/auth/google');
    expect(redirectRes.status).toBe(302);
    const authorizeUrl = new URL(redirectRes.headers.location);
    expect(authorizeUrl.host).toBe('accounts.google.com');
    const state = authorizeUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(authorizeUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');

    // Step 2: hit the callback as Google would, with the state we
    // just got and a faked auth code. Mocked fetch returns the token
    // + userinfo. Plugin creates a User, issues a JWT pair, and
    // redirects to OAUTH_SUCCESS_REDIRECT — but we didn't set that
    // so it returns JSON.
    const cbRes = await ctx.request(ctx.app)
      .get(`/auth/google/callback?code=fake-code&state=${encodeURIComponent(state)}`);
    expect(cbRes.status).toBe(200);
    expect(cbRes.body.accessToken).toBeTruthy();
    expect(cbRes.body.refreshToken).toBeTruthy();
    expect(cbRes.body.user).toBeTruthy();
    expect(cbRes.body.user.email).toMatch(/^oauth-/);
    expect(cbRes.body.created).toBe(true);
    expect(cbRes.body.provider).toBe('google');

    // Step 3: the JWT we just got should authenticate requests to the
    // existing framework routes. Hit a generated REST list endpoint
    // for any auth-gated path; even an empty list (200 with []) is
    // enough to prove the token works.
    const userId = cbRes.body.user._id;
    const accessToken = cbRes.body.accessToken;

    // /api/v1/user/me-style listing — use any auto-generated schema.
    // We don't depend on a specific schema being loaded; we just
    // confirm the token is accepted (any non-401 is enough).
    const schemas = ctx.app.locals.schemaLoader.listSchemas();
    expect(Array.isArray(schemas)).toBe(true);
    if (schemas.length) {
      const probe = schemas[0];
      const protected_ = await ctx.request(ctx.app)
        .get(`/api/v1/${probe.path}`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(protected_.status).not.toBe(401);
    }

    // Step 4: a SECOND callback with the same state replays the same
    // Google profile, which should resolve to the same local User
    // (not a duplicate). Hit the dance again with a fresh state.
    const redirect2 = await ctx.request(ctx.app).get('/auth/google');
    const state2 = new URL(redirect2.headers.location).searchParams.get('state');
    const cb2 = await ctx.request(ctx.app)
      .get(`/auth/google/callback?code=fake-code-2&state=${encodeURIComponent(state2)}`);
    expect(cb2.status).toBe(200);
    expect(String(cb2.body.user._id)).toBe(String(userId));
    expect(cb2.body.created).toBe(false);
  }, 30000);

  test('rejects a callback with an unsigned state', async () => {
    const res = await ctx.request(ctx.app)
      .get('/auth/google/callback?code=x&state=unsigned-garbage');
    // The plugin throws UnauthorizedError → errorHandler → 401.
    expect(res.status).toBe(401);
  });
});
