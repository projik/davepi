'use strict';

/**
 * HTTP channel tests covering the PR #128 review fixes:
 *
 *   - asyncHandler wrapping (rejections funnel into the central
 *     error middleware rather than crashing the process)
 *   - typed-error → { error: { code, message } } shape
 *   - per-user mode REFUSES body-supplied channelUserId
 *     (impersonation primitive — review finding #9)
 *   - per-user mode REQUIRES a signed session cookie on /chat
 *   - link flow serves the HTML form on GET /link/:nonce, accepts
 *     credentials on POST /link/:nonce, sets the session cookie on
 *     success, and never echoes refresh tokens to the browser
 *   - GET /oauth/callback is REFUSED (refresh tokens must not
 *     traverse URLs — finding #8)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createHttpApp, signSession, verifySession, parseCookieHeader } = require('../lib/channels/http');
const { createServiceAuth } = require('../lib/auth/service');
const { createPerUserAuth } = require('../lib/auth/perUser');
const { memoryStore } = require('../lib/store');

function bind(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function urlFor(server, path) {
  const { port, address } = server.address();
  return `http://${address}:${port}${path}`;
}

async function startDavepiStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port, address } = server.address();
      resolve({ url: `http://${address}:${port}`, server });
    });
  });
}

const baseConfig = {
  http: {
    enabled: true,
    port: 0,
    corsOrigins: [],
    sessionSecret: 'test-secret',
    cookieSecure: false,
  },
  tools: { limit: 40, includeRender: false },
  llm: { maxSteps: 1 },
};

test('signSession + verifySession round-trip; tampering is rejected', () => {
  const tok = signSession('s', { cuid: 'u1', iat: 0, exp: 9999 });
  assert.deepEqual(verifySession('s', tok), { cuid: 'u1', iat: 0, exp: 9999 });
  assert.equal(verifySession('s', tok + 'x'), null);
  assert.equal(verifySession('s', 'not.a.real.token'), null);
});

test('parseCookieHeader handles empty / multi-cookie headers', () => {
  assert.deepEqual(parseCookieHeader(''), {});
  assert.deepEqual(parseCookieHeader('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookieHeader('davepi_agent_session=abc%3Dd'), { davepi_agent_session: 'abc=d' });
});

test('/chat without a message returns 400 via central error handler', async () => {
  const app = createHttpApp({
    config: baseConfig,
    model: null,
    mcpClient: { async listTools() { return []; } },
    auth: createServiceAuth({ bearer: 'x' }),
  });
  const server = await bind(app);
  try {
    const res = await fetch(urlFor(server, '/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  } finally {
    server.close();
  }
});

test('per-user mode: /chat refuses body-supplied channelUserId (no cookie) with 401 + linkUrl', async () => {
  const auth = createPerUserAuth({
    davepiUrl: 'http://stub.invalid',
    store: memoryStore(),
    linkBaseUrl: 'http://agent.example.com',
  });
  const app = createHttpApp({
    config: baseConfig,
    model: null,
    mcpClient: { async listTools() { throw new Error('should not reach mcp'); } },
    auth,
  });
  const server = await bind(app);
  try {
    const res = await fetch(urlFor(server, '/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', channelUserId: 'attacker-says-im-alice' }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'UNLINKED');
    assert.match(body.error.linkUrl, /\/link\//);
  } finally {
    server.close();
  }
});

test('per-user mode: /chat accepts a valid signed session cookie and reaches the orchestrator with that cuid', async () => {
  const auth = createPerUserAuth({
    davepiUrl: 'http://stub.invalid',
    store: memoryStore(),
    linkBaseUrl: 'http://agent.example.com',
  });
  let observedCtx = null;
  const app = createHttpApp({
    config: baseConfig,
    model: null,
    mcpClient: {
      async listTools(ctx) {
        observedCtx = ctx;
        // Throw UnlinkedError to short-circuit before invoking the LLM
        // we don't have a real model in this test; the assertion is
        // about which channelCtx the channel passed in.
        const { UnlinkedError } = require('../lib/errors');
        throw new UnlinkedError('http://agent.example.com/link/x');
      },
    },
    auth,
  });
  const server = await bind(app);
  try {
    const token = signSession('test-secret', {
      cuid: 'legit-cuid',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await fetch(urlFor(server, '/chat'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `davepi_agent_session=${encodeURIComponent(token)}`,
      },
      body: JSON.stringify({ message: 'hi', channelUserId: 'ignored-attacker', stream: false }),
    });
    // The UnlinkedError thrown inside listTools after we set channelCtx
    // will be caught by runTurn and surfaced as an assistant message;
    // the call returns 200 with text. What we're asserting here is
    // that observedCtx.channelUserId was the cookie's cuid, NOT the
    // body-supplied one.
    await res.text();
    assert.equal(observedCtx.channelUserId, 'legit-cuid');
  } finally {
    server.close();
  }
});

test('per-user mode: missing AGENT_SESSION_SECRET on /chat returns 500 CONFIG_MISSING', async () => {
  const auth = createPerUserAuth({
    davepiUrl: 'http://stub.invalid',
    store: memoryStore(),
    linkBaseUrl: 'http://agent.example.com',
  });
  const config = { ...baseConfig, http: { ...baseConfig.http, sessionSecret: null } };
  const app = createHttpApp({ config, model: null, mcpClient: {}, auth });
  const server = await bind(app);
  try {
    const res = await fetch(urlFor(server, '/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, 'CONFIG_MISSING');
  } finally {
    server.close();
  }
});

test('/link/:nonce renders the HTML form when nonce is valid; 404s when unknown', async () => {
  const auth = createPerUserAuth({
    davepiUrl: 'http://stub.invalid',
    store: memoryStore(),
    linkBaseUrl: 'http://agent.example.com',
  });
  const link = auth.startLink({ channel: 'http', channelUserId: 'cuid-form' });
  const app = createHttpApp({ config: baseConfig, model: null, mcpClient: {}, auth });
  const server = await bind(app);
  try {
    const ok = await fetch(urlFor(server, `/link/${link.nonce}`));
    assert.equal(ok.status, 200);
    const html = await ok.text();
    assert.match(html, /<form method="POST"/);
    assert.match(html, /<input id="email"/);
    const missing = await fetch(urlFor(server, '/link/nope'));
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('POST /link/:nonce stores the refresh token and issues a session cookie for the http channel', async () => {
  const { url: davepiUrl, server: davepi } = await startDavepiStub((req, res) => {
    if (req.url === '/login' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        token: 'access',
        refreshToken: 'rt-secret',
        user: { _id: 'davepi-user-id' },
      }));
    }
    res.writeHead(404); res.end();
  });
  const store = memoryStore();
  const auth = createPerUserAuth({ davepiUrl, store, linkBaseUrl: 'http://agent.example.com' });
  const link = auth.startLink({ channel: 'http', channelUserId: 'cuid-link' });
  const app = createHttpApp({ config: baseConfig, model: null, mcpClient: {}, auth });
  const server = await bind(app);
  try {
    const body = new URLSearchParams({ email: 'a@b.com', password: 's3cret' }).toString();
    const res = await fetch(urlFor(server, `/link/${link.nonce}`), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Linked\./);
    // Refresh token must NOT appear in the response body — it stays
    // server-side. This is the central guarantee of the redesigned
    // link flow (PR #128 review finding #8).
    assert.equal(html.includes('rt-secret'), false);
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie && setCookie.startsWith('davepi_agent_session='));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    const row = await store.get('http', 'cuid-link');
    assert.equal(row.refresh_token, 'rt-secret');
  } finally {
    server.close();
    davepi.close();
  }
});

test('POST /link/:nonce with bad credentials re-renders the form with an error and does NOT issue a cookie', async () => {
  const { url: davepiUrl, server: davepi } = await startDavepiStub((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Credentials' } }));
  });
  const auth = createPerUserAuth({
    davepiUrl,
    store: memoryStore(),
    linkBaseUrl: 'http://agent.example.com',
  });
  const link = auth.startLink({ channel: 'http', channelUserId: 'cuid-bad' });
  const app = createHttpApp({ config: baseConfig, model: null, mcpClient: {}, auth });
  const server = await bind(app);
  try {
    const body = new URLSearchParams({ email: 'a@b.com', password: 'wrong' }).toString();
    const res = await fetch(urlFor(server, `/link/${link.nonce}`), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.equal(res.status, 401);
    const html = await res.text();
    assert.match(html, /Invalid email or password/);
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    server.close();
    davepi.close();
  }
});

test('GET /oauth/callback is REFUSED to prevent refresh-token leakage via URL', async () => {
  const auth = createPerUserAuth({
    davepiUrl: 'http://stub.invalid',
    store: memoryStore(),
    linkBaseUrl: 'http://agent.example.com',
  });
  const app = createHttpApp({ config: baseConfig, model: null, mcpClient: {}, auth });
  const server = await bind(app);
  try {
    const res = await fetch(urlFor(server, '/oauth/callback?refresh_token=leaky&nonce=x'), {
      method: 'POST',
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});
