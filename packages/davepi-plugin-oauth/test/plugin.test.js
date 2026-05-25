'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createPlugin, signState } = require('../index');

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {}, child: () => silentLog() };
}
function capturingLog() {
  const records = { info: [], warn: [], error: [] };
  return {
    info:  (obj, msg) => records.info.push({ obj, msg }),
    warn:  (obj, msg) => records.warn.push({ obj, msg }),
    error: (obj, msg) => records.error.push({ obj, msg }),
    child: () => capturingLog(),
    records,
  };
}

function fakeErrors() {
  // Match the davepi/utils/errors surface we touch.
  function make(name) {
    return class extends Error {
      constructor(msg) { super(msg); this.name = name; }
    };
  }
  return {
    UnauthorizedError: make('UnauthorizedError'),
    ValidationError:   make('ValidationError'),
    NotFoundError:     make('NotFoundError'),
    ConflictError:     make('ConflictError'),
    ForbiddenError:    make('ForbiddenError'),
  };
}

class InMemoryStore {
  constructor() { this.rows = []; this.nextId = 1; }
  async findOne(q) {
    return this.rows.find((r) => Object.entries(q).every(([k, v]) => String(r[k]) === String(v))) || null;
  }
  async findById(id) { return this.rows.find((r) => String(r._id) === String(id)) || null; }
  async create(doc) {
    const row = { _id: this.nextId++, ...doc };
    row.save = async () => row;
    this.rows.push(row);
    return row;
  }
  async deleteOne(q) {
    const i = this.rows.findIndex((r) => Object.entries(q).every(([k, v]) => String(r[k]) === String(v)));
    if (i >= 0) this.rows.splice(i, 1);
  }
}

const SECRET = 's'.repeat(32);
const BASE = 'https://api.example.com';

function makePluginWithGoogle({ fetch, env = {} }) {
  const Users = new InMemoryStore();
  const Identities = new InMemoryStore();
  const issued = [];
  const plugin = createPlugin({
    env: {
      OAUTH_BASE_URL: BASE,
      OAUTH_STATE_SECRET: SECRET,
      OAUTH_SUCCESS_REDIRECT: 'https://app.example.com/auth/success?token=',
      OAUTH_GOOGLE_CLIENT_ID: 'g-id',
      OAUTH_GOOGLE_CLIENT_SECRET: 'g-secret',
      ...env,
    },
    fetch,
    User: Users,
    OAuthIdentity: Identities,
    issueTokenPair: async (user) => {
      const pair = { accessToken: `AT-${user._id}`, refreshToken: `RT-${user._id}` };
      issued.push({ userId: user._id, ...pair });
      return pair;
    },
    errors: fakeErrors(),
    verifyAuth: () => (req, _res, next) => {
      // Tests inject `req.user` manually.
      if (!req.user) return next(new Error('not authenticated'));
      next();
    },
  });
  return { plugin, Users, Identities, issued };
}

test('default export shape', () => {
  const mod = require('../index');
  assert.equal(mod.name, 'oauth');
  assert.equal(typeof mod.setup, 'function');
  assert.equal(typeof mod.createPlugin, 'function');
  assert.equal(typeof mod.signState, 'function');
  assert.equal(typeof mod.verifyState, 'function');
});

test('dormant when no providers configured; warns and exits setup', async () => {
  const log = capturingLog();
  const plugin = createPlugin({
    env: { OAUTH_BASE_URL: BASE, OAUTH_STATE_SECRET: SECRET },
    errors: fakeErrors(),
  });
  await plugin.setup({ app: null, bus: new EventEmitter(), log, appName: 'demo' });
  assert.equal(plugin.isEnabled(), false);
  assert.match(log.records.warn[0].msg, /no providers configured/);
});

