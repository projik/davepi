'use strict';

/**
 * Unit tests for the Postmark inbound webhook handler + the
 * onInboundEmail / sendEmailWithTemplate surface in index.js.
 *
 * The handler is tested directly with a stub req/res so we don't
 * need Express in this package's deps. The plugin-level mounting
 * (env triggers `app.post(...)`) is asserted by spying on a stub
 * `app` object passed to setup().
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createPlugin } = require('../index');
const { buildInboundHandler, isInboundShape, timingSafeStringEqual } = require('../lib/inbound');

function silentLog() {
  return {
    info:  () => {},
    warn:  () => {},
    error: () => {},
    child: () => silentLog(),
  };
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

function fakeRes() {
  const res = {
    statusCode: null,
    body:       null,
    status(code) { this.statusCode = code; return this; },
    json(body)  { this.body = body; return this; },
  };
  return res;
}

function basicAuthHeader(pair) {
  return 'Basic ' + Buffer.from(pair, 'utf8').toString('base64');
}

const VALID_INBOUND = {
  MessageID: '11111111-2222-3333-4444-555555555555',
  From:      'sender@example.com',
  FromName:  'Sender',
  To:        'inbox@my-app.com',
  Subject:   'Re: ticket #42',
  TextBody:  'thanks for the update',
  HtmlBody:  '<p>thanks for the update</p>',
  Attachments: [],
  Headers: [],
};

// ----- handler unit tests -----

test('inbound handler returns 401 when Authorization header missing', () => {
  const emitter = new EventEmitter();
  const handler = buildInboundHandler({ auth: 'user:pass', emitter, log: silentLog() });
  const req = { headers: {}, body: VALID_INBOUND };
  const res = fakeRes();
  handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'unauthorized');
});

test('inbound handler returns 401 on wrong basic-auth credentials', () => {
  const emitter = new EventEmitter();
  const handler = buildInboundHandler({ auth: 'user:pass', emitter, log: silentLog() });
  const req = {
    headers: { authorization: basicAuthHeader('user:wrong') },
    body: VALID_INBOUND,
  };
  const res = fakeRes();
  handler(req, res);
  assert.equal(res.statusCode, 401);
});

test('inbound handler returns 400 on a body that is not a Postmark message', () => {
  const emitter = new EventEmitter();
  const handler = buildInboundHandler({ auth: 'user:pass', emitter, log: silentLog() });
  const req = {
    headers: { authorization: basicAuthHeader('user:pass') },
    body: { hello: 'world' },
  };
  const res = fakeRes();
  handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'invalid_payload');
});

test('inbound handler ACKs 200 with MessageID and emits to subscribers', async () => {
  const emitter = new EventEmitter();
  const received = [];
  emitter.on('email', (msg) => { received.push(msg); });

  const handler = buildInboundHandler({ auth: 'user:pass', emitter, log: silentLog() });
  const req = {
    headers: { authorization: basicAuthHeader('user:pass') },
    body: VALID_INBOUND,
  };
  const res = fakeRes();
  handler(req, res);

  // ACK is synchronous.
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.MessageID, VALID_INBOUND.MessageID);

  // Fan-out is on setImmediate.
  await new Promise((r) => setImmediate(r));
  assert.equal(received.length, 1);
  assert.equal(received[0].MessageID, VALID_INBOUND.MessageID);
});

test('one throwing subscriber does not starve the others; error is logged', async () => {
  const emitter = new EventEmitter();
  const log = capturingLog();
  const secondCalled = [];
  emitter.on('email', () => { throw new Error('boom'); });
  emitter.on('email', (msg) => { secondCalled.push(msg.MessageID); });

  const handler = buildInboundHandler({ auth: 'user:pass', emitter, log });
  const req = { headers: { authorization: basicAuthHeader('user:pass') }, body: VALID_INBOUND };
  handler(req, fakeRes());

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(secondCalled.length, 1);
  assert.equal(log.records.error.length, 1);
  assert.match(log.records.error[0].msg, /inbound email handler threw/);
});

test('isInboundShape: requires MessageID and From', () => {
  assert.equal(isInboundShape(null), false);
  assert.equal(isInboundShape({}), false);
  assert.equal(isInboundShape({ MessageID: 'x' }), false);
  assert.equal(isInboundShape({ From: 'x' }), false);
  assert.equal(isInboundShape({ MessageID: 'x', From: 'a@b.c' }), true);
});

test('timingSafeStringEqual: equal-length match / mismatch / different lengths', () => {
  assert.equal(timingSafeStringEqual('hello', 'hello'), true);
  assert.equal(timingSafeStringEqual('hello', 'world'), false);
  assert.equal(timingSafeStringEqual('hello', 'hello!'), false);
  assert.equal(timingSafeStringEqual('', ''), true);
  assert.equal(timingSafeStringEqual(null, ''), true);
});

// ----- plugin-level wiring -----

function spyApp() {
  const calls = [];
  return {
    calls,
    post(path, handler) { calls.push({ path, handler }); },
  };
}

test('setup() mounts inbound route when both env vars are set', async () => {
  const app = spyApp();
  const log = capturingLog();
  const plugin = createPlugin({
    env: {
      POSTMARK_SERVER_TOKEN: 'tok',
      POSTMARK_FROM:         'team@example.com',
      POSTMARK_INBOUND_PATH: '/webhooks/postmark/inbound',
      POSTMARK_INBOUND_AUTH: 'inbound-user:inbound-pass',
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  await plugin.setup({ app, bus: new EventEmitter(), log, appName: 'shop' });

  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].path, '/webhooks/postmark/inbound');
  assert.equal(typeof app.calls[0].handler, 'function');
});

test('setup() refuses to mount inbound when only PATH is set (half-config)', async () => {
  const app = spyApp();
  const log = capturingLog();
  const plugin = createPlugin({
    env: {
      POSTMARK_SERVER_TOKEN: 'tok',
      POSTMARK_INBOUND_PATH: '/webhooks/postmark/inbound',
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  await plugin.setup({ app, bus: new EventEmitter(), log, appName: 'shop' });

  assert.equal(app.calls.length, 0);
  assert.equal(log.records.error.length, 1);
  assert.match(log.records.error[0].msg, /half-configured/);
});

test('setup() refuses to mount inbound when AUTH is not user:pass shape', async () => {
  const app = spyApp();
  const log = capturingLog();
  const plugin = createPlugin({
    env: {
      POSTMARK_SERVER_TOKEN: 'tok',
      POSTMARK_INBOUND_PATH: '/webhooks/postmark/inbound',
      POSTMARK_INBOUND_AUTH: 'just-a-token', // no colon
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  await plugin.setup({ app, bus: new EventEmitter(), log, appName: 'shop' });

  assert.equal(app.calls.length, 0);
  assert.equal(log.records.error.length, 1);
  assert.match(log.records.error[0].msg, /user:pass/);
});

test('onInboundEmail registers and unregisters handlers via the returned function', async () => {
  const app = spyApp();
  const plugin = createPlugin({
    env: {
      POSTMARK_SERVER_TOKEN: 'tok',
      POSTMARK_FROM:         'team@example.com',
      POSTMARK_INBOUND_PATH: '/in',
      POSTMARK_INBOUND_AUTH: 'u:p',
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  await plugin.setup({ app, bus: new EventEmitter(), log: silentLog(), appName: 'shop' });

  const seen = [];
  const off = plugin.onInboundEmail((msg) => { seen.push(msg.MessageID); });

  const mountedHandler = app.calls[0].handler;
  const req = {
    headers: { authorization: basicAuthHeader('u:p') },
    body: VALID_INBOUND,
  };
  mountedHandler(req, fakeRes());
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1);

  off(); // unsubscribe

  mountedHandler(req, fakeRes());
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1);
});

test('onInboundEmail throws on a non-function argument', async () => {
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: 'tok', POSTMARK_FROM: 'team@example.com' },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  await plugin.setup({ app: spyApp(), bus: new EventEmitter(), log: silentLog(), appName: 'shop' });
  assert.throws(() => plugin.onInboundEmail('not a function'), /must be a function/);
});

test('sendEmailWithTemplate is an alias for sendTemplate (same function reference)', () => {
  const plugin = createPlugin({
    env: { POSTMARK_SERVER_TOKEN: 'tok', POSTMARK_FROM: 'team@example.com' },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  });
  assert.equal(plugin.sendEmailWithTemplate, plugin.sendTemplate);
  assert.equal(typeof plugin.sendEmailWithTemplate, 'function');
});
