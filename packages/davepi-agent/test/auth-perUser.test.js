'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createPerUserAuth } = require('../lib/auth/perUser');
const { memoryStore } = require('../lib/store');

function startDavepiStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

test('per-user auth: unlinked user throws UnlinkedError with a /link/:nonce URL', async () => {
  const auth = createPerUserAuth({
    davepiUrl: 'http://stub.invalid',
    store: memoryStore(),
    linkBaseUrl: 'http://agent.example.com',
  });
  await assert.rejects(
    () => auth.headersFor({ channel: 'slack', channelUserId: 'u1' }),
    (err) => {
      assert.equal(err.code, 'UNLINKED');
      assert.match(err.linkUrl, /^http:\/\/agent\.example\.com\/link\/[a-f0-9]+$/);
      return true;
    }
  );
});

test('per-user auth: completeLinkWithCredentials hits POST /login and stores the refresh token', async () => {
  let loginBody = null;
  const { url, server } = await startDavepiStub((req, res, body) => {
    if (req.url === '/login' && req.method === 'POST') {
      loginBody = JSON.parse(body);
      assert.equal(req.headers['content-type'], 'application/json');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          token: 'access-from-login',
          refreshToken: 'rt-from-login',
          user: { _id: 'user-42', email: 'alice@example.com' },
        })
      );
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const store = memoryStore();
    const auth = createPerUserAuth({
      davepiUrl: url,
      store,
      linkBaseUrl: 'http://agent.example.com',
    });
    const link = auth.startLink({ channel: 'http', channelUserId: 'cuid-1' });
    const result = await auth.completeLinkWithCredentials({
      nonce: link.nonce,
      email: 'alice@example.com',
      password: 's3cret',
    });
    assert.equal(result.davepiUserId, 'user-42');
    assert.deepEqual(loginBody, { email: 'alice@example.com', password: 's3cret' });
    const row = await store.get('http', 'cuid-1');
    assert.equal(row.refresh_token, 'rt-from-login');
    assert.equal(row.davepi_user_id, 'user-42');
  } finally {
    server.close();
  }
});

test('per-user auth: bad credentials surface as code:LOGIN_FAILED', async () => {
  const { url, server } = await startDavepiStub((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Credentials' } }));
  });
  try {
    const auth = createPerUserAuth({
      davepiUrl: url,
      store: memoryStore(),
      linkBaseUrl: 'http://agent.example.com',
    });
    const link = auth.startLink({ channel: 'http', channelUserId: 'cuid-x' });
    await assert.rejects(
      () => auth.completeLinkWithCredentials({ nonce: link.nonce, email: 'a', password: 'b' }),
      (err) => {
        assert.equal(err.code, 'LOGIN_FAILED');
        return true;
      }
    );
  } finally {
    server.close();
  }
});

test('per-user auth: expired or unknown nonce is rejected', async () => {
  const auth = createPerUserAuth({
    davepiUrl: 'http://stub.invalid',
    store: memoryStore(),
    linkBaseUrl: 'http://agent.example.com',
  });
  await assert.rejects(
    () => auth.completeLinkWithCredentials({ nonce: 'nope', email: 'a@b.com', password: 'x' }),
    (err) => {
      assert.equal(err.code, 'BAD_NONCE');
      return true;
    }
  );
});

test('per-user auth: token refresh hits POST /auth/refresh with { refreshToken }', async () => {
  let refreshBody = null;
  let refreshCalls = 0;
  const { url, server } = await startDavepiStub((req, res, body) => {
    if (req.url === '/auth/refresh' && req.method === 'POST') {
      refreshCalls += 1;
      refreshBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({ token: `at-${refreshCalls}`, refreshToken: 'rt-rotated', expiresIn: 900 })
      );
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const store = memoryStore();
    const auth = createPerUserAuth({
      davepiUrl: url,
      store,
      linkBaseUrl: 'http://agent.example.com',
      refreshSkewSeconds: 60,
    });
    await store.upsert({ channel: 'http', channel_user_id: 'u3', refresh_token: 'rt' });
    const a = await auth.headersFor({ channel: 'http', channelUserId: 'u3' });
    const b = await auth.headersFor({ channel: 'http', channelUserId: 'u3' });
    assert.equal(a.authorization, 'Bearer at-1');
    assert.equal(a.authorization, b.authorization, 'cached access token should be reused');
    assert.equal(refreshCalls, 1);
    assert.deepEqual(refreshBody, { refreshToken: 'rt' });
  } finally {
    server.close();
  }
});

test('per-user auth: refresh re-fired when cached access token is past skew', async () => {
  let refreshCalls = 0;
  const { url, server } = await startDavepiStub((req, res) => {
    refreshCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: `at-${refreshCalls}`, refreshToken: 'rt', expiresIn: 900 }));
  });
  try {
    const store = memoryStore();
    const auth = createPerUserAuth({
      davepiUrl: url,
      store,
      linkBaseUrl: 'http://agent.example.com',
      refreshSkewSeconds: 60,
    });
    await store.upsert({
      channel: 'http',
      channel_user_id: 'u4',
      refresh_token: 'rt',
      access_token: 'stale',
      access_expires_at: Date.now() - 1000,
    });
    const headers = await auth.headersFor({ channel: 'http', channelUserId: 'u4' });
    assert.equal(headers.authorization, 'Bearer at-1');
    assert.equal(refreshCalls, 1);
  } finally {
    server.close();
  }
});

test('per-user auth: nonce TTL expiry prunes stale nonces', async () => {
  const auth = createPerUserAuth({
    davepiUrl: 'http://stub.invalid',
    store: memoryStore(),
    linkBaseUrl: 'http://agent.example.com',
    nonceTtlSeconds: 0.01, // 10ms
  });
  const link = auth.startLink({ channel: 'slack', channelUserId: 'u' });
  assert.ok(auth.lookupNonce(link.nonce), 'nonce should be visible immediately');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(auth.lookupNonce(link.nonce), null);
});