test('dormant when OAUTH_BASE_URL is missing despite a provider being set', async () => {
  const log = capturingLog();
  const plugin = createPlugin({
    env: {
      OAUTH_STATE_SECRET: SECRET,
      OAUTH_GOOGLE_CLIENT_ID: 'g-id',
      OAUTH_GOOGLE_CLIENT_SECRET: 'g-secret',
    },
    errors: fakeErrors(),
  });
  await plugin.setup({ app: null, bus: new EventEmitter(), log, appName: 'demo' });
  assert.equal(plugin.isEnabled(), false);
  assert.match(log.records.error[0].msg, /OAUTH_BASE_URL is required/);
});

test('dormant when OAUTH_STATE_SECRET is too short', async () => {
  const log = capturingLog();
  const plugin = createPlugin({
    env: {
      OAUTH_BASE_URL: BASE,
      OAUTH_STATE_SECRET: 'short',
      OAUTH_GOOGLE_CLIENT_ID: 'g-id',
      OAUTH_GOOGLE_CLIENT_SECRET: 'g-secret',
    },
    errors: fakeErrors(),
  });
  await plugin.setup({ app: null, bus: new EventEmitter(), log, appName: 'demo' });
  assert.equal(plugin.isEnabled(), false);
  assert.match(log.records.error[0].msg, /OAUTH_STATE_SECRET is required/);
});

