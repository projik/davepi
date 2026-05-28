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

test('per-user auth: unlinked user throws UNLINKED with a link URL', async () => {
  const auth = createPerUserAuth({
    davepiUrl: 'http://stub.invalid',
    store: memoryStore(),
    linkBaseUrl: 'http://agent.example.com',
  });
  await assert.rejects(
    () => auth.headersFor({ channel: 'slack', channelUserId: 'u1' }),
    (err) => {
      assert.equal(err.code, 'UNLINKED');
      assert.match(err.linkUrl, /\/login/);
      assert.match(err.linkUrl, /redirect_uri=/);
      return true;
    }
  );
});

test('per-user auth: completeLink stores refresh token; next call mints access', async () => {
  const { url, server } = await startDavepiStub((req, res, body) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/refresh');
    assert.equal(JSON.parse(body).refreshToken, 'refresh-abc');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: 'access-xyz', refreshToken: 'refresh-abc2', expiresIn: 900 }));
  });
  try {
    const store = memoryStore();
    const auth = createPerUserAuth({
      davepiUrl: url,
      store,
      linkBaseUrl: 'http://agent.example.com',
    });
    // First, simulate the link flow
    let nonce;
    try {
      await auth.headersFor({ channel: 'slack', channelUserId: 'u2' });
    } catch (err) {
      nonce = new URL(err.linkUrl).searchParams.get('redirect_uri');
      nonce = new URL(nonce).searchParams.get('nonce');
    }
    assert.ok(nonce);
    await auth.completeLink({ nonce, refreshToken: 'refresh-abc' });

    const headers = await auth.headersFor({ channel: 'slack', channelUserId: 'u2' });
    assert.equal(headers.authorization, 'Bearer access-xyz');
  } finally {
    server.close();
  }
});

test('per-user auth: cached access token reused while within TTL', async () => {
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
    // seed store directly
    await store.upsert({ channel: 'http', channel_user_id: 'u3', refresh_token: 'rt' });
    const a = await auth.headersFor({ channel: 'http', channelUserId: 'u3' });
    const b = await auth.headersFor({ channel: 'http', channelUserId: 'u3' });
    assert.equal(a.authorization, b.authorization, 'second call should reuse cached access token');
    assert.equal(refreshCalls, 1);
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
    // seed store with an already-expired cached access token
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