test('enabled when env is correct; reports the provider list', async () => {
  const { plugin } = makePluginWithGoogle({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  await plugin.setup({ app: null, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });
  assert.equal(plugin.isEnabled(), true);
  assert.deepEqual(plugin.enabledProviders(), ['google']);
});

test('buildAuthorizeRedirect produces a provider authorize URL with state + PKCE challenge', async () => {
  const { plugin } = makePluginWithGoogle({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  await plugin.setup({ app: null, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });
  const { url, redirectUri } = plugin.buildAuthorizeRedirect('google');
  const u = new URL(url);
  assert.equal(u.host, 'accounts.google.com');
  assert.ok(u.searchParams.get('state'));
  assert.ok(u.searchParams.get('code_challenge'));
  assert.equal(u.searchParams.get('client_id'), 'g-id');
  assert.equal(redirectUri, `${BASE}/auth/google/callback`);
});

test('handleCallback: end-to-end google flow mints a user + issues JWT', async () => {
  const fetch = async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return { ok: true, status: 200, json: async () => ({ access_token: 'AT' }) };
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return { ok: true, status: 200, json: async () => ({
        sub: 'GOOGLE-1', email: 'pi@example.com', email_verified: true,
        name: 'Pi', given_name: 'Pi', family_name: 'User',
      }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const { plugin, Users, Identities, issued } = makePluginWithGoogle({ fetch });
  await plugin.setup({ app: null, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });

  // First, the user "comes from" /auth/google — that gives us a
  // signed state. Then we hand the state back at the callback.
  const { url } = plugin.buildAuthorizeRedirect('google');
  const stateToken = new URL(url).searchParams.get('state');

  const result = await plugin.handleCallback('google', { code: 'AUTHCODE', stateToken });
  assert.equal(result.mode, 'login');
  assert.equal(result.created, true);
  assert.equal(result.user.email, 'pi@example.com');
  assert.equal(result.tokens.accessToken, `AT-${result.user._id}`);
  assert.equal(Users.rows.length, 1);
  assert.equal(Identities.rows.length, 1);
  assert.equal(issued.length, 1);
});

test('handleCallback: state with wrong secret is rejected', async () => {
  const { plugin } = makePluginWithGoogle({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  await plugin.setup({ app: null, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });
  // Sign a state with a *different* secret.
  const bad = signState({ provider: 'google' }, { secret: 'x'.repeat(32) });
  await assert.rejects(
    () => plugin.handleCallback('google', { code: 'AUTHCODE', stateToken: bad }),
    /state verification failed/
  );
});

test('handleCallback: provider mismatch in state is rejected', async () => {
  const { plugin } = makePluginWithGoogle({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  await plugin.setup({ app: null, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });
  const bad = signState({ provider: 'github' }, { secret: SECRET });
  await assert.rejects(
    () => plugin.handleCallback('google', { code: 'AUTHCODE', stateToken: bad }),
    /provider mismatch/
  );
});

test('handleCallback (link mode): adds identity to the already-authenticated user', async () => {
  const fetch = async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return { ok: true, json: async () => ({ access_token: 'AT' }) };
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return { ok: true, json: async () => ({ sub: 'NEW-G', email: 'me@example.com' }) };
    }
    throw new Error(url);
  };
  const { plugin, Users, Identities, issued } = makePluginWithGoogle({ fetch });
  await plugin.setup({ app: null, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });
  const existing = await Users.create({ email: 'me@example.com', roles: ['user'] });

  const stateToken = signState(
    { provider: 'google', linkedUserId: String(existing._id), verifier: null },
    { secret: SECRET }
  );
  const result = await plugin.handleCallback('google', { code: 'C', stateToken });
  assert.equal(result.mode, 'link');
  assert.equal(result.linked, true);
  assert.equal(result.created, true);
  assert.equal(Users.rows.length, 1, 'no extra user created');
  assert.equal(Identities.rows.length, 1);
  assert.equal(issued.length, 0, 'link mode does not mint a JWT');
});

test('linking the SAME provider+sub twice is a no-op (idempotent)', async () => {
  const fetch = async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return { ok: true, json: async () => ({ access_token: 'AT' }) };
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return { ok: true, json: async () => ({ sub: 'SAME', email: 'a@b.com' }) };
    }
  };
  const { plugin, Users, Identities } = makePluginWithGoogle({ fetch });
  await plugin.setup({ app: null, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });
  const u = await Users.create({ email: 'a@b.com', roles: ['user'] });
  const s = signState({ provider: 'google', linkedUserId: String(u._id) }, { secret: SECRET });

  await plugin.handleCallback('google', { code: 'C', stateToken: s });
  await plugin.handleCallback('google', { code: 'C', stateToken: s });
  assert.equal(Identities.rows.length, 1);
});

// ---------------------------------------------------------------------
// PR #121 review fixes — open-redirect, errorHandler delegation,
// Apple form-post parser, and the PKCE-in-state confidentiality fix
// (the state encryption itself is covered in state.test.js).
// ---------------------------------------------------------------------

test('returnTo: a malicious absolute URL is dropped (open-redirect defence)', async () => {
  const { plugin } = makePluginWithGoogle({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  await plugin.setup({ app: null, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });
  // Programmatic call is the second line of defence; we sanitise at
  // route boundary AND inside buildAuthorizeRedirect.
  const { url } = plugin.buildAuthorizeRedirect('google', { returnTo: 'https://evil.example/steal' });
  const stateToken = new URL(url).searchParams.get('state');
  const { openState } = require('../lib/state');
  const parsed = openState(stateToken, { secret: SECRET });
  assert.equal(parsed.returnTo, null, 'absolute-URL returnTo must not survive into state');
});

test('returnTo: a protocol-relative URL is dropped', async () => {
  const { plugin } = makePluginWithGoogle({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  await plugin.setup({ app: null, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });
  const { url } = plugin.buildAuthorizeRedirect('google', { returnTo: '//evil.example/foo' });
  const stateToken = new URL(url).searchParams.get('state');
  const { openState } = require('../lib/state');
  const parsed = openState(stateToken, { secret: SECRET });
  assert.equal(parsed.returnTo, null);
});

test('returnTo: a safe relative path survives the round-trip', async () => {
  const { plugin } = makePluginWithGoogle({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  await plugin.setup({ app: null, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });
  const { url } = plugin.buildAuthorizeRedirect('google', { returnTo: '/dashboard?tab=billing' });
  const stateToken = new URL(url).searchParams.get('state');
  const { openState } = require('../lib/state');
  const parsed = openState(stateToken, { secret: SECRET });
  assert.equal(parsed.returnTo, '/dashboard?tab=billing');
});

test('safeReturnTo rejects values containing :// even mid-string', () => {
  // The exported sanitiser via the module is internal; re-implement
  // the same predicate against the module's behaviour through
  // buildAuthorizeRedirect.
  const cases = [
    '/foo://bar',          // contains :// — rejected
    '/x' + 'a'.repeat(2000), // too long — rejected
    'no-leading-slash',    // doesn't start with / — rejected
    '',                    // empty — rejected
  ];
  // Each input that fails the predicate yields a state with
  // returnTo === null.
  const { plugin } = makePluginWithGoogle({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  return plugin.setup({ app: null, bus: new EventEmitter(), log: silentLog(), appName: 'demo' }).then(() => {
    const { openState } = require('../lib/state');
    for (const rt of cases) {
      const { url } = plugin.buildAuthorizeRedirect('google', { returnTo: rt });
      const stateToken = new URL(url).searchParams.get('state');
      const parsed = openState(stateToken, { secret: SECRET });
      assert.equal(parsed.returnTo, null, `expected ${JSON.stringify(rt)} to be dropped`);
    }
  });
});

test('mountRoutes: GET /auth/google sanitises returnTo from req.query', async () => {
  const routes = {};
  const fakeApp = {
    get: (p, ...handlers) => { routes[`GET ${p}`] = handlers[handlers.length - 1]; },
    post: (p, ...handlers) => { routes[`POST ${p}`] = handlers[handlers.length - 1]; },
  };
  const { plugin } = makePluginWithGoogle({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  await plugin.setup({ app: fakeApp, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });
  const handler = routes['GET /auth/google'];
  assert.equal(typeof handler, 'function');

  // Drive the route with a malicious returnTo and assert the
  // resulting state has returnTo === null.
  let redirected;
  await handler(
    { query: { returnTo: 'https://evil.example/steal' } },
    { redirect: (status, loc) => { redirected = { status, loc }; } },
    (err) => { throw err; }
  );
  assert.equal(redirected.status, 302);
  const stateToken = new URL(redirected.loc).searchParams.get('state');
  const { openState } = require('../lib/state');
  assert.equal(openState(stateToken, { secret: SECRET }).returnTo, null);
});

test('callback (no successRedirect): provider error path calls next(err) (errorHandler delegation, not inline 400)', async () => {
  const routes = {};
  const fakeApp = {
    get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; },
    post: (p, ...h) => { routes[`POST ${p}`] = h[h.length - 1]; },
  };
  const { plugin } = makePluginWithGoogle({
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    env: { OAUTH_SUCCESS_REDIRECT: '' }, // force the no-redirect branch
  });
  await plugin.setup({ app: fakeApp, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });
  const cb = routes['GET /auth/google/callback'];
  let nextErr = null;
  let resWrote = false;
  await cb(
    { method: 'GET', query: { error: 'access_denied' } },
    { status: () => ({ json: () => { resWrote = true; } }), redirect: () => { resWrote = true; } },
    (err) => { nextErr = err; }
  );
  assert.equal(resWrote, false, 'no inline response was written');
  assert.ok(nextErr, 'next(err) was called');
  assert.equal(nextErr.name, 'ValidationError');
  assert.match(nextErr.message, /access_denied/);
});

test('callback (with failureRedirect): provider error redirects 302, no next(err)', async () => {
  const routes = {};
  const fakeApp = {
    get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; },
    post: (p, ...h) => { routes[`POST ${p}`] = h[h.length - 1]; },
  };
  const { plugin } = makePluginWithGoogle({
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    env: { OAUTH_FAILURE_REDIRECT: 'https://app.example.com/login?failed=1' },
  });
  await plugin.setup({ app: fakeApp, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });
  const cb = routes['GET /auth/google/callback'];
  let redirected = null;
  let nextCalled = false;
  await cb(
    { method: 'GET', query: { error: 'access_denied' } },
    { redirect: (status, loc) => { redirected = { status, loc }; } },
    (_err) => { nextCalled = true; }
  );
  assert.equal(nextCalled, false);
  assert.equal(redirected.status, 302);
  assert.match(redirected.loc, /https:\/\/app\.example\.com\/login\?failed=1&error=/);
});

test('login redirect appends safe returnTo as a query param to OAUTH_SUCCESS_REDIRECT (never as the destination)', async () => {
  const routes = {};
  const fakeApp = {
    get: (p, ...h) => { routes[`GET ${p}`] = h[h.length - 1]; },
    post: (p, ...h) => { routes[`POST ${p}`] = h[h.length - 1]; },
  };
  const fetch = async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return { ok: true, json: async () => ({ access_token: 'AT' }) };
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return { ok: true, json: async () => ({ sub: 'X', email: 'r@x.com' }) };
    }
  };
  const { plugin } = makePluginWithGoogle({ fetch });
  await plugin.setup({ app: fakeApp, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });
  const stateToken = signState(
    { provider: 'google', returnTo: '/dashboard?tab=bills' },
    { secret: SECRET }
  );
  let redirected;
  const cb = routes['GET /auth/google/callback'];
  await cb(
    { method: 'GET', query: { code: 'C', state: stateToken } },
    { redirect: (status, loc) => { redirected = { status, loc }; }, status: () => ({ json: () => {} }) },
    (err) => { throw err; }
  );
  assert.equal(redirected.status, 302);
  // Destination is ALWAYS the env-configured success origin.
  assert.match(redirected.loc, /^https:\/\/app\.example\.com\/auth\/success\?token=/);
  // returnTo is a query param the SPA can read.
  assert.match(redirected.loc, /&returnTo=%2Fdashboard%3Ftab%3Dbills/);
});

test('Apple form-post POST callback: urlencoded body parser fills req.body', async () => {
  const routes = {};
  const middlewares = {};
  const fakeApp = {
    get: (p, ...h) => { routes[`GET ${p}`] = h; },
    post: (p, ...h) => {
      routes[`POST ${p}`] = h[h.length - 1];
      middlewares[`POST ${p}`] = h.slice(0, -1);
    },
  };
  const { plugin } = makePluginWithGoogle({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  await plugin.setup({ app: fakeApp, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });

  // The POST callback should have at least one middleware (the
  // urlencoded parser) in front of the handler.
  assert.ok(middlewares['POST /auth/google/callback'].length >= 1);
  const parser = middlewares['POST /auth/google/callback'][0];

  // Drive a synthetic form-post: an EventEmitter-shaped req with
  // urlencoded body and Content-Type set. parser should populate
  // req.body.
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = { 'content-type': 'application/x-www-form-urlencoded' };
  req.setEncoding = () => {};
  const done = new Promise((resolve, reject) => {
    parser(req, {}, (err) => err ? reject(err) : resolve());
  });
  // Drain after the listeners are attached.
  setImmediate(() => {
    req.emit('data', 'code=AAA&state=BBB');
    req.emit('end');
  });
  await done;
  assert.deepEqual(req.body, { code: 'AAA', state: 'BBB' });
});

test('urlencoded parser: skips when content-type is JSON (host parser handles it)', async () => {
  const routes = {};
  const middlewares = {};
  const fakeApp = {
    get: () => {},
    post: (p, ...h) => {
      routes[`POST ${p}`] = h[h.length - 1];
      middlewares[`POST ${p}`] = h.slice(0, -1);
    },
  };
  const { plugin } = makePluginWithGoogle({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  await plugin.setup({ app: fakeApp, bus: new EventEmitter(), log: silentLog(), appName: 'demo' });
  const parser = middlewares['POST /auth/google/callback'][0];

  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { code: 'pre-parsed-by-host' },
  };
  await new Promise((resolve, reject) => {
    parser(req, {}, (err) => err ? reject(err) : resolve());
  });
  assert.deepEqual(req.body, { code: 'pre-parsed-by-host' }, 'parser must not clobber an existing body');
});
